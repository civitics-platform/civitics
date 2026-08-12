/**
 * Server-only storage helpers — fs/stream-dependent (FIX-192).
 *
 * Lives in its own module so that Next.js client bundles don't try to resolve
 * `fs` / `stream/promises` via the package's main `index.ts`. Import from
 * `@civitics/db/server-storage` in server-only paths (pipelines, route
 * handlers running in node).
 *
 * All helpers degrade gracefully (return null/false) when R2 credentials are
 * unavailable, so call sites can treat the cache as best-effort.
 */
import { S3Client, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import * as fs from "fs";
import { pipeline as streamPipeline } from "stream/promises";
import type { Readable } from "stream";

function getCacheBucketName(): string {
  return process.env["CLOUDFLARE_R2_BUCKET_CACHE"] || "civitics-cache";
}

function tryGetR2Client(): S3Client | null {
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const accessKeyId = process.env["CLOUDFLARE_R2_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["CLOUDFLARE_R2_SECRET_ACCESS_KEY"];
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export interface CacheObjectHead {
  /**
   * The OBJECT's own timestamps/identity — i.e. when WE finished uploading, and
   * how OUR uploader chunked the bytes. Do NOT compare these to an upstream
   * source's Last-Modified / ETag: they answer a different question (FIX-1014).
   * Use `metadata` for upstream-reported provenance stamped at upload time.
   */
  lastModified: Date | null;
  contentLength: number | null;
  etag: string | null;
  /**
   * User metadata (`x-amz-meta-*`), keys lowercased and the prefix stripped by
   * the SDK. Null when the object carries none.
   */
  metadata: Record<string, string> | null;
}

/** HEAD an object in the cache bucket. Returns null if R2 unavailable or object missing. */
export async function headCacheObject(key: string): Promise<CacheObjectHead | null> {
  const client = tryGetR2Client();
  if (!client) return null;
  try {
    const res = await client.send(
      new HeadObjectCommand({ Bucket: getCacheBucketName(), Key: key }),
    );
    return {
      lastModified: res.LastModified ?? null,
      contentLength: res.ContentLength ?? null,
      etag: res.ETag ?? null,
      metadata: res.Metadata && Object.keys(res.Metadata).length > 0 ? res.Metadata : null,
    };
  } catch {
    return null;
  }
}

/**
 * Stream-download a cache object to disk. Returns true on success, false on any
 * failure. Caller should fall back to the upstream source on false.
 */
export async function downloadCacheObjectToDisk(key: string, destPath: string): Promise<boolean> {
  const client = tryGetR2Client();
  if (!client) return false;
  try {
    const res = await client.send(
      new GetObjectCommand({ Bucket: getCacheBucketName(), Key: key }),
    );
    const body = res.Body as Readable | undefined;
    if (!body) return false;
    await streamPipeline(body, fs.createWriteStream(destPath));
    return true;
  } catch {
    try { fs.unlinkSync(destPath); } catch { /* ok */ }
    return false;
  }
}

/**
 * Upload a file from disk to the cache bucket via multipart (lib-storage).
 * Designed for FEC bulk zips that can exceed S3's 5 GB single-PUT limit.
 * Errors are swallowed and logged; returns true on success, false otherwise.
 *
 * `metadata` is stored as `x-amz-meta-<key>` and comes back from
 * `headCacheObject().metadata`. Callers use it to record what the UPSTREAM
 * source reported for these bytes, so a later freshness check can compare
 * upstream-then against upstream-now instead of against the object's own
 * timestamp (FIX-1014). Values must be US-ASCII.
 */
export async function uploadCacheObjectFromDisk(
  key: string,
  srcPath: string,
  contentType: string = "application/zip",
  metadata?: Record<string, string>,
): Promise<boolean> {
  const client = tryGetR2Client();
  if (!client) return false;
  try {
    const upload = new Upload({
      client,
      params: {
        Bucket: getCacheBucketName(),
        Key: key,
        Body: fs.createReadStream(srcPath),
        ContentType: contentType,
        ...(metadata && Object.keys(metadata).length > 0 ? { Metadata: metadata } : {}),
      },
      queueSize: 4,
      partSize: 16 * 1024 * 1024, // 16 MB parts
      leavePartsOnError: false,
    });
    await upload.done();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`    R2 cache upload failed for ${key}: ${msg}`);
    return false;
  }
}
