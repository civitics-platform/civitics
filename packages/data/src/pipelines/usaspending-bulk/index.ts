/**
 * USASpending bulk archive pipeline — supersedes the paginated API approach.
 *
 * Downloads pre-built annual award archives from:
 *   https://files.usaspending.gov/award_data_archive/
 *
 * Two categories supported:
 *   - "contracts"   → procurement contracts (FY{year}_All_Contracts_*.zip)
 *   - "assistance"  → grants & financial assistance (FY{year}_All_Assistance_*.zip)
 *
 * Advantages over the legacy paginated API approach (removed in FIX-224):
 *   - All agencies (not just the hardcoded top 20)
 *   - All award sizes (no $1M minimum)
 *   - All awards in the FY (not just top 100 per agency)
 *   - Static files — no rate limits, no async polling
 *
 * Strategy:
 *   - First run (no prior baseline): Full file FY{year}_All_{Category}_Full_{YYYYMMDD}.zip
 *   - Subsequent runs: Delta files since last completed archive date. Delta
 *     mode never lists the Fulls (FIX-1274 C3).
 *   - Each archive — Full OR Delta — holds MULTIPLE 1,000,000-row CSV parts
 *     inside one zip (FY2026 contracts Full = 3 parts, assistance = 4; the
 *     2026-09-24 contracts DELTA = 5 parts, 1.45 GB); ./zip.ts enumerates every
 *     part and we process them one at a time (FIX-766). Taking only the first
 *     part was a silent ~1/N truncation latent since inception.
 *   - Filters rows to agencies present in public.agencies (by name match)
 *   - resolveRecipients + upsertSpendingRelationshipsBatch live in ./writer.ts
 *   - Dedup key: contract_award_unique_key / assistance_award_unique_key
 *   - For assistance, filters to grant-shaped assistance_type_codes (02/03/04/05/11);
 *     loans, insurance, and direct payments are skipped because the
 *     financial_relationships enum has no row for them.
 *
 * State: pipeline_state.usaspending_bulk_state (DB, JSONB per-category — FIX-739;
 *        see ./state.ts). Was a runner-local .usaspending-bulk-state.json that
 *        died with each ephemeral CI runner, so every dispatch re-ran Full and
 *        delta mode was dead in CI. Each DB holds its own state; a one-time lift
 *        migrates the legacy file's active-env slice on first run. EVERY run —
 *        Full or Delta (FIX-1274) — checkpoints per completed CSV part, so a
 *        killed or dial-stopped invocation resumes the same archive instead of
 *        restarting from part 1.
 *
 * FIX-1274 / FIX-1291 — a prod writer that can run for hours is made visible
 * and stoppable (ENGINEERING_PLAYBOOK rule C9):
 *   - the dials (./flags.ts): --category, --max-parts, --max-minutes,
 *     --gate-wait-s, --breather-s, --keep-archive, --local-archive;
 *   - the box gate: box_backoff_gate('usaspending-bulk', N) before each part and
 *     at every 100k rows; not clear after the wait → the category stops
 *     `partial` with metadata.gate;
 *   - a heartbeat: metadata.heartbeat_at on the data_sync_log row at every flush
 *     and part boundary — reap_stale_sync_log() reads it before started_at
 *     (migration 20261010050000), so a live run spanning the nightly's reap is
 *     no longer reaped;
 *   - the claim: the standalone entry runs under the FIX-950 supervised-session
 *     claim; the CI entry claims nothing and writes `skipped` when a session is
 *     held (runUsaSpendingBulkCi);
 *   - the tail: VACUUM (ANALYZE) external_source_refs when a category
 *     completes. NOT financial_relationships / financial_entities — their
 *     owners are the 03:00Z / 04:50Z pg_cron vacuums (FIX-1144).
 *
 * Run standalone — src/scripts/usaspending-bulk.ts (every standalone run takes
 * the claim, local too, FIX-950):
 *   cd packages/data && pnpm run data:usaspending-bulk                 # both categories, local
 *   cd packages/data && pnpm run data:usaspending-bulk -- --category contracts --max-parts 2
 *   cd packages/data && pnpm run data:usaspending-bulk-assistance
 *   cd packages/data && pnpm run data:usaspending-bulk:prod -- --category contracts --max-minutes 240
 */

import * as https    from "https";
import * as http     from "http";
import * as fs       from "fs";
import * as path     from "path";
import * as os       from "os";
import { parse }     from "csv-parse";
import type { Client } from "pg";
import { createAdminClient } from "@civitics/db";
import {
  startSync,
  completeSync,
  failSync,
  skipSync,
  type PipelineResult,
} from "../sync-log";
import {
  resolveRecipients,
  upsertSpendingRelationshipsBatch,
  type SpendingRelationshipInput,
} from "./writer";
import { withDirectClient } from "../../lib/direct-pg-upsert";
import { buildDbUrl } from "../../lib/heavy-rebuild";
import {
  readProdSessionState,
  withClient,
  type ProdSessionState,
} from "../../lib/prod-session";
import { prodSessionHoldReason } from "../nightly-hold";
import { canonicalizeEntityName } from "../fec-bulk/writer";
import { openCsvParts } from "./zip";
import {
  DEFAULT_BREATHER_S,
  DEFAULT_GATE_WAIT_S,
  type UsaSpendingFlags,
} from "./flags";
import {
  loadState,
  saveState,
  getBaseline,
  startRun,
  isPartComplete,
  markPartComplete,
  completeFullRun,
  completeDeltaRun,
  describeState,
  partKey,
  type CategoryBaseline,
} from "./state";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMP_DIR           = path.join(os.tmpdir(), "usaspending-bulk");
const ARCHIVE_INDEX_URL = "https://files.usaspending.gov/award_data_archive/";
const BATCH_SIZE        = 1_000;   // rows per DB write batch

// Assistance type codes that map cleanly to relationship_type='grant'.
// 02 block grant · 03 formula grant · 04 project grant ·
// 05 cooperative agreement · 11 other financial assistance.
// Skips loans (07/08), insurance (09), and direct payments (06/10) — these
// are real federal financial assistance but don't fit the 'grant' enum.
const GRANT_ASSISTANCE_TYPE_CODES = new Set(["02", "03", "04", "05", "11"]);

// ---------------------------------------------------------------------------
// Category config
// ---------------------------------------------------------------------------

export type BulkCategory = "contracts" | "assistance";

interface CategoryConfig {
  category:           BulkCategory;
  filePrefix:         "Contracts" | "Assistance";
  syncLogName:        "usaspending_bulk" | "usaspending_bulk_assistance";
  relationshipType:   "contract" | "grant";
  /** CSV column carrying the dedup key. */
  uniqueKeyColumn:    "contract_award_unique_key" | "assistance_award_unique_key";
  /** Fallback CSV column for the dedup key when the primary is missing. */
  fallbackKeyColumn:  "award_id_piid" | "award_id_fain";
}

const CATEGORY_CONFIGS: Record<BulkCategory, CategoryConfig> = {
  contracts: {
    category:          "contracts",
    filePrefix:        "Contracts",
    syncLogName:       "usaspending_bulk",
    relationshipType:  "contract",
    uniqueKeyColumn:   "contract_award_unique_key",
    fallbackKeyColumn: "award_id_piid",
  },
  assistance: {
    category:          "assistance",
    filePrefix:        "Assistance",
    syncLogName:       "usaspending_bulk_assistance",
    relationshipType:  "grant",
    uniqueKeyColumn:   "assistance_award_unique_key",
    fallbackKeyColumn: "award_id_fain",
  },
};

// ---------------------------------------------------------------------------
// Fiscal year helper
// ---------------------------------------------------------------------------

function currentFy(): number {
  const now = new Date();
  // FY runs Oct 1 → Sep 30; month is 0-based, so month >= 9 means Oct+
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

// ---------------------------------------------------------------------------
// Archive index — S3 XML prefix queries
//
// The archive bucket is paginated (>1000 keys, alphabetical). Fetching the
// root listing returns FY2007–FY2010 on the first page; FY2026 is far down.
// Use targeted ?prefix= queries instead of scanning the root listing.
//
// File naming (discovered 2026-04-25 for Contracts, FIX-114 for Assistance):
//   Full  : FY{YEAR}_All_{Category}_Full_{YYYYMMDD}.zip
//   Delta : FY(All)_All_{Category}_Delta_{YYYYMMDD}.zip
// ---------------------------------------------------------------------------

export interface ArchiveFile {
  name: string;
  url:  string;
  date: string;   // YYYYMMDD
  type: "Full" | "Delta";
  part: number;   // 1-based (1 when no part suffix)
  /** Bytes, from the listing's <Size> — the --keep-archive reuse check. */
  size: number | null;
  /** --local-archive only: the zip on disk; nothing is downloaded or deleted. */
  localPath?: string;
}

async function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const follow = (u: string): void => {
      const lib = u.startsWith("https") ? https : http;
      lib.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          follow(res.headers.location ?? u);
          return;
        }
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      }).on("error", reject);
    };
    follow(url);
  });
}

/**
 * Query the S3 bucket with a prefix filter and return matching ArchiveFiles.
 * The parentheses in "FY(All)" must be percent-encoded in the query string.
 */
async function discoverFiles(
  prefix:   string,
  type:     "Full" | "Delta",
  reStr:    string,
  fetch:    (url: string) => Promise<string> = fetchText,
): Promise<ArchiveFile[]> {
  const xml  = await fetch(`${ARCHIVE_INDEX_URL}?prefix=${encodeURIComponent(prefix)}`);
  const re   = new RegExp(reStr);
  const files: ArchiveFile[] = [];

  for (const hit of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    const key = hit[1]!;
    const m = key.match(re);
    if (!m) continue;
    // <Size> sits in the same <Contents> block, after the <Key> and before the
    // next one.
    const after  = xml.slice((hit.index ?? 0) + hit[0].length);
    const next   = after.indexOf("<Key>");
    const sizeM  = (next >= 0 ? after.slice(0, next) : after).match(/<Size>(\d+)<\/Size>/);
    files.push({
      name: key,
      // Keys with '(' must be percent-encoded in the download URL
      url:  `${ARCHIVE_INDEX_URL}${key.replace(/\(/g, "%28").replace(/\)/g, "%29")}`,
      date: m[1]!,
      type,
      part: m[2] ? parseInt(m[2], 10) : 1,
      size: sizeM ? Number(sizeM[1]) : null,
    });
  }
  return files;
}

async function discoverFullFiles(
  cfg:   CategoryConfig,
  fy:    number,
  fetch: (url: string) => Promise<string> = fetchText,
): Promise<ArchiveFile[]> {
  return discoverFiles(
    `FY${fy}_All_${cfg.filePrefix}_Full`,
    "Full",
    `FY${fy}_All_${cfg.filePrefix}_Full_(\\d{8})(?:_(\\d+))?\\.zip$`,
    fetch,
  );
}

/** The fiscal-year facts a run stamps into data_sync_log.metadata (FIX-1268). */
export interface FullFilesResolution {
  files: ArchiveFile[];
  fiscal_year_requested: number;
  /** null when neither year has a Full archive. */
  fiscal_year_used: number | null;
  fiscal_year_fallback: boolean;
}

/**
 * FIX-1268 — the Full listing for `fy`, falling back to `fy − 1` ONCE.
 *
 * currentFy() rolls to the new fiscal year on Oct 1, but USASpending publishes
 * that year's FY<n>_All_*_Full archive on its own schedule, weeks later. Until
 * it does, the prior year's Full set is the newest one there is (10-01 failed
 * every category on "No Full … archive found for FY2027"). Only when neither
 * year has a Full archive is the run a failure.
 */
export async function resolveFullFiles(
  category: BulkCategory,
  fy:       number,
  fetch:    (url: string) => Promise<string> = fetchText,
): Promise<FullFilesResolution> {
  const cfg = CATEGORY_CONFIGS[category];
  const requested = await discoverFullFiles(cfg, fy, fetch);
  if (requested.length > 0) {
    return { files: requested, fiscal_year_requested: fy, fiscal_year_used: fy, fiscal_year_fallback: false };
  }
  const prior = await discoverFullFiles(cfg, fy - 1, fetch);
  if (prior.length > 0) {
    return { files: prior, fiscal_year_requested: fy, fiscal_year_used: fy - 1, fiscal_year_fallback: true };
  }
  return { files: [], fiscal_year_requested: fy, fiscal_year_used: null, fiscal_year_fallback: false };
}

async function discoverDeltaFiles(
  cfg:   CategoryConfig,
  fetch: (url: string) => Promise<string> = fetchText,
): Promise<ArchiveFile[]> {
  return discoverFiles(
    `FY(All)_All_${cfg.filePrefix}_Delta`,
    "Delta",
    `FY\\(All\\)_All_${cfg.filePrefix}_Delta_(\\d{8})(?:_(\\d+))?\\.zip$`,
    fetch,
  );
}

function latestFullSet(files: ArchiveFile[]): ArchiveFile[] {
  if (files.length === 0) return [];
  const latest = files.reduce((max, f) => (f.date > max ? f.date : max), "");
  return files.filter((f) => f.date === latest).sort((a, b) => a.part - b.part);
}

function deltasSince(files: ArchiveFile[], since: string): ArchiveFile[] {
  return files
    .filter((f) => f.date > since)
    .sort((a, b) => a.date.localeCompare(b.date) || a.part - b.part);
}

/** The fiscal-year facts a Full run stamps (FIX-1268). null on a delta run. */
export type FyMeta = Omit<FullFilesResolution, "files">;

export interface RunPlan {
  mode:  "full" | "delta";
  /** In processing order. */
  files: ArchiveFile[];
  /** FIX-1268 — Full runs only; a delta run never lists the Fulls (C3). */
  fyMeta: FyMeta | null;
  /** Set when the plan itself is the failure (no Full archive for FY or FY−1). */
  error?: string;
  /** A delta run with no file newer than the baseline. */
  nothingToDo?: boolean;
}

/** --local-archive: the zip on disk becomes the run's one delta archive. */
export function localArchiveFile(zipPath: string): ArchiveFile {
  const name = path.basename(zipPath);
  const m = name.match(/(\d{8})/);
  if (!m) {
    throw new Error(`--local-archive ${name}: no YYYYMMDD in the file name to date the archive by`);
  }
  if (!fs.existsSync(zipPath)) throw new Error(`--local-archive ${zipPath}: no such file`);
  return {
    name,
    url:       "",
    date:      m[1]!,
    type:      "Delta",
    part:      1,
    size:      fs.statSync(zipPath).size,
    localPath: zipPath,
  };
}

/**
 * FIX-1274 C3 — decide Full vs Delta and list ONLY what that mode needs. The
 * Full listing (and FIX-1268's FY fallback) lives inside the no-baseline arm:
 * before this, every delta run listed the Fulls first and could FAIL on an
 * unpublished FY Full it was never going to read.
 */
export async function planRun(
  category:     BulkCategory,
  baseline:     CategoryBaseline | null,
  fy:           number,
  opts: {
    fetch?:        (url: string) => Promise<string>;
    localArchive?: string | null;
  } = {},
): Promise<RunPlan> {
  const cfg   = CATEGORY_CONFIGS[category];
  const fetch = opts.fetch ?? fetchText;

  if (opts.localArchive) {
    // Dev lever: processed as the delta whatever the baseline says, so a
    // re-run of the same zip (the rehearsal's run E) is possible.
    return { mode: "delta", files: [localArchiveFile(opts.localArchive)], fyMeta: null };
  }

  if (!baseline) {
    const resolved = await resolveFullFiles(category, fy, fetch);
    const fyMeta: FyMeta = {
      fiscal_year_requested: resolved.fiscal_year_requested,
      fiscal_year_used:      resolved.fiscal_year_used,
      fiscal_year_fallback:  resolved.fiscal_year_fallback,
    };
    if (resolved.files.length === 0) {
      return {
        mode: "full", files: [], fyMeta,
        error: `No Full ${cfg.filePrefix} archive found for FY${fy} or FY${fy - 1}`,
      };
    }
    return { mode: "full", files: latestFullSet(resolved.files), fyMeta };
  }

  const deltaFiles = await discoverDeltaFiles(cfg, fetch);
  const files      = deltasSince(deltaFiles, baseline.lastArchiveDate);
  return { mode: "delta", files, fyMeta: null, nothingToDo: files.length === 0 };
}

// ---------------------------------------------------------------------------
// Download helper (follows redirects, works for http + https)
// ---------------------------------------------------------------------------

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string): void => {
      const lib = u.startsWith("https") ? https : http;
      const file = fs.createWriteStream(destPath);
      lib.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume();
          file.destroy();
          follow(res.headers.location ?? u);
          return;
        }
        if (res.statusCode !== 200) {
          file.destroy();
          reject(new Error(`HTTP ${res.statusCode} — ${u}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (err) => {
          fs.unlink(destPath, () => undefined);
          reject(err);
        });
      }).on("error", (err) => {
        file.destroy();
        reject(err);
      });
    };
    follow(url);
  });
}

/**
 * FIX-1274 — get the archive onto disk. With --keep-archive a zip already at
 * `zipPath` whose size matches the listing's is reused (a 1.45 GB delta is not
 * re-fetched for every invocation of a multi-invocation catch-up); anything
 * else is downloaded to `<zip>.part` and renamed, so an interrupted download
 * can never pass for a complete one.
 */
async function ensureArchive(file: ArchiveFile, zipPath: string, keepArchive: boolean): Promise<void> {
  if (keepArchive && fs.existsSync(zipPath)) {
    const have = fs.statSync(zipPath).size;
    if (file.size !== null && have === file.size) {
      console.info(`    Reusing kept archive ${zipPath} (${(have / 1024 / 1024).toFixed(0)} MB, size matches the listing)`);
      return;
    }
    console.info(
      `    Kept archive ${zipPath} is ${have} bytes, the listing says ${file.size ?? "unknown"} — re-downloading`,
    );
  }
  console.info("    Downloading (large file — please wait)...");
  const partPath = `${zipPath}.part`;
  await downloadFile(file.url, partPath);
  fs.renameSync(partPath, zipPath);
}

// ---------------------------------------------------------------------------
// ZIP → CSV extraction lives in ./zip.ts (openCsvParts — enumerates every CSV
// part via the central directory; FIX-766). The main loop extracts, processes,
// and deletes one part at a time to bound disk.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agency map
// ---------------------------------------------------------------------------

async function loadAgencyMap(
  db: ReturnType<typeof createAdminClient>,
): Promise<Map<string, string>> {
  const { data, error } = await db
    .from("agencies")
    .select("id, name, acronym");

  if (error || !data) {
    console.error("  Failed to load agencies:", error?.message);
    return new Map();
  }

  const map = new Map<string, string>();
  for (const row of data as Array<{ id: string; name: string | null; acronym: string | null }>) {
    if (row.name) {
      const upper = row.name.toUpperCase().trim();
      map.set(upper, row.id);
      // Also index without "U.S. " prefix so CSV names like "Department of Agriculture"
      // match DB entries like "U.S. Department of Agriculture".
      const stripped = upper.replace(/^U\.S\.\s+/, "");
      if (stripped !== upper) map.set(stripped, row.id);
    }
    if (row.acronym) map.set(row.acronym.toUpperCase().trim(), row.id);
  }

  console.info(`  Loaded ${data.length} agencies (${map.size} name/acronym keys)`);
  return map;
}

// ---------------------------------------------------------------------------
// CSV processing — streamed line by line through csv-parse
// ---------------------------------------------------------------------------

/**
 * Union of columns we read from either the contracts or the assistance CSV.
 * csv-parse with `columns: true` returns objects keyed by header name; a
 * header that's only present in one schema simply yields `undefined` in
 * the other — safe to read either way.
 */
interface CsvRow {
  // Contracts
  contract_award_unique_key?:    string;
  award_id_piid?:                string;
  naics_code?:                   string;
  // Assistance
  assistance_award_unique_key?:  string;
  award_id_fain?:                string;
  cfda_number?:                  string;
  assistance_type_code?:         string;
  // Shared
  recipient_name?:               string;
  recipient_uei?:                string;
  federal_action_obligation?:    string;
  action_date?:                  string;
  awarding_agency_name?:         string;
  awarding_sub_agency_name?:     string;
  award_description?:            string;
}

interface PendingRow {
  uniqueKey:     string;
  recipientName: string;
  agencyId:      string;
  amountCents:   number;
  actionDate:    string;
  naicsCode:     string | null;
  cfdaNumber:    string | null;
  description:   string | null;
}

interface FileResult {
  upserted:     number;
  failed:       number;
  skipped:      number;
  /** Rows skipped because assistance_type_code wasn't a grant shape. Assistance only. */
  skippedNonGrant: number;
  /** FR rows the server actually inserted or rewrote (FIX-1274 skip-unchanged). */
  changed:      number;
  rowsRead:     number;
  /** Set when the part stopped early — nothing of it is checkpointed. */
  stop:         StopSignal | null;
}

/** Why a category stopped `partial` (data_sync_log.metadata.stop_reason). */
export type StopReason = "max_parts" | "max_minutes" | "gate";

export interface StopSignal {
  reason: StopReason;
  /** The box_backoff_gate() jsonb, when the gate is why. */
  gate?:  GateReading;
}

/** `public.box_backoff_gate()`'s return (migration 20261003030000). */
export interface GateReading {
  job:         string;
  clear:       boolean;
  reason:      string | null;
  age_seconds: number | null;
  waited_s:    number;
  wait_max_s:  number;
  polls:       number;
  readings:    unknown;
}

/** What the per-part loop is allowed to do, and where it reports to. */
interface PartControl {
  /** data_sync_log row id ("" when startSync could not write one). */
  logId:      string;
  /** 0 = gate off. */
  gateWaitS:  number;
  /** Epoch ms after which the part stops at its next 100k line; null = none. */
  deadlineMs: number | null;
}

export const GATE_JOB = "usaspending-bulk";

/**
 * FIX-1291 — the shared box gate the pg_cron rollups use (P1-A), read at a
 * unit boundary. Returns null when the gate is off (--gate-wait-s 0, local
 * only). The direct client connects as `postgres`, the function's owner, so it
 * needs no grant beyond the one service_role already has.
 */
async function readGate(client: Client, waitS: number): Promise<GateReading | null> {
  if (waitS <= 0) return null;
  const res = await client.query<{ g: GateReading }>(
    `SELECT public.box_backoff_gate($1, $2) AS g`,
    [GATE_JOB, waitS],
  );
  const g = res.rows[0]?.g ?? null;
  if (g && !g.clear) {
    console.warn(
      `    [box gate] not clear after ${g.waited_s}s (reason=${g.reason}, polls=${g.polls}) — stopping (FIX-1291)`,
    );
  }
  return g;
}

/**
 * FIX-1291 — stamp `metadata.heartbeat_at` on this run's data_sync_log row.
 * reap_stale_sync_log() reads it before `started_at`, so a run that is still
 * writing is never reaped as an orphan. One small UPDATE per 1,000-row flush
 * (≤ 0.2/s at the 10-08 rate) plus the part boundaries. Best-effort: a failed
 * stamp is logged once per part and never stops the load.
 */
async function heartbeat(
  client: Client,
  logId:  string,
  extra:  Record<string, unknown> = {},
): Promise<boolean> {
  if (!logId) return true;
  try {
    await client.query(
      `UPDATE public.data_sync_log
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('heartbeat_at', now())
                         || $2::jsonb
        WHERE id = $1`,
      [logId, JSON.stringify(extra)],
    );
    return true;
  } catch (err) {
    console.warn(`    [heartbeat] stamp failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * One CSV part, on its own direct client: the gate, extract, stream, upsert.
 *
 * Stops (returns `stop`) without checkpointing anything when, at the gate
 * BEFORE the part or at any 100k-row line, the box gate is not clear after its
 * wait, or the --max-minutes deadline has passed. The in-flight batch is
 * flushed first, so what was read is written; the part is re-read from its
 * first row on resume, and the skip-unchanged predicate makes that re-read a
 * read.
 */
async function processPart(
  cfg:       CategoryConfig,
  part:      { path: string; extractTo(destPath: string): Promise<void> },
  csvPath:   string,
  agencyMap: Map<string, string>,
  ctl:       PartControl,
  label:     string,
): Promise<FileResult> {
  const result: FileResult = {
    upserted: 0, failed: 0, skipped: 0, skippedNonGrant: 0, changed: 0, rowsRead: 0, stop: null,
  };

  // FIX-586: open ONE direct session-pooler client for the whole part. Every
  // flush writes through it with the raised 90min session statement_timeout,
  // sidestepping the 8s PostgREST role cap that produced the 2026-06-14
  // chunk-timeout retry storm. One connection per part (not per flush) avoids
  // reconnect churn across the streaming loop; bulkUpsert chunks are autocommit
  // so a mid-part drop only loses the in-flight chunk.
  await withDirectClient(async (client) => {
    // The gate BEFORE the part — before a byte is extracted.
    const gate = await readGate(client, ctl.gateWaitS);
    if (gate && !gate.clear) {
      result.stop = { reason: "gate", gate };
      return;
    }
    await heartbeat(client, ctl.logId, { heartbeat_part: label });

    await part.extractTo(csvPath);
    const fileMb = (fs.statSync(csvPath).size / 1024 / 1024).toFixed(0);
    console.info(`    Processing CSV (${fileMb} MB uncompressed)...`);

    const input  = fs.createReadStream(csvPath);
    const parser = input.pipe(
      parse({
        columns:          true,
        skip_empty_lines: true,
        relax_quotes:     true,
        trim:             true,
      }),
    );

    let batch: PendingRow[] = [];
    let rowsMatched = 0;

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;

      const recipientInputs = batch.map((r) => ({ displayName: r.recipientName }));
      const { byCanonical } = await resolveRecipients(client, recipientInputs);

      const relInputs: SpendingRelationshipInput[] = [];
      for (const row of batch) {
        const canonical = canonicalizeEntityName(row.recipientName);
        const recipientEntityId = byCanonical.get(canonical);
        if (!recipientEntityId) { result.failed++; continue; }

        relInputs.push({
          agencyId:           row.agencyId,
          recipientEntityId,
          relationshipType:   cfg.relationshipType,
          amountCents:        row.amountCents,
          occurredAt:         row.actionDate,
          usaspendingAwardId: row.uniqueKey,
          naicsCode:          row.naicsCode,
          cfdaNumber:         row.cfdaNumber,
          description:        row.description,
          sourceUrl:          `https://www.usaspending.gov/award/${encodeURIComponent(row.uniqueKey)}/`,
        });
      }

      const batchResult = await upsertSpendingRelationshipsBatch(client, relInputs);
      result.upserted += batchResult.upserted;
      result.failed   += batchResult.failed;
      result.changed  += batchResult.changed;
      batch = [];
      await heartbeat(client, ctl.logId);
    };

    try {
      for await (const row of parser as AsyncIterable<CsvRow>) {
        result.rowsRead++;

        // At the TOP of the loop, so a skipped row cannot carry the count past
        // a 100k line unchecked (the progress line used to sit below every
        // `continue`, and a skipped 100,000th row printed nothing).
        if (result.rowsRead % 100_000 === 0) {
          console.info(
            `    ... ${result.rowsRead.toLocaleString()} rows read,` +
            ` ${rowsMatched.toLocaleString()} matched,` +
            ` ${result.upserted.toLocaleString()} upserted`,
          );
          // FIX-1274 — the in-part stops. Finish the current flush, then stop;
          // nothing of this part is checkpointed.
          if (ctl.deadlineMs !== null && Date.now() >= ctl.deadlineMs) {
            await flushBatch();
            console.warn("    [--max-minutes] deadline passed mid-part — stopping after the flush");
            result.stop = { reason: "max_minutes" };
            break;
          }
          const g = await readGate(client, ctl.gateWaitS);
          if (g && !g.clear) {
            await flushBatch();
            result.stop = { reason: "gate", gate: g };
            break;
          }
          await heartbeat(client, ctl.logId);
        }

        // Assistance: skip rows that aren't grant-shaped (loans, insurance, direct
        // payments) — the financial_relationships enum has no row for them.
        if (cfg.category === "assistance") {
          const code = (row.assistance_type_code ?? "").trim();
          if (!GRANT_ASSISTANCE_TYPE_CODES.has(code)) {
            result.skippedNonGrant++;
            continue;
          }
        }

        const subRaw  = (row.awarding_sub_agency_name ?? "").toUpperCase().trim();
        const subKey  = subRaw.replace(/^U\.S\.\s+/, "");
        const agRaw   = (row.awarding_agency_name ?? "").toUpperCase().trim();
        const agKey   = agRaw.replace(/^U\.S\.\s+/, "");
        const agencyId = (subKey ? agencyMap.get(subKey) ?? agencyMap.get(subRaw) : undefined)
                         ?? agencyMap.get(agKey)
                         ?? agencyMap.get(agRaw);
        if (!agencyId) { result.skipped++; continue; }

        // Use the category's transaction-level unique key; fall back to the
        // category's award_id column when the primary is missing.
        const primaryKey  = (row[cfg.uniqueKeyColumn]   ?? "").trim();
        const fallbackKey = (row[cfg.fallbackKeyColumn] ?? "").trim();
        const uniqueKey   = primaryKey || fallbackKey;
        if (!uniqueKey) { result.skipped++; continue; }

        const recipientName = (row.recipient_name ?? "").trim();
        if (!recipientName) { result.skipped++; continue; }

        const amount = parseFloat((row.federal_action_obligation ?? "").trim());
        // Skip zero and negative obligations (de-obligations / cancellations)
        if (isNaN(amount) || amount <= 0) { result.skipped++; continue; }

        // Archive uses ISO YYYY-MM-DD dates
        const actionDate = (row.action_date ?? "").trim().slice(0, 10);
        if (!actionDate || actionDate.length < 10) { result.skipped++; continue; }

        batch.push({
          uniqueKey,
          recipientName,
          agencyId,
          amountCents: Math.round(amount * 100),
          actionDate,
          naicsCode:   cfg.category === "contracts" ? ((row.naics_code  ?? "").trim() || null) : null,
          cfdaNumber:  cfg.category === "assistance" ? ((row.cfda_number ?? "").trim() || null) : null,
          description: (row.award_description ?? "").trim().slice(0, 500) || null,
        });
        rowsMatched++;

        if (batch.length >= BATCH_SIZE) {
          await flushBatch();
        }
      }

      if (!result.stop) await flushBatch();
    } finally {
      // Release the file before the caller deletes it — on Windows an open
      // handle makes the unlink fail and strands a ~1 GB CSV in the tmp dir.
      parser.destroy();
      input.destroy();
      if (!input.closed) await new Promise<void>((resolve) => input.once("close", () => resolve()));
    }

    await heartbeat(client, ctl.logId, { heartbeat_part: label });

    console.info(`    Rows read:          ${result.rowsRead.toLocaleString()}`);
    console.info(`    Matched agencies:   ${rowsMatched.toLocaleString()}`);
    console.info(`    Skipped:            ${result.skipped.toLocaleString()}`);
    if (cfg.category === "assistance") {
      console.info(`    Non-grant skipped:  ${result.skippedNonGrant.toLocaleString()}`);
    }
    console.info(`    Upserted:           ${result.upserted.toLocaleString()}`);
    console.info(`    FR rows changed:    ${result.changed.toLocaleString()}`);
    console.info(`    Failed:             ${result.failed.toLocaleString()}`);
  });

  return result;
}

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * Clear the tmp dir. With `keepZips` only the extracted CSVs go (FIX-1274
 * --keep-archive: the other category's kept zip, or this one's after a dial
 * stop, must survive into the next invocation).
 */
function cleanTmpDir(keepZips = false): void {
  try {
    if (!fs.existsSync(TMP_DIR)) return;
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (keepZips && !f.toLowerCase().endsWith(".csv")) continue;
      fs.unlinkSync(path.join(TMP_DIR, f));
    }
    if (fs.readdirSync(TMP_DIR).length === 0) fs.rmdirSync(TMP_DIR);
  } catch {
    // best effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * FIX-1274 C8 — the bulk-rewrite tail (CLAUDE.md, FIX-943), scoped by owner.
 * external_source_refs has NO vacuum owner, so the landing vacuums it.
 * financial_relationships and financial_entities DO — jobid 38
 * `fr-vacuum-analyze` 03:00Z and `fe-vacuum-analyze` 04:50Z — and a script
 * VACUUM of FR on prod is FIX-1144's front-door incident, so they are left to
 * them. A fresh client: VACUUM cannot run inside a transaction block, and the
 * direct client is autocommit.
 */
async function vacuumExternalSourceRefs(): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  try {
    await withDirectClient((client) => client.query("VACUUM (ANALYZE) public.external_source_refs"));
    const seconds = +((Date.now() - t0) / 1000).toFixed(1);
    console.info(`  [tail] VACUUM (ANALYZE) external_source_refs — ${seconds}s (FR/FE: their owners, FIX-1144)`);
    return { ok: true, seconds };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [tail] VACUUM (ANALYZE) external_source_refs failed (continuing): ${msg}`);
    return { ok: false, seconds: +((Date.now() - t0) / 1000).toFixed(1), error: msg.slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Main pipeline — one category
// ---------------------------------------------------------------------------

export interface BulkPipelineOpts {
  force?:        boolean;
  category?:     BulkCategory;
  /** Parts this category may process in this invocation; null = no limit. */
  maxParts?:     number | null;
  /** Epoch ms of the --max-minutes wall; null = none. */
  deadlineMs?:   number | null;
  /** box_backoff_gate wait. 0 = off (local only — the flag parser refuses it with --allow-prod). */
  gateWaitS?:    number;
  /** Sleep between parts. */
  breatherS?:    number;
  /** Keep the downloaded zip across invocations; delete it when the category completes. */
  keepArchive?:  boolean;
  /** Dev lever: process this zip as the delta. */
  localArchive?: string | null;
}

export interface BulkPipelineResult extends PipelineResult {
  status:              "complete" | "partial" | "failed";
  stopReason:          StopReason | null;
  /** Parts processed by THIS invocation (not counting resumed ones). */
  partsThisInvocation: number;
}

export async function runUsaSpendingBulkPipeline(
  opts: BulkPipelineOpts = {},
): Promise<BulkPipelineResult> {
  const cfg         = CATEGORY_CONFIGS[opts.category ?? "contracts"];
  const keepArchive = opts.keepArchive ?? false;
  const gateWaitS   = opts.gateWaitS ?? DEFAULT_GATE_WAIT_S;
  const breatherS   = opts.breatherS ?? DEFAULT_BREATHER_S;
  const maxParts    = opts.maxParts ?? null;
  const deadlineMs  = opts.deadlineMs ?? null;

  console.info(`\n=== USASpending bulk archive pipeline (${cfg.category}) ===`);
  const logId = await startSync(cfg.syncLogName);
  const db    = createAdminClient();

  let totalUpserted = 0;
  let totalFailed   = 0;
  let totalChanged  = 0;
  let fyMeta: FyMeta | null = null;
  let partsThisInvocation = 0;
  // FIX-1274 — every exit path writes these (complete / partial / failed).
  const runMeta: Record<string, unknown> = {
    run_type:    null,
    archive:     null,
    parts_done:  0,
    parts_total: 0,
    stop_reason: null,
    dials: {
      max_parts:    maxParts,
      max_minutes_deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
      gate_wait_s:  gateWaitS,
      breather_s:   breatherS,
      keep_archive: keepArchive,
      local_archive: opts.localArchive ? path.basename(opts.localArchive) : null,
    },
  };
  const rowMeta = (): Record<string, unknown> => ({
    ...(fyMeta ?? {}),
    ...runMeta,
    parts_this_invocation: partsThisInvocation,
    fr_rows_changed:       totalChanged,
  });

  try {
    // ── [1/5] Plan: Full or Delta, listing only what that mode needs ───────
    console.info("\n  [1/5] Discovering archive files...");
    const fy = currentFy();

    // FIX-739: DB-backed state (one-time lift from the legacy file on first run).
    const state    = await loadState(db);
    console.info(`  State: ${describeState(state, cfg.category)}`);
    const baseline = opts.force ? null : getBaseline(state, cfg.category);

    const plan = await planRun(cfg.category, baseline, fy, { localArchive: opts.localArchive ?? null });
    fyMeta = plan.fyMeta;
    runMeta["run_type"] = plan.mode;

    if (plan.mode === "full" && plan.fyMeta) {
      if (plan.fyMeta.fiscal_year_fallback) {
        console.info(`  FY${fy} Full ${cfg.filePrefix} files: 0 — not published yet; falling back to FY${fy - 1}`);
      }
      console.info(`  FY${plan.fyMeta.fiscal_year_used ?? fy} Full ${cfg.filePrefix} files: ${plan.files.length}`);
    }

    if (plan.error) {
      console.warn(`  ${plan.error}`);
      await failSync(logId, plan.error, rowMeta());
      return { inserted: 0, updated: 0, failed: 1, estimatedMb: 0, status: "failed", stopReason: null, partsThisInvocation };
    }

    // ── [2/5] Run identity: begin or resume ─────────────────────────────────
    console.info("\n  [2/5] Determining run mode...");
    if (plan.nothingToDo) {
      console.info(`  No new Delta files since ${baseline?.lastArchiveDate} — nothing to do`);
      await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0, metadata: rowMeta() });
      return { inserted: 0, updated: 0, failed: 0, estimatedMb: 0, status: "complete", stopReason: null, partsThisInvocation };
    }

    const newest   = plan.files[plan.files.length - 1]!;
    const identity = { runType: plan.mode, archiveDate: newest.date, archiveName: newest.name };
    runMeta["archive"] = newest.name;

    // FIX-739 / FIX-1274: begin or resume the run in DB state — Full OR Delta.
    // The same archive resumes (skip completed parts); a different one discards
    // the partial and restarts. Persist immediately so a resume is visible even
    // if this invocation dies before the first part completes.
    const start = startRun(state, cfg.category, identity);
    await saveState(db, state);
    if (start.abandoned) {
      console.info(
        `  Abandoned in-progress ${start.abandoned.runType} run for ${start.abandoned.archiveDate}` +
        `${start.abandoned.archiveName ? ` (${start.abandoned.archiveName})` : ""} after ` +
        `${start.abandoned.completedParts.length} part(s) — ${newest.name} supersedes it`,
      );
    }
    const how = opts.force
      ? "Forced full re-run"
      : start.resumed
        ? `Resuming ${plan.mode} run (${start.completedParts.length} CSV part(s) already complete — skipping)`
        : plan.mode === "full"
          ? "No prior baseline — first run"
          : `Delta mode: ${plan.files.length} file(s) since ${baseline?.lastArchiveDate ?? "(local archive)"}`;
    console.info(`  ${how}: ${plan.mode === "full" ? "Full" : "Delta"} archive dated ${newest.date}`);

    // ── [3/5] Load agency map ──────────────────────────────────────────────
    console.info("\n  [3/5] Loading agency map...");
    const agencyMap = await loadAgencyMap(db);
    if (agencyMap.size === 0) {
      await failSync(logId, "No agencies loaded — cannot filter archive rows", rowMeta());
      return { inserted: 0, updated: 0, failed: 1, estimatedMb: 0, status: "failed", stopReason: null, partsThisInvocation };
    }

    // ── [4/5] Download and process each archive file, part by part ─────────
    console.info("\n  [4/5] Processing archive files...");
    ensureTmpDir();

    let lastProcessedDate = plan.mode === "delta" ? (baseline?.lastArchiveDate ?? "") : "";
    let stop: StopSignal | null = null;
    let partsTotal = 0;

    fileLoop:
    for (const archiveFile of plan.files) {
      console.info(`\n  Processing ${archiveFile.name}...`);
      const zipPath = archiveFile.localPath ?? path.join(TMP_DIR, archiveFile.name);

      try {
        if (!archiveFile.localPath) await ensureArchive(archiveFile, zipPath, keepArchive);
        const zipMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(0);
        console.info(`    Archive ${zipPath} — ${zipMb} MB`);

        // FIX-766: enumerate EVERY CSV part via the central directory, then
        // extract → process → delete one part at a time to bound disk.
        const parts = await openCsvParts(zipPath);
        if (parts.length === 0) {
          console.warn(`    No .csv found inside ${archiveFile.name} — skipping`);
          continue;
        }
        partsTotal += parts.length;
        runMeta["parts_total"] = partsTotal;
        console.info(`    ${parts.length} CSV part(s) in ${archiveFile.name}`);

        for (let k = 0; k < parts.length; k++) {
          const part  = parts[k]!;
          const label = `part ${k + 1}/${parts.length}`;
          const key   = partKey(archiveFile.name, part.path);

          // FIX-739 / FIX-1274: skip parts a prior invocation already completed
          // for this same archive — in delta mode too. The pre-FIX-1274 comment
          // here read "Delta parts are not checkpointed — deltas are small and a
          // killed delta simply reprocesses". That premise is retired: the
          // 2026-09-24 contracts delta is 1.45 GB in five 1M-row parts, and the
          // 10-08 run was killed after landing three of them.
          if (isPartComplete(state, cfg.category, key)) {
            console.info(`    ── ${label} (${part.path}) already complete — skipping`);
            continue;
          }

          // The boundary dials, before a new part starts.
          if (maxParts !== null && partsThisInvocation >= maxParts) {
            console.info(`    [--max-parts] ${partsThisInvocation} part(s) processed — stopping before ${label}`);
            stop = { reason: "max_parts" };
            break fileLoop;
          }
          if (deadlineMs !== null && Date.now() >= deadlineMs) {
            console.info(`    [--max-minutes] deadline passed — stopping before ${label}`);
            stop = { reason: "max_minutes" };
            break fileLoop;
          }
          if (partsThisInvocation > 0 && breatherS > 0) {
            console.info(`    [breather] ${breatherS}s before ${label}`);
            await sleep(breatherS * 1000);
          }

          console.info(`\n    ═══════ ${label}: ${part.path} ═══════`);
          const csvPath = path.join(TMP_DIR, path.basename(part.path));
          const t0 = Date.now();
          let fileResult: FileResult;
          try {
            fileResult = await processPart(
              cfg, part, csvPath, agencyMap, { logId, gateWaitS, deadlineMs }, label,
            );
          } finally {
            try { if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath); } catch { /* ok */ }
          }
          totalUpserted += fileResult.upserted;
          totalFailed   += fileResult.failed;
          totalChanged  += fileResult.changed;

          if (fileResult.stop) {
            stop = fileResult.stop;
            break fileLoop;
          }

          // Checkpoint this part immediately — GHA SIGTERM gives no grace window,
          // so persistence must be incremental, never a shutdown handler.
          markPartComplete(state, cfg.category, key);
          await saveState(db, state);
          partsThisInvocation++;
          const secs = (Date.now() - t0) / 1000;
          console.info(
            `    ✓ ${label} checkpointed — ${fileResult.rowsRead.toLocaleString()} rows in ` +
            `${(secs / 60).toFixed(1)} min (${Math.round(fileResult.rowsRead / Math.max(secs, 0.001))} rows/s)`,
          );
        }

        if (archiveFile.date > lastProcessedDate) {
          lastProcessedDate = archiveFile.date;
        }

      } finally {
        // CI (no --keep-archive): the zip is no longer needed once its parts
        // are done — free disk. Kept archives go only when the category
        // completes (below); a --local-archive zip is never ours to delete.
        if (!archiveFile.localPath && !keepArchive) {
          try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch { /* ok */ }
        }
      }
    }

    runMeta["parts_done"] = state[cfg.category]?.runInProgress?.completedParts.length ?? 0;

    // ── A dial stopped the category: `partial`, resumable ────────────────────
    if (stop) {
      runMeta["stop_reason"] = stop.reason;
      if (stop.gate) runMeta["gate"] = stop.gate;
      cleanTmpDir(keepArchive);
      console.info(
        `\n  ⏸  ${cfg.category} stopped (${stop.reason}) — ${runMeta["parts_done"]}/${partsTotal} part(s) ` +
        `done; the next invocation resumes ${newest.name}`,
      );
      const partial: PipelineResult = {
        inserted: totalUpserted, updated: 0, failed: totalFailed, estimatedMb: 0, metadata: rowMeta(),
      };
      await completeSync(logId, partial, "partial");
      return { ...partial, status: "partial", stopReason: stop.reason, partsThisInvocation };
    }

    // ── [5/5] Finalize ─────────────────────────────────────────────────────
    console.info("\n  [5/5] Finalising...");

    // FIX-739: advance the baseline only on a fully-completed run. A Full keys
    // on its archive date (which is always set — never the max-processed date,
    // so an all-parts-already-complete resume still finalizes); a Delta
    // advances to the newest processed delta date. Both clear runInProgress.
    if (plan.mode === "full") {
      completeFullRun(state, cfg.category, identity.archiveDate);
    } else if (lastProcessedDate) {
      completeDeltaRun(state, cfg.category, lastProcessedDate);
    }
    await saveState(db, state);

    // FIX-1274 C8 — the tail, after the baseline advanced.
    runMeta["xsr_vacuum"] = await vacuumExternalSourceRefs();

    // The category completed: a kept archive has done its job.
    for (const f of plan.files) {
      if (f.localPath) continue;
      try {
        const p = path.join(TMP_DIR, f.name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch { /* ok */ }
    }
    cleanTmpDir(keepArchive);

    const result: PipelineResult = {
      inserted:    totalUpserted,
      updated:     0,
      failed:      totalFailed,
      estimatedMb: 0,  // agent of change — let dashboard derive from DB size
      metadata:    rowMeta(),
    };

    console.info("\n  ──────────────────────────────────────────────────");
    console.info(`  USASpending bulk pipeline report (${cfg.category})`);
    console.info("  ──────────────────────────────────────────────────");
    console.info(`  ${"Run mode:".padEnd(30)} ${plan.mode}`);
    if (fyMeta) {
      console.info(`  ${"FY:".padEnd(30)} ${fyMeta.fiscal_year_used}${fyMeta.fiscal_year_fallback ? ` (fallback; FY${fy} not published)` : ""}`);
    }
    console.info(`  ${"Files processed:".padEnd(30)} ${plan.files.length}`);
    console.info(`  ${"Parts (this invocation/total):".padEnd(30)} ${partsThisInvocation}/${partsTotal}`);
    console.info(`  ${"Relationships upserted:".padEnd(30)} ${totalUpserted}`);
    console.info(`  ${"FR rows changed:".padEnd(30)} ${totalChanged}`);
    console.info(`  ${"Failed:".padEnd(30)} ${totalFailed}`);

    await completeSync(logId, result);
    return { ...result, status: "complete", stopReason: null, partsThisInvocation };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  USASpending bulk pipeline (${cfg.category}) fatal error:`, msg);
    cleanTmpDir(keepArchive);
    await failSync(logId, msg, rowMeta());
    return {
      inserted: totalUpserted, updated: 0, failed: totalFailed, estimatedMb: 0,
      status: "failed", stopReason: null, partsThisInvocation,
    };
  }
}

// ---------------------------------------------------------------------------
// One invocation — the categories in order, one dial budget
// ---------------------------------------------------------------------------

export interface CategoryOutcome extends BulkPipelineResult {
  category: BulkCategory;
}

/**
 * Run the categories the flags name, in order, under ONE budget: --max-parts
 * counts parts across the invocation, and --max-minutes is a wall from its
 * start. A dial stop (`partial`) ends the invocation — the next category is
 * not started. A FAILED category does not: the two are independent archives,
 * as they were before FIX-1274.
 */
export async function runUsaSpendingBulkInvocation(
  flags: UsaSpendingFlags,
  deps:  { runCategory?: (opts: BulkPipelineOpts) => Promise<BulkPipelineResult>; nowMs?: () => number } = {},
): Promise<CategoryOutcome[]> {
  const runCategory = deps.runCategory ?? runUsaSpendingBulkPipeline;
  const startedMs   = (deps.nowMs ?? Date.now)();
  const deadlineMs  = flags.maxMinutes === null ? null : startedMs + flags.maxMinutes * 60_000;
  let partsLeft     = flags.maxParts;
  const out: CategoryOutcome[] = [];

  for (const category of flags.categories) {
    const r = await runCategory({
      category,
      force:        flags.force,
      maxParts:     partsLeft,
      deadlineMs,
      gateWaitS:    flags.gateWaitS,
      breatherS:    flags.breatherS,
      keepArchive:  flags.keepArchive,
      localArchive: flags.localArchive,
    });
    out.push({ category, ...r });
    if (partsLeft !== null) partsLeft = Math.max(0, partsLeft - r.partsThisInvocation);
    if (r.status === "partial") {
      console.info(`\n  Invocation stopped at ${category} (${r.stopReason}) — later categories not started`);
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The CI entry's preflight (FIX-1274 C7)
// ---------------------------------------------------------------------------

/**
 * A GitHub-Actions run claims nothing — it is unattended, and a claim exists
 * for a human to hold. Instead it READS the interlock first: when a supervised
 * session holds the box, it writes a `skipped` row per category and does no
 * work, so a dispatch never lands on top of a supervised op. The skip_reason
 * is spelled `prod session held: …` exactly as the nightly and the guarded
 * pg_cron procedures spell theirs (FIX-1137 keys on that prefix). Fails open,
 * like every FIX-950 reader: an unreadable state is not a hold.
 */
export function usaSpendingCiPreflight(
  state: ProdSessionState | null,
): { skip: false } | { skip: true; reason: string } {
  if (!state?.held) return { skip: false };
  const who = state.claimed_by ? ` (claimed by ${state.claimed_by})` : "";
  return { skip: true, reason: `${prodSessionHoldReason(state.reason)}${who}` };
}

export interface CiDeps {
  readState?:    () => Promise<ProdSessionState | null>;
  writeSkipped?: (pipeline: string, reason: string) => Promise<void>;
  invoke?:       (flags: UsaSpendingFlags) => Promise<CategoryOutcome[]>;
}

async function writeSkippedRow(pipeline: string, reason: string): Promise<void> {
  const id = await startSync(pipeline);
  await skipSync(id, reason);
}

/** The CI path: preflight the interlock, then the invocation. Never claims. */
export async function runUsaSpendingBulkCi(
  flags: UsaSpendingFlags,
  deps:  CiDeps = {},
): Promise<{ skipped: string | null; outcomes: CategoryOutcome[] }> {
  const readState    = deps.readState ?? (() => withClient(buildDbUrl(), readProdSessionState));
  const writeSkipped = deps.writeSkipped ?? writeSkippedRow;
  const invoke       = deps.invoke ?? ((f: UsaSpendingFlags) => runUsaSpendingBulkInvocation(f));

  const decision = usaSpendingCiPreflight(await readState());
  if (decision.skip) {
    console.warn(`  [usaspending-bulk] ⏸  ${decision.reason} — no work this run (FIX-1274)`);
    for (const category of flags.categories) {
      await writeSkipped(CATEGORY_CONFIGS[category].syncLogName, decision.reason);
    }
    return { skipped: decision.reason, outcomes: [] };
  }
  return { skipped: null, outcomes: await invoke(flags) };
}

// The standalone entry point is src/scripts/usaspending-bulk.ts (FIX-1274 C7):
// it runs an invocation under the FIX-950 claim, and the FIX-1174 census
// (prod-scripts-interlock.test.ts) reads `:prod` entries from src/scripts/.
