/**
 * FIX-766 — multi-part CSV extraction from a USASpending Full/Delta zip.
 *
 * USASpending splits each FY Full archive into 1,000,000-row CSV parts inside a
 * single zip (FY2026 contracts = 3 parts, assistance = 4). The old
 * `extractCsvFromZip` took only the FIRST `.csv` entry and `autodrain()`'d the
 * rest, so every run since inception silently ingested only ~1/N of the awards
 * and still reported success. This enumerates EVERY `.csv` entry via the zip's
 * central directory (random access — never streams the whole archive), letting
 * the caller extract → process → delete one part at a time to bound disk. Each
 * part carries its own header row, so per-file `columns:true` parsing is
 * unchanged. Delta archives get the same enumeration for free — a multi-part
 * delta must not silently truncate either.
 */

import * as fs       from "fs";
import * as unzipper from "unzipper";

export interface ZipCsvPart {
  /** Entry path inside the zip (e.g. FY2026_All_Contracts_Full_20260704_1.csv). */
  path: string;
  /** Stream this single entry to destPath. Opens its own read stream over the
   *  entry's byte range, so parts not yet extracted stay only inside the zip. */
  extractTo(destPath: string): Promise<void>;
}

/**
 * Enumerate every `.csv` entry in `zipPath`, sorted by entry path for a
 * deterministic part order. Reads only the central directory up front (cheap
 * even on a 2 GB archive); each returned part streams its bytes lazily on
 * `extractTo()`. Non-`.csv` members (readmes, etc.) are ignored.
 */
export async function openCsvParts(zipPath: string): Promise<ZipCsvPart[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dir = await (unzipper as any).Open.file(zipPath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = (dir.files as any[])
    .filter((f) => f.type === "File" && String(f.path).toLowerCase().endsWith(".csv"))
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));

  return entries.map((entry) => ({
    path: entry.path as string,
    extractTo: (destPath: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(destPath);
        entry
          .stream()
          .on("error", reject)
          .pipe(out)
          .on("finish", () => resolve())
          .on("error", reject);
      }),
  }));
}
