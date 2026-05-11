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
  lastModified: Date | null;
  contentLength: number | null;
  etag: string | null;
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
 */
export async function uploadCacheObjectFromDisk(
  key: string,
  srcPath: string,
  contentType: string = "application/zip",
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
