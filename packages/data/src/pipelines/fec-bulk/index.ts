/**
 * FEC bulk data pipeline.
 *
 * Downloads bulk zip files directly from FEC (no API key, no rate limits),
 * parses the all-candidates summary (weball24), matches records to officials
 * in our database, and inserts aggregated financial_relationships rows.
 *
 * Step 2b — PAC contributions:
 *   Downloads committee master (cm24) and PAC-to-candidate file (pas224).
 *   Streams pas224 line-by-line — never loads the full ~200 MB file into memory.
 *   Inserts to DB in batches of 1 000 rows to bound memory use.
 *   Creates financial_entities for named PAC donors,
 *   financial_relationships per PAC × candidate pair ($5 000+ only),
 *   and entity_connections with logarithmic strength scores.
 *
 * Files downloaded to /tmp and deleted after processing:
 *   weball24.zip / weball24.txt — all-candidates summary (2024 cycle)
 *   cm24.zip / cm24.txt         — committee master (~5 MB)
 *   pas224.zip / pas224.txt     — PAC to candidate contributions (~200 MB compressed)
 *
 * Data strategy: download → process → delete. No API key needed.
 * FEC updates bulk files weekly — run this pipeline on the weekly cron.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:fec-bulk
 */

import * as https    from "https";
import * as fs       from "fs";
import * as path     from "path";
import * as os       from "os";
import * as readline from "readline";
import * as unzipper from "unzipper";
import { createAdminClient } from "@civitics/db";
import type { Database }     from "@civitics/db";
import {
  startSync,
  completeSync,
  failSync,
  type PipelineResult,
} from "../sync-log";
import { runConnectionsPipeline } from "../connections";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FinancialInsert    = Database["public"]["Tables"]["financial_relationships"]["Insert"];
type ConnectionInsert   = Database["public"]["Tables"]["entity_connections"]["Insert"];
type DonorType          = Database["public"]["Enums"]["donor_type"];

interface WeBallRow {
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

interface OfficialRecord {
  id:         string;
  full_name:  string;
  first_name: string | null;
  last_name:  string | null;
  role_title: string | null;
  source_ids: Record<string, string>;
  state:      string | null;
}

/** Committee master (cm24) entry */
interface CommitteeInfo {
  name:         string;  // CMTE_NM
  type:         string;  // CMTE_TP raw code (N/Q/V/W/X/Y/Z)
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

const BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// Download + extract helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), "fec-bulk");

function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function downloadFile(url: string, destPath: string): Promise<void> {
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
function parseFecName(candName: string): { last: string; first: string } {
  const commaIdx = candName.indexOf(",");
  if (commaIdx < 0) return { last: candName.toUpperCase().trim(), first: "" };
  const last  = candName.slice(0, commaIdx).toUpperCase().trim();
  const parts = candName.slice(commaIdx + 1).trim().split(/\s+/);
  return { last, first: (parts[0] ?? "").toUpperCase() };
}

function normalizeLastName(name: string | null): string {
  return (name ?? "").toUpperCase().replace(/[^A-Z]/g, "");
}

// ---------------------------------------------------------------------------
// Match FEC rows to our officials
// ---------------------------------------------------------------------------

async function loadOfficials(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<OfficialRecord[]> {
  const { data, error } = await db
    .from("officials")
    .select("id, full_name, first_name, last_name, role_title, source_ids, jurisdictions!jurisdiction_id(short_name)")
    .eq("is_active", true);

  if (error) throw new Error(`Could not load officials: ${error.message}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((o: any) => ({
    id:         o.id as string,
    full_name:  o.full_name as string,
    first_name: (o.first_name as string | null) ?? null,
    last_name:  (o.last_name as string | null) ?? null,
    role_title: (o.role_title as string | null) ?? null,
    source_ids: (o.source_ids ?? {}) as Record<string, string>,
    state:      (o.jurisdictions?.short_name as string | null) ?? null,
  }));
}

interface MatchIndex {
  byFecId:    Map<string, string>;           // fecId → officialId
  byLastName: Map<string, OfficialRecord[]>; // normalizedLast → officials
}

function buildMatchIndex(officials: OfficialRecord[]): MatchIndex {
  const byFecId    = new Map<string, string>();
  const byLastName = new Map<string, OfficialRecord[]>();

  for (const o of officials) {
    // fec_candidate_id is the most authoritative key — always include
    const candidateId = o.source_ids["fec_candidate_id"];
    if (candidateId) byFecId.set(candidateId, o.id);

    // fec_id: only include if its FEC prefix matches the official's current role.
    // Prefix mismatch means it's an old ID from a prior race (e.g. a Senator who
    // previously served in the House and has an H-prefix fec_id still stored).
    const fecId = o.source_ids["fec_id"];
    if (fecId) {
      const prefix    = fecId[0]?.toUpperCase() ?? "";
      const isSenator = o.role_title === "Senator";
      const isRep     = o.role_title === "Representative";
      if ((isSenator && prefix === "S") || (isRep && prefix === "H")) {
        byFecId.set(fecId, o.id);
      }
      // Mismatched prefix (old race) — skip; don't pollute the index
    }

    const key  = normalizeLastName(o.last_name ?? o.full_name);
    const list = byLastName.get(key) ?? [];
    list.push(o);
    byLastName.set(key, list);
  }

  return { byFecId, byLastName };
}

interface MatchResult {
  officialId: string;
  fecId:      string;
  byFecId:    boolean;
}

function matchRow(row: WeBallRow, index: MatchIndex): MatchResult | null {
  // 1. Direct stored fec_id match
  const directId = index.byFecId.get(row.candId);
  if (directId) return { officialId: directId, fecId: row.candId, byFecId: true };

  // 2. Name fuzzy match
  const { last, first } = parseFecName(row.candName);
  const key       = last.replace(/[^A-Z]/g, "");
  const candidates = index.byLastName.get(key) ?? [];
  if (candidates.length === 0) return null;

  // Narrow by state if available
  const statePool =
    row.candOfficeSt
      ? candidates.filter((c) => (c.state ?? "").toUpperCase() === row.candOfficeSt)
      : candidates;
  const pool = statePool.length > 0 ? statePool : candidates;

  if (pool.length === 1) return { officialId: pool[0].id, fecId: row.candId, byFecId: false };

  // Further narrow by first-name prefix
  if (first.length >= 3) {
    const firstPool = pool.filter((c) =>
      c.full_name.toUpperCase().split(/\s+/).some((p) => p.startsWith(first.slice(0, 3)))
    );
    if (firstPool.length === 1) return { officialId: firstPool[0].id, fecId: row.candId, byFecId: false };
  }

  return null; // ambiguous — skip
}

// ---------------------------------------------------------------------------
// Step 2b helpers — PAC-specific types and computations
// ---------------------------------------------------------------------------

/**
 * Parse the cm24 committee master file into a lookup map.
 * File is ~2 MB uncompressed — safe to load fully.
 */
function parseCm24(buffer: Buffer): Map<string, CommitteeInfo> {
  const lookup = new Map<string, CommitteeInfo>();
  for (const line of buffer.toString("latin1").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols   = line.split("|");
    const cmteId = (cols[CM_COL.CMTE_ID] ?? "").trim();
    if (!cmteId) continue;
    lookup.set(cmteId, {
      name:         (cols[CM_COL.CMTE_NM]          ?? "").trim(),
      type:         (cols[CM_COL.CMTE_TP]          ?? "").trim().toUpperCase(),
      connectedOrg: (cols[CM_COL.CONNECTED_ORG_NM] ?? "").trim(),
    });
  }
  return lookup;
}

/**
 * Map FEC CMTE_TP code → entity_type string.
 *   N = PAC non-connected
 *   Q = PAC connected/corporate
 *   V = PAC labor
 *   W = PAC cooperative
 *   X/Y/Z = party committee
 */
function cmteTypeToEntityType(cmteType: string): string {
  if (["X", "Y", "Z"].includes(cmteType)) return "party_committee";
  return "pac";
}

/** Map FEC CMTE_TP code → donor_type enum. */
function cmteTypeToDonorType(cmteType: string): DonorType {
  if (["X", "Y", "Z"].includes(cmteType)) return "party_committee";
  return "pac";
}

/** Convert FEC date "MMDDYYYY" → ISO "YYYY-MM-DD". Returns null if invalid. */
function parseFecDate(mmddyyyy: string): string | null {
  if (!mmddyyyy || mmddyyyy.length !== 8) return null;
  const mm   = mmddyyyy.slice(0, 2);
  const dd   = mmddyyyy.slice(2, 4);
  const yyyy = mmddyyyy.slice(4, 8);
  if (!/^\d+$/.test(mm + dd + yyyy)) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Calculate connection strength from donation amount.
 *
 * Formula: Math.min(1.0, Math.log10(amountCents / 100_000) / 4)
 *   (amountCents / 100_000 converts cents → thousands of dollars)
 *
 * Reference points:
 *   $5 000  → 0.17    $50 000  → 0.42
 *   $100k   → 0.50    $500k    → 0.67
 *   $1M+    → 0.75+
 */
function donationStrength(amountCents: number): number {
  if (amountCents <= 0) return 0;
  return Math.min(1.0, Math.log10(amountCents / 100_000) / 4);
}

// ---------------------------------------------------------------------------
// Step 2b — Stream PAC contributions (pas224)
// ---------------------------------------------------------------------------

/**
 * Extract a single entry from a zip file to disk via pipe (streaming — no buffering).
 * Returns true if the entry was found, false if not.
 */
async function extractZipEntryToDisk(
  zipPath:   string,
  matchName: (name: string) => boolean,
  destPath:  string,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let found = false;

    fs.createReadStream(zipPath)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pipe((unzipper as any).Parse())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on("entry", (entry: any) => {
        const name = path.basename(entry.path as string).toLowerCase();
        if (!found && matchName(name.toLowerCase())) {
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

/**
 * Stream pas224.txt (extracted to disk) line-by-line.
 * Never loads the full file into memory.
 *
 * Filters applied while streaming:
 *   TRANSACTION_TP in ('24K', '24Z')   — direct contributions only
 *   TRANSACTION_AMT >= 5 000           — skip small contributions
 *   CAND_ID in candidateSet            — only our matched officials
 *
 * Returns aggregated totals keyed by "CMTE_ID|CAND_ID".
 *
 * NOTE: extracts pas224.txt to TMP_DIR first to avoid a race condition where
 * unzipper.Parse()'s 'finish' event resolves the Promise before readline
 * finishes consuming the in-memory entry stream.
 */
async function streamPas224(
  zipPath:      string,
  candidateSet: Set<string>,
): Promise<Map<string, PacAggregation>> {
  const aggregated = new Map<string, PacAggregation>();

  // Step A: extract pas224.txt to disk via streaming pipe
  const txtPath = path.join(TMP_DIR, "pas224.txt");
  const found   = await extractZipEntryToDisk(
    zipPath,
    (name) => name.includes("pas2") && name.endsWith(".txt"),  // itpas2.txt inside the zip
    txtPath,
  );

  if (!found) {
    console.error("    pas224.txt not found inside zip — skipping PAC step");
    return aggregated;
  }

  const txtMb = (fs.statSync(txtPath).size / 1024 / 1024).toFixed(0);
  console.log(`    Extracted pas224.txt (${txtMb} MB) — streaming line by line...`);

  // Step B: stream the extracted file line by line
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
    if (isNaN(amt) || amt < 5000) continue;
    passedAmt++;

    // Aggregate by committee × candidate
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
  console.log(`    Passed $5k+ filter:        ${passedAmt.toLocaleString()}`);

  // Clean up the extracted file — TMP_DIR cleanup handles the zip files
  try { fs.unlinkSync(txtPath); } catch { /* best effort */ }

  return aggregated;
}

// ---------------------------------------------------------------------------
// Upsert helpers — weball (existing logic, unchanged)
// ---------------------------------------------------------------------------

async function upsertFinancial(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  record: FinancialInsert
): Promise<"inserted" | "updated" | "failed"> {
  try {
    const { data: existing, error: selErr } = await db
      .from("financial_relationships")
      .select("id")
      .eq("official_id", record.official_id)
      .eq("donor_name",  record.donor_name)
      .eq("cycle_year",  record.cycle_year)
      .maybeSingle();

    if (selErr) {
      console.error("    upsert select error:", selErr.message);
      return "failed";
    }

    if (existing) {
      const { error } = await db
        .from("financial_relationships")
        .update({
          amount_cents: record.amount_cents,
          source_ids:   record.source_ids,
          updated_at:   new Date().toISOString(),
        })
        .eq("id", existing.id);
      return error ? "failed" : "updated";
    } else {
      const { error } = await db.from("financial_relationships").insert(record);
      return error ? "failed" : "inserted";
    }
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Upsert helpers — PAC entities, relationships, and connections
// ---------------------------------------------------------------------------

/**
 * Upsert a financial_entity for a PAC committee.
 * Returns the row ID (needed to create entity_connections).
 * Deduplication key: source_ids->>'fec_committee_id'
 */
async function upsertFinancialEntity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:         any,
  cmteId:     string,
  name:       string,
  entityType: string,
  industry:   string,
  totalCents: number,
): Promise<{ outcome: "inserted" | "updated" | "failed"; id: string | null }> {
  try {
    const { data: existing, error: selErr } = await db
      .from("financial_entities")
      .select("id")
      .filter("source_ids->>fec_committee_id", "eq", cmteId)
      .maybeSingle();

    if (selErr) {
      console.error("    entity select error:", selErr.message);
      return { outcome: "failed", id: null };
    }

    if (existing) {
      const { error } = await db
        .from("financial_entities")
        .update({
          name,
          entity_type:         entityType,
          industry:            industry || null,
          total_donated_cents: totalCents,
          updated_at:          new Date().toISOString(),
        })
        .eq("id", existing.id);
      return { outcome: error ? "failed" : "updated", id: existing.id as string };
    } else {
      const { data: inserted, error } = await db
        .from("financial_entities")
        .insert({
          name,
          entity_type:         entityType,
          industry:            industry || null,
          total_donated_cents: totalCents,
          source_ids:          { fec_committee_id: cmteId },
          metadata:            {},
        })
        .select("id")
        .single();

      if (error || !inserted) return { outcome: "failed", id: null };
      return { outcome: "inserted", id: (inserted as { id: string }).id };
    }
  } catch {
    return { outcome: "failed", id: null };
  }
}

/**
 * Upsert a PAC → candidate financial_relationship row.
 * Deduplication key: official_id + fec_committee_id + cycle_year
 */
async function upsertPacRelationship(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:         any,
  officialId: string,
  agg:        PacAggregation,
  info:       CommitteeInfo,
  cycleYear:  number,
): Promise<"inserted" | "updated" | "failed"> {
  try {
    const { data: existing, error: selErr } = await db
      .from("financial_relationships")
      .select("id")
      .eq("official_id",      officialId)
      .eq("fec_committee_id", agg.cmteId)
      .eq("cycle_year",       cycleYear)
      .maybeSingle();

    if (selErr) {
      console.error("    pac rel select error:", selErr.message);
      return "failed";
    }

    const contribDate = agg.latestDate ? parseFecDate(agg.latestDate) : null;
    const donorType   = cmteTypeToDonorType(info.type);

    if (existing) {
      const { error } = await db
        .from("financial_relationships")
        .update({
          amount_cents:      agg.totalCents,
          contribution_date: contribDate,
          updated_at:        new Date().toISOString(),
        })
        .eq("id", existing.id);
      return error ? "failed" : "updated";
    } else {
      const { error } = await db.from("financial_relationships").insert({
        official_id:       officialId,
        donor_name:        info.name || agg.cmteId,
        donor_type:        donorType,
        industry:          info.connectedOrg || null,
        amount_cents:      agg.totalCents,
        contribution_date: contribDate,
        cycle_year:        cycleYear,
        fec_committee_id:  agg.cmteId,
        is_bundled:        false,
        source_url:        `https://www.fec.gov/data/committee/${agg.cmteId}/`,
        source_ids:        { fec_committee_id: agg.cmteId, source_system: "fec_bulk_pac" },
        metadata:          { tx_count: agg.txCount },
      });
      return error ? "failed" : "inserted";
    }
  } catch {
    return "failed";
  }
}

/**
 * Upsert an entity_connection row linking a financial_entity (PAC) to an official.
 * Deduplication key: from_id + to_id + connection_type
 *
 * Strength scale (logarithmic):
 *   $5k → 0.17  |  $50k → 0.42  |  $100k → 0.50  |  $500k → 0.67  |  $1M+ → 0.75+
 */
async function upsertPacConnection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:           any,
  entityId:     string,
  officialId:   string,
  agg:          PacAggregation,
): Promise<"inserted" | "updated" | "failed"> {
  try {
    const { data: existing, error: selErr } = await db
      .from("entity_connections")
      .select("id")
      .eq("from_id",         entityId)
      .eq("to_id",           officialId)
      .eq("connection_type", "donation")
      .maybeSingle();

    if (selErr) {
      console.error("    connection select error:", selErr.message);
      return "failed";
    }

    const strength       = donationStrength(agg.totalCents);
    const occurredAt     = agg.latestDate ? parseFecDate(agg.latestDate) : null;
    const evidenceArr    = [{ source: "fec", committee_id: agg.cmteId, cycle: "2024" }];

    if (existing) {
      const { error } = await db
        .from("entity_connections")
        .update({
          strength,
          amount_cents: agg.totalCents,
          occurred_at:  occurredAt,
          evidence:     evidenceArr,
          updated_at:   new Date().toISOString(),
        })
        .eq("id", existing.id);
      return error ? "failed" : "updated";
    } else {
      const record: ConnectionInsert = {
        from_type:       "financial",
        from_id:         entityId,
        to_type:         "official",
        to_id:           officialId,
        connection_type: "donation",
        strength,
        amount_cents:    agg.totalCents,
        occurred_at:     occurredAt ?? undefined,
        is_verified:     true,
        evidence:        evidenceArr,
        metadata:        {},
      };
      const { error } = await db.from("entity_connections").insert(record);
      return error ? "failed" : "inserted";
    }
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runFecBulkPipeline(): Promise<PipelineResult> {
  console.log("\n=== FEC bulk data pipeline ===");
  const logId = await startSync("fec_bulk");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  let inserted = 0, updated = 0, failed = 0;
  let pacEntitiesInserted = 0, pacEntitiesUpdated = 0;
  let pacRelsInserted = 0, pacRelsUpdated = 0, pacRelsFailed = 0;
  let pacConnsInserted = 0, pacConnsUpdated = 0;
  let matchedByFecId = 0, matchedByName = 0, notMatched = 0;
  let connectionsCreated = 0;
  let totalFileMb = "0";
  let tempFreedMb = "0";

  try {
    // ── Step 1: Download bulk files ──────────────────────────────────────────
    console.log("\n  [1/7] Downloading FEC bulk files...");
    ensureTmpDir();

    const CYCLE = "2024";
    const bulkFiles = [
      {
        url:  `https://www.fec.gov/files/bulk-downloads/${CYCLE}/weball${CYCLE.slice(2)}.zip`,
        name: `weball${CYCLE.slice(2)}.zip`,
      },
      {
        url:  `https://www.fec.gov/files/bulk-downloads/${CYCLE}/cm${CYCLE.slice(2)}.zip`,
        name: `cm${CYCLE.slice(2)}.zip`,
      },
      {
        url:  `https://www.fec.gov/files/bulk-downloads/${CYCLE}/pas2${CYCLE.slice(2)}.zip`,
        name: `pas2${CYCLE.slice(2)}.zip`,
      },
    ];

    for (const f of bulkFiles) {
      const destPath = path.join(TMP_DIR, f.name);
      console.log(`    Downloading ${f.name}...`);
      await downloadFile(f.url, destPath);
      const sizeMb = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
      console.log(`    ✓ ${f.name} (${sizeMb} MB)`);
    }

    // ── Step 2: Extract and parse weball ────────────────────────────────────
    console.log("\n  [2/7] Extracting and parsing candidate summary...");
    const weballZip  = path.join(TMP_DIR, `weball${CYCLE.slice(2)}.zip`);
    const extracted  = await extractZip(weballZip, TMP_DIR);
    const weballFile = extracted.find(
      (f) => path.basename(f).toLowerCase().startsWith("weball") && f.endsWith(".txt")
    );
    if (!weballFile) throw new Error("weball .txt not found inside zip");

    const weballBuf  = fs.readFileSync(weballFile);
    const weballRows = parseWeBall(weballBuf);
    totalFileMb = (weballBuf.byteLength / 1024 / 1024).toFixed(1);
    console.log(`    Parsed ${weballRows.length} candidate rows (${totalFileMb} MB)`);

    // ── Step 3: Load officials + build match index ───────────────────────────
    console.log("\n  [3/7] Loading officials and matching to FEC candidates...");
    const officials   = await loadOfficials(db);
    const index       = buildMatchIndex(officials);
    const officialMap = new Map(officials.map((o) => [o.id, o]));
    console.log(`    Loaded ${officials.length} active officials`);

    // Build candidate set used to filter the pas224 stream
    const candidateSet = new Set<string>(index.byFecId.keys());

    const matches: Array<{ row: WeBallRow; match: MatchResult }> = [];
    const newFecIds: Array<{
      officialId:  string;
      fecId:       string;
      storageKey:  "fec_id" | "fec_candidate_id";
    }> = [];

    for (const row of weballRows) {
      const match = matchRow(row, index);
      if (!match) { notMatched++; continue; }

      matches.push({ row, match });

      if (match.byFecId) {
        matchedByFecId++;
      } else {
        matchedByName++;
        index.byFecId.set(match.fecId, match.officialId);
        newFecIds.push({ officialId: match.officialId, fecId: match.fecId, storageKey: "fec_id" });
        candidateSet.add(match.fecId);
      }
    }

    console.log(`    Matched by fec_id: ${matchedByFecId}`);
    console.log(`    Matched by name:   ${matchedByName}`);
    console.log(`    Not matched:       ${notMatched}`);

    // ── Fix 3: name-fallback for officials with no stored FEC ID at all ──────
    //
    // Officials whose source_ids contain neither fec_candidate_id nor fec_id
    // (or whose fec_id had a prefix mismatch and was excluded from the index)
    // get a second chance: look up their last-name+first-3+state against weball.
    // Matches are stored as fec_candidate_id (the authoritative key) so future
    // runs use the direct byFecId path and the candidateSet grows.
    {
      const alreadyIndexed = new Set(index.byFecId.values());
      const noFecIdOfficials = officials.filter((o) => {
        if (alreadyIndexed.has(o.id)) return false;           // already matched
        const cid = o.source_ids["fec_candidate_id"];
        const fid = o.source_ids["fec_id"];
        return !cid && !fid;                                   // no FEC ID stored at all
      });

      if (noFecIdOfficials.length > 0) {
        // Build a weball lookup keyed by "NORMLAAST|FIRST3|STATE"
        const weballByKey = new Map<string, WeBallRow>();
        for (const row of weballRows) {
          const { last, first } = parseFecName(row.candName);
          const key = `${last.replace(/[^A-Z]/g, "")}|${first.slice(0, 3)}|${row.candOfficeSt}`;
          if (!weballByKey.has(key)) weballByKey.set(key, row);
        }

        let fallbackMatched = 0;
        for (const official of noFecIdOfficials) {
          const normLast  = normalizeLastName(official.last_name ?? official.full_name);
          const normFirst = (official.first_name ?? official.full_name.split(" ")[0] ?? "")
            .toUpperCase()
            .replace(/[^A-Z]/g, "")
            .slice(0, 3);
          const state = (official.state ?? "").toUpperCase();
          const key   = `${normLast}|${normFirst}|${state}`;

          const row = weballByKey.get(key);
          if (!row) continue;

          fallbackMatched++;
          index.byFecId.set(row.candId, official.id);
          candidateSet.add(row.candId);
          newFecIds.push({ officialId: official.id, fecId: row.candId, storageKey: "fec_candidate_id" });
          // Also capture this as a weball match for financial_relationships
          matches.push({ row, match: { officialId: official.id, fecId: row.candId, byFecId: false } });
        }

        if (fallbackMatched > 0) {
          console.log(`    Name fallback matched: ${fallbackMatched} additional officials`);
        }
      }
    }

    // Persist newly discovered FEC IDs back into officials.source_ids
    if (newFecIds.length > 0) {
      console.log(`    Storing ${newFecIds.length} FEC ID associations...`);
      for (const { officialId, fecId, storageKey } of newFecIds) {
        const o = officialMap.get(officialId);
        if (!o) continue;
        await db
          .from("officials")
          .update({ source_ids: { ...o.source_ids, [storageKey]: fecId } })
          .eq("id", officialId);
      }
    }

    // ── Step 2b: PAC contributions — parse cm24, stream pas224 ──────────────
    console.log("\n  [4/7] Building PAC committee index and streaming contributions...");

    const cmZip       = path.join(TMP_DIR, `cm${CYCLE.slice(2)}.zip`);
    const cmExtracted = await extractZip(cmZip, TMP_DIR);
    const cmFile      = cmExtracted.find(
      (f) => path.basename(f).toLowerCase().startsWith("cm") && f.endsWith(".txt")
    );
    if (!cmFile) throw new Error("cm .txt not found inside zip");

    const cmLookup = parseCm24(fs.readFileSync(cmFile));
    console.log(`    Committee master: ${cmLookup.size.toLocaleString()} committees indexed`);

    console.log(`    Streaming pas224 (filtering to ${candidateSet.size} known fec_ids)...`);
    const pasZip  = path.join(TMP_DIR, `pas2${CYCLE.slice(2)}.zip`);
    const pacAggs = await streamPas224(pasZip, candidateSet);
    console.log(`    PAC pairs matched (committee × candidate): ${pacAggs.size.toLocaleString()}`);

    // ── Step 4: Insert weball financial_relationships ────────────────────────
    console.log("\n  [5/7] Inserting weball financial_relationships...");

    for (const { row, match } of matches) {
      const base = {
        official_id: match.officialId,
        cycle_year:  parseInt(CYCLE, 10),
        source_url:  `https://www.fec.gov/data/candidate/${match.fecId}/`,
        source_ids:  { fec_id: match.fecId, source_system: "fec_bulk" },
      };

      const contributions: Array<{ donorName: string; donorType: DonorType; amountDollars: number }> = [
        {
          donorName:     "Individual Contributors",
          donorType:     "individual",
          amountDollars: row.indivContrib,
        },
        {
          donorName:     "PAC/Committee Contributions",
          donorType:     "pac",
          amountDollars: row.cvrdHarReceipts,
        },
        {
          donorName:     "Party Contributions",
          donorType:     "party_committee",
          amountDollars: row.polPtyContrib,
        },
        {
          donorName:     "Self-Funded (Candidate)",
          donorType:     "individual",
          amountDollars: row.candContrib,
        },
      ];

      for (const contrib of contributions) {
        if (contrib.amountDollars <= 0) continue;

        const record: FinancialInsert = {
          ...base,
          donor_name:   contrib.donorName,
          donor_type:   contrib.donorType,
          amount_cents: Math.round(contrib.amountDollars * 100),
        };

        const outcome = await upsertFinancial(db, record);
        if (outcome === "inserted") inserted++;
        else if (outcome === "updated") updated++;
        else failed++;
      }
    }

    console.log(`    Inserted: ${inserted}  Updated: ${updated}  Failed: ${failed}`);

    // ── Step 4b: PAC financial_entities + relationships + connections ─────────
    //
    // Process aggregated PAC pairs in batches of BATCH_SIZE (1 000).
    // Each batch: upsert financial_entity → upsert financial_relationship →
    //             upsert entity_connection.
    // This bounds working memory to ≤ 1 000 rows at any point.
    // ---------------------------------------------------------------------------
    console.log("\n  [6/7] Upserting PAC entities, relationships, and connections...");

    // Pre-compute per-committee totals (needed for financial_entities.total_donated_cents)
    const cmteTotals = new Map<string, number>();
    for (const agg of pacAggs.values()) {
      cmteTotals.set(agg.cmteId, (cmteTotals.get(agg.cmteId) ?? 0) + agg.totalCents);
    }

    // Entity ID cache so each committee is only upserted once per run
    const entityIdCache = new Map<string, string>(); // cmteId → financial_entities.id

    const aggEntries = [...pacAggs.values()];
    for (let batchStart = 0; batchStart < aggEntries.length; batchStart += BATCH_SIZE) {
      const batch = aggEntries.slice(batchStart, batchStart + BATCH_SIZE);

      for (const agg of batch) {
        // 1. Upsert financial_entity (once per committee)
        let entityId = entityIdCache.get(agg.cmteId);
        if (!entityId) {
          const info = cmLookup.get(agg.cmteId);
          if (!info) continue; // not in cm24 — skip

          const entityType  = cmteTypeToEntityType(info.type);
          const totalCents  = cmteTotals.get(agg.cmteId) ?? agg.totalCents;
          const { outcome, id } = await upsertFinancialEntity(
            db, agg.cmteId, info.name, entityType, info.connectedOrg, totalCents
          );

          if (outcome === "inserted") pacEntitiesInserted++;
          else if (outcome === "updated") pacEntitiesUpdated++;
          if (!id) continue; // insert failed — skip relationship + connection

          entityId = id;
          entityIdCache.set(agg.cmteId, id);
        }

        // 2. Upsert financial_relationship
        const officialId = index.byFecId.get(agg.candId);
        if (!officialId) continue;

        const info = cmLookup.get(agg.cmteId) ?? {
          name:         agg.cmteId,
          type:         "N",
          connectedOrg: "",
        };

        const relOutcome = await upsertPacRelationship(db, officialId, agg, info, parseInt(CYCLE, 10));
        if (relOutcome === "inserted") pacRelsInserted++;
        else if (relOutcome === "updated") pacRelsUpdated++;
        else pacRelsFailed++;

        // 3. Upsert entity_connection
        const connOutcome = await upsertPacConnection(db, entityId, officialId, agg);
        if (connOutcome === "inserted") pacConnsInserted++;
        else if (connOutcome === "updated") pacConnsUpdated++;
      }

      const processed = Math.min(batchStart + BATCH_SIZE, aggEntries.length);
      if (processed < aggEntries.length) {
        process.stdout.write(`\r    Batch progress: ${processed} / ${aggEntries.length}`);
      }
    }
    if (aggEntries.length > BATCH_SIZE) process.stdout.write("\n");

    console.log(`    Entities inserted: ${pacEntitiesInserted}  updated: ${pacEntitiesUpdated}`);
    console.log(`    PAC rels inserted: ${pacRelsInserted}  updated: ${pacRelsUpdated}  failed: ${pacRelsFailed}`);
    console.log(`    Connections inserted: ${pacConnsInserted}  updated: ${pacConnsUpdated}`);

    // ── Step 5: Cleanup ──────────────────────────────────────────────────────
    console.log("\n  [7/7] Cleaning up temp files and rebuilding generic connections...");
    const tmpBytes = fs.readdirSync(TMP_DIR).reduce(
      (acc, f) => acc + fs.statSync(path.join(TMP_DIR, f)).size,
      0
    );
    tempFreedMb = (tmpBytes / 1024 / 1024).toFixed(1);
    deleteTmpDir();
    console.log(`    Freed ~${tempFreedMb} MB ✓`);

    // ── Step 6: Re-run generic connections pipeline ──────────────────────────
    const connResult   = await runConnectionsPipeline();
    connectionsCreated = connResult.inserted;

    // ── Report ───────────────────────────────────────────────────────────────
    const totalInserted = inserted + pacRelsInserted;
    const totalUpdated  = updated  + pacRelsUpdated;
    const totalFailed   = failed   + pacRelsFailed;

    console.log("\n  ──────────────────────────────────────────────────");
    console.log("  FEC Bulk Pipeline Report");
    console.log("  ──────────────────────────────────────────────────");
    console.log(`  ${"Officials matched by fec_id:".padEnd(38)} ${matchedByFecId}`);
    console.log(`  ${"Officials matched by name:".padEnd(38)} ${matchedByName}`);
    console.log(`  ${"Officials not matched:".padEnd(38)} ${notMatched}`);
    console.log(`  ${"Weball rows inserted:".padEnd(38)} ${inserted}`);
    console.log(`  ${"Weball rows updated:".padEnd(38)} ${updated}`);
    console.log(`  ${"Weball rows failed:".padEnd(38)} ${failed}`);
    console.log(`  ${"PAC entities created:".padEnd(38)} ${pacEntitiesInserted}`);
    console.log(`  ${"PAC entities updated:".padEnd(38)} ${pacEntitiesUpdated}`);
    console.log(`  ${"PAC relationships created:".padEnd(38)} ${pacRelsInserted}`);
    console.log(`  ${"PAC relationships updated:".padEnd(38)} ${pacRelsUpdated}`);
    console.log(`  ${"PAC relationships failed:".padEnd(38)} ${pacRelsFailed}`);
    console.log(`  ${"PAC connections created:".padEnd(38)} ${pacConnsInserted}`);
    console.log(`  ${"PAC connections updated:".padEnd(38)} ${pacConnsUpdated}`);
    console.log(`  ${"Generic connections rebuilt:".padEnd(38)} ${connectionsCreated}`);
    console.log(`  ${"Financial data processed:".padEnd(38)} ~${totalFileMb} MB`);
    console.log(`  ${"Temp files deleted:".padEnd(38)} ✓`);

    // Sanity check — top 10 PAC donors by total contributed
    const { data: top10pacs } = await db
      .from("financial_entities")
      .select("name, total_donated_cents")
      .order("total_donated_cents", { ascending: false })
      .limit(10);

    if (top10pacs && top10pacs.length > 0) {
      console.log("\n  Top 10 PAC donors (sanity check — expect EMILY'S LIST, NRA, SEIU, etc.):");
      for (const row of top10pacs) {
        const name = String(row.name ?? "Unknown").padEnd(52);
        const amt  = `$${(Number(row.total_donated_cents) / 100).toLocaleString()}`;
        console.log(`    ${name} ${amt}`);
      }
    }

    // Sanity check — top 5 officials by individual contributions
    const { data: top5 } = await db
      .from("financial_relationships")
      .select("official_id, amount_cents, officials!official_id(full_name)")
      .eq("cycle_year",  parseInt(CYCLE, 10))
      .eq("donor_name",  "Individual Contributors")
      .order("amount_cents", { ascending: false })
      .limit(5);

    if (top5 && top5.length > 0) {
      console.log("\n  Top 5 officials by individual contributions:");
      for (const row of top5) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const name = (row as any).officials?.full_name ?? "Unknown";
        const amt  = `$${(Number(row.amount_cents) / 100).toLocaleString()}`;
        console.log(`    ${String(name).padEnd(40)} ${amt}`);
      }
    }

    const result: PipelineResult = {
      inserted: totalInserted,
      updated:  totalUpdated,
      failed:   totalFailed,
      estimatedMb: parseFloat(totalFileMb),
    };
    await completeSync(logId, result);
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  FEC bulk pipeline fatal error:", msg);
    deleteTmpDir(); // best-effort cleanup even on error
    await failSync(logId, msg);
    return { inserted, updated, failed, estimatedMb: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runFecBulkPipeline()
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
