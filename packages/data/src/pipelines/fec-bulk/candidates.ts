/**
 * FEC candidate master (cn{yy}.zip) ingestion. FIX-246.
 *
 * Streams the FEC candidate master file line-by-line and inserts new
 * `tier='candidate'` rows into the `officials` table for every FEC candidate
 * (House/Senate/Pres) not already represented as an elected official or a
 * prior candidate.
 *
 * Idempotency: dedup key is `officials.source_ids->>'fec_candidate_id'`.
 * Existing elected officials matched via `source_ids->>'fec_candidate_id'`
 * are never overwritten — the weball matching path is the source of truth
 * for adding fec_candidate_id to incumbent records.
 *
 * cn file column layout (pipe-delimited, latin1):
 *   0 CAND_ID, 1 CAND_NAME, 2 CAND_PTY_AFFILIATION, 3 CAND_ELECTION_YR,
 *   4 CAND_OFFICE_ST, 5 CAND_OFFICE (H/S/P), 6 CAND_OFFICE_DISTRICT,
 *   7 CAND_ICI, 8 CAND_STATUS, 9 CAND_PCC,
 *   10 CAND_ST1, 11 CAND_ST2, 12 CAND_CITY, 13 CAND_ST, 14 CAND_ZIP
 */

import * as fs       from "fs";
import * as path     from "path";
import * as readline from "readline";

import type { createAdminClient, Database } from "@civitics/db";
import { extractZipEntryToDisk, parseFecName } from "./util";

type AdminDb = ReturnType<typeof createAdminClient>;
type PartyEnum = Database["public"]["Enums"]["party"];

// Until Database types are regenerated post-migration, augment the Insert type
// with the new `tier` column. Drop the intersection after the next generation
// pass.
type OfficialInsert = Database["public"]["Tables"]["officials"]["Insert"] & {
  tier?: string;
};

const CAND_COL = {
  CAND_ID:               0,
  CAND_NAME:             1,
  CAND_PTY_AFFILIATION:  2,
  CAND_ELECTION_YR:      3,
  CAND_OFFICE_ST:        4,
  CAND_OFFICE:           5,
  CAND_OFFICE_DISTRICT:  6,
  CAND_ICI:              7,
  CAND_STATUS:           8,
  CAND_PCC:              9,
} as const;

const BATCH_SIZE = 500;

export interface CandidateStreamOptions {
  db:                  AdminDb;
  zipPath:             string;
  cycle:               string;
  tempDir:             string;
  /**
   * Mutable map of every officials row that already carries a
   * fec_candidate_id (elected or candidate). Updated in place after each
   * successful insert so a CAND_ID appearing in multiple cycles is only
   * inserted once.
   */
  existingByFecCandId: Map<string, { officialId: string; tier: string }>;
  governingBodies:     { senateId: string; houseId: string; presidencyId: string };
  /** Postal-code → jurisdiction UUID. */
  stateJurisdictions:  Map<string, string>;
  federalId:           string;
}

export interface CandidateStreamResult {
  linesRead:       number;
  matchedExisting: number;
  insertedNew:     number;
  skippedNoOffice: number;
  failed:          number;
  /** Newly-inserted (CAND_ID → officials.id) pairs from this run. Caller can
   *  push these into the weball match index so downstream matching resolves
   *  them via fec_candidate_id without going through the name fallback. */
  newInserts:      Array<{ candId: string; officialId: string }>;
}

function mapFecParty(code: string): PartyEnum | null {
  const c = (code || "").trim().toUpperCase();
  if (!c) return null;
  if (c === "DEM")                return "democrat" as PartyEnum;
  if (c === "REP")                return "republican" as PartyEnum;
  if (c === "IND")                return "independent" as PartyEnum;
  if (c === "LIB")                return "libertarian" as PartyEnum;
  if (c === "GRE" || c === "GP")  return "green" as PartyEnum;
  return "other" as PartyEnum;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function formatFecName(candName: string): { full: string; first: string; last: string } {
  const { last, first } = parseFecName(candName);
  const f = first ? titleCase(first) : "";
  const l = last  ? titleCase(last)  : "";
  const full = [f, l].filter(Boolean).join(" ").trim() || candName.trim();
  return { full, first: f, last: l };
}

function roleTitleFor(office: string): string | null {
  if (office === "H") return "Candidate for Representative";
  if (office === "S") return "Candidate for Senator";
  if (office === "P") return "Candidate for President";
  return null;
}

function governingBodyFor(
  office: string,
  gb: { senateId: string; houseId: string; presidencyId: string },
): string | null {
  if (office === "H") return gb.houseId;
  if (office === "S") return gb.senateId;
  if (office === "P") return gb.presidencyId;
  return null;
}

interface PendingRow {
  candId: string;
  row:    OfficialInsert;
}

async function flushBatch(
  db:         AdminDb,
  pending:    PendingRow[],
  existing:   Map<string, { officialId: string; tier: string }>,
  newInserts: Array<{ candId: string; officialId: string }>,
): Promise<{ inserted: number; failed: number }> {
  if (pending.length === 0) return { inserted: 0, failed: 0 };

  const rows = pending.map((p) => p.row);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await db.from("officials").insert(rows as any).select("id, source_ids");
  if (error) {
    console.error(`    candidate insert failed (${pending.length} rows): ${error.message}`);
    return { inserted: 0, failed: pending.length };
  }

  for (const inserted of data ?? []) {
    const sids = (inserted.source_ids ?? {}) as Record<string, string>;
    const candId = sids["fec_candidate_id"];
    if (candId) {
      const officialId = inserted.id as string;
      existing.set(candId, { officialId, tier: "candidate" });
      newInserts.push({ candId, officialId });
    }
  }

  return { inserted: (data?.length ?? pending.length), failed: 0 };
}

export async function streamCandidates(opts: CandidateStreamOptions): Promise<CandidateStreamResult> {
  const result: CandidateStreamResult = {
    linesRead:       0,
    matchedExisting: 0,
    insertedNew:     0,
    skippedNoOffice: 0,
    failed:          0,
    newInserts:      [],
  };

  const yy = opts.cycle.slice(2);
  const txtPath = path.join(opts.tempDir, `cn-${yy}-extracted.txt`);
  const found = await extractZipEntryToDisk(
    opts.zipPath,
    (name) => name.startsWith("cn") && name.endsWith(".txt"),
    txtPath,
  );
  if (!found) {
    console.warn(`    cn${yy}: no .txt entry found inside zip; skipping`);
    return result;
  }

  const txtMb = (fs.statSync(txtPath).size / 1024 / 1024).toFixed(1);
  console.log(`    cn${yy}: extracted ${txtMb} MB — streaming line by line...`);

  const rl = readline.createInterface({
    input:     fs.createReadStream(txtPath, { encoding: "latin1" }),
    crlfDelay: Infinity,
  });

  const pending: PendingRow[] = [];
  const seenThisRun = new Set<string>();

  for await (const line of rl) {
    result.linesRead++;
    if (!line.trim()) continue;

    const cols = line.split("|");
    const candId   = (cols[CAND_COL.CAND_ID]   ?? "").trim();
    const candName = (cols[CAND_COL.CAND_NAME] ?? "").trim();
    const office   = (cols[CAND_COL.CAND_OFFICE] ?? "").trim().toUpperCase();
    if (!candId || !candName) continue;

    if (office !== "H" && office !== "S" && office !== "P") {
      result.skippedNoOffice++;
      continue;
    }

    if (opts.existingByFecCandId.has(candId) || seenThisRun.has(candId)) {
      result.matchedExisting++;
      continue;
    }
    seenThisRun.add(candId);

    const officeSt = (cols[CAND_COL.CAND_OFFICE_ST]       ?? "").trim().toUpperCase();
    const district = (cols[CAND_COL.CAND_OFFICE_DISTRICT] ?? "").trim();
    const party    = (cols[CAND_COL.CAND_PTY_AFFILIATION] ?? "").trim();
    const status   = (cols[CAND_COL.CAND_STATUS]          ?? "").trim();
    const ici      = (cols[CAND_COL.CAND_ICI]             ?? "").trim();
    const electYr  = (cols[CAND_COL.CAND_ELECTION_YR]     ?? "").trim();
    const pcc      = (cols[CAND_COL.CAND_PCC]             ?? "").trim();

    const { full, first, last } = formatFecName(candName);
    const governingBodyId = governingBodyFor(office, opts.governingBodies);
    if (!governingBodyId) continue; // unreachable given office check

    const jurisdictionId = office === "P"
      ? opts.federalId
      : (opts.stateJurisdictions.get(officeSt) ?? opts.federalId);

    const districtName =
      office === "H" && district && district !== "00" ? district : null;

    const row: OfficialInsert = {
      governing_body_id: governingBodyId,
      jurisdiction_id:   jurisdictionId,
      full_name:         full,
      first_name:        first || null,
      last_name:         last  || null,
      role_title:        roleTitleFor(office)!,
      party:             mapFecParty(party),
      district_name:     districtName,
      is_active:         true,
      is_verified:       false,
      tier:              "candidate",
      source_ids:        { fec_candidate_id: candId },
      metadata: {
        state:               officeSt,
        cand_status:         status || null,
        cand_ici:            ici    || null,
        fec_election_yr:     electYr ? Number(electYr) : null,
        principal_committee: pcc    || null,
        source:              "fec_bulk_cn",
        cycle:               opts.cycle,
      },
    };

    pending.push({ candId, row });

    if (pending.length >= BATCH_SIZE) {
      const { inserted, failed } = await flushBatch(opts.db, pending, opts.existingByFecCandId, result.newInserts);
      result.insertedNew += inserted;
      result.failed      += failed;
      pending.length = 0;
    }
  }

  if (pending.length > 0) {
    const { inserted, failed } = await flushBatch(opts.db, pending, opts.existingByFecCandId, result.newInserts);
    result.insertedNew += inserted;
    result.failed      += failed;
    pending.length = 0;
  }

  try { fs.unlinkSync(txtPath); } catch { /* best-effort cleanup */ }

  return result;
}

/**
 * Pre-fetch every officials row carrying any FEC ID — either as
 * `source_ids->>'fec_candidate_id'` (set by this stage on prior runs) OR as
 * `source_ids->>'fec_id'` (set by the weball matching path on incumbents).
 *
 * For `fec_id`, the prefix must match the official's current role: S* for
 * Senators, H* for Representatives, P* for Presidents. Mismatched prefixes
 * represent old IDs from a prior race and would pollute the dedup map
 * (mirroring the convention in `buildMatchIndex` upstream).
 *
 * The returned map is what the cn{yy} stage consults to skip CAND_IDs that
 * already point at an officials row.
 */
export async function loadOfficialsByFecIds(
  db: AdminDb,
): Promise<Map<string, { officialId: string; tier: string }>> {
  const map = new Map<string, { officialId: string; tier: string }>();
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from("officials")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select("id, tier, role_title, source_ids" as any)
      .or("source_ids->>fec_candidate_id.not.is.null,source_ids->>fec_id.not.is.null")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`loadOfficialsByFecIds: ${error.message}`);
    const rows = (data ?? []) as unknown as Array<{
      id:          string;
      tier?:       string | null;
      role_title:  string;
      source_ids:  Record<string, string>;
    }>;
    for (const r of rows) {
      const tier   = r.tier ?? "elected";
      const candId = r.source_ids?.["fec_candidate_id"];
      if (candId) map.set(candId, { officialId: r.id, tier });

      const fecId = r.source_ids?.["fec_id"];
      if (fecId) {
        const prefix = fecId[0]?.toUpperCase() ?? "";
        const role   = r.role_title ?? "";
        const isSen  = role.includes("Senator");
        const isRep  = role.includes("Representative");
        const isPres = role.includes("President");
        if ((isSen && prefix === "S") || (isRep && prefix === "H") || (isPres && prefix === "P")) {
          // Don't clobber an existing fec_candidate_id mapping — that one is
          // more authoritative (set by an explicit cn{yy} ingestion). Only
          // insert when no fec_candidate_id was already recorded for this ID.
          if (!map.has(fecId)) map.set(fecId, { officialId: r.id, tier });
        }
      }
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return map;
}
