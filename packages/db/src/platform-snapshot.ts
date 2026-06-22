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
import { selectAllOrThrow } from "./read-helpers";
import {
  getPlatformUsage,
  updateUsage,
  type PlanTier,
  type PlatformMetric,
} from "./platform-usage";
import {
  getSupabaseSqlMetrics,
  getSupabaseManagementMetrics,
  getSupabaseAuthMau,
} from "./supabase-usage";
import { getSupabasePrometheusMetrics } from "./supabase-prometheus";
import { getCloudflareR2Usage } from "./cloudflare-usage";
import { getVercelUsage, type VercelUsage } from "./vercel-usage";
import { getGitHubUsage } from "./github-usage";
import {
  evaluateAutoTrips,
  type AutoTripDecision,
} from "./auto-trip-evaluator";

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
  // PR 3 (FIX-286): per-switch evaluation result from the auto-trip evaluator.
  // Surfaced here so the dashboard can show why a switch did or did not flip
  // without having to cross-reference kill_switch_events.
  auto_trip_decisions: AutoTripDecision[];
  // FIX-356: snapshot-time CPU summary. Lives at the payload root (not inside
  // the metrics array) because the get_supabase_cpu_max RPC reads it back
  // out via a stable JSON path — fishing it from payload->'metrics' would
  // require LATERAL jsonb_array_elements every tick. The PlatformMetric for
  // cpu_pct in `metrics` carries the same numbers in its `metadata` field
  // for the dashboard to render alongside the current value.
  supabase_cpu?: {
    current_pct: number;
    max_1h_pct: number;
    max_24h_pct: number;
    core_count: number;
  };
  // FIX-648: per-ServiceName Vercel EffectiveCost, projected to a monthly
  // run-rate (descending). The "what spiked" breakdown — surfaced on the card
  // and read by the leading fluid-cost alert. `window_days` is the trailing
  // billing window the projection was extrapolated from (typically ~7).
  vercel_breakdown?: {
    window_days: number;
    services: { service: string; usd: number }[];
  };
  timestamp: string;
};

export type PlatformSnapshotResult = {
  payload: PlatformUsagePayload;
  any_critical: boolean;
  any_warning: boolean;
  total_overage_cost: number;
  auto_trips_flipped: number;
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

    // FIX-545: paginate + throw; the surrounding catch keeps the null
    // ("unknown") contract and a >1k-row month no longer undercounts.
    const rows = await selectAllOrThrow<UsageRow>(
      "platform-snapshot anthropic-spend logs",
      (from, to) => db
        .from("api_usage_logs")
        .select("input_tokens, output_tokens, cost_cents")
        .eq("service", "anthropic")
        .gte("created_at", monthStart)
        .order("created_at")
        .range(from, to),
    );

    const total = rows.reduce((sum, r) => {
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

  // FIX-295: Auth MAU count from a thin RPC over auth.users. Independent of
  // the Management API path — failure here doesn't trip partial because the
  // RPC's only failure mode in practice is "migration hasn't applied yet."
  try {
    const authMau = await getSupabaseAuthMau(db);
    if (!("error" in authMau)) {
      await updateUsage(db, "supabase", "auth_mau", authMau.auth_mau, "api");
    } else {
      errors.push(`supabase_auth_mau: ${authMau.error}`);
    }
  } catch (err) {
    errors.push(`supabase_auth_mau: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const supabaseMgmt = await getSupabaseManagementMetrics();
    if (!("error" in supabaseMgmt)) {
      await updateUsage(db, "supabase", "api_requests_7d", supabaseMgmt.api_requests_7d, "api");
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

  // Cloudflare R2 live metrics → platform_usage. Helper returns aggregated
  // totals across every bucket the account holds; per-bucket detail is
  // available for a future per-bucket dashboard tab.
  try {
    const cf = await getCloudflareR2Usage();
    if (!("error" in cf)) {
      await Promise.all([
        updateUsage(db, "cloudflare", "storage_bytes", cf.totals.storage_bytes, "api"),
        updateUsage(db, "cloudflare", "class_a_ops", cf.totals.class_a_ops, "api"),
        updateUsage(db, "cloudflare", "class_b_ops", cf.totals.class_b_ops, "api"),
      ]);
    } else {
      if (!/CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)/i.test(cf.error)) {
        errors.push(`cloudflare: ${cf.error}`);
      }
    }
  } catch (err) {
    errors.push(`cloudflare: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Supabase Prometheus live metrics → platform_usage. Sources egress
  // (counter delta), db_connections (gauge), disk_used_bytes (size − avail
  // on the /data mount), cpu_pct (FIX-355 — busy/total delta ratio).
  // Overrides the disk_used_bytes value the Management API helper used to
  // write — FIX-349 removed that side; both writers used 'source=api', so
  // even if the Mgmt write resurfaced on a stale code path the Prometheus
  // tick lands second and wins.
  let supabaseCpuPayload:
    | {
        current_pct: number;
        max_1h_pct: number;
        max_24h_pct: number;
        core_count: number;
      }
    | null = null;
  try {
    const prom = await getSupabasePrometheusMetrics(db);
    if (!("error" in prom)) {
      await Promise.all([
        // FIX-α: egress is raw NIC transmit (node_network_transmit_bytes_total),
        // an UPPER BOUND on billable egress — it includes replication, PITR/WAL,
        // and intra-AWS traffic, not just bytes to clients. Supabase exposes no
        // public API for billable egress (Management API probed 2026-06-19: every
        // egress endpoint 404s). Write it as "estimated" so the card shows the
        // gray "~ Est." badge and it is excluded from critical/warning alerting.
        updateUsage(db, "supabase", "egress_bytes", prom.egress_bytes_month_to_date, "estimated"),
        updateUsage(db, "supabase", "db_connections", prom.db_connections_active, "api"),
        updateUsage(db, "supabase", "disk_used_bytes", prom.disk_used_bytes, "api"),
        updateUsage(db, "supabase", "cpu_pct", prom.cpu_pct_current, "api"),
      ]);
      supabaseCpuPayload = {
        current_pct: prom.cpu_pct_current,
        max_1h_pct: prom.cpu_max_1h,
        max_24h_pct: prom.cpu_max_24h,
        core_count: prom.cpu_core_count,
      };

      // FIX-351: disk utilization % must divide against provisioned size,
      // not the 8 GB Pro plan-included quota that was seeded. Every other
      // platform_limits row is config-shaped (static seed); this one row
      // is overridden each tick with the actual /data filesystem size
      // from Prometheus so the dashboard % reflects real headroom on the
      // (manually resized) disk.
      await anyDb.from("platform_limits")
        .update({
          included_limit: prom.disk_size_bytes,
          notes: "Dynamically set to provisioned disk size from Prometheus tick. " +
                 "Includes db + WAL + indexes + temp on /data.",
        })
        .eq("service", "supabase")
        .eq("metric", "disk_used_bytes")
        .eq("plan", "pro");

      // FIX-353: db_size_bytes preserves its 8 GB included_limit for
      // billing-overage math ($0.125/GB above included), but the %-bar
      // denominator should be the provisioned disk size (same value
      // FIX-351 already reads for disk_used_bytes). display_limit is the
      // capacity-context override added by 20260524200436; included_limit
      // stays untouched here so overage_cost still shows the real $/mo.
      await anyDb.from("platform_limits")
        .update({ display_limit: prom.disk_size_bytes })
        .eq("service", "supabase")
        .eq("metric", "db_size_bytes")
        .eq("plan", "pro");
    } else {
      if (!/SUPABASE_SECRET_KEY/i.test(prom.error)) {
        errors.push(`supabase_prometheus: ${prom.error}`);
      }
    }
  } catch (err) {
    errors.push(`supabase_prometheus: ${err instanceof Error ? err.message : String(err)}`);
  }

  // FIX-357: db_connections gauge counts Postgres backends, bounded by
  // current_setting('max_connections') — not PgBouncer's default_pool_size,
  // which is what the FIX-354 tier→pool-size lookup table was actually
  // returning. Querying max_connections directly is self-correcting on tier
  // upgrades (Supabase adjusts it automatically) and removes the Management
  // API call + tier cache. On RPC failure we skip the UPDATE, so the value
  // stays last-known-good rather than regressing to a wrong default.
  try {
    const { data: maxConn, error: maxConnErr } = await anyDb.rpc(
      "get_supabase_max_connections",
    );
    if (!maxConnErr && typeof maxConn === "number" && maxConn > 0) {
      await anyDb.from("platform_limits")
        .update({ included_limit: maxConn })
        .eq("service", "supabase")
        .eq("metric", "db_connections")
        .eq("plan", "pro");
    } else if (maxConnErr) {
      errors.push(`supabase_max_connections: ${maxConnErr.message}`);
    }
  } catch (err) {
    errors.push(
      `supabase_max_connections: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // GitHub Actions usage → platform_usage. Pulls org-level billing minutes +
  // shared-storage. Missing token is benign (matches FIX-284 convention — the
  // partial flag stays false so the snapshot still completes cleanly); rows
  // stay on source='manual' until GITHUB_BILLING_TOKEN is added.
  try {
    const gh = await getGitHubUsage();
    if (!("error" in gh)) {
      await Promise.all([
        updateUsage(db, "github", "action_minutes", gh.action_minutes, "api"),
        updateUsage(db, "github", "storage_bytes", gh.storage_bytes, "api"),
      ]);
    } else {
      if (!/GITHUB_BILLING_TOKEN/i.test(gh.error)) {
        errors.push(`github: ${gh.error}`);
      }
    }
  } catch (err) {
    errors.push(`github: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Vercel current-cycle usage → platform_usage.
  //
  // FIX-648: /v1/billing/charges only ever returns a trailing ~window_days-day
  // window (it ignores `from`), so every quantity/cost is a sum over that window
  // — NOT month-to-date. We project each to a 30-day run-rate and persist with
  // source='estimated' (honest gray "~Est." badge; excluded from hard
  // escalation). The un-projected window value rides along in the metric
  // metadata (stitched below) for a "last Nd" sub-label, and the per-service
  // breakdown is projected the same way for the card + leading fluid alert.
  let vercelUsage: VercelUsage | null = null;
  let vercelBreakdown: PlatformUsagePayload["vercel_breakdown"] = undefined;
  try {
    const v = await getVercelUsage();
    if (!("error" in v)) {
      vercelUsage = v;
      const now = new Date();
      const daysInMonth = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
      ).getDate();
      // Extrapolate a window total to a full month at the window's daily rate.
      // window_days===0 (the quantity-only fallback) → pass the value through.
      const project = (raw: number): number =>
        v.window_days > 0 ? (raw / v.window_days) * daysInMonth : raw;

      await Promise.all([
        updateUsage(db, "vercel", "fluid_cpu_seconds", project(v.fluid_cpu_seconds), "estimated"),
        updateUsage(db, "vercel", "function_invocations", project(v.function_invocations), "estimated"),
        updateUsage(db, "vercel", "origin_transfer_bytes", project(v.origin_transfer_bytes), "estimated"),
        updateUsage(db, "vercel", "edge_requests", project(v.edge_requests), "estimated"),
        updateUsage(db, "vercel", "edge_cpu_ms", project(v.edge_cpu_ms), "estimated"),
        updateUsage(db, "vercel", "build_minutes", project(v.build_minutes), "estimated"),
        updateUsage(db, "vercel", "web_analytics_events", project(v.web_analytics_events), "estimated"),
        updateUsage(db, "vercel", "isr_reads", project(v.isr_reads), "estimated"),
        updateUsage(db, "vercel", "fluid_memory_gb_hrs", project(v.fluid_memory_gb_hrs), "estimated"),
        // Projected monthly run-rate of EffectiveCost (list value of all
        // consumption incl. the prorated $20 Pro base). NOT BilledCost
        // (charges_total_usd ≈ $0 within plan, watched by Vercel's native
        // Spend-Management cap) — that rides as a metadata sub-label below.
        updateUsage(db, "vercel", "monthly_spend_usd", project(v.effective_cost_usd), "estimated"),
      ]);

      vercelBreakdown = {
        window_days: v.window_days,
        services: v.cost_breakdown
          .map((b) => ({ service: b.service, usd: project(b.effective_usd) }))
          .slice(0, 8),
      };
    } else {
      if (!/VERCEL_API_TOKEN/i.test(v.error) && !/plan_upgrade_required|Plan not found/i.test(v.error)) {
        errors.push(`vercel: ${v.error}`);
      }
    }
  } catch (err) {
    errors.push(`vercel: ${err instanceof Error ? err.message : String(err)}`);
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

  // FIX-356: attach the windowed-max CPU values to the cpu_pct PlatformMetric
  // so the dashboard renders the sub-label from the same shape as every other
  // metric. metadata stays undefined for all other metrics.
  if (supabaseCpuPayload) {
    for (const m of finalMetrics) {
      if (m.service === "supabase" && m.metric === "cpu_pct") {
        m.metadata = {
          cpu_max_1h: supabaseCpuPayload.max_1h_pct,
          cpu_max_24h: supabaseCpuPayload.max_24h_pct,
        };
      }
    }
  }

  // FIX-648: stitch the un-projected trailing-window truth onto each vercel
  // metric so the card can show "last Nd: <raw>" beneath the projected headline.
  // monthly_spend_usd additionally carries the BilledCost ($ the spend cap
  // watches) and the per-service spend breakdown.
  if (vercelUsage) {
    const rawByMetric: Record<string, number> = {
      fluid_cpu_seconds: vercelUsage.fluid_cpu_seconds,
      function_invocations: vercelUsage.function_invocations,
      origin_transfer_bytes: vercelUsage.origin_transfer_bytes,
      edge_requests: vercelUsage.edge_requests,
      edge_cpu_ms: vercelUsage.edge_cpu_ms,
      build_minutes: vercelUsage.build_minutes,
      web_analytics_events: vercelUsage.web_analytics_events,
      isr_reads: vercelUsage.isr_reads,
      fluid_memory_gb_hrs: vercelUsage.fluid_memory_gb_hrs,
      monthly_spend_usd: vercelUsage.effective_cost_usd,
    };
    for (const m of finalMetrics) {
      if (m.service !== "vercel") continue;
      const raw = rawByMetric[m.metric];
      if (raw === undefined) continue;
      m.metadata = {
        is_projected: true,
        window_days: vercelUsage.window_days,
        raw_window_value: raw,
        ...(m.metric === "monthly_spend_usd"
          ? {
              billed_window_usd: vercelUsage.charges_total_usd,
              cost_breakdown: vercelBreakdown?.services ?? [],
            }
          : {}),
      };
    }
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

  // FIX-α: "estimated" metrics (e.g. supabase.egress_bytes — a raw-NIC upper
  // bound, not billable egress) must not trip the banner or escalation tallies.
  // They can sit above 100% of a billable-egress limit without being real spend.
  const alertable = metricsWithValues.filter((m) => m.source !== "estimated");

  const anyCritical = alertable.some((m) => m.status === "critical");
  const anyWarning = alertable.some((m) => m.status === "warning");
  const needsVerification = metricsWithValues.some(
    (m) => m.source_display.needsVerification,
  );

  const criticalCount = alertable.filter((m) => m.status === "critical").length;
  const warningCount = alertable.filter((m) => m.status === "warning").length;
  const unverifiedCount = metricsWithValues.filter(
    (m) => m.source_display.needsVerification,
  ).length;

  // Auto-trip evaluator runs after all vendor APIs have written through to
  // platform_usage (above), before the snapshot row is inserted. Failure to
  // evaluate is non-fatal — we record an error and ship an empty decisions
  // array so the snapshot still lands. The safety net for AI cost overrun
  // is the per-request DB check from PR 1 (kill_switches), not this.
  let autoTripDecisions: AutoTripDecision[] = [];
  try {
    autoTripDecisions = await evaluateAutoTrips(db, finalMetrics);
  } catch (err) {
    errors.push(`auto_trip: ${err instanceof Error ? err.message : String(err)}`);
  }
  const autoTripsFlipped = autoTripDecisions.filter(
    (d) => d.action === "flip",
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
    auto_trip_decisions: autoTripDecisions,
    ...(supabaseCpuPayload ? { supabase_cpu: supabaseCpuPayload } : {}),
    ...(vercelBreakdown ? { vercel_breakdown: vercelBreakdown } : {}),
    timestamp: new Date().toISOString(),
  };

  return {
    payload,
    any_critical: anyCritical,
    any_warning: anyWarning,
    total_overage_cost: totalOverageCost,
    auto_trips_flipped: autoTripsFlipped,
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
