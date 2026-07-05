/**
 * FIX-253 · EDGAR util helpers.
 *
 * Small, dependency-free building blocks shared across the pipeline. Nothing
 * here hits the network or the DB — keep it that way so the test surface is
 * easy to reason about.
 */

const TITLE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:chief\s+executive\s+officer|^ceo$|\bceo\b)/i, "ceo"],
  [/\b(?:chief\s+financial\s+officer|^cfo$|\bcfo\b)/i, "cfo"],
  [/\b(?:chief\s+operating\s+officer|^coo$|\bcoo\b)/i, "coo"],
  [/\bchair(?:man|person|woman)?\b/i,                  "chairperson"],
  [/\bpresident\b/i,                                   "president"],
  [/\bdirector\b/i,                                    "director"],
];

/** Pad CIK to the 10-digit zero-prefixed form SEC URLs expect. */
export function padCik(raw: string | number): string {
  const s = String(raw).trim();
  if (!s) return "";
  return s.padStart(10, "0");
}

/** Map a free-form filed title string to one of the role_category enum values. */
export function classifyTitle(title: string): string {
  if (!title) return "officer";
  for (const [re, cat] of TITLE_PATTERNS) {
    if (re.test(title)) return cat;
  }
  return "officer";
}

/** Strip "0000320193-24-000123" → "000032019324000123" for filing URL paths. */
export function accessionPathSegment(accession: string): string {
  return accession.replace(/-/g, "");
}

/**
 * Parse cents from strings like "$1,234,567", "1234567", "1,234.56".
 * Returns null on parse failure; never throws. Treats bare integers as USD
 * (DEF 14A Summary Compensation Tables disclose total comp in whole dollars).
 */
export function parseUsdCents(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  // FIX-742: a mis-parsed / oversized comp cell (concatenated table numbers,
  // scientific-notation source like "8.49e+22") yields a value past
  // Number.MAX_SAFE_INTEGER. JS then serializes it as scientific notation, which
  // Postgres rejects on the total_compensation_cents BIGINT column
  // ("invalid input syntax for type bigint: \"8.49e+22\"") — and because the
  // officers are written as a single 500-row upsert chunk, that ONE bad value
  // failed the whole chunk and dropped real officer rows + 339 filings alongside
  // it (2026-07-05). Reject anything that isn't a safe integer (which is also
  // strictly within bigint range) so the garbage value is skipped and the chunk
  // lands. Legit exec comp maxes ~$100M (1e10 cents) — far under the guard.
  if (!Number.isSafeInteger(cents)) {
    console.warn(
      `  [edgar/util] parseUsdCents: dropping out-of-range value ${JSON.stringify(raw)} (=${cents}) — exceeds safe bigint range`,
    );
    return null;
  }
  return cents;
}

/** Parse a percentage string ("7.3%", "7.3") to a numeric. Null on failure. */
export function parsePercent(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[%\s]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Best-effort YYYY-MM-DD parse. Accepts ISO, "September 24, 2024", "9/24/24". */
export function parseFilingDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

/** Current calendar year (UTC) — used as the default for DEF 14A effective_year. */
export function currentYear(): number {
  return new Date().getUTCFullYear();
}
