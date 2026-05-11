import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createAdminClient } from "./client";

// ---------------------------------------------------------------------------
// Storage utility — provider-agnostic file storage
//
// IMPORTANT DESIGN RULE:
// Never store full URLs in the database.
// Always store relative paths only: 'bills/s2847.txt', 'regulations/epa-2026.txt'
// Resolve to full URL via getStorageUrl() at read time.
//
// STORAGE_PROVIDER=supabase  → Supabase Storage (default)
// STORAGE_PROVIDER=r2        → Cloudflare R2 via S3-compatible API
// ---------------------------------------------------------------------------

function getR2Client(): S3Client {
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const accessKeyId = process.env["CLOUDFLARE_R2_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["CLOUDFLARE_R2_SECRET_ACCESS_KEY"];
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("Missing Cloudflare R2 credentials (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, CLOUDFLARE_R2_SECRET_ACCESS_KEY)");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function getStorageUrl(path: string): string {
  const provider = process.env["STORAGE_PROVIDER"] || "supabase";

  if (provider === "r2") {
    const r2Url = process.env["CLOUDFLARE_R2_PUBLIC_URL_DOCUMENTS"];
    if (!r2Url) throw new Error("Missing CLOUDFLARE_R2_PUBLIC_URL_DOCUMENTS");
    return `${r2Url}/${path}`;
  }

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!supabaseUrl) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  return `${supabaseUrl}/storage/v1/object/public/civitics-documents/${path}`;
}

export async function uploadFile(
  path: string,
  content: string | Buffer,
  contentType: string = "text/plain"
): Promise<string> {
  const provider = process.env["STORAGE_PROVIDER"] || "supabase";

  if (provider === "r2") {
    const client = getR2Client();
    const bucket = process.env["CLOUDFLARE_R2_BUCKET_DOCUMENTS"] || "civitics-documents";
    const body = typeof content === "string" ? Buffer.from(content) : content;

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: path,
        Body: body,
        ContentType: contentType,
      })
    );

    return path;
  }

  // Supabase Storage
  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from("civitics-documents")
    .upload(path, content, {
      contentType,
      upsert: true,
    });

  if (error) throw error;
  return path;
}

export async function getFile(path: string): Promise<string> {
  const url = getStorageUrl(path);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch file at ${path}: ${response.statusText}`);
  }
  return response.text();
}

export async function fileExists(path: string): Promise<boolean> {
  const provider = process.env["STORAGE_PROVIDER"] || "supabase";

  if (provider === "r2") {
    try {
      const client = getR2Client();
      const bucket = process.env["CLOUDFLARE_R2_BUCKET_DOCUMENTS"] || "civitics-documents";
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: path }));
      return true;
    } catch {
      return false;
    }
  }

  try {
    const supabase = createAdminClient();
    const parts = path.split("/");
    const folder = parts.slice(0, -1).join("/");
    const filename = parts[parts.length - 1];

    const { data } = await supabase.storage
      .from("civitics-documents")
      .list(folder || undefined);

    return data?.some((f) => f.name === filename) ?? false;
  } catch {
    return false;
  }
}

// Note: R2 cache helpers for opaque pipeline artifacts (e.g. FEC bulk zips,
// FIX-192) live in `./storage-server.ts` to keep their `fs` / `stream` imports
// out of the client bundle. Import them via `@civitics/db/server-storage`.
