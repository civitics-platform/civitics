/**
 * Supabase self-metrics — for the Platform Costs card.
 *
 * Two helpers, two auth paths:
 *
 *  - getSupabaseSqlMetrics(adminClient)
 *      Calls the public.get_supabase_self_metrics() RPC. Cheap, uses the
 *      existing admin client (SUPABASE_SECRET_KEY). Returns db_size_bytes
 *      and storage_bytes.
 *
 *  - getSupabaseManagementMetrics()
 *      Hits the Supabase Management API at api.supabase.com/v1/projects/{ref}/...
 *      Needs SUPABASE_MANAGEMENT_API_KEY (Personal Access Token from
 *      supabase.com/dashboard/account/tokens). Returns api_requests_total,
 *      function_invocations, disk_used_bytes. 5-minute in-memory cache to
 *      stay well under any rate limit. Returns { error } if the env var is
 *      missing — never throws.
 *
 * Egress is not exposed by any public Supabase API as of May 2026 — that row
 * stays manual and is flagged via platform_limits.has_public_api=false so the
 * card can render it differently from "stale manual".
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Project ref (matches CLAUDE.md / Vercel env) ──────────────────────────────
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const MGMT_BASE = "https://api.supabase.com/v1";

// ── Public types ──────────────────────────────────────────────────────────────

export type SupabaseSqlMetrics = {
  db_size_bytes: number;
  storage_bytes: number;
};

export type SupabaseSqlMetricsError = {
  error: string;
};

export type SupabaseManagementMetrics = {
  /** Sum of REST + Auth + Realtime + Storage requests over the last 7 days.
   *  The Management API's analytics endpoint caps at 7day intervals — there's
   *  no monthly-cycle equivalent. */
  api_requests_7d: number;
  disk_used_bytes: number;
  fetched_at: string;
};

export type SupabaseManagementMetricsError = {
  error: string;
};

// ── SQL metrics ───────────────────────────────────────────────────────────────

export async function getSupabaseSqlMetrics(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
): Promise<SupabaseSqlMetrics | SupabaseSqlMetricsError> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = supabase as any;
  const { data, error } = await anyDb.rpc("get_supabase_self_metrics");

  if (error) {
    return { error: error.message };
  }

  // RPC returns a single-row TABLE; PostgREST surfaces it as an array.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return { error: "RPC returned no rows" };
  }

  return {
    db_size_bytes: Number(row.db_size_bytes ?? 0),
    storage_bytes: Number(row.storage_bytes ?? 0),
  };
}

// ── Management API metrics ────────────────────────────────────────────────────

const MGMT_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedMgmt: SupabaseManagementMetrics | null = null;
let cachedMgmtExpiresAt = 0;

/** Bust the in-memory Management API cache. Used by the admin force-refresh route. */
export function clearSupabaseManagementCache(): void {
  cachedMgmt = null;
  cachedMgmtExpiresAt = 0;
}

type UsageApiCountsResponse = {
  result?: Array<{
    timestamp: string;
    total_auth_requests: number;
    total_realtime_requests: number;
    total_rest_requests: number;
    total_storage_requests: number;
  }>;
  error?: unknown;
};

type DiskUtilResponse = {
  timestamp: string;
  metrics: {
    fs_size_bytes: number;
    fs_avail_bytes: number;
    fs_used_bytes: number;
  };
};

async function mgmtGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${MGMT_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // Avoid Next.js fetch caching the response — we run our own 5-min cache.
    cache: "no-store",
  } as RequestInit & { cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload" });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function sumApiRequests(json: UsageApiCountsResponse): number {
  if (!Array.isArray(json.result)) return 0;
  let total = 0;
  for (const row of json.result) {
    total +=
      (row.total_auth_requests ?? 0) +
      (row.total_realtime_requests ?? 0) +
      (row.total_rest_requests ?? 0) +
      (row.total_storage_requests ?? 0);
  }
  return total;
}

export async function getSupabaseManagementMetrics(): Promise<
  SupabaseManagementMetrics | SupabaseManagementMetricsError
> {
  if (cachedMgmt && Date.now() < cachedMgmtExpiresAt) {
    return cachedMgmt;
  }

  const token = process.env["SUPABASE_MANAGEMENT_API_KEY"];
  if (!token) {
    return { error: "SUPABASE_MANAGEMENT_API_KEY not set" };
  }

  try {
    // 7day is the largest interval the analytics endpoint accepts —
    // 'monthly' returns 400. function-invocations endpoint requires a per-
    // function ID and we don't deploy Edge Functions, so it's omitted entirely.
    const [apiCounts, disk] = await Promise.all([
      mgmtGet<UsageApiCountsResponse>(
        `/projects/${PROJECT_REF}/analytics/endpoints/usage.api-counts?interval=7day`,
        token,
      ),
      mgmtGet<DiskUtilResponse>(`/projects/${PROJECT_REF}/config/disk/util`, token),
    ]);

    const result: SupabaseManagementMetrics = {
      api_requests_7d: sumApiRequests(apiCounts),
      disk_used_bytes: Number(disk.metrics?.fs_used_bytes ?? 0),
      fetched_at: new Date().toISOString(),
    };

    cachedMgmt = result;
    cachedMgmtExpiresAt = Date.now() + MGMT_CACHE_TTL_MS;
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
