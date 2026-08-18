/**
 * FEC bulk data pipeline — post-cutover, writes directly to public.
 * Multi-cycle (FIX-178): processes 2020/2022/2024/2026 by default so that
 * mid-term senators (Class II/III, not running in 2024) still have donor
 * records. Override with FEC_CYCLES env var ("2024" for legacy single-cycle).
 *
 * After the shadow→public promotion (migration 20260422000000), financial_*
 * tables live in public. This pipeline writes PAC committees and their
 * (committee × candidate × cycle) donation aggregates to:
 *   public.financial_entities         one row per FEC committee
 *     - fec_committee_id UNIQUE — primary dedup key
 *     - entity_type derived from FEC CMTE_TP (N/Q/V/W → pac, O → super_pac,
 *                                             X/Y/Z → party_committee)
 *     - total_donated_cents refreshed each run as SUM across all processed
 *       cycles (cross-cycle final pass after the per-cycle loop)
 *
 *   public.financial_relationships    one row per (PAC, candidate, cycle)
 *     - relationship_type='donation', from=financial_entity, to=official
 *     - amount_cents aggregated across all 24K/24Z txns in the cycle
 *     - occurred_at = latest txn date in the aggregation
 *     - cycle_year discriminates rows from different cycles
 *
 * Individual contributions (FIX-181, indiv{yy}.zip + ccl{yy}.zip):
 *   Per cycle, the indiv stage downloads ccl + indiv (~2 GB), parses ccl
 *   into a CMTE_ID → CAND_ID lookup, streams indiv line-by-line, aggregates
 *   to (donor_fingerprint × CAND_ID) pairs, upserts donor entities
 *   (entity_type='individual', dedup by canonical_name=fingerprint), and
 *   upserts donation relationships. Skip with FEC_INCLUDE_INDIV=false.
 *
 * Not written here:
 *   - No weball synthetic-donor rows ("Individual Contributors" etc.). Those
 *     were rollups forced to fit the old narrow schema; in the new shape they
 *     belong in a nightly aggregate view / official_financials rollup.
 *   - No entity_connections. Per L5 that table is derivation-only; the
 *     rebuild_entity_connections() SQL function handles donation edges.
 *
 * Data flow:
 *   Once (before cycle loop):
 *     - Load public.officials + build fuzzy-match index
 *   Per cycle:
 *     1. Download bulk zips (weball, cm, pas2) for this cycle
 *     2. Parse weball → grow match index, queue newly discovered FEC IDs
 *     3. Parse cm (committee master) → merge into cross-cycle map
 *     4. Stream pas2 line-by-line, aggregating 24K/24Z $5k+ txns by
 *        (CMTE_ID × CAND_ID)
 *     5. Upsert per-cycle entities (cycle-local total) + relationships
 *        (cycle_year=<cycle>)
 *     6. Cleanup cycle-local temp files
 *   Once (after cycle loop):
 *     - Persist newFecIds back to officials.source_ids
 *     - Cross-cycle final entity upsert: total_donated_cents = SUM across cycles
 *
 * Files downloaded to /tmp and deleted between cycles, so peak disk usage
 * stays under ~250MB regardless of how many cycles are processed.
 * No API key, no rate limits. FEC refreshes bulk files weekly.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:fec-bulk
 *   FEC_CYCLES=2022,2024 pnpm --filter @civitics/data data:fec-bulk
 *
 * Surgical / scoped re-runs (FIX-700 + FIX-701) — four independent knobs, each
 * defaulting to today's full-run behavior when unset:
 *   FEC_CYCLES=2024              — which cycles to process (existing)
 *   FEC_INDIV_TX_TYPES=10        — override the 15,15E,10 tx-type filter (indiv.ts)
 *   FEC_INDIV_STAGES=...         — comma allow-list of indiv sub-stages (scope.ts):
 *                                  donor-entities, indiv-to-candidate,
 *                                  recipient-entities, indiv-to-committee,
 *                                  independent-expenditures, totals
 *   FEC_INDIV_RECIPIENT_CMTES=…  — comma allow-list of recipient FEC committee
 *                                  IDs (indiv.ts). When set, only donations to
 *                                  those committees are captured. Type-15 D/B
 *                                  donations can't be isolated by tx-type, so
 *                                  this is the handle for the FIX-701 2024 D/B
 *                                  re-capture.
 * When FEC_INDIV_TX_TYPES narrows below the default OR FEC_INDIV_STAGES excludes
 * a stage OR FEC_INDIV_RECIPIENT_CMTES is set, the run is "scoped": the
 * donor/recipient entity upserts stop overwriting total_donated_cents /
 * total_received_cents (a partial slice must not clobber a full aggregate), and
 * the authoritative values are re-derived by the `totals` stage. ALWAYS run the
 * totals rebuild after any scoped relationship-writing run. Examples:
 *   FEC_CYCLES=2024 FEC_INDIV_TX_TYPES=10 pnpm --filter @civitics/data data:fec-bulk
 *   FEC_CYCLES=2024 FEC_INDIV_RECIPIENT_CMTES=C00…,C00… pnpm … data:fec-bulk
 *   # then, if `totals` was excluded, run rebuild_financial_entity_*_totals
 */

import * as https    from "https";
import * as fs       from "fs";
import * as path     from "path";
import * as os       from "os";
import * as readline from "readline";
import * as unzipper from "unzipper";
import { createAdminClient } from "@civitics/db";
import {
  startSync,
  completeSync,
  failSync,
  type PipelineResult,
} from "../sync-log";
import {
  upsertPacEntitiesBatch,
  upsertIeSpenderEntitiesByName,
  upsertDonationRelationshipsBatch,
  upsertIndividualDonorsBatch,
  upsertIndividualDonationsBatch,
  upsertIndividualToCommitteeDonationsBatch,
  upsertIndependentExpendituresBatch,
  fetchDonorIdsByFingerprint,
  fetchEntityIdsByCmteId,
  persistNewFecIds,
  type WriterResume,
  type IndividualDonationInput,
  type IndividualToCommitteeDonationInput,
  type IndependentExpenditureInput,
} from "./writer";
import {
  planCycleResume,
  createRunState,
  stageIsComplete,
  markStageComplete,
  updateStageCursor,
  describeRunState,
  sameLastModified,
  loadRunState,
  saveRunState,
  clearRunState,
  saveCycleStageWatermark,
  newCheckpointThrottle,
  shouldPersistCheckpoint,
  describeCheckpointStats,
  type CheckpointThrottle,
  type FecBulkRunState,
  type TrackedStage,
  type CursoredStage,
} from "./run-state";
import {
  extractZipEntryToDisk,
  parseFecDate,
  parseFecName,
  candMasterUrl,
  downloadWithR2Cache,
  headFecFile,
  parseLastModified,
  type FecHead,
} from "./util";
import {
  parseCcl,
  streamIndiv,
  parseKeepTxTypes,
  isIndivTxScoped,
  parseRecipientCmtes,
  isRecipientScoped,
  applyRecipientCmteScope,
} from "./indiv";
import {
  parseIndivStages,
  stageEnabled,
  isStagesScoped,
  INDIV_STAGE_NAMES,
  type IndivStageName,
} from "./scope";
import { streamIndependentExpenditures, isMintableSpenderName } from "./indep-exp";
import { resolveOrMintIeTargets, type IeTargetIdentity } from "./mint-ie-targets";
import {
  streamCandidates,
  loadOfficialsByFecIds,
} from "./candidates";
import { seedJurisdictions, seedGoverningBodies } from "../../jurisdictions/us-states";
import { runHeavyRebuild } from "../../lib/heavy-rebuild";
import { withDirectClient } from "../../lib/direct-pg-upsert";
import { errMsg } from "../utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeBallRow {
  candId:           string;  // CAND_ID
  candName:         string;  // CAND_NAME  (format: "LAST, FIRST MI")
  ttlReceipts:      number;  // TTL_RECEIPTS
  ttlDisb:          number;  // TTL_DISB
  cohCop:           number;  // COH_COP (cash on hand, close of period)
  candContrib:      number;  // CAND_CONTRIB (self-funded)
  candLoans:        number;  // CAND_LOANS
  otherLoans:       number;  // OTHER_LOANS
  indivContrib:     number;  // TTL_INDIV_CONTRIB
  polPtyContrib:    number;  // POL_PTY_CONTRIB
  cvrdHarReceipts:  number;  // OTHER_POL_CMTE_CONTRIB (PAC contributions)
  candOfficeSt:     string;  // CAND_OFFICE_ST (state abbr)
}

export interface OfficialRecord {
  id:         string;
  full_name:  string;
  first_name: string | null;
  last_name:  string | null;
  role_title: string | null;
  source_ids: Record<string, string>;
  state:      string | null;
  /**
   * FIX-941 — `officials.tier`. Optional so existing fixtures stay valid;
   * absent is read as 'elected', matching the column default and the same
   * fallback `loadOfficialsByFecIds` uses.
   */
  tier?:      string | null;
}

/** Committee master (cm24) entry */
export interface CommitteeInfo {
  name:         string;  // CMTE_NM
  type:         string;  // CMTE_TP raw code (N/Q/V/W/X/Y/Z/O)
  designation:  string;  // CMTE_DSGN raw code (J=joint-fundraising, D=leadership, B, P=principal, A=authorized, U=unauthorized)
  connectedOrg: string;  // CONNECTED_ORG_NM (parent company / union / etc)
}

/** Aggregated PAC → candidate contribution (grouped by CMTE_ID × CAND_ID) */
interface PacAggregation {
  cmteId:     string;
  candId:     string;
  totalCents: number;
  txCount:    number;
  latestDate: string | null; // raw MMDDYYYY from FEC
}

// ---------------------------------------------------------------------------
// Column index maps
// ---------------------------------------------------------------------------

// weball24 pipe-delimited column indices (0-based)
// Ref: https://www.fec.gov/campaign-finance-data/all-candidates-file-description/
const COL = {
  CAND_ID:                0,
  CAND_NAME:              1,
  TTL_RECEIPTS:           5,
  TRANS_FROM_AUTH:        6,
  TTL_DISB:               7,
  COH_COP:                10,
  CAND_CONTRIB:           11,
  CAND_LOANS:             12,
  OTHER_LOANS:            13,
  TTL_INDIV_CONTRIB:      17,
  CAND_OFFICE_ST:         18,
  OTHER_POL_CMTE_CONTRIB: 25,
  POL_PTY_CONTRIB:        26,
} as const;

// cm24 (committee master) pipe-delimited column indices
// Ref: https://www.fec.gov/campaign-finance-data/committee-master-file-description/
const CM_COL = {
  CMTE_ID:          0,
  CMTE_NM:          1,
  CMTE_DSGN:        8,  // designation (J=joint-fundraising, D=leadership, B, P/A/U) — col before CMTE_TP
  CMTE_TP:          9,
  CONNECTED_ORG_NM: 13,
} as const;

// pas224 (PAC to candidate contributions) pipe-delimited column indices
// Ref: https://www.fec.gov/campaign-finance-data/pac-and-party-committee-to-candidate-contributions-file-description/
const PAS_COL = {
  CMTE_ID:         0,
  TRANSACTION_TP:  5,
  TRANSACTION_DT:  13,
  TRANSACTION_AMT: 14,
  CAND_ID:         16,
} as const;

// ---------------------------------------------------------------------------
// Download + extract helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), "fec-bulk");

function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

/** R2 cache key layout for FEC bulk files (FIX-192). One namespace per cycle
 *  keeps simple LIST-by-prefix operations clean if we ever audit the bucket. */
function r2KeyFor(cycle: string, fileName: string): string {
  return `fec/${cycle}/${fileName}`;
}

export function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (targetUrl: string): void => {
      const file = fs.createWriteStream(destPath);
      https
        .get(targetUrl, (res) => {
          const { statusCode, headers } = res;
          if (statusCode === 301 || statusCode === 302) {
            res.resume();
            file.destroy();
            follow(headers.location ?? targetUrl);
            return;
          }
          if (statusCode !== 200) {
            file.destroy();
            reject(new Error(`HTTP ${statusCode} — ${targetUrl}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
          file.on("error", (err) => {
            fs.unlink(destPath, () => undefined);
            reject(err);
          });
        })
        .on("error", (err) => {
          file.destroy();
          reject(err);
        });
    };
    follow(url);
  });
}

async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  const extracted: string[] = [];
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    if (entry.type === "File") {
      const outPath = path.join(destDir, path.basename(entry.path));
      const content = await entry.buffer();
      fs.writeFileSync(outPath, content);
      extracted.push(outPath);
    }
  }
  return extracted;
}

function deleteTmpDir(): void {
  try {
    if (fs.existsSync(TMP_DIR)) {
      for (const f of fs.readdirSync(TMP_DIR)) {
        fs.unlinkSync(path.join(TMP_DIR, f));
      }
      fs.rmdirSync(TMP_DIR);
    }
  } catch {
    // non-fatal — best effort
  }
}

// ---------------------------------------------------------------------------
// Parse weball flat file
// ---------------------------------------------------------------------------

function parseMoney(raw: string | undefined): number {
  const n = parseFloat(raw ?? "0");
  return isNaN(n) ? 0 : n;
}

function parseWeBall(buffer: Buffer): WeBallRow[] {
  const rows: WeBallRow[] = [];
  for (const line of buffer.toString("latin1").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols   = line.split("|");
    const candId = (cols[COL.CAND_ID] ?? "").trim();
    if (!candId) continue;
    rows.push({
      candId,
      candName:        (cols[COL.CAND_NAME] ?? "").trim(),
      ttlReceipts:     parseMoney(cols[COL.TTL_RECEIPTS]),
      ttlDisb:         parseMoney(cols[COL.TTL_DISB]),
      cohCop:          parseMoney(cols[COL.COH_COP]),
      candContrib:     parseMoney(cols[COL.CAND_CONTRIB]),
      candLoans:       parseMoney(cols[COL.CAND_LOANS]),
      otherLoans:      parseMoney(cols[COL.OTHER_LOANS]),
      indivContrib:    parseMoney(cols[COL.TTL_INDIV_CONTRIB]),
      polPtyContrib:   parseMoney(cols[COL.POL_PTY_CONTRIB]),
      cvrdHarReceipts: parseMoney(cols[COL.OTHER_POL_CMTE_CONTRIB]),
      candOfficeSt:    (cols[COL.CAND_OFFICE_ST] ?? "").trim().toUpperCase(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Name normalization for fuzzy matching
// ---------------------------------------------------------------------------

/** "SMITH, JOHN A" → { last: "SMITH", first: "JOHN" } */
function normalizeLastName(name: string | null): string {
  return (name ?? "").toUpperCase().replace(/[^A-Z]/g, "");
}

// ---------------------------------------------------------------------------
// Match FEC rows to our officials
// ---------------------------------------------------------------------------

export async function loadOfficials(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<OfficialRecord[]> {
  const PAGE = 1000;
  const all: OfficialRecord[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await db
      .from("officials")
      .select("id, full_name, first_name, last_name, role_title, tier, source_ids, jurisdictions!jurisdiction_id(short_name)")
      .eq("is_active", true)
      // FIX-760: stable unique order — unordered .range() pagination can
      // skip/duplicate rows as page boundaries shift between queries.
      .order("id")
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`Could not load officials: ${error.message}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const o of (data ?? []) as any[]) {
      all.push({
        id:         o.id as string,
        full_name:  o.full_name as string,
        first_name: (o.first_name as string | null) ?? null,
        last_name:  (o.last_name as string | null) ?? null,
        role_title: (o.role_title as string | null) ?? null,
        source_ids: (o.source_ids ?? {}) as Record<string, string>,
        state:      (o.jurisdictions?.short_name as string | null) ?? null,
        tier:       (o.tier as string | null) ?? null,
      });
    }
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

export interface MatchIndex {
  byFecId:    Map<string, string>;           // fecId → officialId
  byLastName: Map<string, OfficialRecord[]>; // normalizedLast → officials
}

/**
 * FIX-941 — `byFecId` is built in TWO passes, and an elected row always wins.
 *
 * Both passes used to `.set()` unconditionally while iterating `.order("id")`,
 * which made the index doubly order-dependent: the higher uuid won any
 * duplicated CAND_ID, AND a row's `fec_id` could clobber another row's
 * authoritative `fec_candidate_id` purely because it came later. (Its sibling
 * `loadOfficialsByFecIds` in ./candidates.ts already guarded the second case
 * with `!map.has()` — the two were inconsistent.) Splitting the passes makes
 * the precedence explicit — every `fec_candidate_id` claim is resolved before
 * any `fec_id` claim is considered — and the tier preference makes the outcome
 * independent of uuid order rather than arbitrary.
 */
/**
 * FIX-955 — has this officials row RETIRED its claim on `key`?
 *
 * FIX-933 neutralises a same-person duplicate by moving its `fec_candidate_id`
 * to `merged_fec_candidate_id` — the money goes to the elected survivor and the
 * candidate stub keeps the id only as provenance. Nothing in this pipeline used
 * to know that marker existed, so `matchRow` re-matched the retired stub BY NAME
 * (the FIX-929 first-name gate passes — it genuinely is the same person) and
 * `persistNewFecIds` wrote the claim straight back. The money then re-split
 * across the pair and the merge silently undid itself, every run.
 *
 * Measured on a clone where FIX-933 had already been applied, after one
 * `FEC_CYCLES=2020,2022` pass: 76 candidate rows carrying BOTH markers and
 * holding money again, and $309,080,435 of freshly double-counted money across
 * 95 rows — e.g. `Steny Hoyer` (candidate) and `Steny H. Hoyer` (elected) each
 * holding an identical 510 rows for 2020 and 404 for 2022.
 *
 * A retired claim is permanent until a human reverses it, so it is refused
 * everywhere a CAND_ID can select an official: both index passes below, and the
 * name fallback in `matchRow`.
 */
export function hasRetiredClaim(o: OfficialRecord, key: string): boolean {
  return o.source_ids["merged_fec_candidate_id"] === key;
}

/**
 * FIX-937 — the only `role_title`s that can legitimately hold an FEC
 * House / Senate / President CAND_ID.
 *
 * WHY A ROLE ALLOW-LIST AND NOT THE `short_name` SYMPTOM. The bullet found the
 * population via jurisdiction `short_name` values that are not two-letter state
 * codes (`AUS`, `SEA`, `SF`, `US`), because such an official can never satisfy
 * `matchRow`'s state narrowing and therefore only ever bound through the
 * national-pool fallback FIX-936 has now closed. But `short_name` is a
 * *consequence* of where the row came from, not a statement about the seat:
 * `US` is also the jurisdiction of every presidential candidate the cn{yy}
 * stage mints, which IS federally electable. The stable signal is the role.
 *
 * The read side already refuses these ids — `buildMatchIndex` pass 2 honours a
 * stored `fec_id` only when its FEC prefix matches the role (Senator→S,
 * Representative→H), and `loadOfficialsByFecIds` mirrors that with a
 * President→P arm. The write side had NO role check at all, so the pipeline
 * wrote a binding by surname, refused to read it back, and re-derived it by
 * name on the next run, forever. This list is that asymmetry closed: the same
 * vocabulary, applied where the binding is MADE.
 *
 * EXACT strings, never `includes`/`ILIKE`. `"State Senator"` contains
 * `"Senator"`; `"Vice President, Marketing"` (a real USPS row on the clone)
 * contains `"President"`. An allow-list also fails in the recoverable
 * direction — an unrecognised federal role is refused a name match, which
 * lands in FIX-935's UNIQUE HOLDER branch (write the id later), rather than
 * binding someone else's donors (FIX-934).
 *
 * `President` / `Vice President` match nothing on the clone today (the sitting
 * President is not carried as an `officials` row); they are listed so a future
 * seed does not silently fall out of the pool.
 */
export const FEC_ELECTABLE_ROLE_TITLES: ReadonlySet<string> = new Set([
  "Senator",
  "Representative",
  "President",
  "Vice President",
  // Minted by the cn{yy} stage — see roleTitleFor() in ./candidates.ts.
  "Candidate for Senator",
  "Candidate for Representative",
  "Candidate for President",
]);

/** FIX-937 — may this official hold an FEC candidate id at all? */
export function isFecElectableRole(o: OfficialRecord): boolean {
  return FEC_ELECTABLE_ROLE_TITLES.has((o.role_title ?? "").trim());
}

export function buildMatchIndex(officials: OfficialRecord[]): MatchIndex {
  const byFecId    = new Map<string, string>();
  const byLastName = new Map<string, OfficialRecord[]>();
  /** key → tier currently holding it, so a later elected row can displace a stub. */
  const holderTier = new Map<string, string>();
  const collisions: string[] = [];

  const claim = (key: string, o: OfficialRecord): void => {
    const tier = o.tier ?? "elected";
    const held = byFecId.get(key);
    if (held === undefined) {
      byFecId.set(key, o.id);
      holderTier.set(key, tier);
      return;
    }
    if (held === o.id) return;

    const heldTier = holderTier.get(key) ?? "elected";
    if (heldTier !== "elected" && tier === "elected") {
      byFecId.set(key, o.id);
      holderTier.set(key, tier);
      collisions.push(`    ${key}: ${o.id} (elected) TAKES the slot from ${held} (${heldTier})`);
    } else {
      collisions.push(`    ${key}: ${held} (${heldTier}) KEEPS the slot; ${o.id} (${tier}) refused`);
    }
  };

  // Pass 1 — fec_candidate_id is the most authoritative key.
  for (const o of officials) {
    const candidateId = o.source_ids["fec_candidate_id"];
    // FIX-955: a re-written claim on an id this row already retired is exactly
    // the defect; refuse it here rather than letting it win a slot.
    if (candidateId && !hasRetiredClaim(o, candidateId)) claim(candidateId, o);
  }

  // Pass 2 — fec_id, only when its FEC prefix matches the official's current
  // role. Prefix mismatch means it's an old ID from a prior race (e.g. a Senator
  // who previously served in the House and has an H-prefix fec_id still stored).
  // Never displaces a pass-1 claim: an explicit cn{yy} ingestion outranks a
  // weball-derived id for the same key.
  for (const o of officials) {
    const fecId = o.source_ids["fec_id"];
    if (!fecId) continue;
    if (hasRetiredClaim(o, fecId)) continue; // FIX-955
    const prefix    = fecId[0]?.toUpperCase() ?? "";
    const isSenator = o.role_title === "Senator";
    const isRep     = o.role_title === "Representative";
    if ((isSenator && prefix === "S") || (isRep && prefix === "H")) {
      claim(fecId, o);
    }
    // Mismatched prefix (old race) — skip; don't pollute the index
  }

  // FIX-937 — the NAME pool is federal-electable only. A city council member or
  // an Article III judge holds no federal seat, so an H*/S*/P* CAND_ID can never
  // legitimately be theirs; excluding them here is both cheaper and stricter
  // than any name heuristic downstream. The judges arrive via CourtListener and
  // the municipal rows via Legistar — neither population has an FEC identity to
  // match. (The byFecId passes above are deliberately untouched: they resolve a
  // STORED, authoritative id, and pass 2 already enforces the role/prefix rule.)
  //
  // Excluding at pool-CONSTRUCTION time, not per row, is what keeps the FIX-929
  // ambiguity guard honest — the same reasoning as FIX-955's retired-claim
  // filter. A judge sitting in a surname pool inflates `firstPool.length` and
  // can suppress a legitimate lone match; dropping the judge is allowed to
  // reveal that match, because the judge was never a candidate for it.
  let roleExcluded = 0;
  for (const o of officials) {
    if (!isFecElectableRole(o)) { roleExcluded++; continue; }
    const key  = normalizeLastName(o.last_name ?? o.full_name);
    const list = byLastName.get(key) ?? [];
    list.push(o);
    byLastName.set(key, list);
  }
  if (roleExcluded > 0) {
    console.log(
      `    FIX-937: ${roleExcluded} of ${officials.length} officials excluded from the ` +
        `name-match pool (role_title is not federally electable)`,
    );
  }

  if (collisions.length > 0) {
    console.warn(
      `  ⚠ FIX-941: ${collisions.length} FEC ID(s) claimed by more than one officials row. ` +
        `Resolved by tier preference (elected wins) instead of uuid order:`,
    );
    for (const line of collisions) console.warn(line);
  }

  return { byFecId, byLastName };
}

interface MatchResult {
  officialId: string;
  fecId:      string;
  byFecId:    boolean;
}

/**
 * Three-letter first-name key, uppercase and stripped of everything but A-Z.
 * Returns "" when fewer than three comparable letters survive — the caller
 * treats that as "cannot compare", never as "agrees".
 *
 * Mirrors the key the sibling name-fallback loop below already builds
 * (`normalizedLast | first3 | state`), so both fallbacks agree on what a
 * first-name match means.
 */
function firstNameKey(raw: string | null | undefined): string {
  const norm = (raw ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return norm.length >= 3 ? norm.slice(0, 3) : "";
}

/** The official's own first name, falling back to the leading full_name token. */
function officialFirstNameKey(o: OfficialRecord): string {
  return firstNameKey(o.first_name) || firstNameKey(o.full_name.split(/\s+/)[0]);
}

/** Why a weball row was refused a name match, for the per-cycle telemetry line. */
export type NamePoolRefusal =
  | "no-surname-match"  // nobody in the pool carries that surname at all
  | "no-state-match";   // FIX-936: surname pool exists, but nobody is in that state

export interface NamePoolSelection {
  /** Officials the first-name gate may run over. Empty ⇒ refuse to bind. */
  pool: OfficialRecord[];
  /** Non-null exactly when `pool` is empty. */
  refusal: NamePoolRefusal | null;
  /** True when state narrowing actually ran and produced this pool. */
  narrowedByState: boolean;
}

/**
 * FIX-936 — pick the pool the weball name fallback may bind from. Pure, so the
 * refusal rule is testable without a pipeline run or a DB.
 *
 * THE DEFECT: this was `statePool.length > 0 ? statePool : candidates`. When
 * state narrowing yielded NOTHING the pool silently widened back to every
 * official in the country with that surname — the inverse of the intended
 * safety property, because "narrowing failed" is precisely the case where a
 * name match is least trustworthy. FIX-929's first-name gate mitigates it but
 * does not remove it: a coincidental national single-match whose first names
 * happen to agree still binds, and the FIX-930 audit showed first names
 * agreeing by coincidence is common at national scale.
 *
 * THE RULE: no state match ⇒ no name match. Strict, not corroborated. The cost
 * asymmetry decides it — a refused bind lands in FIX-935's UNIQUE HOLDER branch
 * (the id gets written later; non-destructive and recoverable), while a wrong
 * bind renders another person's donors under an official's name and, because
 * the writer upserts on (relationship_type, from_id, to_id, cycle_year), a
 * later corrected binding writes a NEW row and never retires the bad one
 * (FIX-934). A corroborator-based alternative (ccl committee linkage, district
 * agreement, an existing external_source_refs binding) is deliberately NOT
 * built here.
 *
 * RECORDED DECISION — a weball row with a BLANK CAND_OFFICE_ST keeps the
 * un-narrowed pool. Narrowing was not attempted there, so there is no state
 * disagreement to act on; that is a different epistemic position from "we
 * checked and nobody with this surname sits in that state". FIX-929's
 * first-name gate is the only guard on that path, exactly as before this fix.
 * It is counted separately in the telemetry (`blankState`) so the decision can
 * be revisited on evidence rather than on argument.
 */
export function selectNameFallbackPool(
  candidates: OfficialRecord[],
  candOfficeSt: string,
): NamePoolSelection {
  if (candidates.length === 0) {
    return { pool: [], refusal: "no-surname-match", narrowedByState: false };
  }
  if (!candOfficeSt) {
    return { pool: candidates, refusal: null, narrowedByState: false };
  }
  const statePool = candidates.filter(
    (c) => (c.state ?? "").toUpperCase() === candOfficeSt,
  );
  if (statePool.length === 0) {
    return { pool: [], refusal: "no-state-match", narrowedByState: true };
  }
  return { pool: statePool, refusal: null, narrowedByState: true };
}

/** Per-cycle counters for the FIX-936 / FIX-937 refusal log line. */
export interface MatchRefusalStats {
  /** Surname is not in the (federal-electable) name pool at all. */
  noSurnameMatch: number;
  /** FIX-936: surname pool exists but nobody sits in the FEC row's state. */
  noStateMatch: number;
  /** FEC row carried no CAND_OFFICE_ST, so narrowing never ran. */
  blankState: number;
  /** FIX-929: pool survived, but no unique first-name agreement. */
  noFirstNameAgreement: number;
}

export function newMatchRefusalStats(): MatchRefusalStats {
  return { noSurnameMatch: 0, noStateMatch: 0, blankState: 0, noFirstNameAgreement: 0 };
}

export function describeMatchRefusals(s: MatchRefusalStats): string {
  return (
    `refused: ${s.noSurnameMatch} no-surname, ${s.noStateMatch} no-state-match (FIX-936), ` +
    `${s.noFirstNameAgreement} no-first-name-agreement (FIX-929); ` +
    `${s.blankState} row(s) had a blank CAND_OFFICE_ST`
  );
}

export function matchRow(
  row: WeBallRow,
  index: MatchIndex,
  stats?: MatchRefusalStats,
): MatchResult | null {
  // 1. Direct stored fec_id match
  const directId = index.byFecId.get(row.candId);
  if (directId) return { officialId: directId, fecId: row.candId, byFecId: true };

  // 2. Name fuzzy match
  const { last, first } = parseFecName(row.candName);
  const key       = last.replace(/[^A-Z]/g, "");
  // FIX-955 — drop any row that RETIRED this CAND_ID before the pool is sized.
  // This is the path that actually undid FIX-933: the retired stub is the same
  // human as the survivor, so the first-name gate agrees and the stub wins the
  // match on name alone. Filtering here (not after) also keeps the ambiguity
  // guard honest — the retired row must not count toward `firstPool.length`,
  // or removing it would silently turn an ambiguous pool into a lone match.
  const candidates = (index.byLastName.get(key) ?? []).filter(
    (c) => !hasRetiredClaim(c, row.candId),
  );

  // FIX-936 — "no state match ⇒ no name match" (see selectNameFallbackPool).
  const selection = selectNameFallbackPool(candidates, row.candOfficeSt);
  if (stats && !selection.narrowedByState && row.candOfficeSt === "") stats.blankState++;
  if (selection.refusal) {
    if (stats) {
      if (selection.refusal === "no-surname-match") stats.noSurnameMatch++;
      else stats.noStateMatch++;
    }
    return null;
  }
  const pool = selection.pool;

  // FIX-929 — first names are compared on EVERY name-fallback match, including
  // a pool that state-narrowing already collapsed to one.
  //
  // A missed match is strictly better than a wrong match. An official with no
  // FEC binding renders $0 and a "FEC sync weekly" note; an official with a
  // WRONG binding renders another person's donors under their name on a public
  // page — and because the writer upserts on (relationship_type, from_id,
  // to_id, cycle_year), a later corrected binding writes a NEW row and never
  // retires the bad one, so the mis-attribution is permanent until someone
  // cleans it up by hand (see FIX-930).
  //
  // The old `if (pool.length === 1) return pool[0]` shortcut returned before
  // the first names were ever compared, and state-narrowing made that WORSE
  // rather than safer: it collapsed an ambiguous same-surname pool down to one
  // and thereby removed the very ambiguity guard that would have forced a skip.
  // Ohio has three officials surnamed Brown; that shortcut bound Sherrod
  // Brown's Senate CAND_ID (S6OH00163) to Shontel M. Brown and parked $51.0M
  // of his donors on her page.
  //
  // When the FEC first name is too short to compare (initials-only rows like
  // "PRYCE, B", or a blank name field) firstNameKey returns "" and nothing
  // matches — skip rather than guess.
  const fecFirst = firstNameKey(first);
  if (!fecFirst) {
    if (stats) stats.noFirstNameAgreement++;
    return null;
  }

  const firstPool = pool.filter((c) => officialFirstNameKey(c) === fecFirst);
  if (firstPool.length === 1) {
    return { officialId: firstPool[0].id, fecId: row.candId, byFecId: false };
  }

  if (stats) stats.noFirstNameAgreement++;
  return null; // no first-name agreement, or still ambiguous — skip
}

/**
 * FIX-960 — the per-cycle weball name-fallback, extracted so it can be tested
 * and so its two guards are impossible to miss.
 *
 * This is the SECOND name-resolution path (the first is `matchRow`'s fallback
 * above) and it undid FIX-933 on prod through two independent defects:
 *
 * 1. Its eligibility filter was `!fec_candidate_id && !fec_id` only — it never
 *    consulted `merged_fec_candidate_id`, so a FIX-933 merge stub (freshly
 *    id-less by design) re-entered the pool. The exclusion here is deliberately
 *    key-PRESENCE, not `hasRetiredClaim`'s id-equality: a merge stub must never
 *    re-enter any name pool for ANY id. The id-equality form provably leaves
 *    the second-id path open — the Banks/Budd/Cotton "Candidate for Senator"
 *    stubs carried retired SENATE ids and name-claimed their old HOUSE ids
 *    through this loop (+$451,756 of duplicated House-stub money, 2026-08-02).
 *
 * 2. Its `index.byFecId.set()` was unconditional, so a fallback match STOLE
 *    CAND_IDs already correctly bound byFecId to the elected survivor (79+3
 *    thefts on 2026-08-02, $132.9M of duplicate donation rows). A binding that
 *    already exists always wins now; the fallback only ever fills empty slots.
 *
 * The pool is also processed elected-tier first (same preference as
 * `buildMatchIndex`, FIX-941): when an elected row and a stub share a name key,
 * the elected row takes the binding and the non-clobber guard refuses the stub,
 * instead of the outcome depending on officials load order.
 *
 * Mutates `index.byFecId` for the bindings it makes and returns them; the
 * caller owns the cross-cycle `newFecIds` dedup.
 */
export function perCycleNameFallback(
  officials: OfficialRecord[],
  weballRows: WeBallRow[],
  index: MatchIndex,
): Array<{ officialId: string; fecId: string }> {
  const alreadyIndexed = new Set(index.byFecId.values());
  const pool = officials
    .filter((o) => {
      if (alreadyIndexed.has(o.id)) return false;
      // FIX-937 — same federal-electable gate buildMatchIndex applies to
      // byLastName. This loop takes `officials` directly rather than the index,
      // so it is a SECOND pool that has to be filtered independently; that is
      // exactly the enumeration gap FIX-960 was filed for.
      if (!isFecElectableRole(o)) return false;
      // FIX-960 guard 1 — broad key-presence exclusion (see doc comment).
      if (o.source_ids["merged_fec_candidate_id"] !== undefined) return false;
      return !o.source_ids["fec_candidate_id"] && !o.source_ids["fec_id"];
    })
    .sort(
      (a, b) =>
        Number((b.tier ?? "elected") === "elected") -
        Number((a.tier ?? "elected") === "elected"),
    );
  if (pool.length === 0) return [];

  const weballByKey = new Map<string, WeBallRow>();
  for (const row of weballRows) {
    const { last, first } = parseFecName(row.candName);
    const key = `${last.replace(/[^A-Z]/g, "")}|${first.slice(0, 3)}|${row.candOfficeSt}`;
    if (!weballByKey.has(key)) weballByKey.set(key, row);
  }

  const bound: Array<{ officialId: string; fecId: string }> = [];
  for (const official of pool) {
    const normLast  = normalizeLastName(official.last_name ?? official.full_name);
    const normFirst = (official.first_name ?? official.full_name.split(" ")[0] ?? "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 3);
    const state = (official.state ?? "").toUpperCase();
    const row   = weballByKey.get(`${normLast}|${normFirst}|${state}`);
    if (!row) continue;

    // FIX-960 guard 2 — never clobber an existing binding, and never report a
    // refused binding as a new FEC id (the caller would persist it).
    if (index.byFecId.has(row.candId)) continue;

    index.byFecId.set(row.candId, official.id);
    bound.push({ officialId: official.id, fecId: row.candId });
  }
  return bound;
}

// ---------------------------------------------------------------------------
// Parse cm24 committee master (in-memory — ~2 MB uncompressed)
// ---------------------------------------------------------------------------

export function parseCm24(buffer: Buffer): Map<string, CommitteeInfo> {
  const lookup = new Map<string, CommitteeInfo>();
  for (const line of buffer.toString("latin1").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols   = line.split("|");
    const cmteId = (cols[CM_COL.CMTE_ID] ?? "").trim();
    if (!cmteId) continue;
    lookup.set(cmteId, {
      name:         (cols[CM_COL.CMTE_NM]          ?? "").trim(),
      type:         (cols[CM_COL.CMTE_TP]          ?? "").trim().toUpperCase(),
      designation:  (cols[CM_COL.CMTE_DSGN]        ?? "").trim().toUpperCase(),
      connectedOrg: (cols[CM_COL.CONNECTED_ORG_NM] ?? "").trim(),
    });
  }
  return lookup;
}

// Non-candidate-committee recipient capture set (FIX-236 + FIX-698 + FIX-701).
//
// CMTE_TP we want as individual→committee recipients: super PAC (O), party
// (X/Y/Z), other PAC (N/Q/V/W). CMTE_DSGN='J' (joint-fundraising) is excluded
// REGARDLESS of type — a JFC re-itemizes its receipts to participants via
// JFC→participant transfers, so counting the individual→JFC leg double-counts
// the same dollars. Before FIX-698 the designation filter was only documented,
// never applied (CMTE_DSGN was never parsed), so JFCs filed as CMTE_TP='N'
// (Harris Victory Fund, the Trump JFCs) slipped through.
//
// FIX-701: the exclusion was WRONGLY broadened to {J,D,B} in FIX-698. Only J is
// a true double-count. Leadership PACs (D) and SSF / connected PACs (B) are
// legitimate DISTINCT recipients — a donation to a leadership PAC is real money
// to that PAC, not a re-itemized transfer — so they belong in the recipient set.
// Narrowed back to {J}. (The candidate-attribution ccl path in indiv.ts is a
// P/A allow-list, not a J/D/B exclusion — leaving D/B out of THAT path is
// correct, since leadership-PAC receipts must not be attributed to the sponsor's
// campaign; they surface here as their own committee entity instead.)
export const NON_CAND_KEEP_TYPES = new Set(["O", "X", "Y", "Z", "N", "Q", "V", "W"]);
export const EXCLUDE_DESIGNATIONS = new Set(["J"]);

export function buildNonCandRecipientSet(
  cmLookup: Map<string, CommitteeInfo>,
  cmteToCand: Map<string, string>,
): Set<string> {
  const nonCandCmtes = new Set<string>();
  for (const [cmteId, info] of cmLookup.entries()) {
    if (cmteToCand.has(cmteId)) continue;                       // already a candidate-authorized recipient
    if (EXCLUDE_DESIGNATIONS.has(info.designation)) continue;   // JFC (J) only — the true double-count (FIX-701)
    if (NON_CAND_KEEP_TYPES.has(info.type)) nonCandCmtes.add(cmteId);
  }
  return nonCandCmtes;
}

// ---------------------------------------------------------------------------
// Stream PAC contributions (pas224)
// ---------------------------------------------------------------------------

/**
 * Stream pas224.txt (extracted to disk) line-by-line.
 * Never loads the full file into memory.
 *
 * Filters applied while streaming:
 *   TRANSACTION_TP in ('24K', '24Z')   — direct contributions only
 *   TRANSACTION_AMT >= 200             — FEC's itemization threshold; rejects malformed/refund rows
 *   CAND_ID in candidateSet            — only our matched officials
 *
 * Returns aggregated totals keyed by "CMTE_ID|CAND_ID".
 */
async function streamPas224(
  zipPath:      string,
  candidateSet: Set<string>,
): Promise<Map<string, PacAggregation>> {
  const aggregated = new Map<string, PacAggregation>();

  const txtPath = path.join(TMP_DIR, "pas224.txt");
  const found   = await extractZipEntryToDisk(
    zipPath,
    (name) => name.includes("pas2") && name.endsWith(".txt"),
    txtPath,
  );

  if (!found) {
    console.error("    pas224.txt not found inside zip — skipping PAC step");
    return aggregated;
  }

  const txtMb = (fs.statSync(txtPath).size / 1024 / 1024).toFixed(0);
  console.log(`    Extracted pas224.txt (${txtMb} MB) — streaming line by line...`);

  let linesRead = 0, passedTxType = 0, passedCand = 0, passedAmt = 0;

  const rl = readline.createInterface({
    input:      fs.createReadStream(txtPath, { encoding: "latin1" }),
    crlfDelay:  Infinity,
  });

  for await (const line of rl) {
    linesRead++;

    const cols   = line.split("|");
    const cmteId = (cols[PAS_COL.CMTE_ID]         ?? "").trim();
    const txType = (cols[PAS_COL.TRANSACTION_TP]  ?? "").trim();
    const candId = (cols[PAS_COL.CAND_ID]         ?? "").trim();
    const amtStr = (cols[PAS_COL.TRANSACTION_AMT] ?? "").trim();
    const dtStr  = (cols[PAS_COL.TRANSACTION_DT]  ?? "").trim();

    if (txType !== "24K" && txType !== "24Z") continue;
    passedTxType++;

    if (!candidateSet.has(candId)) continue;
    passedCand++;

    const amt = parseFloat(amtStr);
    if (isNaN(amt) || amt < 200) continue;
    passedAmt++;

    const key      = `${cmteId}|${candId}`;
    const amtCents = Math.round(amt * 100);
    const existing = aggregated.get(key);
    if (existing) {
      existing.totalCents += amtCents;
      existing.txCount++;
      if (dtStr && dtStr > (existing.latestDate ?? "")) existing.latestDate = dtStr;
    } else {
      aggregated.set(key, {
        cmteId,
        candId,
        totalCents: amtCents,
        txCount:    1,
        latestDate: dtStr || null,
      });
    }
  }

  console.log(`    Lines read: ${linesRead.toLocaleString()}`);
  console.log(`    Passed 24K/24Z filter:    ${passedTxType.toLocaleString()}`);
  console.log(`    Passed candidateSet filter: ${passedCand.toLocaleString()}`);
  console.log(`    Passed $200+ filter:       ${passedAmt.toLocaleString()}`);

  try { fs.unlinkSync(txtPath); } catch { /* best effort */ }

  return aggregated;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runFecBulkPipeline(): Promise<PipelineResult> {
  console.log("\n=== FEC bulk data pipeline (public, multi-cycle) ===");
  const logId = await startSync("fec_bulk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  // Cycle list — overridable via FEC_CYCLES env var. Default covers the four
  // most recent biennial cycles so that all current senators (Class I/II/III,
  // 6-year terms) and reps (current term + prior incumbency) appear in at
  // least one cycle. 2026 is the in-progress cycle and may 404 until FEC
  // publishes the first bulk drop — handled gracefully.
  const CYCLES = (process.env.FEC_CYCLES ?? "2020,2022,2024,2026")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`  Cycles to process: ${CYCLES.join(", ")}`);

  // FIX-193: separate knob for the (very expensive) indiv stage. Defaults to
  // FEC_CYCLES so a manual `pnpm data:fec-bulk` still processes indiv for every
  // cycle. The nightly orchestrator narrows this to the active cycle only —
  // closed cycles' indiv files don't change between weekly drops.
  const INDIV_CYCLES = (process.env.FEC_INDIV_CYCLES ?? process.env.FEC_CYCLES ?? CYCLES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const indivCycleSet = new Set(INDIV_CYCLES);
  console.log(`  Indiv cycles:      ${INDIV_CYCLES.join(", ")}`);

  // FIX-700: surgical scope filters for the (expensive) indiv stage. Two axes,
  // each defaulting to full-run behavior when unset (see the header comment):
  //   FEC_INDIV_TX_TYPES — override KEEP_TX_TYPES (default 15,15E,10)
  //   FEC_INDIV_STAGES   — allow-list of indiv sub-stages (default = all)
  // Only the indiv stage is scoped; cn/weball/pas2 always run in full.
  const keepTxTypes = parseKeepTxTypes();
  // FIX-701: recipient-committee allow-list (FEC_INDIV_RECIPIENT_CMTES). Empty ⇒
  // no filter. Parsed once so the log line runs a single time; applied per-cycle
  // to both recipient maps just before streamIndiv.
  const recipientCmtes = parseRecipientCmtes();
  const { set: indivStageSet, unknown: unknownStages } = parseIndivStages();
  if (unknownStages.length > 0) {
    console.warn(
      `  FEC_INDIV_STAGES has unknown stage name(s): ${unknownStages.join(", ")} ` +
        `— valid: ${INDIV_STAGE_NAMES.join(", ")}`,
    );
  }
  const stageOn = (name: IndivStageName): boolean => stageEnabled(indivStageSet, name);
  // A scoped run must NOT overwrite entity aggregate columns — a partial slice
  // (e.g. tx-type 10 only) would clobber a mixed donor's real total. The totals
  // rebuild re-derives the authoritative values afterward (writer.ts).
  const isScoped =
    isIndivTxScoped(keepTxTypes) ||
    isStagesScoped(indivStageSet) ||
    isRecipientScoped(recipientCmtes);
  if (isScoped) {
    console.log(
      `  ⚠ SCOPED RUN — tx_types=[${[...keepTxTypes].join(",")}] ` +
        `stages=[${indivStageSet.size ? [...indivStageSet].join(",") : "all"}] ` +
        `recipient_cmtes=[${recipientCmtes.size ? `${recipientCmtes.size} committee(s)` : "all"}] ` +
        `cycles=[${INDIV_CYCLES.join(", ")}]; entity aggregates will NOT be overwritten — ` +
        `run the totals rebuild after (this run ${stageOn("totals") ? "INCLUDES" : "SKIPS"} the totals stage)`,
    );
  }

  let pacEntitiesUpserted = 0, pacEntitiesFailed = 0;
  let pacRelsUpserted = 0, pacRelsFailed = 0;
  let indivDonorsUpserted = 0, indivDonorsFailed = 0;
  let indivRelsUpserted = 0, indivRelsFailed = 0;
  let indivCmteRelsUpserted = 0, indivCmteRelsFailed = 0; // FIX-236
  // FIX-686 integrity counter: donor→committee rows skipped because an entity id
  // failed to resolve. With the retry+throw writers this must read 0; a nonzero
  // value means a committee/donor entity silently went missing — re-run the cycle.
  let indivCmteSkippedUnresolved = 0;
  let indivCyclesProcessed = 0, indivCyclesSkipped = 0;
  let ieRelsUpserted = 0, ieRelsFailed = 0;               // FIX-240
  let ieSupportRows = 0, ieOpposeRows = 0;                // FIX-240
  let ieSpendersUpserted = 0, ieSpendersOrphaned = 0;     // FIX-240
  let ieSpendersMintedByName = 0;                         // FIX-841 (orphan spe_nam mint)
  let ieCyclesProcessed = 0, ieCyclesSkipped = 0;         // FIX-240
  let ieTargetsResolved = 0, ieTargetsMinted = 0, ieTargetsFailed = 0; // FIX-674
  let matchedByFecId = 0, matchedByName = 0, notMatched = 0;
  let totalFileMb = 0;

  // FIX-181: indiv ingest is on by default; flip to "false" to run PAC-only.
  const INCLUDE_INDIV = (process.env.FEC_INCLUDE_INDIV ?? "true").toLowerCase() !== "false";
  if (!INCLUDE_INDIV) {
    console.log("  FEC_INCLUDE_INDIV=false — skipping individual contributions stage");
  }

  // Cross-cycle accumulators
  const cmteTotalsAllCycles = new Map<string, number>();
  const cmteInfoSeen        = new Map<string, CommitteeInfo>();
  const entityIdByCmteAcc   = new Map<string, string>();
  const newFecIds: Array<{
    officialId: string;
    fecId:      string;
    storageKey: "fec_id" | "fec_candidate_id";
  }> = [];
  const newFecIdSeen = new Set<string>(); // dedup key: `${officialId}|${fecId}`

  // FIX-193: per-cycle Last-Modified watermark for the indiv stage. Keyed by
  // cycle string. Stored as pipeline_state.fec_indiv_watermark, JSONB shape
  // `{ "2024": { last_modified: "<RFC1123>", etag: "..." }, "2026": {...} }`.
  // Watermark is FEC's value (source of truth) — R2 mirror is downstream.
  type IndivWatermark = Record<string, { last_modified: string; etag: string | null }>;
  let indivWatermark: IndivWatermark = {};
  // Pending uploads for the CURRENT cycle. Drained before each per-cycle
  // tmpdir cleanup, since R2 multipart uploads stream from disk and would
  // fail if their source files were unlinked mid-stream.
  let cycleR2Uploads: Array<Promise<boolean>> = [];
  let totalR2UploadsOk = 0;
  let totalR2UploadsAttempted = 0;

  try {
    ensureTmpDir();

    // Load existing indiv watermark (best-effort — empty on first run / missing row).
    try {
      const { data } = await db
        .from("pipeline_state")
        .select("value")
        .eq("key", "fec_indiv_watermark")
        .maybeSingle();
      const v = (data?.value ?? null) as IndivWatermark | null;
      if (v && typeof v === "object") indivWatermark = v;
    } catch {
      // Non-fatal: missing pipeline_state row, RLS hiccup, etc.
    }

    // FIX-754: pending checkpoint/resume state for the indiv stage. Scoped runs
    // bypass the machinery entirely — cursors from a partial slice must not
    // resume into a different scope, and a scoped run must not clobber pending
    // unscoped state (mirrors the FIX-701 watermark bypass).
    let runState: FecBulkRunState | null = null;
    if (!isScoped) {
      runState = await loadRunState(db);
      if (runState) {
        console.log(`  ⟳ Pending fec_bulk_run_state: ${describeRunState(runState)}`);
        // Self-guard: narrow the indiv cycle set to the pending cycle so a
        // multi-cycle manual run can't start a second cycle's indiv work and
        // clobber the single state slot. Other cycles' indiv files are
        // watermark-guarded anyway, so this is behavior-preserving in practice.
        // (The nightly orchestrator narrows the env before invoking us; this
        // guards the standalone `pnpm data:fec-bulk` path.)
        if (indivCycleSet.has(runState.cycle) && indivCycleSet.size > 1) {
          console.log(
            `  ⟳ FIX-754 self-guard: narrowing indiv cycles [${[...indivCycleSet].join(",")}] → ` +
              `[${runState.cycle}] while resume is pending`,
          );
          for (const c of [...indivCycleSet]) {
            if (c !== runState.cycle) indivCycleSet.delete(c);
          }
        }
      }
    }
    // Cycle whose indiv work fully completed this run — gates the end-of-run
    // state clear (after the watermark persist, per the FIX-754 ordering).
    let runStateCompletedCycle: string | null = null;

    // FIX-246: seed jurisdictions + governing bodies for the cn{yy} stage's
    //          candidate-row inserts. Idempotent — re-seed defensively when
    //          fec-bulk runs standalone (orchestrator path already seeds).
    console.log("\n  Seeding jurisdictions + governing bodies (idempotent)...");
    const { federalId, stateIds, warnings: seedWarnings } = await seedJurisdictions(db);
    const governingBodies = await seedGoverningBodies(db, federalId);

    // FIX-246: pre-fetch every officials row carrying any FEC ID (either
    //          fec_candidate_id or a role-prefix-matching fec_id). The cn{yy}
    //          stage skips these so it never overwrites electeds and never
    //          double-inserts candidates across cycles.
    const existingByFecCandId = await loadOfficialsByFecIds(db);
    console.log(`    Officials indexed by FEC ID: ${existingByFecCandId.size}`);
    let totalCandidatesInserted = 0;
    let totalCandidatesMatched  = 0;

    // ── Load officials + match index (once, shared across all cycles) ───────
    console.log("\n  Loading officials and building match index...");
    const officials   = await loadOfficials(db);
    const index       = buildMatchIndex(officials);
    console.log(`    Loaded ${officials.length} active officials`);
    console.log(`    Initial FEC ID index size: ${index.byFecId.size}`);

    // ── Per-cycle loop ──────────────────────────────────────────────────────
    for (const CYCLE of CYCLES) {
      console.log(`\n────────── Cycle ${CYCLE} ──────────`);

      // FIX-754: non-null while this cycle's indiv stage runs with checkpoint
      // machinery active; also read by the IE stage's skip/marker below.
      let cycleActiveState: FecBulkRunState | null = null;

      // Step 1: Download bulk files for this cycle
      console.log(`  [${CYCLE} 1/5] Downloading FEC bulk files...`);
      const bulkFiles = [
        { url:  `https://www.fec.gov/files/bulk-downloads/${CYCLE}/weball${CYCLE.slice(2)}.zip`,
          name: `weball${CYCLE.slice(2)}.zip` },
        { url:  `https://www.fec.gov/files/bulk-downloads/${CYCLE}/cm${CYCLE.slice(2)}.zip`,
          name: `cm${CYCLE.slice(2)}.zip` },
        { url:  `https://www.fec.gov/files/bulk-downloads/${CYCLE}/pas2${CYCLE.slice(2)}.zip`,
          name: `pas2${CYCLE.slice(2)}.zip` },
      ];

      let downloadFailed = false;
      for (const f of bulkFiles) {
        const destPath = path.join(TMP_DIR, f.name);
        console.log(`    Downloading ${f.name}...`);
        try {
          const r2Key = r2KeyFor(CYCLE, f.name);
          const res = await downloadWithR2Cache(f.url, r2Key, destPath, downloadFile);
          const sizeMb = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
          console.log(`    ✓ ${f.name} (${sizeMb} MB, source=${res.source})`);
          if (res.r2UploadPromise) cycleR2Uploads.push(res.r2UploadPromise);
        } catch (err) {
          const msg = errMsg(err);
          console.warn(`    ✗ ${f.name} unavailable: ${msg} — skipping cycle ${CYCLE}`);
          downloadFailed = true;
          break;
        }
      }
      if (downloadFailed) {
        // Common for the in-progress cycle (e.g. 2026 before first FEC drop).
        for (const f of bulkFiles) {
          try { fs.unlinkSync(path.join(TMP_DIR, f.name)); } catch { /* ok */ }
        }
        continue;
      }

      // Step 1b (FIX-246): Ingest FEC candidate master (cn{yy}.zip) before
      // weball matching so candidate rows exist and weball's fec_candidate_id
      // discovery path can resolve against them without going through the
      // name-fallback branch.
      console.log(`  [${CYCLE} 1b/5] Ingesting FEC candidate master (cn${CYCLE.slice(2)}.zip)...`);
      const cnZipName = `cn${CYCLE.slice(2)}.zip`;
      const cnZipPath = path.join(TMP_DIR, cnZipName);
      let cnDownloadOk = true;
      try {
        const r2Key = r2KeyFor(CYCLE, cnZipName);
        const res   = await downloadWithR2Cache(candMasterUrl(CYCLE), r2Key, cnZipPath, downloadFile);
        const sizeMb = (fs.statSync(cnZipPath).size / 1024 / 1024).toFixed(2);
        console.log(`    ✓ ${cnZipName} (${sizeMb} MB, source=${res.source})`);
        if (res.r2UploadPromise) cycleR2Uploads.push(res.r2UploadPromise);
      } catch (err) {
        const msg = errMsg(err);
        console.warn(`    ✗ ${cnZipName} unavailable: ${msg} — continuing without candidate ingest for ${CYCLE}`);
        cnDownloadOk = false;
      }
      if (cnDownloadOk) {
        const candResult = await streamCandidates({
          db,
          zipPath: cnZipPath,
          cycle:   CYCLE,
          tempDir: TMP_DIR,
          existingByFecCandId,
          governingBodies,
          stateJurisdictions: stateIds,
          federalId,
        });
        totalCandidatesInserted += candResult.insertedNew;
        totalCandidatesMatched  += candResult.matchedExisting;
        console.log(
          `    cn${CYCLE.slice(2)}: lines=${candResult.linesRead} ` +
          `new=${candResult.insertedNew} existing=${candResult.matchedExisting} ` +
          `name_updated=${candResult.nameUpdated} ` +
          `no_office=${candResult.skippedNoOffice} failed=${candResult.failed}`,
        );
        // Wire newly-inserted candidate rows into the weball match index so
        // weball matching resolves them via fec_candidate_id this cycle.
        for (const { candId, officialId } of candResult.newInserts) {
          index.byFecId.set(candId, officialId);
        }
        try { fs.unlinkSync(cnZipPath); } catch { /* ok */ }
      }

      // Step 2: Extract + parse weball
      console.log(`  [${CYCLE} 2/5] Extracting and parsing candidate summary...`);
      const weballZip  = path.join(TMP_DIR, `weball${CYCLE.slice(2)}.zip`);
      const extracted  = await extractZip(weballZip, TMP_DIR);
      const weballFile = extracted.find(
        (f) => path.basename(f).toLowerCase().startsWith("weball") && f.endsWith(".txt")
      );
      if (!weballFile) {
        console.warn(`    weball .txt not found in ${weballZip} — skipping cycle ${CYCLE}`);
        continue;
      }
      const weballBuf  = fs.readFileSync(weballFile);
      const weballRows = parseWeBall(weballBuf);
      const cycleMb    = weballBuf.byteLength / 1024 / 1024;
      totalFileMb     += cycleMb;
      console.log(`    Parsed ${weballRows.length} candidate rows (${cycleMb.toFixed(1)} MB)`);

      // Step 3: Match weball → officials, growing index across cycles
      let cycMatchedByFecId = 0, cycMatchedByName = 0, cycNotMatched = 0;
      // FIX-936/FIX-937 — why rows were refused, so the first post-deploy run
      // shows the refusal mix instead of one opaque "not matched" count.
      const refusals = newMatchRefusalStats();
      for (const row of weballRows) {
        const match = matchRow(row, index, refusals);
        if (!match) { cycNotMatched++; continue; }
        if (match.byFecId) {
          cycMatchedByFecId++;
        } else {
          cycMatchedByName++;
          // Effectively non-clobbering (FIX-960): match.fecId === row.candId,
          // and matchRow only reaches its name fallback after step 1 found NO
          // byFecId binding for row.candId — a bound CAND_ID short-circuits as
          // a byFecId match and never lands in this branch.
          index.byFecId.set(match.fecId, match.officialId);
          const dedupKey = `${match.officialId}|${match.fecId}`;
          if (!newFecIdSeen.has(dedupKey)) {
            newFecIdSeen.add(dedupKey);
            newFecIds.push({ officialId: match.officialId, fecId: match.fecId, storageKey: "fec_id" });
          }
        }
      }
      matchedByFecId += cycMatchedByFecId;
      matchedByName  += cycMatchedByName;
      notMatched     += cycNotMatched;
      console.log(`    Matched by fec_id: ${cycMatchedByFecId}  by name: ${cycMatchedByName}  not matched: ${cycNotMatched}`);
      console.log(`    ${describeMatchRefusals(refusals)}`);

      // Name-fallback for officials with no stored FEC ID at all. Re-run per
      // cycle — a senator who didn't run in 2024 may appear in 2020/2022's
      // weball under their incumbent committee. Extracted (FIX-960) — it
      // excludes merge stubs and never overwrites an existing byFecId binding.
      const fallbackBound = perCycleNameFallback(officials, weballRows, index);
      for (const { officialId, fecId } of fallbackBound) {
        const dedupKey = `${officialId}|${fecId}`;
        if (!newFecIdSeen.has(dedupKey)) {
          newFecIdSeen.add(dedupKey);
          newFecIds.push({ officialId, fecId, storageKey: "fec_candidate_id" });
        }
      }
      if (fallbackBound.length > 0) {
        console.log(`    Name fallback matched: ${fallbackBound.length} additional officials`);
      }

      const candidateSet = new Set<string>(index.byFecId.keys());

      // Step 4: Parse cm + stream pas2
      console.log(`  [${CYCLE} 3/5] Building PAC committee index and streaming contributions...`);
      const cmZip       = path.join(TMP_DIR, `cm${CYCLE.slice(2)}.zip`);
      const cmExtracted = await extractZip(cmZip, TMP_DIR);
      const cmFile      = cmExtracted.find(
        (f) => path.basename(f).toLowerCase().startsWith("cm") && f.endsWith(".txt")
      );
      if (!cmFile) {
        console.warn(`    cm .txt not found in ${cmZip} — skipping cycle ${CYCLE}`);
        continue;
      }
      const cmLookup = parseCm24(fs.readFileSync(cmFile));
      console.log(`    Committee master: ${cmLookup.size.toLocaleString()} committees indexed`);
      // Merge into cross-cycle map (later cycles override — keep freshest committee name)
      for (const [cmteId, info] of cmLookup.entries()) {
        cmteInfoSeen.set(cmteId, info);
      }

      console.log(`    Streaming pas2 (filtering to ${candidateSet.size} known fec_ids)...`);
      const pasZip  = path.join(TMP_DIR, `pas2${CYCLE.slice(2)}.zip`);
      const pacAggs = await streamPas224(pasZip, candidateSet);
      console.log(`    PAC pairs matched (committee × candidate): ${pacAggs.size.toLocaleString()}`);

      // Step 5: Upsert entities + relationships for this cycle
      console.log(`  [${CYCLE} 4/5] Upserting entities + relationships...`);

      // Cycle-local committee totals (used as initial total_donated_cents;
      // the cross-cycle final pass below will overwrite with the proper sum)
      const cycleCmteTotals = new Map<string, number>();
      for (const agg of pacAggs.values()) {
        cycleCmteTotals.set(agg.cmteId, (cycleCmteTotals.get(agg.cmteId) ?? 0) + agg.totalCents);
        cmteTotalsAllCycles.set(
          agg.cmteId,
          (cmteTotalsAllCycles.get(agg.cmteId) ?? 0) + agg.totalCents,
        );
      }

      const entityInputs = [];
      for (const [cmteId, totalCents] of cycleCmteTotals.entries()) {
        const info = cmLookup.get(cmteId);
        if (!info) continue;
        entityInputs.push({
          cmteId,
          name:              info.name,
          cmteType:          info.type,
          connectedOrg:      info.connectedOrg,
          totalDonatedCents: totalCents,
        });
      }

      const entityResult = await upsertPacEntitiesBatch(entityInputs);
      pacEntitiesUpserted += entityResult.upserted;
      pacEntitiesFailed   += entityResult.failed;
      for (const [cmteId, id] of entityResult.entityIdByCmte.entries()) {
        entityIdByCmteAcc.set(cmteId, id);
      }
      console.log(`    Entities — upserted: ${entityResult.upserted}  failed: ${entityResult.failed}`);

      const relInputs = [];
      for (const agg of pacAggs.values()) {
        const entityId = entityIdByCmteAcc.get(agg.cmteId);
        if (!entityId) continue;
        const officialId = index.byFecId.get(agg.candId);
        if (!officialId) continue;
        relInputs.push({
          fromEntityId: entityId,
          toOfficialId: officialId,
          cycleYear:    parseInt(CYCLE, 10),
          amountCents:  agg.totalCents,
          occurredAt:   agg.latestDate ? parseFecDate(agg.latestDate) : null,
          cmteId:       agg.cmteId,
          txCount:      agg.txCount,
        });
      }

      const relResult = await upsertDonationRelationshipsBatch(relInputs);
      pacRelsUpserted += relResult.upserted;
      pacRelsFailed   += relResult.failed;
      console.log(`    Relationships — upserted: ${relResult.upserted}  failed: ${relResult.failed}`);

      // Step 5: individual contributions (indiv{yy}.zip + ccl{yy}.zip) — FIX-181
      // Tolerant of FEC outages on these files: if either download fails, log
      // and continue with PAC-only data for the cycle. Indiv files may also be
      // unpublished for a not-yet-closed cycle (e.g. mid-2026).
      //
      // FIX-193 gates (in order):
      //   1. FEC_INDIV_CYCLES — env knob. Defaults to FEC_CYCLES, but cron
      //      narrows to the active cycle only to avoid the 80M-row churn on
      //      closed cycles whose indiv file hasn't moved.
      //   2. Last-Modified watermark — HEAD the FEC indiv URL; if unchanged
      //      since the last successful pipeline run, skip the cycle's indiv
      //      stage entirely (no download, no streaming, no upsert).
      if (INCLUDE_INDIV && !indivCycleSet.has(CYCLE)) {
        console.log(`  [${CYCLE} 5/6] Indiv stage skipped — cycle not in FEC_INDIV_CYCLES`);
        indivCyclesSkipped++;
      }
      if (INCLUDE_INDIV && indivCycleSet.has(CYCLE)) {
        const yy        = CYCLE.slice(2);
        const cclName   = `ccl${yy}.zip`;
        const indivName = `indiv${yy}.zip`;
        const cclUrl    = `https://www.fec.gov/files/bulk-downloads/${CYCLE}/${cclName}`;
        const indivUrl  = `https://www.fec.gov/files/bulk-downloads/${CYCLE}/${indivName}`;
        const cclPath   = path.join(TMP_DIR, cclName);
        const indivPath = path.join(TMP_DIR, indivName);

        let indivFailed     = false;
        let indivFecHead:   FecHead | null = null;
        console.log(`  [${CYCLE} 5/6] Individual contributions stage (FIX-181)...`);

        // FIX-193 layer 2: watermark short-circuit. HEAD FEC; if Last-Modified
        // is unchanged from the stored watermark, skip the whole stage. We
        // tolerate HEAD failures (null head → fall through to download path,
        // which is the pre-FIX-193 behavior).
        //
        // FIX-701: a SCOPED run (tx-type / stage / recipient-committee filter)
        // is an EXPLICIT surgical re-ingest — its intent is to re-capture rows
        // regardless of whether FEC's file moved. A closed cycle's indiv file
        // never changes again, so the freshness watermark would ALWAYS short-
        // circuit a scoped re-run into a silent no-op — which is exactly what
        // defeated the first 2024 D/B re-capture dispatch (the indiv stage was
        // skipped, so zero D/B rows were restored). Bypass the watermark whenever
        // isScoped; the un-scoped nightly still short-circuits as before.
        const headProbe = await headFecFile(indivUrl);
        const stored    = indivWatermark[CYCLE];
        const probeLm   = parseLastModified(headProbe?.lastModified);
        const storedLm  = parseLastModified(stored?.last_modified);
        const watermarkUnchanged = !!(probeLm && storedLm && probeLm.getTime() <= storedLm.getTime());
        if (watermarkUnchanged && !isScoped) {
          console.log(
            `    ↺ Indiv ${indivName} unchanged since last run ` +
            `(FEC Last-Modified ${headProbe?.lastModified} ≤ watermark ${stored?.last_modified}) — skipping cycle ${CYCLE}`,
          );
          // indivFailed routes us into the existing `else { indivCyclesSkipped++ }`
          // branch at the bottom of the indiv block — single source of truth for
          // the skipped counter avoids double-counting.
          indivFailed = true;
        } else if (watermarkUnchanged && isScoped) {
          console.log(
            `    ⇢ Indiv ${indivName} unchanged since last run, but SCOPED run — ` +
            `bypassing the FIX-193 watermark to re-ingest cycle ${CYCLE} (FIX-701)`,
          );
        }

        // FIX-754: stale bookkeeping — the watermark already covers this cycle
        // but the state was never cleared (kill landed between the watermark
        // persist and the state clear). Clear it here so the nightly
        // orchestrator stops re-triggering resume runs.
        if (indivFailed && runState?.cycle === CYCLE) {
          console.log(
            `    ⟳ clearing fec_bulk_run_state — watermark already current for cycle ${CYCLE} (FIX-754)`,
          );
          await clearRunState(db);
          runState = null;
        }

        // FIX-754: resume plan for this cycle. Identity = FEC HEAD Last-Modified
        // vs the stored state — see run-state.ts for the decision table.
        let indivStateSkip = false;
        if (!indivFailed && !isScoped && runState) {
          const plan = planCycleResume(runState, CYCLE, headProbe?.lastModified ?? null);
          if (plan === "resume" || plan === "skip-indiv") {
            cycleActiveState = runState;
            console.log(
              `    ⟳ RESUMING fec_bulk cycle=${CYCLE} (FIX-754): ${describeRunState(runState)}`,
            );
            if (plan === "skip-indiv") {
              // Every indiv writer stage landed in a prior run — skip
              // download/extract/stream entirely; only the IE stage, totals,
              // and the watermark persist remain.
              indivStateSkip = true;
              indivWatermark[CYCLE] = {
                last_modified: runState.fec_last_modified,
                etag:          runState.fec_etag,
              };
              runStateCompletedCycle = CYCLE;
              console.log(
                `    ⟳ all indiv writer stages complete — skipping download/stream for cycle ${CYCLE}`,
              );
            }
          } else if (plan === "stale") {
            console.warn(
              `    ⟳ fec_bulk_run_state is stale — FEC published a new drop ` +
                `(stored "${runState.fec_last_modified}" vs FEC "${headProbe?.lastModified}"); ` +
                `discarding and starting cycle ${CYCLE} fresh (FIX-754)`,
            );
            await clearRunState(db);
            runState = null;
          } else if (plan === "unverifiable") {
            console.warn(
              `    ⟳ FEC HEAD failed — cannot verify fec_bulk_run_state identity; running ` +
                `cycle ${CYCLE} WITHOUT checkpointing (state kept for a later verifiable run) (FIX-754)`,
            );
          }
          // plan === "other-cycle": the state belongs to a different cycle; this
          // cycle runs un-checkpointed so the single state slot isn't clobbered.
        }

        if (!indivFailed && !indivStateSkip) {
          console.log(`    Downloading ${cclName}...`);
          try {
            const r2KeyCcl = r2KeyFor(CYCLE, cclName);
            const res = await downloadWithR2Cache(cclUrl, r2KeyCcl, cclPath, downloadFile);
            const sizeMb = (fs.statSync(cclPath).size / 1024 / 1024).toFixed(2);
            console.log(`    ✓ ${cclName} (${sizeMb} MB, source=${res.source})`);
            if (res.r2UploadPromise) cycleR2Uploads.push(res.r2UploadPromise);
          } catch (err) {
            const msg = errMsg(err);
            console.warn(`    ✗ ${cclName} unavailable: ${msg} — skipping indiv stage`);
            indivFailed = true;
          }
        }

        if (!indivFailed && !indivStateSkip) {
          console.log(`    Downloading ${indivName} (~2 GB)...`);
          try {
            const r2KeyIndiv = r2KeyFor(CYCLE, indivName);
            const res = await downloadWithR2Cache(indivUrl, r2KeyIndiv, indivPath, downloadFile);
            const sizeMb = (fs.statSync(indivPath).size / 1024 / 1024).toFixed(0);
            console.log(`    ✓ ${indivName} (${sizeMb} MB, source=${res.source})`);
            totalFileMb += parseFloat(sizeMb);
            indivFecHead = res.fecHead ?? headProbe;
            if (res.r2UploadPromise) cycleR2Uploads.push(res.r2UploadPromise);
          } catch (err) {
            const msg = errMsg(err);
            console.warn(`    ✗ ${indivName} unavailable: ${msg} — skipping indiv stage`);
            indivFailed = true;
          }
        }

        // FIX-754: re-verify identity against the download's own HEAD — closes
        // the rare race where FEC publishes between the resume probe and the GET.
        if (
          cycleActiveState && !indivStateSkip && !indivFailed &&
          !sameLastModified(cycleActiveState.fec_last_modified, indivFecHead?.lastModified)
        ) {
          console.warn(
            `    ⟳ downloaded ${indivName} Last-Modified "${indivFecHead?.lastModified}" != ` +
              `state "${cycleActiveState.fec_last_modified}" — discarding state, running cycle ${CYCLE} fresh (FIX-754)`,
          );
          await clearRunState(db);
          runState = null;
          cycleActiveState = null;
        }

        // FIX-961: the indiv stage's aggregates live in gzip'd sort files under
        // TMP_DIR. Hoisted so the finally below reclaims that disk on EVERY
        // exit path — including a writer stage throwing mid-cycle, which the
        // catch swallows so the run can continue to the next cycle.
        let indivDisposable: { dispose(): Promise<void> } | null = null;

        if (indivStateSkip) {
          // FIX-754 fast path: prior run already landed every indiv writer
          // stage; nothing streamed or upserted this run.
          indivCyclesSkipped++;
        } else if (!indivFailed) {
          try {
            // Parse ccl: build CMTE_ID → CAND_ID lookup, then narrow to committees
            // owned by candidates in our index.byFecId.
            const cclExtracted = await extractZip(cclPath, TMP_DIR);
            const cclTxt       = cclExtracted.find(
              (f) => path.basename(f).toLowerCase().startsWith("ccl") && f.endsWith(".txt"),
            );
            if (!cclTxt) {
              console.warn(`    ccl .txt not found in ${cclName} — skipping indiv stage`);
            } else {
              const cclLookupAll = parseCcl(fs.readFileSync(cclTxt));
              // Filter to only committees whose CAND_ID is in our candidateSet
              const cmteToCand = new Map<string, string>();
              for (const [cmteId, candId] of cclLookupAll.entries()) {
                if (candidateSet.has(candId)) cmteToCand.set(cmteId, candId);
              }
              console.log(`    ccl: ${cclLookupAll.size.toLocaleString()} all committees, ${cmteToCand.size.toLocaleString()} mapped to our candidates`);

              // FIX-236 + FIX-698: build the non-candidate-committee recipient
              // set (super PAC / party / other PAC, excluding the JFC/leadership
              // designations that would double-count). See
              // buildNonCandRecipientSet for the full rationale.
              const nonCandCmtes = buildNonCandRecipientSet(cmLookup, cmteToCand);
              console.log(`    Non-candidate committees to capture (super PAC + party + other PAC + leadership/SSF, excl. JFC): ${nonCandCmtes.size.toLocaleString()}`);

              // FIX-701: narrow both recipient maps to FEC_INDIV_RECIPIENT_CMTES
              // when set (the 2024 D/B re-capture passes the D/B committee list).
              // No-op when the allow-list is empty.
              if (recipientCmtes.size > 0) {
                const candBefore = cmteToCand.size, nonCandBefore = nonCandCmtes.size;
                const { candKept, nonCandKept } = applyRecipientCmteScope(cmteToCand, nonCandCmtes, recipientCmtes);
                console.log(
                  `    FEC_INDIV_RECIPIENT_CMTES scope: ${recipientCmtes.size} committee(s) allow-listed — ` +
                    `cand recipients ${candBefore}→${candKept}, non-cand recipients ${nonCandBefore}→${nonCandKept}`,
                );
              }

              if (cmteToCand.size === 0 && nonCandCmtes.size === 0) {
                console.warn("    No committees mapped to candidates or non-cand recipients — skipping indiv stage");
              } else {
                const indivResult = await streamIndiv(indivPath, cmteToCand, candidateSet, nonCandCmtes, TMP_DIR, keepTxTypes);
                indivDisposable = indivResult;

                // FIX-754: establish fresh checkpoint state (resume runs arrive
                // here with cycleActiveState already set). Requires a verifiable
                // file identity — mirrors the watermark's non-null-LM rule. The
                // !runState guard keeps another cycle's pending state (and the
                // "unverifiable" mode) from being clobbered.
                if (!isScoped && !cycleActiveState && !runState && indivFecHead?.lastModified) {
                  cycleActiveState = createRunState(CYCLE, indivFecHead.lastModified, indivFecHead.etag ?? null);
                  runState = cycleActiveState;
                  await saveRunState(db, cycleActiveState);
                  console.log(
                    `    ⟳ checkpoint state established for cycle ${CYCLE} (lm="${indivFecHead.lastModified}") (FIX-754)`,
                  );
                }

                // FIX-754 helpers: per-chunk cursor persistence + stage markers.
                // No-ops when the checkpoint machinery is inactive (scoped run,
                // unverifiable identity, another cycle's state pending).
                // FIX-996: per-stage checkpoint cadence + accounting. The
                // throttle is keyed by stage so each cursored writer gets its
                // own window and its own counters for the stage-end summary.
                const checkpointThrottles = new Map<CursoredStage, CheckpointThrottle>();
                const stageResume = (stage: CursoredStage): WriterResume | undefined => {
                  const st = cycleActiveState;
                  if (!st) return undefined;
                  const throttle = newCheckpointThrottle();
                  checkpointThrottles.set(stage, throttle);
                  return {
                    progress: st.stages[stage],
                    onProgress: async (processedRows, totalRows, client) => {
                      // The cursor is updated on EVERY chunk — bulkUpsert's
                      // every-chunk contract is load-bearing for FIX-754's
                      // accounting (decision: throttle the WRITE, never the
                      // hook). Only the persist is rate-limited.
                      updateStageCursor(st, stage, processedRows, totalRows);
                      const stageDone = processedRows >= totalRows;
                      if (!shouldPersistCheckpoint(throttle, Date.now(), stageDone)) {
                        throttle.stats.throttled++;
                        return;
                      }
                      throttle.stats.attempted++;
                      // best-effort — warns, never throws. Rides `client` (the
                      // live direct-pg connection) when the writer supplied one.
                      const ok = await saveRunState(db, st, client);
                      if (ok) {
                        throttle.stats.saved++;
                        throttle.lastSavedAtMs = Date.now();
                      } else {
                        throttle.stats.failed++;
                      }
                    },
                  };
                };
                const completeStage = async (stage: TrackedStage): Promise<void> => {
                  if (!cycleActiveState) return;
                  markStageComplete(cycleActiveState, stage);
                  await saveRunState(db, cycleActiveState);
                  // FIX-957: the durable half. Reached only after the stage's
                  // writer returned without throwing, so a killed or partial
                  // stage never advances its stamp. See run-state.ts for why
                  // this lives under its own pipeline_state key rather than in
                  // the (deliberately ephemeral) resume state.
                  await saveCycleStageWatermark(
                    db, CYCLE, stage, cycleActiveState.fec_last_modified,
                  );
                  // FIX-996: one summary line per cursored stage. The
                  // 2026-08-03..08-08 investigation had to derive save cadence
                  // from cursor arithmetic because nothing counted them.
                  const throttle = checkpointThrottles.get(stage as CursoredStage);
                  if (throttle && throttle.stats.attempted > 0) {
                    console.log(`    [${stage}] ${describeCheckpointStats(throttle.stats)}`);
                  }
                };

                // Per-cycle donor rows: meta + the donor's total across BOTH
                // recipient routes (a donor who gives to a candidate AND a
                // super PAC counts both toward total_donated_cents).
                //
                // FIX-961: the join now happens inside the indiv stage. The
                // external path merge-joins two fingerprint-sorted files, so
                // the `cycleDonorTotals` Map that used to be built here — one
                // entry per donor, ~1.9M on a presidential cycle — is gone.
                // FIX-995's donorMetas release is likewise subsumed: nothing
                // holds a meta map any more.
                const donorInputs = [];
                for await (const d of indivResult.readDonorInputs()) donorInputs.push(d);

                // FIX-700 stage: donor-entities. Skipping it leaves
                // donorIdByFingerprint empty, so the two indiv relationship
                // stages below resolve no from_id (they log skipped_unresolved).
                // For the type-10 finish this stage runs.
                let donorResult: Awaited<ReturnType<typeof upsertIndividualDonorsBatch>> = {
                  upserted: 0,
                  failed: 0,
                  donorIdByFingerprint: new Map<string, string>(),
                };
                if (stageOn("donor-entities") && cycleActiveState && stageIsComplete(cycleActiveState, "donor-entities")) {
                  // FIX-754: prior run landed every donor — rebuild the id map
                  // via batched direct-pg reads instead of re-upserting 780k rows.
                  console.log(
                    `    ⟳ [donor-entities] complete in prior run — rebuilding donor id map ` +
                      `via direct-pg read (${donorInputs.length.toLocaleString()} fingerprints) (FIX-754)...`,
                  );
                  donorResult = {
                    upserted: 0,
                    failed:   0,
                    donorIdByFingerprint: await fetchDonorIdsByFingerprint(donorInputs.map((d) => d.fingerprint)),
                  };
                  console.log(
                    `    ⟳ [donor-entities] resolved ${donorResult.donorIdByFingerprint.size.toLocaleString()}` +
                      `/${donorInputs.length.toLocaleString()} fingerprints`,
                  );
                } else if (stageOn("donor-entities")) {
                  console.log(`    Upserting ${donorInputs.length.toLocaleString()} individual donor entities...`);
                  // isScoped ⇒ omit total_donated_cents/total_received_cents so a
                  // partial-slice run doesn't clobber existing donor aggregates.
                  donorResult = await upsertIndividualDonorsBatch(donorInputs, isScoped, stageResume("donor-entities"));
                  indivDonorsUpserted += donorResult.upserted;
                  indivDonorsFailed   += donorResult.failed;
                  console.log(`    Donors — upserted: ${donorResult.upserted}  failed: ${donorResult.failed}`);
                  // FIX-754: a cursor-resumed upsert only RETURNs ids from the
                  // start offset on — backfill the rows the prior run committed
                  // so the two relationship stages can resolve every from_id.
                  if (cycleActiveState && donorResult.donorIdByFingerprint.size < donorInputs.length) {
                    const missing = donorInputs
                      .map((d) => d.fingerprint)
                      .filter((fp) => !donorResult.donorIdByFingerprint.has(fp));
                    if (missing.length > 0) {
                      console.log(
                        `    ⟳ [donor-entities] backfilling ${missing.length.toLocaleString()} donor ids ` +
                          `committed by the prior run (FIX-754)...`,
                      );
                      const fetched = await fetchDonorIdsByFingerprint(missing);
                      for (const [fp, id] of fetched) donorResult.donorIdByFingerprint.set(fp, id);
                    }
                  }
                  await completeStage("donor-entities");
                } else {
                  console.log(`    [donor-entities] — skipped (not in FEC_INDIV_STAGES)`);
                }

                // FIX-700 stage: indiv-to-candidate. (A tx-type-10-only run yields
                // no candidate-path rows — type 10 flows to super PACs — so this
                // stage upserts 0 in the FIX-677 finish, harmlessly.)
                if (stageOn("indiv-to-candidate") && cycleActiveState && stageIsComplete(cycleActiveState, "indiv-to-candidate")) {
                  console.log(`    ⟳ [indiv-to-candidate] complete in prior run — skipping (FIX-754)`);
                } else if (stageOn("indiv-to-candidate")) {
                  // Build relationship inputs — one per (donor × candidate × cycle)
                  const indivRelInputs: IndividualDonationInput[] = [];
                  for await (const agg of indivResult.readAggregations()) {
                    const fromEntityId = donorResult.donorIdByFingerprint.get(agg.donorFingerprint);
                    if (!fromEntityId) continue;
                    const toOfficialId = index.byFecId.get(agg.candId);
                    if (!toOfficialId) continue;
                    indivRelInputs.push({
                      fromEntityId,
                      toOfficialId,
                      cycleYear:        parseInt(CYCLE, 10),
                      amountCents:      agg.totalCents,
                      occurredAt:       agg.latestDate ? parseFecDate(agg.latestDate) : null,
                      donorFingerprint: agg.donorFingerprint,
                      txCount:          agg.txCount,
                    });
                  }

                  console.log(`    Upserting ${indivRelInputs.length.toLocaleString()} individual → candidate donation relationships...`);
                  const indivRelResult = await upsertIndividualDonationsBatch(indivRelInputs, stageResume("indiv-to-candidate"));
                  indivRelsUpserted += indivRelResult.upserted;
                  indivRelsFailed   += indivRelResult.failed;
                  console.log(`    Donations (→ candidate) — upserted: ${indivRelResult.upserted}  failed: ${indivRelResult.failed}`);
                  await completeStage("indiv-to-candidate");
                } else {
                  console.log(`    [indiv-to-candidate] — skipped (not in FEC_INDIV_STAGES)`);
                }

                // ── FIX-236: donor → non-candidate committee donations ──
                // Pre-upsert the recipient committee entities so we can
                // resolve cmteId → entityId. upsertPacEntitiesBatch uses
                // ON CONFLICT (fec_committee_id), so committees already
                // touched by the pas2 path are updated idempotently.
                //
                // We DO NOT roll indiv-inflow into total_donated_cents.
                // The existing convention (set by the pas2 path) is that
                // total_donated_cents = outflow this entity sent to others.
                // Indiv-inflow is the *received* side for super PACs and
                // semantically belongs in total_received_cents (currently
                // unused; future FIX can populate it). Setting inflow=0
                // here means a pure-IE super PAC ranks low by amount in
                // search, but it surfaces by name, and clicking through
                // shows the donor relationships correctly.
                //
                // For committees that ALSO appeared in pas2, the cross-
                // cycle final pass at the bottom of this function uses
                // `cmteTotalsAllCycles` (pas2-derived) as the source of
                // truth and overwrites whatever this pre-upsert set —
                // so any totalDonatedCents value here for a dual-mode PAC
                // is transient.
                const cmteEntityInputs = [];
                const seenInflowCmtes  = new Set<string>();
                for await (const agg of indivResult.readCommitteeAggregations()) {
                  if (seenInflowCmtes.has(agg.cmteId)) continue;
                  seenInflowCmtes.add(agg.cmteId);
                  const info = cmLookup.get(agg.cmteId);
                  if (!info) continue;
                  cmteEntityInputs.push({
                    cmteId:            agg.cmteId,
                    name:              info.name,
                    cmteType:          info.type,
                    connectedOrg:      info.connectedOrg,
                    totalDonatedCents: 0,
                  });
                  // Remember the committee info so the cross-cycle pass
                  // has it for committees never seen by pas2 (would
                  // otherwise be skipped by the `if (!info) continue;`
                  // check at the final pass).
                  if (!cmteInfoSeen.has(agg.cmteId)) cmteInfoSeen.set(agg.cmteId, info);
                }

                // FIX-700 stage: recipient-entities. The cmteInfoSeen seeding above
                // is intentionally OUTSIDE the gate — the cross-cycle final pass
                // and IE stage depend on it. Only the upsert (which populates
                // entityIdByCmteAcc, the to_id source for indiv-to-committee) is
                // gated. isScoped ⇒ omit aggregate columns (skip-overwrite).
                if (stageOn("recipient-entities") && cycleActiveState && stageIsComplete(cycleActiveState, "recipient-entities")) {
                  // FIX-754: prior run pre-upserted the recipient committees —
                  // rebuild the cmte→entity id map the indiv-to-committee stage
                  // resolves to_id from, without re-running the upsert.
                  if (cmteEntityInputs.length > 0) {
                    console.log(
                      `    ⟳ [recipient-entities] complete in prior run — rebuilding ` +
                        `${cmteEntityInputs.length.toLocaleString()} committee ids via direct-pg read (FIX-754)...`,
                    );
                    const fetched = await fetchEntityIdsByCmteId(cmteEntityInputs.map((i) => i.cmteId));
                    for (const [cmteId, id] of fetched) entityIdByCmteAcc.set(cmteId, id);
                    console.log(
                      `    ⟳ [recipient-entities] resolved ${fetched.size.toLocaleString()}` +
                        `/${cmteEntityInputs.length.toLocaleString()} committees`,
                    );
                  }
                } else if (stageOn("recipient-entities")) {
                  if (cmteEntityInputs.length > 0) {
                    console.log(`    Pre-upserting ${cmteEntityInputs.length.toLocaleString()} non-candidate-committee recipient entities...`);
                    const cmteEntityResult = await upsertPacEntitiesBatch(cmteEntityInputs, isScoped);
                    pacEntitiesUpserted += cmteEntityResult.upserted;
                    pacEntitiesFailed   += cmteEntityResult.failed;
                    for (const [cmteId, id] of cmteEntityResult.entityIdByCmte.entries()) {
                      entityIdByCmteAcc.set(cmteId, id);
                    }
                    console.log(`    Recipient committees — upserted: ${cmteEntityResult.upserted}  failed: ${cmteEntityResult.failed}`);
                  }
                  await completeStage("recipient-entities");
                } else {
                  console.log(`    [recipient-entities] — skipped (not in FEC_INDIV_STAGES)`);
                }

                // FIX-700 stage: indiv-to-committee. This is the path that lands
                // the FIX-677 super-PAC (type-10) receipts — the finish's target.
                if (stageOn("indiv-to-committee") && cycleActiveState && stageIsComplete(cycleActiveState, "indiv-to-committee")) {
                  console.log(`    ⟳ [indiv-to-committee] complete in prior run — skipping (FIX-754)`);
                } else if (stageOn("indiv-to-committee")) {
                  const indivCmteRelInputs: IndividualToCommitteeDonationInput[] = [];
                  for await (const agg of indivResult.readCommitteeAggregations()) {
                    const fromEntityId = donorResult.donorIdByFingerprint.get(agg.donorFingerprint);
                    if (!fromEntityId) { indivCmteSkippedUnresolved++; continue; } // FIX-686
                    const toEntityId = entityIdByCmteAcc.get(agg.cmteId);
                    if (!toEntityId) { indivCmteSkippedUnresolved++; continue; } // FIX-686
                    indivCmteRelInputs.push({
                      fromEntityId,
                      toEntityId,
                      cycleYear:        parseInt(CYCLE, 10),
                      amountCents:      agg.totalCents,
                      occurredAt:       agg.latestDate ? parseFecDate(agg.latestDate) : null,
                      donorFingerprint: agg.donorFingerprint,
                      cmteId:           agg.cmteId,
                      txCount:          agg.txCount,
                    });
                  }

                  console.log(`    Upserting ${indivCmteRelInputs.length.toLocaleString()} individual → committee donation relationships...`);
                  const indivCmteRelResult = await upsertIndividualToCommitteeDonationsBatch(indivCmteRelInputs, stageResume("indiv-to-committee"));
                  indivCmteRelsUpserted += indivCmteRelResult.upserted;
                  indivCmteRelsFailed   += indivCmteRelResult.failed;
                  console.log(`    Donations (→ committee) — upserted: ${indivCmteRelResult.upserted}  failed: ${indivCmteRelResult.failed}`);
                  console.log(`    Donations (→ committee) — skipped_unresolved: ${indivCmteSkippedUnresolved} (FIX-686; should be 0)`);
                  await completeStage("indiv-to-committee");
                } else {
                  console.log(`    [indiv-to-committee] — skipped (not in FEC_INDIV_STAGES)`);
                }

                // FIX-193 watermark advance: record the FEC Last-Modified we
                // just successfully processed. Next run sees this and short-
                // circuits if FEC hasn't published a newer drop. Only update
                // when we have a non-null Last-Modified — falling back to
                // never-watermark is safer than recording an empty value.
                if (indivFecHead?.lastModified) {
                  indivWatermark[CYCLE] = {
                    last_modified: indivFecHead.lastModified,
                    etag:          indivFecHead.etag,
                  };
                }

                // FIX-754: the cycle's indiv writer work is fully landed — the
                // end-of-run block persists the watermark then clears the state.
                if (cycleActiveState) runStateCompletedCycle = CYCLE;

                indivCyclesProcessed++;
              }
            }
          } catch (err) {
            const msg = errMsg(err);
            console.warn(`    indiv stage failed: ${msg} — continuing without indiv data for cycle ${CYCLE}`);
            indivCyclesSkipped++;
          } finally {
            // FIX-961: reclaim the cycle's sort files before the next cycle
            // extracts its own ~13 GB indiv text into the same TMP_DIR.
            if (indivDisposable) {
              try { await indivDisposable.dispose(); } catch { /* best effort */ }
              indivDisposable = null;
            }
          }
        } else {
          indivCyclesSkipped++;
        }
      }

      // Step 6: Independent expenditures (Schedule E) — FIX-240
      // ~19 MB CSV per cycle, plain comma-delimited with a header row
      // (different from the pipe-delimited TXTs everywhere else in FEC).
      // Closes the super-PAC → candidate trail that pas2 (24K/24Z direct
      // contributions) misses because IE-only super PACs never appear in
      // pas2. Tolerant of FEC outages: failure here is logged and the
      // cycle still wraps up cleanly with PAC + indiv data already landed.
      console.log(`  [${CYCLE} 6/7] Independent expenditures (Schedule E) stage...`);
      if (!stageOn("independent-expenditures")) {
        console.log(`    [independent-expenditures] — skipped (not in FEC_INDIV_STAGES)`);
      } else if (cycleActiveState && stageIsComplete(cycleActiveState, "independent-expenditures")) {
        // FIX-754: a kill can land between the IE stage and the end-of-run
        // watermark persist — the marker keeps the resumed run from re-running IE.
        console.log(`    ⟳ [independent-expenditures] complete in prior run — skipping for cycle ${CYCLE} (FIX-754)`);
        ieCyclesSkipped++;
      } else {
        const ieName = `independent_expenditure_${CYCLE}.csv`;
        const ieUrl  = `https://www.fec.gov/files/bulk-downloads/${CYCLE}/${ieName}`;
        const iePath = path.join(TMP_DIR, ieName);

        let ieFailed = false;
        try {
          const r2KeyIe = r2KeyFor(CYCLE, ieName);
          const res = await downloadWithR2Cache(ieUrl, r2KeyIe, iePath, downloadFile);
          const sizeMb = (fs.statSync(iePath).size / 1024 / 1024).toFixed(1);
          console.log(`    ✓ ${ieName} (${sizeMb} MB, source=${res.source})`);
          totalFileMb += parseFloat(sizeMb);
          if (res.r2UploadPromise) cycleR2Uploads.push(res.r2UploadPromise);
        } catch (err) {
          const msg = errMsg(err);
          console.warn(`    ✗ ${ieName} unavailable: ${msg} — skipping IE stage for cycle ${CYCLE}`);
          ieFailed = true;
        }

        if (!ieFailed) {
          try {
            const ieResult = await streamIndependentExpenditures(iePath, candidateSet, {
              collectUnmatched:    true, // FIX-674
              collectSpenderNames: true, // FIX-841 — mint orphan spenders from spe_nam
            });

            // FIX-674: resolve-or-mint the unmatched IE targets, then merge
            // their aggregations back into the write set. Without this the money
            // whose target cand_id isn't a matched official (~6% of valid IE $,
            // 13% in 2020) is silently dropped. resolveOrMintIeTargets reuses an
            // existing official when the exact id already lives on one (incl.
            // inactive rows), else mints a tier='candidate' row keyed on
            // fec_candidate_id — dedup-safe across cycles.
            if (ieResult.unmatchedAggregations && ieResult.unmatchedAggregations.size > 0) {
              const targetById = new Map<string, IeTargetIdentity>();
              for (const agg of ieResult.unmatchedAggregations.values()) {
                if (!targetById.has(agg.candId)) {
                  targetById.set(agg.candId, {
                    candId:     agg.candId,
                    candName:   agg.candName,
                    candOffice: agg.candOffice,
                    candState:  agg.candState,
                  });
                }
              }
              const mintResult = await resolveOrMintIeTargets({
                db,
                targets:            [...targetById.values()],
                existingByFecCandId,
                governingBodies,
                stateJurisdictions: stateIds,
                federalId,
              });
              ieTargetsResolved += mintResult.resolved;
              ieTargetsMinted   += mintResult.minted;
              ieTargetsFailed   += mintResult.failed;
              console.log(
                `    IE targets — resolved: ${mintResult.resolved}  minted: ${mintResult.minted}  failed: ${mintResult.failed}`,
              );
              // Wire resolved+minted targets into the match index so the writer
              // loop below resolves them, and fold the unmatched aggregations
              // into the main set so they flow through spender pre-upsert + write.
              for (const [candId, officialId] of mintResult.candIdToOfficialId) {
                index.byFecId.set(candId, officialId);
              }
              for (const [key, agg] of ieResult.unmatchedAggregations) {
                if (!ieResult.aggregations.has(key)) ieResult.aggregations.set(key, agg);
              }
            }

            // Surface new spenders that pas2/cm/indiv never touched. The
            // canonical case is IE-only super PACs whose only money flow
            // is Schedule E spending — no pas2 contributions, no indiv
            // inflow within our matched-candidate set. Pre-upsert them
            // here so we can resolve cmteId → entityId for the writer.
            const newSpenderIds = new Set<string>();
            for (const agg of ieResult.aggregations.values()) {
              if (!entityIdByCmteAcc.has(agg.spendingCmteId)) {
                newSpenderIds.add(agg.spendingCmteId);
              }
            }

            if (newSpenderIds.size > 0) {
              // FIX-841: first non-empty spe_nam per new-spender id, for the
              // orphan (∉ cm) mint fallback below.
              const nameBySpe = new Map<string, string>();
              for (const agg of ieResult.aggregations.values()) {
                const nm = (agg.spenderName ?? "").trim();
                if (nm && newSpenderIds.has(agg.spendingCmteId) && !nameBySpe.has(agg.spendingCmteId)) {
                  nameBySpe.set(agg.spendingCmteId, nm);
                }
              }

              const newSpenderInputs = [];
              const orphanNameInputs: Array<{ cmteId: string; name: string }> = []; // FIX-841
              let orphanCount = 0;
              for (const cmteId of newSpenderIds) {
                const info = cmteInfoSeen.get(cmteId);
                if (info) {
                  newSpenderInputs.push({
                    cmteId,
                    name:              info.name,
                    cmteType:          info.type,
                    connectedOrg:      info.connectedOrg,
                    // total_donated_cents kept at 0 — the cross-cycle final
                    // pass below uses cmteTotalsAllCycles (pas2-derived) as
                    // truth, same convention as the FIX-236 pre-upsert.
                    totalDonatedCents: 0,
                  });
                  continue;
                }
                // FIX-841: orphan spe_id (∉ cm). Mint a name-only entity from
                // spe_nam when mintable (non-empty, not a known prankster name)
                // instead of dropping the money.
                const nm = (nameBySpe.get(cmteId) ?? "").trim();
                if (isMintableSpenderName(nm)) { orphanNameInputs.push({ cmteId, name: nm }); continue; }
                orphanCount++; // blank OR denylisted prankster name
              }
              console.log(
                `    New IE spenders to pre-upsert: ${newSpenderInputs.length}` +
                (orphanNameInputs.length > 0 ? ` (+${orphanNameInputs.length} orphan minted from spe_nam)` : "") +
                (orphanCount > 0 ? ` (${orphanCount} orphan spe_id(s) missing from cm AND spe_nam — skipped)` : ""),
              );
              ieSpendersOrphaned += orphanCount;

              if (newSpenderInputs.length > 0) {
                const spenderResult = await upsertPacEntitiesBatch(newSpenderInputs);
                pacEntitiesUpserted += spenderResult.upserted;
                pacEntitiesFailed   += spenderResult.failed;
                ieSpendersUpserted  += spenderResult.upserted;
                for (const [cmteId, id] of spenderResult.entityIdByCmte.entries()) {
                  entityIdByCmteAcc.set(cmteId, id);
                }
              }

              if (orphanNameInputs.length > 0) {
                // FIX-841: name-only mint keyed on spe_id, provenance
                // source='schedule_e_spe_nam'; totals left at DEFAULT 0.
                const orphanResult = await upsertIeSpenderEntitiesByName(orphanNameInputs);
                pacEntitiesUpserted    += orphanResult.upserted;
                ieSpendersUpserted     += orphanResult.upserted;
                ieSpendersMintedByName += orphanResult.upserted;
                for (const [cmteId, id] of orphanResult.entityIdByCmte.entries()) {
                  entityIdByCmteAcc.set(cmteId, id);
                }
              }
            }

            // Build IE writer inputs from aggregations
            const ieInputs: IndependentExpenditureInput[] = [];
            for (const agg of ieResult.aggregations.values()) {
              const fromEntityId = entityIdByCmteAcc.get(agg.spendingCmteId);
              if (!fromEntityId) continue;
              const toOfficialId = index.byFecId.get(agg.candId);
              if (!toOfficialId) continue;
              ieInputs.push({
                fromEntityId,
                toOfficialId,
                cycleYear:      parseInt(CYCLE, 10),
                amountCents:    agg.totalCents,
                occurredAt:     agg.latestDate,
                supportOppose:  agg.supportOppose,
                spendingCmteId: agg.spendingCmteId,
                txCount:        agg.txCount,
              });
              if (agg.supportOppose === "S") ieSupportRows++;
              else                            ieOpposeRows++;
            }

            console.log(`    Upserting ${ieInputs.length.toLocaleString()} IE relationships (S: ${ieSupportRows}, O: ${ieOpposeRows})...`);
            const ieWriteResult = await upsertIndependentExpendituresBatch(ieInputs);
            ieRelsUpserted += ieWriteResult.upserted;
            ieRelsFailed   += ieWriteResult.failed;
            console.log(`    IE relationships — upserted: ${ieWriteResult.upserted}  failed: ${ieWriteResult.failed}`);

            ieCyclesProcessed++;

            // FIX-754: mark IE done for this cycle so a kill during totals /
            // the watermark persist doesn't re-run it on resume.
            if (cycleActiveState) {
              markStageComplete(cycleActiveState, "independent-expenditures");
              await saveRunState(db, cycleActiveState);
              // FIX-957 — same success-only stamp as completeStage(); this site
              // is outside that helper's scope, which is exactly the shape of
              // enumeration gap FIX-960 was filed for.
              await saveCycleStageWatermark(
                db, CYCLE, "independent-expenditures", cycleActiveState.fec_last_modified,
              );
            }
          } catch (err) {
            const msg = errMsg(err);
            console.warn(`    IE stage failed: ${msg} — continuing without IE data for cycle ${CYCLE}`);
            ieCyclesSkipped++;
          }
        } else {
          ieCyclesSkipped++;
        }
      }

      // Drain any in-flight R2 cache uploads for this cycle before nuking
      // its temp files — `Upload` streams from disk; unlinking mid-upload
      // fails on Windows and is racy on Linux.
      if (cycleR2Uploads.length > 0) {
        console.log(`    Awaiting ${cycleR2Uploads.length} R2 cache upload(s) for cycle ${CYCLE}...`);
        const results = await Promise.all(cycleR2Uploads);
        const ok = results.filter(Boolean).length;
        console.log(`    R2 uploads: ${ok}/${cycleR2Uploads.length} ok`);
        totalR2UploadsOk        += ok;
        totalR2UploadsAttempted += cycleR2Uploads.length;
        cycleR2Uploads = [];
      }

      // Step 7: cleanup cycle-specific temp files (keeps disk under ~3GB
      // peak with indiv enabled — pas2 + indiv + cm + weball + ccl + IE per cycle)
      console.log(`  [${CYCLE} 7/7] Cleaning up cycle ${CYCLE} temp files...`);
      for (const f of fs.readdirSync(TMP_DIR)) {
        try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch { /* ok */ }
      }
    } // end per-cycle loop

    // ── Persist newly discovered FEC IDs ────────────────────────────────────
    // FIX-759: server-side jsonb merge (writer.ts persistNewFecIds), not the
    // old client spread off the pipeline-START officials snapshot — that was a
    // stale read-modify-write that dropped any source_ids key another writer
    // merged in mid-run.
    if (newFecIds.length > 0) {
      console.log(`\n  Storing ${newFecIds.length} FEC ID associations across cycles...`);
      await withDirectClient((client) => persistNewFecIds(client, newFecIds));
    }

    // ── Cross-cycle entity total recompute ──────────────────────────────────
    // Per-cycle upserts wrote each cycle's local total to total_donated_cents,
    // so the last-cycle-processed value is what's currently in the row. Final
    // pass overwrites with the SUM across every cycle observed in this run.
    console.log("\n  Recomputing financial_entities.total_donated_cents across all cycles...");
    const finalEntityInputs = [];
    for (const [cmteId, totalCents] of cmteTotalsAllCycles.entries()) {
      const info = cmteInfoSeen.get(cmteId);
      if (!info) continue;
      finalEntityInputs.push({
        cmteId,
        name:              info.name,
        cmteType:          info.type,
        connectedOrg:      info.connectedOrg,
        totalDonatedCents: totalCents,
      });
    }
    const finalResult = await upsertPacEntitiesBatch(finalEntityInputs);
    console.log(`    Cross-cycle entity totals — upserted: ${finalResult.upserted}  failed: ${finalResult.failed}`);

    // ── FIX-700 stage: totals — end-of-run authoritative aggregate recomputes ─
    // Gateable via FEC_INDIV_STAGES. After ANY scoped relationship-writing run
    // this MUST run (here, or a later standalone rebuild) — it re-derives the
    // aggregates the writers deliberately left un-overwritten. The cross-cycle
    // finalResult upsert above is NOT part of this gate (it is pas2's own inline
    // recompute, itself corrected by these SQL rebuilds).
    if (stageOn("totals")) {
    // ── Cross-cycle individual-donor total recompute (FIX-269) ──────────────
    // Per-cycle indiv upsert overwrites total_donated_cents (onConflict on
    // donor_fingerprint), so multi-cycle donors carry only the last cycle's
    // slice. SQL recompute UPDATEs every entity with its live SUM of donation
    // outflow from financial_relationships, covering candidate AND committee
    // recipients (FIX-181 + FIX-236) in one pass. Excludes ie_support/
    // ie_oppose/contract/grant/lobbying — only relationship_type='donation'
    // counts toward this column. Pattern mirrors rebuild_official_donation_totals.
    // ── total_donated_cents / total_received_cents: MOVED to pg_cron (FIX-702/726) ─
    // The heavy full-table rebuilds (rebuild_financial_entity_donation_totals /
    // _received_totals) that used to run HERE saturated Pro Small during the
    // FIX-701 re-capture → live-site RPC timeouts (the FIX-726 incident). Both are
    // now incremental, dirty-scoped, chunked+committed pg_cron jobs aggregating
    // financial_relationships directly:
    //   * financial-entity-totals-incremental  (weekly, Tue) — dirty from_id /
    //     to_id only, per-chunk COMMIT, bounded work_mem;
    //   * financial-entity-totals-reconcile    (monthly)     — hard-delete sweep.
    // See supabase/migrations/20260704000000_fix702_726_incremental_financial_
    // entity_totals.sql. The old SQL functions remain as break-glass full
    // rebuilds; only these pipeline calls are removed so the FEC phase stays light.

    // ── IE (Schedule E) total recompute (FIX-666) ───────────────────────────
    // total_donated_cents deliberately excludes ie_support/ie_oppose, so IE-only
    // super PACs need their own materialized totals (total_ie_support_cents /
    // total_ie_oppose_cents) for the search + donor-page read surfaces. Same
    // direct-pg lift as the donation recompute. Advisory — a failure here leaves
    // stale IE totals the next cycle recomputes; it must not abort the pipeline.
    console.log("\n  Recomputing financial_entities IE (Schedule E) totals from live financial_relationships...");
    try {
      await runHeavyRebuild("rebuild_financial_entity_ie_totals");
      console.log("    ✓ IE support/oppose totals recomputed from financial_relationships");
    } catch (rebuildErr) {
      console.warn(`    rebuild_financial_entity_ie_totals failed: ${errMsg(rebuildErr)}`);
    }

    // total_received_cents (FIX-675) is likewise handled by the FIX-702/726
    // pg_cron jobs above — the to_id mirror of the donation total, same weekly
    // incremental + monthly reconcile. No inline rebuild here.
    } else {
      console.log(
        "\n  [totals] — skipped (not in FEC_INDIV_STAGES); IE totals rebuild " +
          "(rebuild_financial_entity_ie_totals) not run. Donation/received totals " +
          "are maintained out-of-band by the financial-entity-totals pg_cron jobs " +
          "(FIX-702/726).",
      );
    }

    // ── Persist indiv Last-Modified watermark (FIX-193) ─────────────────────
    let watermarkPersisted = false;
    if (Object.keys(indivWatermark).length > 0) {
      try {
        await db
          .from("pipeline_state")
          .upsert(
            {
              key:        "fec_indiv_watermark",
              value:      indivWatermark,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "key" },
          );
        watermarkPersisted = true;
        console.log(`  Persisted indiv watermark for cycles: ${Object.keys(indivWatermark).join(", ")}`);
      } catch (err) {
        const msg = errMsg(err);
        console.warn(`  Failed to persist indiv watermark: ${msg}`);
      }
    }

    // ── Clear checkpoint state (FIX-754) ────────────────────────────────────
    // Ordering: final stage completes → watermark persisted → state cleared.
    // A failed watermark persist keeps the state so the next nightly retries
    // the (cheap) completion path instead of stranding an unpersisted advance.
    if (runStateCompletedCycle) {
      if (watermarkPersisted) {
        await clearRunState(db);
        console.log(`  ⟳ Cleared fec_bulk_run_state — cycle ${runStateCompletedCycle} complete (FIX-754)`);
      } else {
        console.warn(
          `  ⟳ cycle ${runStateCompletedCycle} complete but the watermark persist failed — ` +
            `keeping fec_bulk_run_state so the next nightly retries (FIX-754)`,
        );
      }
    }

    // R2 cache upload summary (FIX-192) — per-cycle uploads were drained
    // inside the cycle loop above; this is just the final tally.
    if (totalR2UploadsAttempted > 0) {
      console.log(`  R2 cache uploads (cumulative): ${totalR2UploadsOk}/${totalR2UploadsAttempted} ok`);
    }

    // ── Final cleanup + report ──────────────────────────────────────────────
    deleteTmpDir();

    const totalUpserted =
      pacEntitiesUpserted + pacRelsUpserted + finalResult.upserted +
      indivDonorsUpserted + indivRelsUpserted + indivCmteRelsUpserted +
      ieRelsUpserted + totalCandidatesInserted;
    const totalFailed =
      pacEntitiesFailed + pacRelsFailed + finalResult.failed +
      indivDonorsFailed + indivRelsFailed + indivCmteRelsFailed +
      ieRelsFailed;

    console.log("\n  ──────────────────────────────────────────────────");
    console.log("  FEC Bulk Pipeline Report (multi-cycle)");
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${"Cycles processed:".padEnd(38)} ${CYCLES.join(", ")}`);
    console.log(`  ${"Officials matched by fec_id:".padEnd(38)} ${matchedByFecId}`);
    console.log(`  ${"Officials matched by name:".padEnd(38)} ${matchedByName}`);
    console.log(`  ${"Officials not matched:".padEnd(38)} ${notMatched}`);
    console.log(`  ${"Candidate officials inserted:".padEnd(38)} ${totalCandidatesInserted}`);
    console.log(`  ${"Candidate officials existing:".padEnd(38)} ${totalCandidatesMatched}`);
    console.log(`  ${"PAC entity upserts (per-cycle):".padEnd(38)} ${pacEntitiesUpserted}`);
    console.log(`  ${"PAC entity failures:".padEnd(38)} ${pacEntitiesFailed}`);
    console.log(`  ${"PAC entity upserts (cross-cycle):".padEnd(38)} ${finalResult.upserted}`);
    console.log(`  ${"PAC relationships upserted:".padEnd(38)} ${pacRelsUpserted}`);
    console.log(`  ${"PAC relationships failed:".padEnd(38)} ${pacRelsFailed}`);
    if (INCLUDE_INDIV) {
      console.log(`  ${"Indiv cycles processed / skipped:".padEnd(38)} ${indivCyclesProcessed} / ${indivCyclesSkipped}`);
      console.log(`  ${"Indiv donor entities upserted:".padEnd(38)} ${indivDonorsUpserted}`);
      console.log(`  ${"Indiv donor entity failures:".padEnd(38)} ${indivDonorsFailed}`);
      console.log(`  ${"Indiv → cand rels upserted:".padEnd(38)} ${indivRelsUpserted}`);
      console.log(`  ${"Indiv → cand rels failed:".padEnd(38)} ${indivRelsFailed}`);
      console.log(`  ${"Indiv → cmte rels upserted:".padEnd(38)} ${indivCmteRelsUpserted}`);
      console.log(`  ${"Indiv → cmte rels failed:".padEnd(38)} ${indivCmteRelsFailed}`);
      console.log(`  ${"Indiv → cmte skipped_unresolved:".padEnd(38)} ${indivCmteSkippedUnresolved} (FIX-686; done-gate: 0)`);
    }
    console.log(`  ${"IE cycles processed / skipped:".padEnd(38)} ${ieCyclesProcessed} / ${ieCyclesSkipped}`);
    console.log(`  ${"IE new spenders pre-upserted:".padEnd(38)} ${ieSpendersUpserted}`);
    console.log(`  ${"IE orphan spenders minted (spe_nam):".padEnd(38)} ${ieSpendersMintedByName}`); // FIX-841
    console.log(`  ${"IE targets resolved/minted/failed:".padEnd(38)} ${ieTargetsResolved} / ${ieTargetsMinted} / ${ieTargetsFailed}`); // FIX-674
    console.log(`  ${"IE orphan spe_ids skipped:".padEnd(38)} ${ieSpendersOrphaned}`);
    console.log(`  ${"IE → cand rels upserted (S+O):".padEnd(38)} ${ieRelsUpserted}`);
    console.log(`  ${"IE → cand rels failed:".padEnd(38)} ${ieRelsFailed}`);
    console.log(`  ${"IE support / oppose split:".padEnd(38)} ${ieSupportRows} / ${ieOpposeRows}`);
    console.log(`  ${"Financial data processed:".padEnd(38)} ~${totalFileMb.toFixed(1)} MB`);

    // Sanity check — top 10 PAC donors by total contributed (cross-cycle)
    // reads-ok: end-of-run console report; an empty result prints nothing and must not fail the sync
    const { data: top10pacs } = await db
      .from("financial_entities")
      .select("display_name, total_donated_cents")
      .order("total_donated_cents", { ascending: false })
      .limit(10);

    if (top10pacs && top10pacs.length > 0) {
      console.log("\n  Top 10 PAC donors (cross-cycle):");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of top10pacs as any[]) {
        const name = String(row.display_name ?? "Unknown").padEnd(52);
        const amt  = `$${(Number(row.total_donated_cents) / 100).toLocaleString()}`;
        console.log(`    ${name} ${amt}`);
      }
    }

    // Sanity check — federal Senate coverage (the main FIX-178 metric)
    // reads-ok: end-of-run console report; an empty result prints nothing and must not fail the sync
    const { data: senatorRows } = await db
      .from("officials")
      .select("id, full_name, source_ids")
      .eq("is_active", true)
      .eq("role_title", "Senator")
      .limit(200);

    if (senatorRows && senatorRows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fedSenators = (senatorRows as any[]).filter((s) => s.source_ids?.congress_gov);
      // Per-senator existence probe — avoids PostgREST's 1000-row default cap
      // truncating a naive .in() + .select("to_id") query when senators with
      // hundreds of donations exhaust the page before less-funded senators are
      // sampled. ~100 round-trips. FIX-511: the metric only needs "has ≥1
      // donation", so a LIMIT 1 probe replaces the prior exact head-count,
      // which walked every (donation → senator) index entry plus heap
      // visibility checks per senator on the cache-starved Pro instance
      // (COUNT→EXISTS precedent: FIX-345).
      let withDonations = 0;
      let probeErrors = 0;
      for (const s of fedSenators) {
        const { data: probe, error: probeError } = await db
          .from("financial_relationships")
          .select("id")
          .eq("relationship_type", "donation")
          .eq("to_type", "official")
          .eq("to_id", s.id as string)
          .limit(1);
        // A gateway blip mid-loop must not silently read as "senator has no
        // donations" — that undercounts the FIX-178 coverage metric in a way
        // that looks legit. Count errors and flag them on the printed line.
        if (probeError) {
          probeErrors++;
          continue;
        }
        if ((probe ?? []).length > 0) withDonations++;
      }
      console.log(
        `\n  Senate coverage: ${withDonations}/${fedSenators.length} federal senators have ≥1 donation` +
        (probeErrors > 0 ? ` (${probeErrors} probe error(s) — coverage undercounted)` : ""),
      );
    }

    const result: PipelineResult = {
      inserted: totalUpserted,
      updated:  0,
      failed:   totalFailed,
      estimatedMb: totalFileMb,
      seed_warnings: seedWarnings.length > 0 ? seedWarnings : undefined,
    };
    await completeSync(logId, result);
    return result;

  } catch (err) {
    const msg = errMsg(err);
    console.error("  FEC bulk pipeline fatal error:", msg);
    deleteTmpDir(); // best-effort cleanup even on error
    await failSync(logId, msg);
    return {
      inserted: pacEntitiesUpserted + pacRelsUpserted,
      updated:  0,
      failed:   pacEntitiesFailed   + pacRelsFailed,
      estimatedMb: 0,
      fatal_error: msg, // FIX-727: standalone entrypoint exits 1 on this
    };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runFecBulkPipeline()
    .then((result) => {
      // FIX-727: a caught fatal (failSync fired) must not exit 0 — the GHA step
      // (fec-backfill.yml / nightly fec-phase) would show a failed run green.
      // Keep the graceful 500ms cleanup delay either way.
      if (result.fatal_error) {
        console.error(`Pipeline failed (fatal): ${result.fatal_error}`);
        setTimeout(() => process.exit(1), 500);
      } else {
        setTimeout(() => process.exit(0), 500);
      }
    })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
