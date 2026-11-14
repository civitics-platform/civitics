/**
 * FIX-253 · 13D / 13G beneficial-ownership scanner.
 *
 * Daily-index path:
 *   https://www.sec.gov/Archives/edgar/daily-index/{YYYY}/QTR{N}/master.{YYYYMMDD}.idx
 * Pipe-delimited: CIK|Company Name|Form Type|Date Filed|Filename
 *
 * SEC publishes a new daily-index file every business day (US Eastern). We
 * scan the index for rows where Form Type ∈ {SC 13D, SC 13D/A, SC 13G,
 * SC 13G/A} AND the CIK is in our tracked S&P 500 universe.
 *
 * For each hit we fetch the primary document, do best-effort cover-page
 * parsing for Reporting Person + percent + shares + event date. Filings
 * that don't parse cleanly are logged and skipped — better to miss a row
 * than to write garbage.
 *
 * FIX-1394: the archive answers a MISSING object with 403 `AccessDenied`,
 * never 404 (cc-278 read 2: an unpublished daily-index date and the
 * nonexistent full-index path both 403 with the same body). A status alone
 * cannot tell "not published yet" from "refused", so the scan asks the quarter
 * directory's listing (`index.json`) first: a file the listing does not name is
 * `not_published`; a listing that fails, or a listed file that answers non-OK,
 * is `refused`. The scan reports which — it never returns a bare empty list
 * that the caller would log as a quiet day.
 */

import { normalizeName } from "../fec-bulk/indiv";
import { canonicalizeEntityName } from "../fec-bulk/writer";
import { edgarFetch, type EdgarFetchOptions, type EdgarResponse } from "./client";
import { accessionPathSegment, padCik, parseFilingDate, parsePercent } from "./util";

const DAILY_INDEX_BASE = "https://www.sec.gov/Archives/edgar/daily-index";
const MASTER_FILE_RE = /^master\.\d{8}\.idx$/;
const BODY_HEAD_CHARS = 120;

/** edgarFetch's shape, injectable so tests never reach the network. */
export type EdgarFetchLike = (url: string, opts?: EdgarFetchOptions) => Promise<EdgarResponse>;

const TARGET_FORMS = new Set(["SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A"]);

export interface ShareholderFiling {
  cik:                 string;     // tracked company's padded CIK
  companyId:           string;     // edgar_companies.id (filled by caller)
  filingType:          string;
  accession:           string;
  filedAt:             string;     // YYYY-MM-DD
  primaryDocPath:      string;     // Archive-relative path from daily index
  holders:             ShareholderHolder[];
}

export interface ShareholderHolder {
  holderName:           string;
  canonicalHolderName:  string;    // normalizeName for persons, canonicalizeEntityName for orgs
  isOrganization:       boolean;
  pctOfClass:           number | null;
  sharesHeld:           number | null;
  eventDate:            string | null;
}

function quarterFor(month: number): number {
  if (month <= 3) return 1;
  if (month <= 6) return 2;
  if (month <= 9) return 3;
  return 4;
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

/** `…/daily-index/{YYYY}/QTR{N}/` — the quarter directory a daily file lives in. */
export function quarterDirUrl(year: number, quarter: number): string {
  return `${DAILY_INDEX_BASE}/${year}/QTR${quarter}/`;
}

/** `master.YYYYMMDD.idx` for a UTC calendar date. */
export function masterFileName(date: Date): string {
  const y = date.getUTCFullYear();
  return `master.${y}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}.idx`;
}

/**
 * FIX-1394: `daily-index`, not `full-index`. `full-index/{YYYY}/QTR{N}/` holds
 * the quarter's cumulative `master.idx`; there is no dated file under it, and
 * asking for one answers 403 AccessDenied.
 */
export function dailyIndexUrl(date: Date): string {
  const y = date.getUTCFullYear();
  const q = quarterFor(date.getUTCMonth() + 1);
  return quarterDirUrl(y, q) + masterFileName(date);
}

/** Refused: the listing failed, or a file the listing names answered non-OK. */
export interface IndexRefused {
  kind:     "refused";
  status:   number | null;   // null: the request threw (edgarFetch's 3 attempts)
  url:      string;
  bodyHead: string;          // the body's first 120 characters, or the thrown message
}

export interface QuarterListing {
  kind:  "listed";
  url:   string;
  files: string[];           // master.YYYYMMDD.idx names, ascending
}

/** The first 120 characters, on one line — it rides a log line and error_message. */
function bodyHead(body: string): string {
  return body.slice(0, BODY_HEAD_CHARS).replace(/\s+/g, " ");
}

async function getOrRefuse(
  url: string,
  accept: string,
  fetchImpl: EdgarFetchLike,
): Promise<{ kind: "ok"; body: string } | IndexRefused> {
  try {
    const res = await fetchImpl(url, { accept });
    if (!res.ok) {
      return { kind: "refused", status: res.status, url, bodyHead: bodyHead(res.body) };
    }
    return { kind: "ok", body: res.body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "refused", status: null, url, bodyHead: bodyHead(msg) };
  }
}

/**
 * Read one quarter directory's `index.json` and return its `master.*.idx`
 * names. A non-OK answer, a throw, or a body that is not the directory JSON is
 * `refused` — the listing is the thing that tells a missing file from a refusal,
 * so a listing that cannot be read leaves the run unable to say which.
 */
export async function listQuarter(
  year: number,
  quarter: number,
  fetchImpl: EdgarFetchLike = edgarFetch,
): Promise<QuarterListing | IndexRefused> {
  const url = quarterDirUrl(year, quarter) + "index.json";
  const got = await getOrRefuse(url, "application/json", fetchImpl);
  if (got.kind === "refused") return got;
  let items: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items = (JSON.parse(got.body) as any)?.directory?.item;
  } catch {
    items = undefined;
  }
  if (!Array.isArray(items)) {
    return { kind: "refused", status: 200, url, bodyHead: bodyHead(got.body) };
  }
  const files = items
    .map((it) => String((it as { name?: unknown })?.name ?? ""))
    .filter((n) => MASTER_FILE_RE.test(n))
    .sort();
  return { kind: "listed", url, files };
}

interface IndexRow {
  cik:        string;
  companyName: string;
  formType:   string;
  filedAt:    string;
  filename:   string;     // edgar/data/.../...txt
}

function parseDailyIndex(body: string): IndexRow[] {
  const out: IndexRow[] = [];
  const lines = body.split(/\r?\n/);
  let headerSeen = false;
  for (const line of lines) {
    if (!line) continue;
    if (!headerSeen) {
      if (line.startsWith("CIK|Company Name|Form Type")) { headerSeen = true; continue; }
      if (line.startsWith("--")) continue;
      continue;
    }
    const cols = line.split("|");
    if (cols.length < 5) continue;
    out.push({
      cik:         padCik(cols[0] ?? ""),
      companyName: (cols[1] ?? "").trim(),
      formType:    (cols[2] ?? "").trim(),
      filedAt:     (cols[3] ?? "").trim(),
      filename:    (cols[4] ?? "").trim(),
    });
  }
  return out;
}

const REPORTING_PERSON_RE = /name\s+of\s+reporting\s+(?:person|persons)[\s\S]{0,300}?(?:i\.r\.s\.?\s+identification\s+no\.?[\s\S]{0,200}?)?(?:<br\s*\/?>|\n|<\/td>|<\/p>)([\s\S]{0,200}?)(?:<|\n|$)/i;
const PCT_RE = /percent(?:\s+of)?\s+class\s+represented[\s\S]{0,400}?(\d{1,3}(?:\.\d+)?)\s*%/i;
const SHARES_RE = /aggregate\s+amount\s+beneficially\s+owned[\s\S]{0,400}?([\d,]{1,15})/i;
const EVENT_RE = /date\s+of\s+event\s+which\s+requires\s+filing[\s\S]{0,200}?(\d{1,2}\/\d{1,2}\/\d{2,4}|\w+\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})/i;

function looksLikeOrganization(name: string): boolean {
  return /\b(?:llc|lp|inc\.?|corp\.?|corporation|company|partners|fund|capital|management|holdings|group|trust|limited|ltd)\b/i.test(name);
}

function extractHolders(body: string): ShareholderHolder[] {
  // The Reporting-Person section repeats per co-filer on the cover page;
  // grab every match.
  const out: ShareholderHolder[] = [];
  const namePattern = new RegExp(REPORTING_PERSON_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = namePattern.exec(body)) !== null) {
    const raw = (m[1] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (!raw || raw.length > 120) continue;
    if (/[0-9]{4,}/.test(raw)) continue;             // skip stray EIN / SSN echoes
    const isOrg = looksLikeOrganization(raw);
    const canonical = isOrg ? canonicalizeEntityName(raw) : normalizeName(raw);
    if (!canonical) continue;
    out.push({
      holderName:           raw,
      canonicalHolderName:  canonical,
      isOrganization:       isOrg,
      pctOfClass:           null,
      sharesHeld:           null,
      eventDate:            null,
    });
  }
  if (out.length === 0) return out;

  // Single-pass extraction for the rest; we attribute the first match to
  // every holder since cover-page percentages usually summarize the group.
  const pctMatch = PCT_RE.exec(body);
  const sharesMatch = SHARES_RE.exec(body);
  const eventMatch = EVENT_RE.exec(body);
  const pct = pctMatch ? parsePercent(pctMatch[1]!) : null;
  const sharesRaw = sharesMatch ? sharesMatch[1]!.replace(/,/g, "") : null;
  const sharesHeld = sharesRaw ? Number(sharesRaw) : null;
  const eventDate = eventMatch ? parseFilingDate(eventMatch[1]!) : null;

  for (const h of out) {
    h.pctOfClass = pct;
    h.sharesHeld = Number.isFinite(sharesHeld) ? sharesHeld : null;
    h.eventDate = eventDate;
  }
  return out;
}

async function fetchPrimaryFromFilingIndex(
  cik: string,
  accession: string,
  fetchImpl: EdgarFetchLike,
): Promise<{ body: string; docName: string } | null> {
  const cikInt = String(parseInt(cik, 10));
  const seg = accessionPathSegment(accession);
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${seg}/index.json`;
  const res = await fetchImpl(indexUrl, { accept: "application/json" });
  if (!res.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = JSON.parse(res.body);
  const items: Array<{ name: string; type: string }> = json?.directory?.item ?? [];
  // Prefer .htm or .txt named after the form; otherwise first .htm.
  const htm = items.find((it) => /\.htm$/i.test(it.name) && !/_index/i.test(it.name));
  const target = htm ?? items.find((it) => /\.txt$/i.test(it.name));
  if (!target) return null;
  const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${seg}/${target.name}`;
  const docRes = await fetchImpl(docUrl, { accept: "text/html,*/*" });
  if (!docRes.ok) return null;
  return { body: docRes.body, docName: target.name };
}

/** What one scan found. `read` with `rowsTracked: 0` is the genuine quiet day. */
export type DailyIndexOutcome =
  | {
      kind:        "read";
      file:        string;
      filings:     ShareholderFiling[];
      rowsTracked: number;             // 13D/G rows on tracked CIKs in the file
    }
  | { kind: "not_published"; file: string; listingUrl: string }
  | IndexRefused;

export interface ScanOptions {
  date:        Date;
  trackedCiks: Map<string, string>;            // padded CIK → edgar_companies.id
  fetch?:      EdgarFetchLike;
}

export async function scanDailyShareholders(opts: ScanOptions): Promise<DailyIndexOutcome> {
  const fetchImpl = opts.fetch ?? edgarFetch;
  const { date, trackedCiks } = opts;
  const listing = await listQuarter(date.getUTCFullYear(), quarterFor(date.getUTCMonth() + 1), fetchImpl);
  if (listing.kind === "refused") {
    console.warn(`  [edgar/shareholders] daily index listing refused: HTTP ${listing.status ?? "—"} ${listing.url} — ${listing.bodyHead}`);
    return listing;
  }
  const file = masterFileName(date);
  if (!listing.files.includes(file)) {
    console.info(`  [edgar/shareholders] ${file} not listed in ${listing.url} (newest listed: ${listing.files[listing.files.length - 1] ?? "none"})`);
    return { kind: "not_published", file, listingUrl: listing.url };
  }

  const url = dailyIndexUrl(date);
  const got = await getOrRefuse(url, "text/plain,*/*", fetchImpl);
  if (got.kind === "refused") {
    console.warn(`  [edgar/shareholders] daily index HTTP ${got.status ?? "—"} ${url} — ${got.bodyHead}`);
    return got;
  }

  const rows = parseDailyIndex(got.body).filter(
    (r) => TARGET_FORMS.has(r.formType) && trackedCiks.has(r.cik),
  );
  console.info(`  [edgar/shareholders] ${rows.length} relevant 13D/G rows in ${file}`);

  const out: ShareholderFiling[] = [];
  for (const row of rows) {
    // Filename pattern: edgar/data/{cik_int}/{accession-no-dashes}.txt or .../{accession}-index.html
    const accMatch = row.filename.match(/(\d{10}-\d{2}-\d{6})/);
    if (!accMatch) continue;
    const accession = accMatch[1]!;
    let parsed: { body: string; docName: string } | null = null;
    try {
      parsed = await fetchPrimaryFromFilingIndex(row.cik, accession, fetchImpl);
    } catch (err) {
      console.warn(`  [edgar/shareholders] ${row.cik} ${accession} fetch failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (!parsed) continue;

    const holders = extractHolders(parsed.body);
    if (holders.length === 0) continue;

    out.push({
      cik:            row.cik,
      companyId:      trackedCiks.get(row.cik)!,
      filingType:     row.formType,
      accession,
      filedAt:        parseFilingDate(row.filedAt) ?? row.filedAt,
      primaryDocPath: parsed.docName,
      holders,
    });
  }
  return { kind: "read", file, filings: out, rowsTracked: rows.length };
}
