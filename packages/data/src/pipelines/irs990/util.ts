/**
 * FIX-250 — HTTP + CSV streaming helpers for the IRS 990 pipeline.
 *
 * Two distinct fetch shapes:
 *   1. Index CSV — `https://apps.irs.gov/pub/epostcard/990/xml/{YEAR}/index_{YEAR}.csv`
 *      Reasonably small (a few hundred MB at most for a full year). HEAD-cached
 *      via pipeline_state.irs990_index_watermark — skip the year if the
 *      Last-Modified header hasn't moved since the last successful run.
 *   2. Per-filing XML — `https://apps.irs.gov/pub/epostcard/990/xml/{YEAR}/{OBJECT_ID}_public.xml`
 *      Tiny (≤1 MB each), but there can be hundreds across a seed run. Plain
 *      GET with retry/backoff is enough; no caching layer.
 */

import * as https from "https";
import * as fs    from "fs";
import * as path  from "path";
import * as os    from "os";
import * as unzipper from "unzipper";
import { parse as parseCsvRaw } from "csv-parse";

// ---------------------------------------------------------------------------
// Index URL builders
// ---------------------------------------------------------------------------

const IRS_BASE         = "https://apps.irs.gov/pub/epostcard/990/xml";
const IRS_DOWNLOADS_PAGE = "https://www.irs.gov/charities-non-profits/form-990-series-downloads";

export function indexCsvUrl(year: number): string {
  return `${IRS_BASE}/${year}/index_${year}.csv`;
}

/**
 * Discover the per-year TEOS bulk ZIP URLs.
 *
 * Modern (2023+) pattern: `{year}_TEOS_XML_{MM}{LETTER}.zip` where MM ∈ 01..12
 * and LETTER ∈ A..D (variants only present for high-volume months). Pre-2023
 * uses a different bundling scheme (`download990xml_{year}_{N}.zip`,
 * `{year}_TEOS_XML_CT1.zip`) that this pipeline does not yet handle.
 *
 * Rather than encode the discovery rule, we scrape the IRS page once per run.
 * It's one extra HTTP fetch and removes a brittle naming dependency.
 */
export async function getYearZipUrls(year: number): Promise<string[]> {
  const html = await fetchTextUrl(IRS_DOWNLOADS_PAGE);
  if (!html) return [];
  // Match all href= attributes pointing at IRS bulk ZIPs for the requested year.
  const escapedBase = IRS_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedBase}/${year}/[^"\\s<]+\\.zip`, "g");
  const matches = html.match(re) ?? [];
  return Array.from(new Set(matches));
}

// ---------------------------------------------------------------------------
// HEAD with redirect following — used for index-CSV freshness watermarks
// ---------------------------------------------------------------------------

export interface IrsHead {
  lastModified:  string | null;
  etag:          string | null;
  contentLength: number | null;
}

export async function headIrsFile(url: string, maxRedirects = 5): Promise<IrsHead | null> {
  return new Promise((resolve) => {
    const visit = (target: string, hops: number): void => {
      const req = https.request(target, { method: "HEAD" }, (res) => {
        const { statusCode, headers } = res;
        res.resume();
        if ((statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) && headers.location) {
          if (hops <= 0) { resolve(null); return; }
          visit(headers.location, hops - 1);
          return;
        }
        if (statusCode !== 200) { resolve(null); return; }
        const lm  = (headers["last-modified"] as string | undefined) ?? null;
        const et  = (headers["etag"]          as string | undefined) ?? null;
        const cl  = headers["content-length"] as string | undefined;
        const len = cl ? parseInt(cl, 10) : NaN;
        resolve({ lastModified: lm, etag: et, contentLength: isNaN(len) ? null : len });
      });
      req.on("error", () => resolve(null));
      req.end();
    };
    visit(url, maxRedirects);
  });
}

// ---------------------------------------------------------------------------
// GET helpers
// ---------------------------------------------------------------------------

/**
 * Stream-parse the IRS index CSV row-by-row. The full file can be ~100MB for
 * a busy year; never materialize it in memory. The callback runs once per
 * data row (header is consumed by csv-parse with columns:true).
 *
 * Returns the IrsHead from the GET response (Last-Modified + ETag) so the
 * caller can advance the watermark on success.
 */
export interface IndexRow {
  RETURN_ID:     string;
  FILING_TYPE:   string;
  EIN:           string;
  TAX_PERIOD:    string;
  SUB_DATE:      string;
  TAXPAYER_NAME: string;
  RETURN_TYPE:   string;
  DLN:           string;
  OBJECT_ID:     string;
  XML_BATCH_ID:  string;
}

export async function streamIndexCsv(
  url:    string,
  onRow:  (row: IndexRow) => void | Promise<void>,
): Promise<{ headers: IrsHead | null; rowCount: number }> {
  return new Promise((resolve, reject) => {
    let rowCount = 0;
    let headers: IrsHead | null = null;

    const visit = (target: string, hops: number): void => {
      const req = https.get(target, (res) => {
        const { statusCode, headers: resHeaders } = res;

        if ((statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) && resHeaders.location) {
          if (hops <= 0) { res.resume(); reject(new Error("Too many redirects")); return; }
          res.resume();
          visit(resHeaders.location, hops - 1);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${statusCode} for ${target}`));
          return;
        }

        const lm = (resHeaders["last-modified"] as string | undefined) ?? null;
        const et = (resHeaders["etag"]          as string | undefined) ?? null;
        const cl = resHeaders["content-length"] as string | undefined;
        const len = cl ? parseInt(cl, 10) : NaN;
        headers = { lastModified: lm, etag: et, contentLength: isNaN(len) ? null : len };

        const parser = parseCsvRaw({ columns: true, skip_empty_lines: true, trim: true });
        let pending = Promise.resolve();
        let parserErr: Error | null = null;

        parser.on("readable", () => {
          let rec: IndexRow | null;
          while ((rec = parser.read() as IndexRow | null) !== null) {
            rowCount++;
            const r = rec;
            pending = pending.then(() => Promise.resolve(onRow(r)).catch((e: unknown) => {
              parserErr = e instanceof Error ? e : new Error(String(e));
            }));
          }
        });

        parser.on("end", () => {
          pending.then(() => {
            if (parserErr) reject(parserErr);
            else resolve({ headers, rowCount });
          });
        });
        parser.on("error", (err) => reject(err));

        res.pipe(parser);
      });
      req.on("error", reject);
    };

    visit(url, 5);
  });
}

/**
 * Plain GET that buffers a text response into a string. Returns null on any
 * non-2xx or network failure.
 */
async function fetchTextUrl(url: string, maxRedirects = 5): Promise<string | null> {
  return new Promise((resolve) => {
    const visit = (target: string, hops: number): void => {
      const req = https.get(target, (res) => {
        const { statusCode, headers } = res;
        if ((statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) && headers.location) {
          if (hops <= 0) { res.resume(); resolve(null); return; }
          res.resume();
          visit(headers.location, hops - 1);
          return;
        }
        if (statusCode !== 200) { res.resume(); resolve(null); return; }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end",  () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => resolve(null));
      });
      req.on("error", () => resolve(null));
    };
    visit(url, maxRedirects);
  });
}

/**
 * Stream a URL straight to a destination file. Follows redirects. Throws on
 * non-2xx after redirects exhausted.
 */
export async function downloadFileToTemp(url: string, destPath: string, maxRedirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const visit = (target: string, hops: number): void => {
      const req = https.get(target, (res) => {
        const { statusCode, headers } = res;
        if ((statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) && headers.location) {
          if (hops <= 0) { res.resume(); reject(new Error("Too many redirects")); return; }
          res.resume();
          visit(headers.location, hops - 1);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${statusCode} for ${target}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on("finish", () => resolve());
        out.on("error", reject);
        res.on("error", reject);
      });
      req.on("error", reject);
    };
    visit(url, maxRedirects);
  });
}

/**
 * Stream a ZIP from disk, extracting only entries whose basename matches a
 * needed object_id. Returns a Map<object_id, xml-string>.
 *
 * 990 ZIPs contain ~50k filings per monthly archive; we typically need 0-5
 * matches per ZIP. Auto-drain everything else to keep the stream moving.
 *
 * Filenames inside the ZIP: `{OBJECT_ID}_public.xml`. We match on the prefix
 * before `_public.xml` so any variant suffix still resolves.
 */
export async function extractObjectIdXmlsFromZip(
  zipPath:           string,
  neededObjectIds:   Set<string>,
): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, string>();
    const remaining = new Set(neededObjectIds);

    fs.createReadStream(zipPath)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .pipe((unzipper as any).Parse())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .on("entry", (entry: any) => {
        const baseName = path.basename(entry.path as string);
        // Strip _public.xml or just .xml to get the OBJECT_ID candidate.
        const m = baseName.match(/^(\d+)(?:_public)?\.xml$/i);
        if (m && remaining.has(m[1])) {
          const id = m[1];
          const chunks: Buffer[] = [];
          entry.on("data", (c: Buffer) => chunks.push(c));
          entry.on("end", () => {
            found.set(id, Buffer.concat(chunks).toString("utf8"));
            remaining.delete(id);
            // Don't early-exit — unzipper expects us to consume to end of stream.
          });
          entry.on("error", reject);
        } else {
          entry.autodrain();
        }
      })
      .on("finish", () => resolve(found))
      .on("error", reject);
  });
}

/** Convenience: where to write temp ZIPs during a pipeline run. */
export function tempDir(): string {
  const dir = path.join(os.tmpdir(), "irs990");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Delete a path, ignoring missing-file errors. */
export function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Watermark helpers — public.pipeline_state(key TEXT PK, value JSONB)
//
// One row per pipeline+purpose. Key: 'irs990:index_watermark'. Value:
// { "2024": "Mon, 03 May 2026 12:14:00 GMT", "2023": "..." } — Last-Modified
// per year. Skip ingesting a year when its watermark matches the current
// HEAD value.
// ---------------------------------------------------------------------------

const WATERMARK_KEY = "irs990:index_watermark";

export type IndexWatermark = Record<string, string>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadIndexWatermark(db: any): Promise<IndexWatermark> {
  try {
    const { data, error } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", WATERMARK_KEY)
      .maybeSingle();
    if (error) return {};
    return (data?.value as IndexWatermark | null) ?? {};
  } catch {
    return {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function saveIndexWatermark(db: any, wm: IndexWatermark): Promise<void> {
  try {
    await db.from("pipeline_state").upsert({
      key:        WATERMARK_KEY,
      value:      wm,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
  } catch (err) {
    console.warn("  [irs990] watermark save failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Normalize an EIN to digits-only 9-char form. The IRS index sometimes pads
 * with a leading zero or includes whitespace; the seed list stores
 * unambiguous 9-digit strings, so normalization keeps the lookup deterministic.
 */
export function normalizeEin(raw: string): string {
  return (raw ?? "").replace(/\D+/g, "").padStart(9, "0").slice(-9);
}

/**
 * Parse the IRS tax_period CSV column (`YYYYMM`) into the calendar year
 * portion of the filing. 990s are filed for a tax year ending in a given
 * month; we key on the year alone in irs990_filings.tax_year.
 */
export function parseTaxYear(taxPeriod: string): number | null {
  if (!taxPeriod || taxPeriod.length < 4) return null;
  const y = parseInt(taxPeriod.slice(0, 4), 10);
  return isNaN(y) ? null : y;
}
