/**
 * Platform usage snapshot helpers.
 *
 * computePlatformUsagePayload — runs the full vendor-API + DB-sum aggregation
 *   that used to live inside /api/platform/usage GET. Calls out to:
 *     - Anthropic monthly spend (api_usage_logs SUM)
 *     - Supabase SQL self-metrics (RPC)
 *     - Supabase Management API (HTTP, optional)
 *     - pipeline_state.platform_plan overrides
 *     - platform_limits + platform_usage
 *   Writes the live numbers back to platform_usage (same behavior the GET
 *   route had — keeps "current value" rows fresh) and returns the assembled
 *   PlatformUsageResponse-shaped payload.
 *
 * writePlatformUsageSnapshot — compute then INSERT a row into
 *   platform_usage_snapshot. Called by /api/cron/platform-snapshot every
 *   10 minutes. Never throws — partial failure produces a snapshot row
 *   with `error` set so the dashboard can still render the last good
 *   payload from the previous cron tick.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getPlatformUsage,
  updateUsage,
  type PlanTier,
  type PlatformMetric,
} from "./platform-usage";
import {
  getSupabaseSqlMetrics,
  getSupabaseManagementMetrics,
} from "./supabase-usage";

// ── Types ─────────────────────────────────────────────────────────────────────

type UsageRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
};

export type PlatformUsageSummary = {
  total_overage_cost: number;
  top3_by_pct: PlatformMetric[];
  top3_by_cost: PlatformMetric[];
  any_critical: boolean;
  any_warning: boolean;
  needs_verification: boolean;
  critical_count: number;
  warning_count: number;
  unverified_count: number;
};

export type PlatformUsagePayload = {
  plan: PlanTier;
  plan_overrides: Record<string, string>;
  metrics: PlatformMetric[];
  by_service: Record<string, PlatformMetric[]>;
  total_metrics: number;
  summary: PlatformUsageSummary;
  timestamp: string;
};

export type PlatformSnapshotResult = {
  payload: PlatformUsagePayload;
  any_critical: boolean;
  any_warning: boolean;
  total_overage_cost: number;
  error: string | null;
};

// ── Anthropic monthly spend (USD) ─────────────────────────────────────────────
//
// Kept local to this file (rather than imported from anthropic-usage.ts)
// because anthropic-usage's getMonthlyAnthropicSpend has a 60s module cache
// that would mask vendor-API freshness on the cron path. The cron runs every
// 10 min and wants the current value; the AI per-request gate wants the
// cached value. Same SQL, different cache discipline.

async function getMonthlyAnthropicSpend(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<number | null> {
  try {
    const monthStart = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    ).toISOString();

    const { data: rows } = await db
      .from("api_usage_logs")
      .select("input_tokens, output_tokens, cost_cents")
      .eq("service", "anthropic")
      .gte("created_at", monthStart);

    if (!rows) return null;

    const total = ((rows as UsageRow[]) ?? []).reduce((sum, r) => {
      if (r.input_tokens != null && r.output_tokens != null) {
        return sum + (r.input_tokens * 0.25 + r.output_tokens * 1.25) / 1_000_000;
      }
      return sum + (r.cost_cents ?? 0) / 100;
    }, 0);

    return Math.round(total * 10000) / 10000;
  } catch {
    return null;
  }
}

// ── Main compute ──────────────────────────────────────────────────────────────

export async function computePlatformUsagePayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<PlatformSnapshotResult> {
  const errors: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;

  // Plan overrides
  let planOverrides: Record<string, string> = {};
  try {
    const { data: planState } = await anyDb
      .from("pipeline_state")
      .select("value")
      .eq("key", "platform_plan")
      .maybeSingle();
    planOverrides =
      (planState?.value as Record<string, string> | null) ?? {};
  } catch (err) {
    errors.push(`plan_overrides: ${err instanceof Error ? err.message : String(err)}`);
  }
  const defaultPlan: PlanTier = "free";

  // Anthropic live spend → platform_usage
  try {
    const spend = await getMonthlyAnthropicSpend(anyDb);
    if (spend !== null) {
      await updateUsage(db, "anthropic", "monthly_spend_usd", spend, "api");
    }
  } catch (err) {
    errors.push(`anthropic: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Supabase live metrics → platform_usage. Each side is independent and
  // either may degrade; we keep going either way.
  try {
    const supabaseSql = await getSupabaseSqlMetrics(db);
    if (!("error" in supabaseSql)) {
      await Promise.all([
        updateUsage(db, "supabase", "db_size_bytes", supabaseSql.db_size_bytes, "api"),
        updateUsage(db, "supabase", "storage_bytes", supabaseSql.storage_bytes, "api"),
      ]);
    } else {
      errors.push(`supabase_sql: ${supabaseSql.error}`);
    }
  } catch (err) {
    errors.push(`supabase_sql: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const supabaseMgmt = await getSupabaseManagementMetrics();
    if (!("error" in supabaseMgmt)) {
      await Promise.all([
        updateUsage(db, "supabase", "api_requests_7d", supabaseMgmt.api_requests_7d, "api"),
        updateUsage(db, "supabase", "disk_used_bytes", supabaseMgmt.disk_used_bytes, "api"),
      ]);
    } else {
      // Management API is optional (no token → benign error). Only flag
      // when it's a real HTTP error, not the missing-token branch
      // (supabase-usage.ts returns "SUPABASE_MANAGEMENT_API_KEY not set").
      if (!/MANAGEMENT_API_KEY/i.test(supabaseMgmt.error)) {
        errors.push(`supabase_mgmt: ${supabaseMgmt.error}`);
      }
    }
  } catch (err) {
    errors.push(`supabase_mgmt: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Pull free-tier limits + apply per-service plan overrides
  const allMetrics = await getPlatformUsage(db, defaultPlan);
  const upgradedServices = Object.entries(planOverrides).filter(
    ([, plan]) => plan !== defaultPlan,
  );

  let finalMetrics = allMetrics;

  if (upgradedServices.length > 0) {
    const overrideResults = await Promise.all(
      upgradedServices.map(async ([service, plan]) => ({
        service,
        metrics: await getPlatformUsage(db, plan as PlanTier),
      })),
    );

    finalMetrics = allMetrics.filter(
      (m) => !upgradedServices.some(([svc]) => svc === m.service),
    );

    for (const { service, metrics } of overrideResults) {
      finalMetrics.push(...metrics.filter((m) => m.service === service));
    }

    finalMetrics.sort((a, b) =>
      a.service === b.service
        ? a.sort_order - b.sort_order
        : a.service.localeCompare(b.service),
    );
  }

  const byService: Record<string, PlatformMetric[]> = {};
  for (const m of finalMetrics) {
    if (!byService[m.service]) byService[m.service] = [];
    byService[m.service]!.push(m);
  }

  let totalOverageCost = 0;
  const metricsWithValues = finalMetrics.filter((m) => m.value !== null);
  for (const m of metricsWithValues) totalOverageCost += m.overage_cost;

  const top3ByPct = [...metricsWithValues]
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 3);
  const top3ByCost = [...metricsWithValues]
    .sort((a, b) => b.overage_cost - a.overage_cost || b.pct - a.pct)
    .slice(0, 3);

  const anyCritical = metricsWithValues.some((m) => m.status === "critical");
  const anyWarning = metricsWithValues.some((m) => m.status === "warning");
  const needsVerification = metricsWithValues.some(
    (m) => m.source_display.needsVerification,
  );

  const criticalCount = metricsWithValues.filter((m) => m.status === "critical").length;
  const warningCount = metricsWithValues.filter((m) => m.status === "warning").length;
  const unverifiedCount = metricsWithValues.filter(
    (m) => m.source_display.needsVerification,
  ).length;

  const payload: PlatformUsagePayload = {
    plan: defaultPlan,
    plan_overrides: planOverrides,
    metrics: finalMetrics,
    by_service: byService,
    total_metrics: finalMetrics.length,
    summary: {
      total_overage_cost: totalOverageCost,
      top3_by_pct: top3ByPct,
      top3_by_cost: top3ByCost,
      any_critical: anyCritical,
      any_warning: anyWarning,
      needs_verification: needsVerification,
      critical_count: criticalCount,
      warning_count: warningCount,
      unverified_count: unverifiedCount,
    },
    timestamp: new Date().toISOString(),
  };

  return {
    payload,
    any_critical: anyCritical,
    any_warning: anyWarning,
    total_overage_cost: totalOverageCost,
    error: errors.length > 0 ? errors.join("; ") : null,
  };
}

// ── Snapshot write ────────────────────────────────────────────────────────────

export async function writePlatformUsageSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<PlatformSnapshotResult> {
  const result = await computePlatformUsagePayload(db);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  await anyDb.from("platform_usage_snapshot").insert({
    any_critical: result.any_critical,
    any_warning: result.any_warning,
    total_overage_cost: result.total_overage_cost,
    payload: result.payload,
    error: result.error,
  });

  return result;
}
