/**
 * FIX-253 · DEF 14A officer-roster + compensation parser.
 *
 * DEF 14A bodies are HTML proxy statements with no enforced template; the
 * Summary Compensation Table (SCT) is the de-facto canonical roster source.
 * Strategy:
 *   1. From the company's recent filings, pick the most recent DEF 14A /
 *      DEF 14A/A within the last 18 months.
 *   2. Fetch the primary document.
 *   3. Use node-html-parser to find the SCT-anchored table.
 *   4. Extract rows: name + title from the leftmost cell, total comp from
 *      the rightmost numeric cell.
 *   5. Tolerate any failure mode — log + emit zero officers for that company.
 *
 * This is heuristic, not authoritative. Expect ~60-80% coverage of S&P 500
 * DEF 14As on first pass; the remainder needs filing-specific patterns
 * (follow-up FIXes — keep the log to find systematic misses).
 */

import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { normalizeName } from "../fec-bulk/indiv";
import { edgarFetch } from "./client";
import { accessionPathSegment, classifyTitle, currentYear, parseUsdCents } from "./util";
import type { CompanyRecord, SubmissionFiling } from "./companies";

// 18 months — typical DEF 14A cycle is annual, but late filers or amendments
// up to 18 months back still represent the current officer roster.
const MAX_FILING_AGE_DAYS = 18 * 30;

const HEADING_RE = /summary\s+compensation\s+table|executive\s+compensation|named\s+executive\s+officers/i;

// Real SCTs have a column header row that mentions both "Salary" and "Total"
// (or "Total Compensation"). Stylistic / TOC tables do not.
const SCT_COLUMN_HEADER_RE = /\bsalary\b[\s\S]{0,500}\btotal\b/i;

// Words that strongly suggest a row is a section heading, not a person name.
const NAME_BLOCKLIST = new Set([
  "COMPENSATION", "OFFICERS", "OFFICER", "INFORMATION", "PLAN", "PLANS",
  "PROPOSALS", "PROPOSAL", "EXECUTIVE", "DIRECTORS", "DIRECTOR", "TABLE",
  "TABLES", "REQUIRED", "VOTE", "VOTES", "GENERAL", "MANAGEMENT",
  "SHAREHOLDER", "SHAREHOLDERS", "BOARD", "AUDIT", "COMMITTEE", "REPORT",
  "EQUITY", "AWARDS", "OPTION", "BONUS", "SALARY", "TOTAL", "SECTION",
  "ELECTION", "OTHER", "ANNUAL", "MEETING", "INDEPENDENT", "RISK",
  "NOMINEES", "GOVERNANCE", "POLICIES", "POLICY",
]);

const MIN_REAL_COMP_CENTS = 100_000_00;     // $100k — filters page numbers + line counts

// Title keywords that anchor the name|title split inside the SCT's leftmost
// cell. Apple's SCT writes "Tim Cook Chief Executive Officer" as a single
// cell; we find the first keyword to slice the name off the front.
const TITLE_KEYWORD_RE = /\b(?:Chief|President|Senior|Vice|Director|Chairman|Chairwoman|Chairperson|Chair|Treasurer|Secretary|Controller|Founder|Managing|Executive|Officer|General\s+Counsel|Head\s+of)\b/;

export interface ParsedOfficer {
  fullName:                 string;
  canonicalName:            string;
  title:                    string;
  roleCategory:             string;
  totalCompensationCents:   number | null;
  sourceFilingType:         string;       // "DEF 14A" | "DEF 14A/A"
  sourceAccession:          string;
  effectiveYear:            number;
}

export interface Def14aParseResult {
  companyId:        string;       // edgar_companies.id
  financialEntityId: string;      // for downstream matcher convenience
  cik:              string;
  filing:           SubmissionFiling | null;
  officers:         ParsedOfficer[];
  unparseable:      boolean;      // true when filing was located but yielded zero officers
}

function pickRecentDef14a(filings: SubmissionFiling[]): SubmissionFiling | null {
  const cutoff = Date.now() - MAX_FILING_AGE_DAYS * 24 * 3600 * 1000;
  for (const f of filings) {
    if (f.form !== "DEF 14A" && f.form !== "DEF 14A/A") continue;
    const t = Date.parse(f.filingDate);
    if (!Number.isFinite(t)) continue;
    if (t < cutoff) return null;             // filings are listed most-recent first
    return f;
  }
  return null;
}

function buildPrimaryDocUrl(cikPadded: string, filing: SubmissionFiling): string {
  const cikInt = String(parseInt(cikPadded, 10));
  const seg = accessionPathSegment(filing.accessionNumber);
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${seg}/${filing.primaryDocument}`;
}

/** Decode the common HTML entities EDGAR filings actually emit. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&#1[60]0;/g, " ")
    .replace(/&#x[Aa]0;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"');
}

/** Plain-text reduction of an HTML cell, with double-line semantics preserved. */
function cellText(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  // Replace <br> with newline before grabbing text so multi-line cells split.
  const html = el.innerHTML.replace(/<br\s*\/?>/gi, "\n");
  const stripped = html.replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();
}

// 2-4 capitalized words; each must contain at least one lowercase letter so
// "EXECUTIVE OFFICERS"-style all-caps section captions are rejected.
const NAME_LINE_RE = /^([A-Z][a-z][A-Za-z'.\-]*(?:\s+(?:[A-Z]\.?|[A-Z][a-z][A-Za-z'.\-]*)){1,4}(?:\s+(?:Jr|Sr|II|III|IV)\.?)?)$/;

function nameContainsBlocklisted(name: string): boolean {
  for (const w of name.toUpperCase().split(/\s+/)) {
    if (NAME_BLOCKLIST.has(w)) return true;
  }
  return false;
}

interface ExtractedRow { name: string; title: string; totalCents: number | null; }

/**
 * Try to split a "Tim Cook Chief Executive Officer" blob into (name, title)
 * by anchoring on the first title keyword. Falls back to the raw text if no
 * keyword is found.
 */
function splitNameAndTitle(blob: string): { name: string; title: string } {
  const flat = blob.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return { name: "", title: "" };
  const match = flat.match(TITLE_KEYWORD_RE);
  if (!match || match.index === undefined || match.index === 0) {
    return { name: flat, title: "" };
  }
  const name = flat.slice(0, match.index).trim();
  const title = flat.slice(match.index).trim();
  return { name, title };
}

function extractRowFromCells(cells: HTMLElement[]): ExtractedRow | null {
  if (cells.length < 2) return null;
  const firstText = cellText(cells[0]);
  if (!firstText) return null;

  // The first cell can come in two shapes:
  //   (a) "Tim Cook\nChief Executive Officer" (newline-separated)
  //   (b) "Tim Cook Chief Executive Officer" (single line; Apple's format)
  // splitNameAndTitle handles (b); the line-split below handles (a).
  let name = "";
  let title = "";

  const lines = firstText.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length > 1) {
    for (const line of lines) {
      if (!name && NAME_LINE_RE.test(line) && !nameContainsBlocklisted(line)) {
        name = line;
        continue;
      }
      if (name && !title) {
        title = line;
        break;
      }
    }
  }

  if (!name) {
    const sliced = splitNameAndTitle(firstText);
    if (sliced.name && NAME_LINE_RE.test(sliced.name) && !nameContainsBlocklisted(sliced.name)) {
      name = sliced.name;
      title = sliced.title;
    }
  }

  if (!name) {
    // SCT sometimes splits name/title across the first two cells.
    const second = cellText(cells[1] ?? null);
    if (second && NAME_LINE_RE.test(firstText) && !nameContainsBlocklisted(firstText)) {
      name = firstText;
      title = second;
    }
  }
  if (!name) return null;

  // Total comp = rightmost cell that parses as a USD amount above the real-NEO
  // floor. Pre-FIX-253-debug the rightmost numeric cell sometimes captured a
  // page number ("3300") from a TOC table; the floor rejects those.
  let totalCents: number | null = null;
  for (let i = cells.length - 1; i >= 1; i--) {
    const t = cellText(cells[i] ?? null);
    const c = parseUsdCents(t);
    if (c !== null && c >= MIN_REAL_COMP_CENTS) { totalCents = c; break; }
  }
  if (totalCents === null) return null;       // require real comp to keep the SCT signal high

  return { name, title, totalCents };
}

function extractOfficersFromTable(table: HTMLElement): ExtractedRow[] {
  const rows: ExtractedRow[] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("td");
    if (cells.length === 0) continue;
    const row = extractRowFromCells(cells);
    if (row) rows.push(row);
  }
  return rows;
}

function locateSctTable(root: HTMLElement): HTMLElement | null {
  // The Summary Compensation Table is uniquely identified by a column header
  // row mentioning both "Salary" and "Total" (or "Total Compensation"). TOC
  // tables, governance tables, etc. don't have this signature.
  const candidates: HTMLElement[] = [];
  for (const t of root.querySelectorAll("table")) {
    const text = t.text ?? "";
    if (!SCT_COLUMN_HEADER_RE.test(text)) continue;
    candidates.push(t);
  }
  if (candidates.length === 0) return null;

  // Prefer a candidate that's preceded by or contains the SCT heading text.
  for (const t of candidates) {
    if (HEADING_RE.test(t.text ?? "")) return t;
    let prev: HTMLElement | null = t.previousElementSibling as HTMLElement | null;
    for (let step = 0; step < 10 && prev; step++) {
      const prevText = (prev.text ?? "").slice(0, 500);
      if (HEADING_RE.test(prevText)) return t;
      prev = prev.previousElementSibling as HTMLElement | null;
    }
  }
  // Otherwise return the widest of the candidates (SCT has 9-11 columns; smaller
  // tables matching the "salary…total" hint are less likely to be it).
  let best = candidates[0]!;
  let bestCols = 0;
  for (const t of candidates) {
    const firstRow = t.querySelector("tr");
    const cols = firstRow ? firstRow.querySelectorAll("th, td").length : 0;
    if (cols > bestCols) { best = t; bestCols = cols; }
  }
  return best;
}

export async function parseDef14a(company: CompanyRecord): Promise<Def14aParseResult> {
  const filing = pickRecentDef14a(company.recentFilings);
  const result: Def14aParseResult = {
    companyId:         company.edgarCompanyId,
    financialEntityId: company.financialEntityId,
    cik:               company.universe.cik,
    filing,
    officers:          [],
    unparseable:       false,
  };
  if (!filing || !filing.primaryDocument) return result;

  const url = buildPrimaryDocUrl(company.universe.cik, filing);
  let body: string;
  try {
    const res = await edgarFetch(url, { accept: "text/html,*/*" });
    if (!res.ok) {
      console.warn(`  [edgar/def14a] ${company.universe.ticker} ${filing.accessionNumber} HTTP ${res.status}`);
      result.unparseable = true;
      return result;
    }
    body = res.body;
  } catch (err) {
    console.warn(`  [edgar/def14a] ${company.universe.ticker} ${filing.accessionNumber} fetch failed: ${err instanceof Error ? err.message : err}`);
    result.unparseable = true;
    return result;
  }

  let root: HTMLElement;
  try {
    root = parseHtml(body, { lowerCaseTagName: true });
  } catch (err) {
    console.warn(`  [edgar/def14a] ${company.universe.ticker} parse failed: ${err instanceof Error ? err.message : err}`);
    result.unparseable = true;
    return result;
  }

  const table = locateSctTable(root);
  if (!table) {
    result.unparseable = true;
    return result;
  }

  const rows = extractOfficersFromTable(table);
  if (rows.length === 0) {
    result.unparseable = true;
    return result;
  }

  // De-dup by canonical name (same officer can appear in multiple comp years).
  const seen = new Set<string>();
  const year = filing.filingDate ? Number(filing.filingDate.slice(0, 4)) : currentYear();
  for (const r of rows) {
    const canonical = normalizeName(r.name);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.officers.push({
      fullName:                r.name,
      canonicalName:           canonical,
      title:                   r.title || "(unknown)",
      roleCategory:            classifyTitle(r.title),
      totalCompensationCents:  r.totalCents,
      sourceFilingType:        filing.form,
      sourceAccession:         filing.accessionNumber,
      effectiveYear:           year,
    });
  }
  if (result.officers.length === 0) result.unparseable = true;
  return result;
}
