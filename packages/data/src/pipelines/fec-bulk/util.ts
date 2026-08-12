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

/** FEC bulk URL for candidate master (cn{yy}.zip) per cycle. FIX-246. */
export function candMasterUrl(cycle: string): string {
  const yy = cycle.slice(2);
  return `https://www.fec.gov/files/bulk-downloads/${cycle}/cn${yy}.zip`;
}

/**
 * Parse FEC "LASTNAME, FIRSTNAME [MIDDLE]" → { last, first } in uppercase.
 *
 * Two or more leading single-letter tokens are joined with periods so that
 * "VANCE, J D" → first = "J.D." rather than "J" (FIX-247). Single-token
 * proper first names are preserved as-is: "VANCE, JOHN D" → first = "JOHN".
 *
 * Middle names / suffixes past the leading initial cluster (or past a single
 * proper first name) are dropped — callers can reconstruct from the raw input
 * if they need them.
 */
export function parseFecName(candName: string): { last: string; first: string } {
  const commaIdx = candName.indexOf(",");
  if (commaIdx < 0) return { last: candName.toUpperCase().trim(), first: "" };
  const last  = candName.slice(0, commaIdx).toUpperCase().trim();
  const rawAfter = candName.slice(commaIdx + 1).trim();
  if (!rawAfter) return { last, first: "" };

  const tokens = rawAfter.split(/\s+/).map((t) => t.toUpperCase());

  // Collect leading single-letter initials, tolerating a trailing period or
  // comma on each token. "J", "J.", and "J," all count as one initial.
  const initials: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const stripped = tokens[i].replace(/[.,]+$/, "");
    if (stripped.length === 1 && /^[A-Z]$/.test(stripped)) {
      initials.push(stripped);
      i++;
    } else {
      break;
    }
  }

  if (initials.length >= 2) {
    // Two or more leading initials → join with periods.
    return { last, first: initials.join(".") + "." };
  }
  if (initials.length === 1 && tokens.length === 1) {
    // Single token that is a single letter (e.g. "PRYCE, B"). Store as-is.
    return { last, first: initials[0] };
  }
  if (initials.length === 1) {
    // One leading initial followed by a proper name (rare, e.g. "DOE, J SMITH").
    // The initial is the first name; the following tokens are middle.
    return { last, first: initials[0] };
  }
  // First token is a proper name — use as-is, drop any trailing middle tokens.
  return { last, first: tokens[0] };
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

// ---------------------------------------------------------------------------
// R2 cache freshness — compare like with like (FIX-1014)
//
// The original check was `r2Object.LastModified >= fec.LastModified`. Those
// answer different questions: the left side is when WE finished uploading, the
// right side is when FEC published. A republish landing between our HEAD and
// our upload therefore stamps SUPERSEDED bytes with a NEWER timestamp than
// FEC's current file, and every later run reads that as fresh — silently
// serving a stale copy for a full ingest cycle with no signal anywhere.
//
// The fix is to stamp FEC's OWN reported headers onto the object as user
// metadata at upload time and compare stored-FEC vs live-FEC. The R2 object's
// own LastModified and ETag drop out of the decision entirely — the ETag in
// particular is NOT comparable to FEC's, because multipart chunk sizes differ
// between our uploader and theirs (measured 2026-08-11: our indiv26 copy reads
// `-123` parts against FEC's `-246` for byte-identical content).
//
// Content-Length stays in the check as cheap belt-and-braces: in the 2026-08-09
// near-miss the two candidate files were 3.3% apart, so a size compare alone
// would have caught it, and it costs one integer compare.
// ---------------------------------------------------------------------------

/** R2 user-metadata keys (stored on the wire as `x-amz-meta-<key>`). */
export const FEC_META_LAST_MODIFIED  = "fec-last-modified";
export const FEC_META_CONTENT_LENGTH = "fec-content-length";
export const FEC_META_ETAG           = "fec-etag";

/** What FEC reported about a file — either just now, or when we cached it. */
export interface FecProvenance {
  lastModified:  string | null;
  contentLength: string | null;  // string on both sides so the compare is literal
  etag:          string | null;
}

export type R2FreshnessReason =
  | "match"
  | "no-cache-object"
  | "no-stored-metadata"
  | "no-stored-last-modified"
  | "no-live-last-modified"
  | "last-modified-mismatch"
  | "content-length-mismatch"
  | "etag-mismatch";

export interface R2FreshnessDecision {
  fresh:  boolean;
  reason: R2FreshnessReason;
  stored: FecProvenance;  // FEC-reported-then, read off the R2 object's metadata
  live:   FecProvenance;  // FEC-reported-now, from the HEAD we just did
}

/** Minimal shape of an R2 HEAD result. Deliberately narrower than
 *  `CacheObjectHead` so the freshness decision cannot reach the object's own
 *  LastModified/ETag even by accident (FIX-1014). */
export interface R2HeadLike {
  metadata?: Record<string, string> | null;
}

function readMetaKey(meta: Record<string, string> | null | undefined, key: string): string | null {
  if (!meta) return null;
  // S3/R2 lowercase metadata keys on retrieval; tolerate either form.
  const v = meta[key] ?? meta[key.toLowerCase()] ?? meta[key.toUpperCase()];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Read FEC's stamped provenance off an R2 object's user metadata. */
export function readStoredFecProvenance(meta: Record<string, string> | null | undefined): FecProvenance {
  return {
    lastModified:  readMetaKey(meta, FEC_META_LAST_MODIFIED),
    contentLength: readMetaKey(meta, FEC_META_CONTENT_LENGTH),
    etag:          readMetaKey(meta, FEC_META_ETAG),
  };
}

/** Normalize a live FEC HEAD into the same shape as the stored provenance. */
export function liveFecProvenance(head: FecHead | null | undefined): FecProvenance {
  return {
    lastModified:  head?.lastModified ?? null,
    contentLength: head?.contentLength != null ? String(head.contentLength) : null,
    etag:          head?.etag ?? null,
  };
}

/** Same HTTP date? Compared by parsed timestamp so a header FORMAT change on
 *  FEC's side doesn't read as a new publish (same rule as FIX-754's
 *  `sameLastModified`; duplicated here to avoid a util↔run-state import cycle). */
function sameHttpDate(a: string, b: string): boolean {
  const pa = parseLastModified(a);
  const pb = parseLastModified(b);
  if (pa && pb) return pa.getTime() === pb.getTime();
  return a === b;
}

/** Both-null counts as equal; one-sided presence is a real change signal. */
function sameLength(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return a === b;
}

/**
 * Decide whether the cached object still corresponds to FEC's current file.
 *
 * PURE — no network, no clock. Fresh iff FEC's stamped headers equal FEC's
 * live headers. Anything unknowable resolves to STALE, including an object
 * with no `fec-*` metadata at all: objects cached before FIX-1014 have
 * unknowable provenance (that IS the bug), so they are re-fetched once and
 * re-uploaded with metadata. That one-time re-download is deliberate and is
 * not a backfill candidate — there is nothing trustworthy to backfill FROM.
 */
export function evaluateR2Freshness(
  r2Head:  R2HeadLike | null | undefined,
  fecHead: FecHead | null | undefined,
): R2FreshnessDecision {
  const live = liveFecProvenance(fecHead);
  const none: FecProvenance = { lastModified: null, contentLength: null, etag: null };

  if (!r2Head) return { fresh: false, reason: "no-cache-object", stored: none, live };

  const stored = readStoredFecProvenance(r2Head.metadata);

  if (stored.lastModified === null && stored.contentLength === null && stored.etag === null) {
    return { fresh: false, reason: "no-stored-metadata", stored, live };
  }
  if (stored.lastModified === null) {
    return { fresh: false, reason: "no-stored-last-modified", stored, live };
  }
  if (live.lastModified === null) {
    return { fresh: false, reason: "no-live-last-modified", stored, live };
  }
  if (!sameHttpDate(stored.lastModified, live.lastModified)) {
    return { fresh: false, reason: "last-modified-mismatch", stored, live };
  }
  if (!sameLength(stored.contentLength, live.contentLength)) {
    return { fresh: false, reason: "content-length-mismatch", stored, live };
  }
  if (stored.etag !== live.etag) {
    return { fresh: false, reason: "etag-mismatch", stored, live };
  }
  return { fresh: true, reason: "match", stored, live };
}

function fmtProvenance(p: FecProvenance): string {
  return `lm="${p.lastModified ?? "-"}" len=${p.contentLength ?? "-"} etag=${p.etag ?? "-"}`;
}

/** One auditable line per cache decision, both sides shown (FIX-1014). */
export function formatR2FreshnessDecision(r2Key: string, d: R2FreshnessDecision): string {
  return (
    `    ⟳ r2 cache ${d.fresh ? "HIT " : "MISS"} ${r2Key} [${d.reason}] — ` +
    `stored ${fmtProvenance(d.stored)} | live ${fmtProvenance(d.live)} (FIX-1014)`
  );
}

/**
 * Build the metadata to stamp on an upload from the FEC HEAD that describes
 * the bytes we just downloaded.
 *
 * Returns null — meaning "do not cache these bytes" — when the head cannot
 * vouch for them:
 *   - no live Last-Modified (HEAD failed): an unstamped object is permanently
 *     stale under `evaluateR2Freshness`, so uploading it is pure waste.
 *   - the file on disk is not the size FEC advertised: the head does not
 *     describe these bytes (partial download, or a republish landed between
 *     our HEAD and our GET), so stamping it would be a lie.
 *
 * Note the remaining benign race, which fails SAFE: if FEC republishes between
 * our HEAD and our GET and the new file happens to be the same length, we
 * stamp the old Last-Modified onto new bytes. Next run compares stored-old
 * against live-new, sees a mismatch, and re-downloads. Wasteful, never stale.
 */
export function buildFecCacheMetadata(
  fecHead:     FecHead | null | undefined,
  bytesOnDisk?: number | null,
): Record<string, string> | null {
  const lm = fecHead?.lastModified ?? null;
  if (!lm) return null;

  const advertised = fecHead?.contentLength ?? null;
  if (advertised != null && bytesOnDisk != null && advertised !== bytesOnDisk) return null;

  const meta: Record<string, string> = { [FEC_META_LAST_MODIFIED]: lm };
  if (advertised != null)     meta[FEC_META_CONTENT_LENGTH] = String(advertised);
  if (fecHead?.etag)          meta[FEC_META_ETAG]           = fecHead.etag;
  return meta;
}

/**
 * Download a FEC bulk file, preferring the R2 cache when fresh.
 *
 * Decision order (FIX-192, freshness rule replaced by FIX-1014):
 *   1. HEAD R2 + HEAD FEC.
 *   2. If the object's stamped FEC provenance equals FEC's live headers →
 *      download from R2. The object's own LastModified/ETag are NEVER consulted.
 *   3. Else download from FEC (via the supplied fecDownloader, which already
 *      handles redirects). On success, kick off a background R2 upload —
 *      stamped with FEC's headers — that the caller may await or fire-and-forget.
 *
 * R2 unavailable (no creds, network failure, missing object) is non-fatal —
 * the caller still gets the file from FEC. The returned `fecHead` is what the
 * caller should use to advance the watermark.
 *
 * Returns a tuple containing the source the file came from and the FEC
 * HEAD result (for watermark advancement). When `r2UploadPromise` is non-null
 * the caller may await it for tests; otherwise it is a fire-and-forget upload
 * that runs to completion in the background. It is null when the cache was
 * used, or when the bytes could not be vouched for (see buildFecCacheMetadata).
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

  const decision = evaluateR2Freshness(r2Head, fecHead);
  console.log(formatR2FreshnessDecision(r2Key, decision));

  if (decision.fresh) {
    const ok = await downloadCacheObjectToDisk(r2Key, destPath);
    if (ok) {
      return { source: "r2", fecHead, r2UploadPromise: null };
    }
    // R2 HEAD succeeded but GET failed — fall through to FEC.
    console.warn(`    ⟳ r2 cache GET failed for ${r2Key} after a HIT — falling through to FEC`);
  }

  await fecDownloader(fecUrl, destPath);

  // Best-effort: repopulate cache from the freshly downloaded file, stamped
  // with FEC's own headers so the next run can compare like with like. Caller
  // may await for tests; production calls should `void` the promise.
  let bytesOnDisk: number | null = null;
  try { bytesOnDisk = fs.statSync(destPath).size; } catch { /* leave null */ }

  const metadata = buildFecCacheMetadata(fecHead, bytesOnDisk);
  if (!metadata) {
    console.warn(
      `    ⟳ r2 cache upload SKIPPED for ${r2Key} — FEC head cannot vouch for these bytes ` +
        `(live lm="${fecHead?.lastModified ?? "-"}" len=${fecHead?.contentLength ?? "-"} ` +
        `vs on-disk ${bytesOnDisk ?? "-"}); an unstamped object would never be a cache hit (FIX-1014)`,
    );
    return { source: "fec", fecHead, r2UploadPromise: null };
  }

  const r2UploadPromise = uploadCacheObjectFromDisk(r2Key, destPath, "application/zip", metadata);
  return { source: "fec", fecHead, r2UploadPromise };
}
