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
 *   - First run (no prior state): Full file FY{year}_All_{Category}_Full_{YYYYMMDD}.zip
 *   - Subsequent runs: Delta files since last processed date
 *   - Filters rows to agencies present in public.agencies (by name match)
 *   - resolveRecipients + upsertSpendingRelationshipsBatch live in ./writer.ts
 *   - Dedup key: contract_award_unique_key / assistance_award_unique_key
 *   - For assistance, filters to grant-shaped assistance_type_codes (02/03/04/05/11);
 *     loans, insurance, and direct payments are skipped because the
 *     financial_relationships enum has no row for them.
 *
 * State: packages/data/.usaspending-bulk-state.json (gitignored, not committed).
 *        Keyed `envs.{supabase-url-host}.{category}` (FIX-166) so local and
 *        prod runs progress independently. Legacy shapes are migrated under
 *        whichever env is active at first read; the other env starts fresh
 *        and needs one Full run before deltas resume.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:usaspending-bulk
 *   pnpm --filter @civitics/data data:usaspending-bulk -- --force
 *   pnpm --filter @civitics/data data:usaspending-bulk-assistance
 *   pnpm --filter @civitics/data data:usaspending-bulk -- --category=assistance --force
 */

import * as https    from "https";
import * as http     from "http";
import * as fs       from "fs";
import * as path     from "path";
import * as os       from "os";
import * as unzipper from "unzipper";
import { parse }     from "csv-parse";
import { createAdminClient } from "@civitics/db";
import {
  startSync,
  completeSync,
  failSync,
  type PipelineResult,
} from "../sync-log";
import {
  resolveRecipients,
  upsertSpendingRelationshipsBatch,
  type SpendingRelationshipInput,
} from "./writer";
import { withDirectClient } from "../../lib/direct-pg-upsert";
import { canonicalizeEntityName } from "../fec-bulk/writer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMP_DIR           = path.join(os.tmpdir(), "usaspending-bulk");
const ARCHIVE_INDEX_URL = "https://files.usaspending.gov/award_data_archive/";
const STATE_FILE        = path.join(__dirname, "../../../.usaspending-bulk-state.json");
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
// State management (delta tracking, per-env per-category)
// ---------------------------------------------------------------------------

interface CategoryState {
  /** YYYYMMDD of the latest archive file processed on the last successful run. */
  lastArchiveDate: string;
  lastRunType:     "full" | "delta";
  lastRunAt:       string;
}

interface EnvState {
  contracts?:  CategoryState;
  assistance?: CategoryState;
}

interface PipelineState {
  envs?: Record<string, EnvState>;
  // v1 legacy (post-FIX-114, pre-FIX-166): per-category at root.
  contracts?:  CategoryState;
  assistance?: CategoryState;
  // v0 legacy (pre-FIX-114): single CategoryState at the root, contracts only.
  lastArchiveDate?: string;
  lastRunType?:     "full" | "delta";
  lastRunAt?:       string;
}

/**
 * Stable env identifier derived from the active Supabase URL.
 * Uses URL.host so the dev port is captured (`127.0.0.1:54321`).
 */
function envKey(): string {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!url) return "unknown";
  try { return new URL(url).host; } catch { return "unknown"; }
}

function readStateFile(): PipelineState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as PipelineState;
  } catch {
    return {};
  }
}

/**
 * Lift legacy v0/v1 root state under a specific env key. The legacy file
 * carries no env attribution, so on migration we attribute it to whichever
 * env is active at the moment of the first read; the other env will start
 * fresh on its next invocation.
 */
function liftLegacyIntoEnv(raw: PipelineState, key: string): PipelineState {
  const next: PipelineState = { envs: { ...(raw.envs ?? {}) } };
  const legacyEnv: EnvState = { ...(next.envs![key] ?? {}) };

  if (raw.contracts && !legacyEnv.contracts) {
    legacyEnv.contracts = raw.contracts;
  }
  if (raw.assistance && !legacyEnv.assistance) {
    legacyEnv.assistance = raw.assistance;
  }
  // v0: single contracts state at the root.
  if (!legacyEnv.contracts && raw.lastArchiveDate) {
    legacyEnv.contracts = {
      lastArchiveDate: raw.lastArchiveDate,
      lastRunType:     raw.lastRunType ?? "full",
      lastRunAt:       raw.lastRunAt   ?? new Date().toISOString(),
    };
  }

  if (legacyEnv.contracts || legacyEnv.assistance) {
    next.envs![key] = legacyEnv;
  }
  return next;
}

function loadCategoryState(category: BulkCategory): CategoryState | null {
  const raw = readStateFile();
  const key = envKey();

  const fresh = raw.envs?.[key]?.[category];
  if (fresh) return fresh;

  // Legacy fallback — apply the lift in-memory so the same pre-migration
  // file gives the same answer on a second read.
  const lifted = liftLegacyIntoEnv(raw, key);
  const lifedCat = lifted.envs?.[key]?.[category] ?? null;
  if (lifedCat) {
    console.log(
      `  [state] Migrating legacy state under env "${key}" — ` +
      `the other env will need a Full re-run (use --force) on next invocation.`,
    );
  }
  return lifedCat;
}

function saveCategoryState(category: BulkCategory, next: CategoryState): void {
  try {
    const raw    = readStateFile();
    const key    = envKey();
    const lifted = liftLegacyIntoEnv(raw, key);

    const envs   = { ...(lifted.envs ?? {}) };
    const env    = { ...(envs[key] ?? {}) };
    env[category] = next;
    envs[key]    = env;

    // Drop any v0/v1 legacy keys from the persisted shape — keep only `envs`.
    fs.writeFileSync(STATE_FILE, JSON.stringify({ envs }, null, 2), "utf8");
  } catch (err) {
    console.warn("  [state] Could not save state:", err instanceof Error ? err.message : err);
  }
}

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

interface ArchiveFile {
  name: string;
  url:  string;
  date: string;   // YYYYMMDD
  type: "Full" | "Delta";
  part: number;   // 1-based (1 when no part suffix)
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
): Promise<ArchiveFile[]> {
  const xml  = await fetchText(`${ARCHIVE_INDEX_URL}?prefix=${encodeURIComponent(prefix)}`);
  const re   = new RegExp(reStr);
  const files: ArchiveFile[] = [];

  for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    const m = key.match(re);
    if (!m) continue;
    files.push({
      name: key,
      // Keys with '(' must be percent-encoded in the download URL
      url:  `${ARCHIVE_INDEX_URL}${key.replace(/\(/g, "%28").replace(/\)/g, "%29")}`,
      date: m[1]!,
      type,
      part: m[2] ? parseInt(m[2], 10) : 1,
    });
  }
  return files;
}

async function discoverFullFiles(cfg: CategoryConfig, fy: number): Promise<ArchiveFile[]> {
  return discoverFiles(
    `FY${fy}_All_${cfg.filePrefix}_Full`,
    "Full",
    `FY${fy}_All_${cfg.filePrefix}_Full_(\\d{8})(?:_(\\d+))?\\.zip$`,
  );
}

async function discoverDeltaFiles(cfg: CategoryConfig): Promise<ArchiveFile[]> {
  return discoverFiles(
    `FY(All)_All_${cfg.filePrefix}_Delta`,
    "Delta",
    `FY\\(All\\)_All_${cfg.filePrefix}_Delta_(\\d{8})(?:_(\\d+))?\\.zip$`,
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

// ---------------------------------------------------------------------------
// ZIP → CSV extraction (streaming, no full-zip buffer)
// ---------------------------------------------------------------------------

/**
 * Extract the first .csv entry from a zip file to disk via pipe.
 * Never loads the full zip into memory — identical to the FEC bulk approach.
 */
async function extractCsvFromZip(zipPath: string, destPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let found = false;

    fs.createReadStream(zipPath)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pipe((unzipper as any).Parse())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on("entry", (entry: any) => {
        const name = (entry.path as string).toLowerCase();
        if (!found && name.endsWith(".csv")) {
          found = true;
          const out = fs.createWriteStream(destPath);
          entry.pipe(out);
          out.on("finish", () => resolve(true));
          out.on("error", reject);
        } else {
          entry.autodrain();
        }
      })
      .on("finish", () => { if (!found) resolve(false); })
      .on("error", reject);
  });
}

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

  console.log(`  Loaded ${data.length} agencies (${map.size} name/acronym keys)`);
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
}

async function processCsvFile(
  cfg:       CategoryConfig,
  csvPath:   string,
  agencyMap: Map<string, string>,
): Promise<FileResult> {
  const result: FileResult = { upserted: 0, failed: 0, skipped: 0, skippedNonGrant: 0 };

  const fileMb = (fs.statSync(csvPath).size / 1024 / 1024).toFixed(0);
  console.log(`    Processing CSV (${fileMb} MB uncompressed)...`);

  const parser = fs.createReadStream(csvPath).pipe(
    parse({
      columns:          true,
      skip_empty_lines: true,
      relax_quotes:     true,
      trim:             true,
    }),
  );

  let batch: PendingRow[] = [];
  let rowsRead = 0;
  let rowsMatched = 0;

  // FIX-586: open ONE direct session-pooler client for the whole file. Every
  // flush writes through it with the raised 90min session statement_timeout,
  // sidestepping the 8s PostgREST role cap that produced the 2026-06-14
  // chunk-timeout retry storm. One connection per file (not per flush) avoids
  // reconnect churn across the streaming loop; bulkUpsert chunks are autocommit
  // so a mid-file drop only loses the in-flight chunk.
  await withDirectClient(async (client) => {
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
      batch = [];
    };

    for await (const row of parser as AsyncIterable<CsvRow>) {
      rowsRead++;

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

      if (rowsRead % 100_000 === 0) {
        console.log(
          `    ... ${rowsRead.toLocaleString()} rows read,` +
          ` ${rowsMatched.toLocaleString()} matched,` +
          ` ${result.upserted.toLocaleString()} upserted`,
        );
      }
    }

    await flushBatch();
  });

  console.log(`    Rows read:          ${rowsRead.toLocaleString()}`);
  console.log(`    Matched agencies:   ${rowsMatched.toLocaleString()}`);
  console.log(`    Skipped:            ${result.skipped.toLocaleString()}`);
  if (cfg.category === "assistance") {
    console.log(`    Non-grant skipped:  ${result.skippedNonGrant.toLocaleString()}`);
  }
  console.log(`    Upserted:           ${result.upserted.toLocaleString()}`);
  console.log(`    Failed:             ${result.failed.toLocaleString()}`);

  return result;
}

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function cleanTmpDir(): void {
  try {
    if (!fs.existsSync(TMP_DIR)) return;
    for (const f of fs.readdirSync(TMP_DIR)) {
      fs.unlinkSync(path.join(TMP_DIR, f));
    }
    fs.rmdirSync(TMP_DIR);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export interface BulkPipelineOpts {
  force?:    boolean;
  category?: BulkCategory;
}

export async function runUsaSpendingBulkPipeline(
  opts: BulkPipelineOpts = {},
): Promise<PipelineResult> {
  const cfg = CATEGORY_CONFIGS[opts.category ?? "contracts"];

  console.log(`\n=== USASpending bulk archive pipeline (${cfg.category}) ===`);
  const logId = await startSync(cfg.syncLogName);
  const db    = createAdminClient();

  let totalUpserted = 0;
  let totalFailed   = 0;

  try {
    // ── [1/5] Discover archive files via S3 prefix queries ────────────────
    console.log("\n  [1/5] Discovering archive files...");
    const fy    = currentFy();
    const state = opts.force ? null : loadCategoryState(cfg.category);

    // Fetch Full listing unconditionally (needed whether we run Full or to
    // determine the latest Full date for delta-mode display). Delta listing
    // is deferred — only fetched when we actually need it.
    const fullFiles = await discoverFullFiles(cfg, fy);
    console.log(`  FY${fy} Full ${cfg.filePrefix} files: ${fullFiles.length}`);

    if (fullFiles.length === 0) {
      console.warn(`  No Full archive found for FY${fy} ${cfg.filePrefix}`);
      await failSync(logId, `No Full ${cfg.filePrefix} archive found for FY${fy}`);
      return { inserted: 0, updated: 0, failed: 1, estimatedMb: 0 };
    }

    // ── [2/5] Decide Full vs Delta ─────────────────────────────────────────
    console.log("\n  [2/5] Determining run mode...");

    let filesToProcess: ArchiveFile[];
    let runMode: "full" | "delta";

    if (!state) {
      filesToProcess = latestFullSet(fullFiles);
      runMode = "full";
      console.log(
        `  ${opts.force ? "Forced full re-run" : "No prior state — first run"}:` +
        ` Full file dated ${filesToProcess[0]!.date}`,
      );
    } else {
      const deltaFiles = await discoverDeltaFiles(cfg);
      console.log(`  Delta files available: ${deltaFiles.length}`);
      filesToProcess = deltasSince(deltaFiles, state.lastArchiveDate);
      runMode = "delta";
      if (filesToProcess.length === 0) {
        console.log(`  No new Delta files since ${state.lastArchiveDate} — nothing to do`);
        await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
        return { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };
      }
      console.log(
        `  Delta mode: ${filesToProcess.length} file(s) since ${state.lastArchiveDate}`,
      );
    }

    // ── [3/5] Load agency map ──────────────────────────────────────────────
    console.log("\n  [3/5] Loading agency map...");
    const agencyMap = await loadAgencyMap(db);
    if (agencyMap.size === 0) {
      await failSync(logId, "No agencies loaded — cannot filter archive rows");
      return { inserted: 0, updated: 0, failed: 1, estimatedMb: 0 };
    }

    // ── [4/5] Download and process each archive file ───────────────────────
    console.log("\n  [4/5] Processing archive files...");
    ensureTmpDir();

    let lastProcessedDate = state?.lastArchiveDate ?? "";

    for (const archiveFile of filesToProcess) {
      console.log(`\n  Processing ${archiveFile.name}...`);

      const zipPath = path.join(TMP_DIR, archiveFile.name);
      const csvPath = path.join(TMP_DIR, path.basename(archiveFile.name, ".zip") + ".csv");

      try {
        // Download ZIP (can be 300 MB – 1 GB)
        console.log("    Downloading (large file — please wait)...");
        await downloadFile(archiveFile.url, zipPath);
        const zipMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(0);
        console.log(`    Downloaded ${zipMb} MB`);

        // Extract inner CSV to disk (streaming — never buffers full zip)
        console.log("    Extracting CSV from ZIP...");
        const found = await extractCsvFromZip(zipPath, csvPath);

        // ZIP no longer needed — delete immediately to free disk space
        try { fs.unlinkSync(zipPath); } catch { /* best effort */ }

        if (!found) {
          console.warn(`    No .csv found inside ${archiveFile.name} — skipping`);
          continue;
        }

        // Process the CSV stream
        const fileResult = await processCsvFile(cfg, csvPath, agencyMap);
        totalUpserted += fileResult.upserted;
        totalFailed   += fileResult.failed;

        if (archiveFile.date > lastProcessedDate) {
          lastProcessedDate = archiveFile.date;
        }

      } finally {
        // Best-effort cleanup — don't let stray temp files accumulate
        try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch { /* ok */ }
        try { if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath); } catch { /* ok */ }
      }
    }

    // ── [5/5] Finalize ─────────────────────────────────────────────────────
    console.log("\n  [5/5] Finalising...");
    cleanTmpDir();

    const result: PipelineResult = {
      inserted:    totalUpserted,
      updated:     0,
      failed:      totalFailed,
      estimatedMb: 0,  // agent of change — let dashboard derive from DB size
    };

    console.log("\n  ──────────────────────────────────────────────────");
    console.log(`  USASpending bulk pipeline report (${cfg.category})`);
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${"Run mode:".padEnd(30)} ${runMode}`);
    console.log(`  ${"FY:".padEnd(30)} ${fy}`);
    console.log(`  ${"Files processed:".padEnd(30)} ${filesToProcess.length}`);
    console.log(`  ${"Relationships upserted:".padEnd(30)} ${totalUpserted}`);
    console.log(`  ${"Failed:".padEnd(30)} ${totalFailed}`);

    await completeSync(logId, result);

    // Persist state for next run's delta logic
    if (lastProcessedDate) {
      saveCategoryState(cfg.category, {
        lastArchiveDate: lastProcessedDate,
        lastRunType:     runMode,
        lastRunAt:       new Date().toISOString(),
      });
    }

    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  USASpending bulk pipeline (${cfg.category}) fatal error:`, msg);
    cleanTmpDir();
    await failSync(logId, msg);
    return { inserted: totalUpserted, updated: 0, failed: totalFailed, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

function parseCategoryArg(): BulkCategory {
  const arg = process.argv.find((a) => a.startsWith("--category="));
  if (!arg) return "contracts";
  const value = arg.slice("--category=".length).toLowerCase();
  if (value === "contracts" || value === "assistance") return value;
  console.error(`Unknown --category=${value} (expected 'contracts' or 'assistance')`);
  process.exit(2);
}

if (require.main === module) {
  const force    = process.argv.includes("--force");
  const category = parseCategoryArg();
  runUsaSpendingBulkPipeline({ force, category })
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
