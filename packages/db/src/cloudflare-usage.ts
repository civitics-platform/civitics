/**
 * Cloudflare R2 metrics — for the Platform Costs card.
 *
 * Pulls per-bucket storage + class-A/B operation counts in a single GraphQL
 * round trip against the Cloudflare Analytics API. Two datasets are queried
 * under the same `viewer.accounts[]` node:
 *
 *   r2StorageAdaptiveGroups    → latest payloadSize per bucket (today's reading)
 *   r2OperationsAdaptiveGroups → SUM(requests) per bucket × actionType, MTD
 *
 * Cloudflare classifies R2 operations into pricing classes:
 *   Class A (writes, more expensive): Put*, *MultipartUpload, *UploadPart*,
 *                                     Copy*, List* (bucket and objects), Set*
 *   Class B (reads, cheaper):         Get*, Head*, Usage*
 *   Free:                             Delete*, Abort*
 *
 * Operations not mapped to a class are counted as Class A (conservative — over-
 * counting writes is safer than under-counting them for billing alerts).
 *
 * 5-minute in-memory cache (mirrors getSupabaseManagementMetrics). The cron
 * runs every 10 min and the debug route hits the helper directly; the cache
 * keeps both off the GraphQL API on burst loads.
 *
 * Failures (missing token, HTTP error, schema mismatch) return { error } —
 * never throws. The snapshot compute path expects this shape and degrades to
 * "partial: true" rather than losing the whole tick.
 */

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Public types ──────────────────────────────────────────────────────────────

export type CloudflareR2BucketUsage = {
  storage_bytes: number;
  class_a_ops: number;
  class_b_ops: number;
};

export type CloudflareR2Usage = {
  buckets: Record<string, CloudflareR2BucketUsage>;
  totals: CloudflareR2BucketUsage;
  fetched_at: string;
};

export type CloudflareR2UsageError = { error: string };

// ── Class A / Class B mapping ─────────────────────────────────────────────────
//
// Sourced from https://developers.cloudflare.com/r2/pricing/. Patterns are
// matched against the GraphQL `actionType` dimension (e.g. "PutObject",
// "GetObject", "UploadPart", "CompleteMultipartUpload").

const CLASS_A_PATTERNS: RegExp[] = [
  /^Put/,
  /^Copy/,
  /^List/,
  /^Create/,
  /MultipartUpload$/,
  /^UploadPart/,
  /^Set/,
];

const CLASS_B_PATTERNS: RegExp[] = [
  /^Get/,
  /^Head/,
  /^Usage/,
];

const FREE_PATTERNS: RegExp[] = [
  /^Delete/,
  /^Abort/,
];

function classify(actionType: string): "a" | "b" | "free" {
  for (const p of CLASS_B_PATTERNS) if (p.test(actionType)) return "b";
  for (const p of FREE_PATTERNS) if (p.test(actionType)) return "free";
  for (const p of CLASS_A_PATTERNS) if (p.test(actionType)) return "a";
  return "a";
}

// ── In-memory cache ───────────────────────────────────────────────────────────

let cached: CloudflareR2Usage | null = null;
let cacheExpiresAt = 0;

export function clearCloudflareUsageCache(): void {
  cached = null;
  cacheExpiresAt = 0;
}

// ── GraphQL query ─────────────────────────────────────────────────────────────
//
// Storage retention on r2StorageAdaptiveGroups is 31 days, so a 30-day window
// is safe. We take the latest payloadSize per bucket via descending sort + a
// per-bucket first-row pick downstream.
//
// Operations are summed across the current calendar month so the totals match
// what Cloudflare's billing dashboard shows for the in-cycle period.

type StorageGroup = {
  dimensions: { bucketName: string; date: string };
  max: {
    payloadSize: number | null;
    metadataSize: number | null;
    objectCount: number | null;
  };
};

type OpsGroup = {
  dimensions: { bucketName: string; actionType: string };
  sum: { requests: number | null };
};

type GraphQLResponse = {
  data?: {
    viewer?: {
      accounts?: Array<{
        r2StorageAdaptiveGroups?: StorageGroup[];
        r2OperationsAdaptiveGroups?: OpsGroup[];
      }>;
    };
  };
  errors?: Array<{ message: string }>;
};

function buildQuery(accountTag: string, monthStart: string, today: string): string {
  return JSON.stringify({
    query: `
      query R2Usage($tag: String!, $monthStart: Date!, $today: Date!) {
        viewer {
          accounts(filter: { accountTag: $tag }) {
            r2StorageAdaptiveGroups(
              limit: 1000
              filter: { date_geq: $today }
              orderBy: [date_DESC]
            ) {
              dimensions { bucketName date }
              max { payloadSize metadataSize objectCount }
            }
            r2OperationsAdaptiveGroups(
              limit: 10000
              filter: { date_geq: $monthStart }
            ) {
              dimensions { bucketName actionType }
              sum { requests }
            }
          }
        }
      }
    `,
    variables: { tag: accountTag, monthStart, today },
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getCloudflareR2Usage(): Promise<
  CloudflareR2Usage | CloudflareR2UsageError
> {
  if (cached && Date.now() < cacheExpiresAt) {
    return cached;
  }

  const token = process.env["CLOUDFLARE_API_TOKEN"];
  const accountTag = process.env["CLOUDFLARE_ACCOUNT_ID"];
  if (!token) return { error: "CLOUDFLARE_API_TOKEN not set" };
  if (!accountTag) return { error: "CLOUDFLARE_ACCOUNT_ID not set" };

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  // Storage is daily; if today's reading hasn't landed yet, fall back to
  // yesterday by widening to a 2-day window and taking the most recent row.
  const yesterday = new Date(now.getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);

  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: buildQuery(accountTag, monthStart, yesterday),
      cache: "no-store",
    } as RequestInit & { cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload" });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      return { error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const json = (await res.json()) as GraphQLResponse;
    if (json.errors?.length) {
      return { error: json.errors.map((e) => e.message).join("; ").slice(0, 200) };
    }

    const account = json.data?.viewer?.accounts?.[0];
    if (!account) {
      return { error: "GraphQL returned no account row" };
    }

    const buckets: Record<string, CloudflareR2BucketUsage> = {};

    // Take latest payloadSize per bucket from the date-desc storage rows.
    for (const row of account.r2StorageAdaptiveGroups ?? []) {
      const name = row.dimensions.bucketName || "(unknown)";
      if (buckets[name]) continue; // already took the first (latest) row
      buckets[name] = {
        storage_bytes:
          (row.max.payloadSize ?? 0) + (row.max.metadataSize ?? 0),
        class_a_ops: 0,
        class_b_ops: 0,
      };
    }

    // Add operation counts.
    for (const row of account.r2OperationsAdaptiveGroups ?? []) {
      const name = row.dimensions.bucketName || "(unknown)";
      if (!buckets[name]) {
        buckets[name] = { storage_bytes: 0, class_a_ops: 0, class_b_ops: 0 };
      }
      const reqs = row.sum.requests ?? 0;
      const cls = classify(row.dimensions.actionType);
      if (cls === "a") buckets[name].class_a_ops += reqs;
      else if (cls === "b") buckets[name].class_b_ops += reqs;
    }

    const totals: CloudflareR2BucketUsage = {
      storage_bytes: 0,
      class_a_ops: 0,
      class_b_ops: 0,
    };
    for (const b of Object.values(buckets)) {
      totals.storage_bytes += b.storage_bytes;
      totals.class_a_ops += b.class_a_ops;
      totals.class_b_ops += b.class_b_ops;
    }

    const result: CloudflareR2Usage = {
      buckets,
      totals,
      fetched_at: new Date().toISOString(),
    };
    cached = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
