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
 */

import { normalizeName } from "../fec-bulk/indiv";
import { canonicalizeEntityName } from "../fec-bulk/writer";
import { edgarFetch } from "./client";
import { accessionPathSegment, padCik, parseFilingDate, parsePercent } from "./util";

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

export function dailyIndexUrl(date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const q = quarterFor(m);
  return `https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${q}/master.${y}${pad(m)}${pad(d)}.idx`;
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

async function fetchPrimaryFromFilingIndex(cik: string, accession: string): Promise<{ body: string; docName: string } | null> {
  const cikInt = String(parseInt(cik, 10));
  const seg = accessionPathSegment(accession);
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${seg}/index.json`;
  const res = await edgarFetch(indexUrl, { accept: "application/json" });
  if (!res.ok) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = JSON.parse(res.body);
  const items: Array<{ name: string; type: string }> = json?.directory?.item ?? [];
  // Prefer .htm or .txt named after the form; otherwise first .htm.
  const htm = items.find((it) => /\.htm$/i.test(it.name) && !/_index/i.test(it.name));
  const target = htm ?? items.find((it) => /\.txt$/i.test(it.name));
  if (!target) return null;
  const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${seg}/${target.name}`;
  const docRes = await edgarFetch(docUrl, { accept: "text/html,*/*" });
  if (!docRes.ok) return null;
  return { body: docRes.body, docName: target.name };
}

export async function scanDailyShareholders(
  date: Date,
  trackedCiks: Map<string, string>,            // padded CIK → edgar_companies.id
): Promise<ShareholderFiling[]> {
  const url = dailyIndexUrl(date);
  let res;
  try {
    res = await edgarFetch(url, { accept: "text/plain,*/*" });
  } catch (err) {
    console.warn(`  [edgar/shareholders] daily index fetch failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
  if (!res.ok) {
    // SEC publishes no index on weekends / market holidays — that's a 404
    if (res.status !== 404) {
      console.warn(`  [edgar/shareholders] daily index HTTP ${res.status}`);
    }
    return [];
  }

  const rows = parseDailyIndex(res.body).filter(
    (r) => TARGET_FORMS.has(r.formType) && trackedCiks.has(r.cik),
  );
  console.log(`  [edgar/shareholders] ${rows.length} relevant 13D/G rows in ${url.slice(url.lastIndexOf("/") + 1)}`);

  const out: ShareholderFiling[] = [];
  for (const row of rows) {
    // Filename pattern: edgar/data/{cik_int}/{accession-no-dashes}.txt or .../{accession}-index.html
    const accMatch = row.filename.match(/(\d{10}-\d{2}-\d{6})/);
    if (!accMatch) continue;
    const accession = accMatch[1]!;
    let parsed: { body: string; docName: string } | null = null;
    try {
      parsed = await fetchPrimaryFromFilingIndex(row.cik, accession);
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
  return out;
}
