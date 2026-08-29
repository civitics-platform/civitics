/**
 * Self-counted vendor usage (FIX-1090).
 *
 * ── WHY SELF-COUNTING AT ALL ─────────────────────────────────────────────────
 *
 * Two providers in the cost chain expose no usage number we can read:
 *
 *   Mapbox — the token we hold is a `pk.` publishable token; analytics/v1
 *            answers 403 "requires a token with analytics:read scope", and
 *            /accounts/v1/{user}/subscriptions 404s. (Probed 2026-08-22.)
 *   Resend — GET /emails returns only the retained tail: 84 rows,
 *            `has_more: false` at limit=100, oldest 2026-07-27. Good enough to
 *            cross-check a month, not good enough to BE the counter.
 *
 * ── THE TABLE ALREADY EXISTED, AND WAS EMPTY ─────────────────────────────────
 *
 * `service_usage` was built in Phase 1 (migration 0006) explicitly to "track
 * Mapbox map loads". On prod it holds **zero rows**. The cause is not the
 * FIX-695 missing RPC — that landed, and `increment_service_usage` exists on
 * prod today. The cause was that the only component which called the tracker,
 * `app/components/DistrictMap.tsx`, was ORPHANED: nothing imported it. (That
 * file was deleted outright in FIX-1119; the finding stands and this is the
 * record of why the counter read zero.) The two live billable Mapbox sites (the
 * server-side Geocoding v6 call in `api/auth/verify-constituent`, and the map
 * mount in `districts/components/SingleDistrictMap`) never counted anything.
 *
 * A counter nobody increments reads exactly like a service nobody uses. That is
 * the failure mode this module exists to close, and it is why the metric is
 * labelled a LOWER BOUND rather than a measurement.
 *
 * ── BEST-EFFORT IS A REQUIREMENT, NOT A COMPROMISE ───────────────────────────
 *
 * The Resend counter sits on the alert-email path. An alert that fails to send
 * because its usage counter could not be written would be a monitoring system
 * that breaks the thing it monitors. So every write here swallows its own
 * errors, and callers increment only AFTER the real work has already succeeded.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** `service_usage.period` format — 'YYYY-MM', UTC. */
export function currentUsagePeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Increment one (service, metric, period) counter by 1. Never throws, never
 * rejects — a caller can `await` it on a hot path without risking the request.
 */
export async function recordServiceUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  service: string,
  metric: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).rpc("increment_service_usage", {
      p_service: service,
      p_metric: metric,
      p_period: currentUsagePeriod(now),
    });
  } catch {
    // Deliberately silent. See the header: counting must never cost the caller.
  }
}

export type SelfCounts = {
  /** metric → count, for the requested period. Missing metric ⇒ absent key. */
  byMetric: Record<string, number>;
  total: number;
};

/**
 * Read this period's self-counts for one service.
 *
 * Returns zeroes rather than an error on failure: the snapshot writer treats a
 * missing self-count as "0 so far", which is the same thing a genuinely unused
 * service looks like, and both are honestly served by the LOWER BOUND label the
 * metric carries.
 */
export async function getServiceSelfCounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  service: string,
  now: Date = new Date(),
): Promise<SelfCounts> {
  const empty: SelfCounts = { byMetric: {}, total: 0 };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from("service_usage")
      .select("metric, count")
      .eq("service", service)
      .eq("period", currentUsagePeriod(now));
    if (error || !Array.isArray(data)) return empty;

    const byMetric: Record<string, number> = {};
    let total = 0;
    for (const row of data as { metric: string; count: number }[]) {
      const n = Number(row.count) || 0;
      byMetric[row.metric] = n;
      total += n;
    }
    return { byMetric, total };
  } catch {
    return empty;
  }
}

/**
 * Mapbox metrics that cost money, and the ones that do not.
 *
 * `map_load` is a billed map load. `geocode_request` is a billed Temporary
 * Geocoding request. `map_activated`, `geolocation_used` and `address_used` are
 * UI-funnel counters from the pre-existing tracker — they describe user
 * behaviour, not vendor billing, and summing them into the metric would inflate
 * it with events Mapbox never charged for.
 *
 * The two billable counters share ONE metric row against the 50,000-load free
 * tier (design decision), which is the SMALLER of the two Mapbox allowances
 * (loads 50k, temporary geocode 100k) and therefore the conservative
 * denominator. The split rides in the metric's metadata so the conflation stays
 * visible.
 */
export const MAPBOX_BILLABLE_METRICS = ["map_load", "geocode_request"] as const;

export function mapboxBillableTotal(counts: SelfCounts): number {
  return MAPBOX_BILLABLE_METRICS.reduce((sum, m) => sum + (counts.byMetric[m] ?? 0), 0);
}
