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
 *      supabase.com/dashboard/account/tokens). Returns api_requests_7d only —
 *      Prometheus (see supabase-prometheus.ts, FIX-349) now sources
 *      disk_used_bytes more reliably, so the Management API's config/disk/util
 *      call was dropped. 5-minute in-memory cache to stay well under any
 *      rate limit. Returns { error } if the env var is missing — never throws.
 *
 * Egress used to live here as "no public API, manual entry only"; FIX-349
 * moved it onto the Prometheus path (node_network_transmit_bytes_total +
 * a small state table for monthly delta) and flipped
 * platform_limits.has_public_api = true for the egress_bytes row.
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
  fetched_at: string;
};

export type SupabaseManagementMetricsError = {
  error: string;
};

export type SupabaseAuthMau = {
  auth_mau: number;
  fetched_at: string;
};

export type SupabaseAuthMauError = {
  error: string;
};

export type SupabaseComputeTier = {
  /** Lowercased tier identifier — micro / small / medium / large / xl / 2xl / … */
  tier: string;
  fetched_at: string;
};

export type SupabaseComputeTierError = {
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

// ── Auth MAUs ─────────────────────────────────────────────────────────────────
//
// Calls the public.get_supabase_auth_mau() RPC (migration
// 20260518000000_supabase_auth_mau.sql), which counts auth.users with
// last_sign_in_at >= NOW() - INTERVAL '30 days'. SECURITY DEFINER inside the
// RPC handles the auth-schema read; this helper just unwraps the BIGINT.
// Cheap (~ms) — no cache.

export async function getSupabaseAuthMau(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
): Promise<SupabaseAuthMau | SupabaseAuthMauError> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = supabase as any;
  const { data, error } = await anyDb.rpc("get_supabase_auth_mau");

  if (error) {
    return { error: error.message };
  }

  // RPC returns BIGINT scalar; PostgREST surfaces it as a number or a
  // single-cell array depending on driver version. Handle both shapes.
  const raw = Array.isArray(data) ? data[0] : data;
  const count = typeof raw === "object" && raw !== null
    ? Number((raw as { get_supabase_auth_mau?: unknown }).get_supabase_auth_mau ?? 0)
    : Number(raw ?? 0);

  return {
    auth_mau: Number.isFinite(count) ? count : 0,
    fetched_at: new Date().toISOString(),
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
    // disk_used_bytes moved to Prometheus (FIX-349) — one HTTP call removed.
    const apiCounts = await mgmtGet<UsageApiCountsResponse>(
      `/projects/${PROJECT_REF}/analytics/endpoints/usage.api-counts?interval=7day`,
      token,
    );

    const result: SupabaseManagementMetrics = {
      api_requests_7d: sumApiRequests(apiCounts),
      fetched_at: new Date().toISOString(),
    };

    cachedMgmt = result;
    cachedMgmtExpiresAt = Date.now() + MGMT_CACHE_TTL_MS;
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Compute tier (Management API addons) ──────────────────────────────────────
//
// FIX-354: db_connections pool max varies by compute add-on tier. Pulled from
// /v1/projects/{ref}/billing/addons — selected_addons[].variant.identifier is
// `ci_<tier>` for compute_instance type. A project on the default Pro compute
// (no compute_instance addon) is treated as "micro". 1-hour cache because tier
// changes are rare (manual upgrade); five-minute cache would burn API quota
// for no benefit.

const COMPUTE_TIER_CACHE_TTL_MS = 60 * 60 * 1000;
let cachedComputeTier: SupabaseComputeTier | null = null;
let cachedComputeTierExpiresAt = 0;

export function clearSupabaseComputeTierCache(): void {
  cachedComputeTier = null;
  cachedComputeTierExpiresAt = 0;
}

type BillingAddon = {
  type?: string;
  variant?: { identifier?: string };
};

type BillingAddonsResponse = {
  selected_addons?: BillingAddon[];
};

export async function getSupabaseComputeTier(): Promise<
  SupabaseComputeTier | SupabaseComputeTierError
> {
  if (cachedComputeTier && Date.now() < cachedComputeTierExpiresAt) {
    return cachedComputeTier;
  }

  const token = process.env["SUPABASE_MANAGEMENT_API_KEY"];
  if (!token) {
    return { error: "SUPABASE_MANAGEMENT_API_KEY not set" };
  }

  try {
    const json = await mgmtGet<BillingAddonsResponse>(
      `/projects/${PROJECT_REF}/billing/addons`,
      token,
    );

    const compute = (json.selected_addons ?? []).find(
      (a) => a.type === "compute_instance",
    );
    const identifier = compute?.variant?.identifier ?? "";
    // `ci_large` → `large`. Falls back to `micro` when no compute_instance
    // addon is selected (= default Pro compute). The caller's lookup table
    // still applies a "large" fallback when this whole helper errors, so
    // the absolute worst case matches the prior static value.
    const tier = identifier.startsWith("ci_")
      ? identifier.slice(3).toLowerCase()
      : "micro";

    const result: SupabaseComputeTier = {
      tier,
      fetched_at: new Date().toISOString(),
    };
    cachedComputeTier = result;
    cachedComputeTierExpiresAt = Date.now() + COMPUTE_TIER_CACHE_TTL_MS;
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// FIX-354: pool max per Supabase compute add-on tier. Source:
// https://supabase.com/docs/guides/database/connection-management.
// Values reflect the dedicated-Postgres connection cap, not the pgBouncer
// pool size (the project queries direct Postgres for self-metrics).
// Re-verify against the docs when adding new tiers — these numbers shift
// occasionally on Supabase's side.
export const SUPABASE_COMPUTE_POOL_MAX: Record<string, number> = {
  nano: 15,
  micro: 15,
  small: 15,
  medium: 15,
  large: 60,
  xl: 120,
  "2xl": 200,
  "4xl": 300,
  "8xl": 400,
  "12xl": 500,
  "16xl": 750,
};

export function poolMaxForTier(tier: string | undefined): number {
  if (!tier) return 60;
  return SUPABASE_COMPUTE_POOL_MAX[tier] ?? 60;
}
