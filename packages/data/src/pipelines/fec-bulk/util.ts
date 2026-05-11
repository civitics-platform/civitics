import * as fs       from "fs";
import * as path     from "path";
import * as https    from "https";
import * as unzipper from "unzipper";
import {
  headCacheObject,
  downloadCacheObjectToDisk,
  uploadCacheObjectFromDisk,
} from "@civitics/db/server-storage";

/**
 * Extract a single entry from a zip file to disk via pipe (streaming — no full-buffer materialization).
 * Returns true if the entry was found, false if not.
 */
export async function extractZipEntryToDisk(
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
        if (!found && matchName(name)) {
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

/** Convert FEC date "MMDDYYYY" → ISO "YYYY-MM-DD". Returns null if invalid. */
export function parseFecDate(mmddyyyy: string): string | null {
  if (!mmddyyyy || mmddyyyy.length !== 8) return null;
  const mm   = mmddyyyy.slice(0, 2);
  const dd   = mmddyyyy.slice(2, 4);
  const yyyy = mmddyyyy.slice(4, 8);
  if (!/^\d+$/.test(mm + dd + yyyy)) return null;
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// HEAD + download helpers (FIX-192 + FIX-193)
//
// FEC bulk URLs at fec.gov/files/bulk-downloads/{cycle}/X.zip 302-redirect to a
// cloud.gov-hosted S3 bucket. The redirected response carries Last-Modified and
// ETag headers — usable as a freshness watermark.
//
// All helpers below degrade gracefully:
//   - headFecFile()       → null on network error (caller treats as "always process")
//   - downloadWithR2Cache → falls through to FEC if R2 is unavailable or stale
// ---------------------------------------------------------------------------

export interface FecHead {
  lastModified: string | null;  // RFC1123 string straight from HTTP header
  etag:         string | null;
  contentLength: number | null;
}

/** HEAD a URL, following 302 redirects. Returns null on any network error. */
export async function headFecFile(url: string, maxRedirects = 5): Promise<FecHead | null> {
  return new Promise((resolve) => {
    const visit = (targetUrl: string, hopsLeft: number): void => {
      const req = https.request(targetUrl, { method: "HEAD" }, (res) => {
        const { statusCode, headers } = res;
        res.resume();
        if ((statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) && headers.location) {
          if (hopsLeft <= 0) { resolve(null); return; }
          visit(headers.location, hopsLeft - 1);
          return;
        }
        if (statusCode !== 200) { resolve(null); return; }
        const lm  = (headers["last-modified"] as string | undefined) ?? null;
        const et  = (headers["etag"]          as string | undefined) ?? null;
        const cl  = headers["content-length"] as string | undefined;
        const len = cl ? parseInt(cl, 10) : NaN;
        resolve({
          lastModified: lm,
          etag:         et,
          contentLength: isNaN(len) ? null : len,
        });
      });
      req.on("error", () => resolve(null));
      req.end();
    };
    visit(url, maxRedirects);
  });
}

/** Parse an HTTP Last-Modified string to a Date. Returns null on failure. */
export function parseLastModified(s: string | null | undefined): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

export interface DownloadFromR2OrUpstreamResult {
  source: "r2" | "fec";
  fecHead: FecHead | null;
}

/**
 * Download a FEC bulk file, preferring the R2 cache when fresh.
 *
 * Decision order (FIX-192):
 *   1. HEAD R2 + HEAD FEC.
 *   2. If R2 exists AND R2.LastModified >= FEC.LastModified → download from R2.
 *   3. Else download from FEC (via the supplied fecDownloader, which already
 *      handles redirects). On success, kick off a background R2 upload that
 *      the caller may choose to await or fire-and-forget.
 *
 * R2 unavailable (no creds, network failure, missing object) is non-fatal —
 * the caller still gets the file from FEC. The returned `fecHead` is what the
 * caller should use to advance the watermark.
 *
 * Returns a tuple containing the source the file came from and the FEC
 * HEAD result (for watermark advancement). When `r2UploadPromise` is non-null
 * the caller may await it for tests; otherwise it is a fire-and-forget upload
 * that runs to completion in the background.
 */
export async function downloadWithR2Cache(
  fecUrl:        string,
  r2Key:         string,
  destPath:      string,
  fecDownloader: (url: string, destPath: string) => Promise<void>,
): Promise<DownloadFromR2OrUpstreamResult & { r2UploadPromise: Promise<boolean> | null }> {
  const [r2Head, fecHead] = await Promise.all([
    headCacheObject(r2Key),
    headFecFile(fecUrl),
  ]);

  const r2Lm  = r2Head?.lastModified ?? null;
  const fecLm = parseLastModified(fecHead?.lastModified);

  // R2 is fresh iff we know both LM values and R2's is not older than FEC's.
  // If we can't compare (either missing), fall back to FEC to avoid serving
  // stale bytes.
  const r2Fresh = r2Lm !== null && fecLm !== null && r2Lm.getTime() >= fecLm.getTime();

  if (r2Fresh) {
    const ok = await downloadCacheObjectToDisk(r2Key, destPath);
    if (ok) {
      return { source: "r2", fecHead, r2UploadPromise: null };
    }
    // R2 HEAD succeeded but GET failed — fall through to FEC.
  }

  await fecDownloader(fecUrl, destPath);

  // Best-effort: repopulate cache from the freshly downloaded file. Caller
  // may await for tests; production calls should `void` the promise.
  const r2UploadPromise = uploadCacheObjectFromDisk(r2Key, destPath);
  return { source: "fec", fecHead, r2UploadPromise };
}
