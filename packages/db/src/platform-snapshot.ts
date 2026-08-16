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
import { calculateLoggedCostUsd } from "./ai-pricing";
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
import {
  getUpstashHealth,
  getUpstashUsage,
  recordUpstashLimiterState,
  type UpstashLimiterState,
  type UpstashLimiterTransition,
  type UpstashUsage,
} from "./upstash-usage";
import { getVercelUsage, type VercelUsage } from "./vercel-usage";
import { getGitHubUsage } from "./github-usage";
import {
  evaluateAutoTrips,
  type AutoTripDecision,
} from "./auto-trip-evaluator";
import {
  getCloudflareEdgeVolume,
  getZoneSecurityLevel,
  setZoneSecurityLevel,
  probeZoneWriteScope,
  type CloudflareEdgeVolume,
  type CloudflareHourBucket,
  type SecurityLevel,
} from "./cloudflare-analytics";
import {
  runCloudflareMitigationLoop,
  resolveTripThreshold,
  TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR,
  REQUIRED_BREACH_HOURS,
  REVERT_AFTER_HOURS,
  type MitigationRunResult,
} from "./cf-mitigation-loop";
import { computeVercelBilling, VERCEL_PRO_INCLUDED_USD, type VercelBilling } from "./vercel-billing";
import { evaluateBurnRate, readBurnRateSeries, type BurnRateVerdict } from "./burn-rate";
import { isKillSwitchEnabled } from "./kill-switches";

// ── Types ─────────────────────────────────────────────────────────────────────

type UsageRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  // FIX-893: needed so spend is priced by the model that actually ran.
  model: string | null;
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
  // FIX-1038: the edge rate limiter's backing store. Upstash was the one vendor
  // in the cost chain this snapshot could not see, and its silent exhaustion on
  // 2026-08-15 was the incident's force-multiplier — every crawl-defense bucket
  // switched itself off with zero signal. `state` is a live probe; `since` /
  // `previous_state` / `transitions` come from the durable pipeline_state
  // record so the card can say "DEGRADED since 21:30 UTC" rather than just
  // "degraded". Absent when UPSTASH_* is unset (local dev).
  upstash?: {
    state: UpstashLimiterState;
    detail: string | null;
    limit_commands: number | null;
    usage_commands: number | null;
    attempts: number;
    refusals: number;
    latency_ms: number;
    checked_at: string;
    since: string;
    previous_state: UpstashLimiterState | null;
    last_transition_at: string | null;
    transitions: UpstashLimiterTransition[];
    // Control-plane reading (management API). Absent without UPSTASH_EMAIL /
    // _API_KEY / _DATABASE_ID. Deliberately NOT merged into the fields above:
    // `usage.used_commands` (billing) and `usage_commands` (the enforcement
    // number parsed off a refusal) are different counters that disagree, and
    // collapsing them would hide that.
    usage?: UpstashUsage;
  };
  // FIX-1044: the LEADING cost signal. Cloudflare is the only near-real-time,
  // script-readable counter in this stack, and every downstream dollar (Vercel
  // invocations, Upstash commands, observability events) follows edge request
  // volume. `origin_requests` — requests the origin actually answered — is the
  // one that costs money and is what the alert and the mitigation loop key on;
  // `edge_requests` rides along so the card can show "absorbed at the edge",
  // which is exactly the shape that made Under Attack mode's effect legible on
  // 2026-08-15 (same ~7,300 edge requests/hr, origin fell from 7,302 to 36).
  // Absent when CLOUDFLARE_API_TOKEN is unset (local dev).
  cloudflare_edge?: {
    zone_id: string;
    /** Most recent COMPLETE clock hour. Partial hours are never reported. */
    latest: CloudflareHourBucket | null;
    /** Up to 3 complete hours, newest first — GHA drift can skip one. */
    hours: CloudflareHourBucket[];
    trip_threshold: number;
    fetched_at: string;
  };
  // FIX-1045: closed-loop auto-mitigation state. `decision.action` is the whole
  // story for the card; `security_level` is what the zone read this tick.
  cf_mitigation?: {
    action: string;
    reason: string;
    observed_level: SecurityLevel | null;
    acted: boolean;
    write_error: string | null;
    tripped_at: string | null;
    previous_level: SecurityLevel | null;
    breach_hours: number;
    required_breach_hours: number;
    revert_after_hours: number;
    writes_enabled: boolean;
    // FIX-1047: is the loop CONFIRMED able to act, rather than assumed to be?
    // `write_scope_confirmed` null = never probed (disarmed, or CF unreadable).
    write_scope_confirmed: boolean | null;
    write_scope_checked_at: string | null;
    write_scope_detail: string | null;
    // Threshold actually in force, after any CF_TRIP_ORIGIN_REQ_THRESHOLD
    // override. Surfaced so a verify-run value left in place is visible.
    threshold: number;
    threshold_is_overridden: boolean;
  };
  // FIX-1046: the corrected Vercel billing picture. `monthly_spend_usd` in
  // `metrics` remains the GROSS list value (the leading indicator); everything
  // billable lives here.
  vercel_billing?: VercelBilling;
  // FIX-1044 D2: day-over-day consumption deltas vs the trailing median.
  burn_rate?: BurnRateVerdict;
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
        .select("input_tokens, output_tokens, cost_cents, model")
        .eq("service", "anthropic")
        .gte("created_at", monthStart)
        .order("created_at")
        .range(from, to),
    );

    // FIX-893: was an inline (in*0.25 + out*1.25) using Haiku-3-era prices that
    // also ignored the model column. calculateLoggedCostUsd prices by the row's
    // model, erring high on an unknown one.
    const total = rows.reduce((sum, r) => {
      if (r.input_tokens != null && r.output_tokens != null) {
        return sum + calculateLoggedCostUsd(r.input_tokens, r.output_tokens, r.model);
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

  // FIX-1038: Upstash edge-limiter health → platform_usage. Three cheap PINGs
  // per tick (≤0.09% of the 500k allotment it watches — an over-quota Upstash
  // refuses only ~38% of commands, so one PING is not enough to see an outage;
  // see upstash-usage.ts's header for the measurement). `limiter_degraded` is
  // 0/1 against an included_limit of 1, so a degraded limiter reads 100% and
  // trips the SAME critical machinery every other metric uses — no new alerting
  // substrate.
  //
  // `period_commands` now comes from the MANAGEMENT API (control plane), which
  // is the leading half: it reads total_monthly_requests against the vendor's
  // own db_request_limit every tick, so the 80% warning is reachable BEFORE the
  // limiter dies rather than at the instant it does. The quota-error parse stays
  // as the fallback for when the management key is absent. The two counters
  // disagree — billing lags enforcement — so health, not usage, decides
  // `limiter_degraded`. Missing env on either side is benign (matches the
  // github/cloudflare convention).
  let upstashPayload: PlatformUsagePayload["upstash"] = undefined;
  try {
    const [upstash, usage] = await Promise.all([getUpstashHealth(), getUpstashUsage()]);
    const usageOk = !("error" in usage);
    if (usageOk) {
      await updateUsage(db, "upstash", "period_commands", usage.used_commands, "api");
      // Keep the denominator honest against the vendor's own cap rather than a
      // seeded constant — same pattern as FIX-351 for the Supabase disk size.
      await anyDb
        .from("platform_limits")
        .update({ included_limit: usage.limit_commands })
        .eq("service", "upstash")
        .eq("metric", "period_commands");
    } else if (!/UPSTASH_(EMAIL|API_KEY|DATABASE_ID)/i.test(usage.error)) {
      errors.push(`upstash_usage: ${usage.error}`);
    }

    if (!("error" in upstash)) {
      const history = await recordUpstashLimiterState(anyDb, upstash.state);
      await updateUsage(
        db,
        "upstash",
        "limiter_degraded",
        upstash.state === "healthy" ? 0 : 1,
        "api",
      );
      // Fallback only: without the management key the quota error is the sole
      // source of a number, and it appears only once the cap is already crossed.
      if (!usageOk && upstash.usage_commands !== null) {
        await updateUsage(db, "upstash", "period_commands", upstash.usage_commands, "api");
      }
      upstashPayload = {
        ...upstash,
        ...history,
        ...(usageOk ? { usage } : {}),
      };
    } else if (!/UPSTASH_REDIS_REST/i.test(upstash.error)) {
      errors.push(`upstash: ${upstash.error}`);
    }
  } catch (err) {
    errors.push(`upstash: ${err instanceof Error ? err.message : String(err)}`);
  }

  // FIX-1044 — Cloudflare edge volume: THE leading cost signal.
  //
  // One GraphQL call per tick returning the last 3 COMPLETE clock hours. Three,
  // not one, because this cron is GHA-driven and its measured inter-run gap is
  // p50 46 min / p90 87 min / max 155 min (200 runs, 6.8 days) — a single-hour
  // read would silently skip hours on 26% of runs, and skipped hours cannot
  // contribute to the mitigation loop's sustained-breach count.
  //
  // The metric written to platform_usage is origin-reaching requests in the
  // latest complete hour. Missing env is benign (matches the github/cloudflare/
  // upstash convention) so local dev and any environment without the token just
  // omits the block rather than flagging the snapshot partial.
  //
  // FIX-1045 — the closed loop runs from the SAME reading, immediately after,
  // so the decision and the number it was made on can never disagree.
  let cloudflareEdge: PlatformUsagePayload["cloudflare_edge"] = undefined;
  let cfMitigation: PlatformUsagePayload["cf_mitigation"] = undefined;
  let cfHours: CloudflareHourBucket[] = [];
  try {
    const edge: CloudflareEdgeVolume | { error: string } = await getCloudflareEdgeVolume({
      lookbackHours: 3,
    });
    if (!("error" in edge)) {
      cfHours = edge.hours;
      cloudflareEdge = {
        zone_id: edge.zone_id,
        latest: edge.latest,
        hours: edge.hours,
        // FIX-1047: the EFFECTIVE threshold, so the card and the alert email
        // never quote a constant the loop is not actually using.
        trip_threshold: resolveTripThreshold(),
        fetched_at: edge.fetched_at,
      };
      if (edge.latest) {
        await Promise.all([
          updateUsage(db, "cloudflare", "origin_requests_hourly", edge.latest.origin_requests, "api"),
          updateUsage(db, "cloudflare", "edge_requests_hourly", edge.latest.edge_requests, "api"),
          updateUsage(db, "cloudflare", "edge_mitigated_pct", edge.latest.mitigated_pct, "api"),
        ]);
      }
    } else if (!/CLOUDFLARE_(API_TOKEN|ZONE)/i.test(edge.error)) {
      errors.push(`cloudflare_edge: ${edge.error}`);
    }
  } catch (err) {
    errors.push(`cloudflare_edge: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The loop is skipped entirely when there is no Cloudflare reading at all —
  // acting on no evidence is exactly the failure mode rail 5 exists to prevent.
  if (cloudflareEdge) {
    try {
      // Rail 6: the kill switch disarms the WRITE only. Detection above and the
      // alerting below stay live regardless, so turning the loop off never
      // makes the platform blinder than it was before this shipped.
      const writesEnabled = await isKillSwitchEnabled(db, "cf_auto_mitigation");
      const run: MitigationRunResult = await runCloudflareMitigationLoop(anyDb, cfHours, {
        writesEnabled,
        deps: {
          getLevel: getZoneSecurityLevel,
          setLevel: setZoneSecurityLevel,
          // FIX-1047: proves Zone Settings:Edit before an incident needs it,
          // at most twice a day. See cf-mitigation-loop.ts for why not more.
          probeScope: probeZoneWriteScope,
        },
      });
      cfMitigation = {
        action: run.decision.action,
        reason: run.decision.reason,
        observed_level: run.observed_level,
        acted: run.acted,
        write_error: run.write_error,
        tripped_at: run.state.tripped?.tripped_at ?? null,
        previous_level: run.state.tripped?.previous_level ?? null,
        breach_hours: run.state.breaches.length,
        required_breach_hours: REQUIRED_BREACH_HOURS,
        revert_after_hours: REVERT_AFTER_HOURS,
        writes_enabled: writesEnabled,
        write_scope_confirmed: run.scope_probe ? run.scope_probe.writable : null,
        write_scope_checked_at: run.scope_probe?.checked_at ?? null,
        write_scope_detail: run.scope_probe?.detail ?? null,
        threshold: run.threshold,
        threshold_is_overridden: run.threshold !== TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR,
      };
    } catch (err) {
      errors.push(`cf_mitigation: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  let vercelBilling: VercelBilling | undefined = undefined;
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

      // FIX-1046 — the billing correction.
      //
      // Vercel Pro is $20/mo and that $20 BUYS $20 of included usage, so the
      // bill is `$20 + max(0, usage - $20)`. Everything above still writes the
      // GROSS list value (`monthly_spend_usd`) because it is the leading
      // indicator and it is what reconciles against the Vercel dashboard — but
      // it is not money owed, and treating it as such is why the card read
      // $31.38/mo on a month whose true billable overage was $0.00.
      //
      // The included credit comes from platform_limits so it is retunable with
      // an UPDATE, with the named constant as the fallback. Two new metrics:
      //   included_usage_usd   — consumption vs the $20 credit (the % bar that
      //                          finally means something), and
      //   billable_overage_usd — the projected money actually owed. THIS is the
      //                          headline and the alerting row.
      const creditRow = await anyDb
        .from("platform_limits")
        .select("included_limit")
        .eq("service", "vercel")
        .eq("metric", "included_usage_usd")
        .eq("plan", "pro")
        .maybeSingle();
      const includedCreditUsd =
        typeof creditRow?.data?.included_limit === "number" && creditRow.data.included_limit > 0
          ? creditRow.data.included_limit
          : VERCEL_PRO_INCLUDED_USD;

      vercelBilling = computeVercelBilling({
        effectiveMtdUsd: v.effective_cost_usd,
        planBaseMtdUsd: v.plan_base_usd,
        windowDays: v.window_days,
        daysInCycle: daysInMonth,
        includedCreditUsd,
      });

      await Promise.all([
        // source='api': both are exact arithmetic over measured charge lines,
        // not an extrapolated quantity. The PROJECTION inside them is honest
        // about itself via `projectable` and the sub-labels on the card.
        updateUsage(db, "vercel", "included_usage_usd", vercelBilling.projected_usage_usd, "api"),
        updateUsage(
          db,
          "vercel",
          "billable_overage_usd",
          vercelBilling.projected_billable_overage_usd,
          "api",
        ),
      ]);
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

  // FIX-1044 D2 — burn rate. Differentiates the cumulative MTD cost series the
  // snapshot has been storing all along into per-day consumption and compares
  // today against the trailing median. This is the calculation the 2026-08-15
  // audit did BY HAND to establish that the spike was 3.7x baseline; nothing
  // was automating it. Reads via an RPC so the jsonb extraction stays in the
  // database — there are ~150 snapshot rows/day and each payload is large.
  //
  // Runs LAST because it reads back snapshot rows written by earlier ticks;
  // failure is non-fatal and degrades to "not enough history".
  let burnRate: BurnRateVerdict | undefined = undefined;
  try {
    const series = await readBurnRateSeries(anyDb, 12);
    burnRate = evaluateBurnRate(series);
  } catch (err) {
    errors.push(`burn_rate: ${err instanceof Error ? err.message : String(err)}`);
  }

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
    ...(upstashPayload ? { upstash: upstashPayload } : {}),
    ...(cloudflareEdge ? { cloudflare_edge: cloudflareEdge } : {}),
    ...(cfMitigation ? { cf_mitigation: cfMitigation } : {}),
    ...(vercelBilling ? { vercel_billing: vercelBilling } : {}),
    ...(burnRate ? { burn_rate: burnRate } : {}),
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
