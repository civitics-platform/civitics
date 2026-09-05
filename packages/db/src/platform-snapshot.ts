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
import { selectAllKeyset, afterKey } from "./read-helpers";
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
  getSupabaseOrgBilling,
} from "./supabase-usage";
import {
  configuredRateFromLimit,
  measuredRate,
  trimNumber,
  type ImpliedCostBasis,
} from "./platform-rates";
import {
  anniversaryCycle,
  calendarMonthCycle,
  vendorWindowCycle,
  type ProviderCycle,
} from "./billing-cycles";
import {
  computePlatformCostTotals,
  type BillableUsageItem,
  type SubscriptionItem,
} from "./platform-costs";
import {
  getPlatformSubscriptions,
  updateSubscriptionPrice,
} from "./platform-subscriptions";
import {
  currentUsagePeriod,
  getServiceSelfCounts,
  mapboxBillableTotal,
} from "./service-self-count";
import { getVercelAccount } from "./vercel-account";
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
  /**
   * Estimated USD above what the plans include, this cycle, across every
   * service. Non-Vercel services contribute per-metric quota overage priced at
   * the vendor's list rate; Vercel contributes its FIX-1046 credit-aware
   * `billable_overage_mtd_usd` INSTEAD of its per-metric rows, so the same
   * consumption is never counted on two definitions (FIX-1050). Month-to-date
   * throughout — this is not a month-end projection.
   */
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
  // FIX-1104: provenance for the /data denominator under the Disk row. The
  // guard that pins it is invisible by construction — a held tick and a quiet
  // tick both leave the number unchanged — so record what was observed next to
  // what was applied. `action` is one of bootstrap | steady | grow |
  // shrink_confirmed | shrink_held; anything but the first four means a scrape
  // disagreed with durable config and was refused.
  supabase_disk?: {
    provisioned_bytes: number;
    observed_bytes: number;
    action: string;
  };
  // FIX-648: per-ServiceName Vercel EffectiveCost, projected to a monthly
  // run-rate (descending). The "what spiked" breakdown — surfaced on the card
  // and read by the leading fluid-cost alert.
  //
  // FIX-1041 corrected two things here. `window_days` is the MONTH-TO-DATE
  // billing window the projection was extrapolated from — 1 on the 1st, ~31 by
  // month end, resetting each month (this comment used to say "trailing,
  // typically ~7"; see vercel-usage.ts for the measurement). And `services` is
  // now EVERY non-zero line rather than the top 8, each carrying the raw
  // metered `quantity` / `unit` behind its dollars and the `metric` name when
  // it is one of ours. A null `quantity` means Vercel billed the line without
  // metering it to us; a null `metric` means it is metered but not one we
  // track. `quantity_note` says which, in words.
  //
  // Consumers must NOT assume a length. The leading fluid-cost alert finds its
  // two lines by name (`.find`), which is why it needed no change.
  vercel_breakdown?: {
    window_days: number;
    services: {
      service: string;
      usd: number;
      quantity: number | null;
      unit: string | null;
      metric: string | null;
      quantity_note: string | null;
    }[];
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

  // ── FIX-1089 / FIX-1090 (R4a) ───────────────────────────────────────────────
  //
  // EVERY field below is optional, and that is load-bearing rather than
  // defensive. The dashboard renders a PERSISTED snapshot payload and the cron
  // that writes it is GHA-driven with measured 1–3.5 h drift, so between this
  // deploy and the next tick the card is rendering the OLD payload — which has
  // none of this. Consumers must degrade to the pre-R4a fields, which are all
  // still populated. That is the FIX-1076 lesson.

  /**
   * The recurring charges, itemized. Vercel Pro's $20 was previously visible
   * only because it rides inside vercel_billing.projected_total_bill_usd;
   * Supabase Pro's $25 was in no payload field at all.
   */
  subscriptions_usd?: {
    total: number;
    items: SubscriptionItem[];
  };
  /**
   * Metered money owed this cycle, itemized. Selected BY BASIS — a vendor with
   * credit-aware billing contributes exactly one figure and its per-metric list
   * values are never summed. See platform-costs.ts for why.
   */
  billable_usage_usd?: {
    total: number;
    items: BillableUsageItem[];
  };
  /** subscriptions + billable usage. The true monthly cost to run. */
  total_monthly_usd?: number;
  /** Costs we know exist and deliberately did not price rather than guess. */
  cost_omissions?: string[];
  /**
   * Billing cycle per provider, with provenance. `source` distinguishes a
   * window the vendor stated from one we assumed, so the UI can caveat the
   * assumptions instead of rendering all four dates with equal authority.
   */
  cycles?: Record<string, ProviderCycle>;
  /** FIX-1089: the CONTRACT half of Vercel — plan, period, subscription, credit. */
  vercel_account?: {
    plan: string;
    plan_iteration: string | null;
    status: string | null;
    subscription_usd: number | null;
    included_credit_usd: number | null;
  };
  /**
   * FIX-1089: Supabase plan tier verified live off the Management API. The $25
   * price is NOT sourceable (every billing endpoint 404s) and lives in
   * platform_subscriptions as `configured`; this is what stops that configured
   * price from being asserted against a plan we may no longer be on.
   */
  supabase_account?: {
    plan: string;
    compute_addon: { id: string; name: string; monthly_usd: number | null } | null;
  };
  /**
   * FIX-1090: the dollars GitHub's billing API reports, which no payload field
   * carried before. On a public repo `billed_usd` is $0 and `gross_usd` is the
   * interesting number — 5,136 Actions minutes at $0.006 is $30.82 of runner
   * time the free tier is absorbing.
   */
  github?: {
    action_minutes: number;
    minutes_breakdown: Record<string, number>;
    storage_bytes: number;
    billed_usd: number;
    gross_usd: number;
    minutes_price_per_unit: number | null;
    fetched_at: string;
  };
  /**
   * FIX-1090: what the self-counters actually hold this period, so a "0" on the
   * Mapbox row is distinguishable from a counter that is not wired up. Both
   * rows are LOWER BOUNDS by construction — see service-self-count.ts.
   */
  self_counted?: {
    period: string;
    mapbox: { total: number; by_metric: Record<string, number> };
    resend: { total: number; by_metric: Record<string, number> };
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
    const rows = await selectAllKeyset<UsageRow & { id: string }, string>(
      "platform-snapshot anthropic-spend logs",
      (after, limit) => afterKey(db
        .from("api_usage_logs")
        .select("id, input_tokens, output_tokens, cost_cents, model")
        .eq("service", "anthropic")
        .gte("created_at", monthStart)
      // FIX-984: keyset on the `id` pkey, not OFFSET, and not on created_at --
      // created_at is not unique, and a keyset walk that seeks past a repeated
      // key drops every row sharing it. Nothing downstream depends on the
      // order: the rows are summed.
        .order("id")
        .limit(limit), "id", after),
      { key: (r) => r.id },
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
  // FIX-1104: what the disk-denominator guard saw and did this tick. Additive
  // payload field — a held scrape must be visible somewhere, or "the number
  // didn't move" and "the number was wrong and we ignored it" look identical.
  let supabaseDiskPayload:
    | {
        provisioned_bytes: number;
        observed_bytes: number;
        action: string;
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
      supabaseDiskPayload = {
        provisioned_bytes: prom.disk_size_bytes,
        observed_bytes: prom.disk_size_observed_bytes,
        action: prom.disk_size_action,
      };

      // FIX-351: disk utilization % must divide against provisioned size,
      // not the 8 GB Pro plan-included quota that was seeded. Every other
      // platform_limits row is config-shaped (static seed); this one row
      // is overridden each tick with the actual /data filesystem size
      // from Prometheus so the dashboard % reflects real headroom on the
      // (manually resized) disk.
      //
      // FIX-1104: `prom.disk_size_bytes` is the PINNED size, not the raw
      // scrape — a lone divergent reading no longer lands here. That matters
      // precisely because this write is durable: before the guard, one bad
      // scrape on 2026-08-23 left the public Disk row at 87% instead of 58%
      // for 81 minutes, until an unrelated later tick happened to correct it.
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
  //
  // FIX-1090: the reading is now KEPT rather than written-through and dropped.
  // The dollars GitHub reports never reached the payload, so nothing could say
  // that this month's 5,136 Actions minutes are $30.82 of runner time the
  // public-repo free tier is absorbing down to $0.00 billed.
  let githubUsage: PlatformUsagePayload["github"] = undefined;
  let githubBilledUsd: number | null = null;
  let githubMinutesGrossUsd: number | null = null;
  let githubMinutesBilledUsd: number | null = null;
  try {
    const gh = await getGitHubUsage();
    if (!("error" in gh)) {
      await Promise.all([
        updateUsage(db, "github", "action_minutes", gh.action_minutes, "api"),
        updateUsage(db, "github", "storage_bytes", gh.storage_bytes, "api"),
      ]);
      githubBilledUsd = gh.total_billed_usd;
      githubMinutesGrossUsd = gh.minutes_gross_usd;
      githubMinutesBilledUsd = gh.minutes_billed_usd;
      githubUsage = {
        action_minutes: gh.action_minutes,
        minutes_breakdown: gh.minutes_breakdown,
        storage_bytes: gh.storage_bytes,
        billed_usd: gh.total_billed_usd,
        gross_usd: gh.total_gross_usd,
        minutes_price_per_unit: gh.minutes_price_per_unit,
        fetched_at: gh.fetched_at,
      };
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

      // FIX-1041 — EVERY non-zero service line is persisted, and each carries
      // the raw metered amount behind its dollars.
      //
      // This used to end in `.slice(0, 8)`. Measured on prod over the whole
      // retained window (927 snapshots, 2026-08-07..09-05):
      // jsonb_array_length was 8 on every single one, so the cap was ALWAYS
      // binding and never slack — while ten distinct services appeared across
      // the window. A line could therefore vanish from the audit trail with no
      // error, no flag and no residual, purely because something else outranked
      // it that day: on billing day 15 "Speed Insights Data Points" entered the
      // top 8 and silently displaced "Function Invocations". With 30-day
      // retention the history is then gone for good. FIX-969's "no silent caps"
      // rule, applied to the cost record itself.
      //
      // There are ~10 lines. This was never a size problem.
      //
      // `quantity` is null ONLY when Vercel sent no ConsumedQuantity for the
      // service — a present-but-zero quantity stays 0. `metric` is null when the
      // line is not one of ours; Observability Events is the case that matters
      // (the largest non-subscription line on this account) and the reason the
      // 2026-08-15 audit could report its cost rising 3.7x but never an event
      // count. `quantity_note` says which of the two is going on, in words, so
      // the gap reads off the card instead of being inferred from a null.
      //
      // NOT projected: quantity is the RAW window total, deliberately. Dollars
      // are projected to a monthly run-rate because that is what the card and
      // the alert compare against a monthly credit; a quantity is evidence, and
      // extrapolating evidence is how a measurement becomes an estimate nobody
      // remembers making. `window_days` is right here for anyone who wants a
      // rate.
      vercelBreakdown = {
        window_days: v.window_days,
        services: v.cost_breakdown.map((b) => ({
          service: b.service,
          usd: project(b.effective_usd),
          quantity: b.quantity,
          unit: b.unit,
          metric: b.metric,
          quantity_note:
            b.quantity === null
              ? "no quantity metric in billing/charges"
              : b.metric === null
                ? "metered by Vercel, not tracked as a Civitics metric"
                : null,
        })),
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
        // FIX-1050 — the first-cent trigger, as a 0/1 companion row.
        //
        // It is a separate row because `warning_pct` is an INTEGER column and
        // $0.01 of the $20 credit is 0.05%. Rounding that to 0 is not a near
        // miss — the band test is `pct >= warning_pct`, so a 0 would park every
        // metric in the warning band forever, a $0.00 one included.
        //
        // ACTUAL MTD, NOT THE PROJECTION, and the difference decides whether
        // this alert is useful. The projection scales by
        // daysInCycle/windowDays, so on day 1 of a cycle an entirely ordinary
        // $0.71 of usage extrapolates to ~$22 and would report overage — a
        // false first-cent email in the opening days of most months.
        // `billable_overage_mtd_usd` only goes positive once real cumulative
        // consumption has genuinely passed $20, and it is monotonic within a
        // cycle, so the healthy→warning edge fires at most once per episode.
        // The dollar row above stays on the projection: "is month-end heading
        // past $10" is a different question from "are we over the credit now".
        updateUsage(
          db,
          "vercel",
          "overage_present",
          vercelBilling.billable_overage_mtd_usd > 0 ? 1 : 0,
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

  // ── FIX-1089: the CONTRACT half of Vercel ───────────────────────────────────
  //
  // /v2/teams/{id} answers what /v1/billing/charges cannot: which plan, which
  // billing PERIOD, what the subscription costs and how much credit it buys.
  //
  // Note the premise this contradicts. vercel-billing.ts records that "nothing
  // in the charges API discriminates between" the calendar month and the
  // Aug 14 – Sep 14 cycle the usage page shows. Still true of the charges API —
  // but this endpoint states the period outright, and it matches the usage
  // page. The projection basis is deliberately NOT re-based here: it feeds
  // billable_overage_usd and overage_present, both alerting rows with tuned
  // bands, and moving the divisor would silently move every threshold. The
  // cycle is surfaced so the card stops implying a calendar month; re-basing
  // the projection is its own change with its own verification.
  let vercelAccount: PlatformUsagePayload["vercel_account"] = undefined;
  let vercelPeriodStartMs: number | null = null;
  let vercelPeriodEndMs: number | null = null;
  try {
    const acct = await getVercelAccount();
    if (!("error" in acct)) {
      vercelPeriodStartMs = acct.period_start_ms;
      vercelPeriodEndMs = acct.period_end_ms;
      vercelAccount = {
        plan: acct.plan,
        plan_iteration: acct.plan_iteration,
        status: acct.status,
        subscription_usd: acct.subscription_usd,
        included_credit_usd: acct.included_credit_usd,
      };
      // Self-correcting subscription price: the seeded $20 in the migration is
      // only ever the fallback for a failed call.
      if (acct.subscription_usd !== null) {
        await updateSubscriptionPrice(db, "vercel", "Pro", acct.subscription_usd);
      }
      // Cross-check only — the credit that DRIVES billing still comes from
      // platform_limits (FIX-1046's retune-by-UPDATE design). All three sources
      // read $20 today; a divergence means the vendor moved and the alert bands
      // are being computed against a stale credit.
      if (
        acct.included_credit_usd !== null &&
        Math.abs(acct.included_credit_usd - VERCEL_PRO_INCLUDED_USD) > 0.005
      ) {
        errors.push(
          `vercel_credit_drift: vendor reports $${acct.included_credit_usd} included ` +
            `credit, platform_limits/constant use $${VERCEL_PRO_INCLUDED_USD}`,
        );
      }
    } else if (!/VERCEL_(API_TOKEN|TEAM_ID)/i.test(acct.error)) {
      errors.push(`vercel_account: ${acct.error}`);
    }
  } catch (err) {
    errors.push(`vercel_account: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── FIX-1089: Supabase plan tier, verified rather than assumed ──────────────
  //
  // The $25/month Pro price is NOT sourceable — every Management API billing
  // endpoint 404s (org-scope subscription/usage/addons, project-scope
  // subscription; probed 2026-08-22) — so it lives in platform_subscriptions as
  // `configured`. What IS readable is the plan tier, and reading it is what
  // stops a configured price being asserted against a plan we are no longer on.
  let supabaseAccount: PlatformUsagePayload["supabase_account"] = undefined;
  try {
    const org = await getSupabaseOrgBilling();
    if (!("error" in org)) {
      supabaseAccount = { plan: org.plan, compute_addon: org.compute_addon };
      if (org.compute_addon?.monthly_usd != null) {
        // Micro (~$10/mo) is exactly covered by the $10/mo compute credit Pro
        // includes, so the NET line stays $0 — but the row is live, so a resize
        // to Small shows up as money the moment it happens.
        const netCompute = Math.max(0, org.compute_addon.monthly_usd - 10);
        await updateSubscriptionPrice(
          db,
          "supabase",
          "Compute (Micro)",
          Math.round(netCompute * 100) / 100,
        );
      }
    } else if (!/MANAGEMENT_API_KEY/i.test(org.error)) {
      errors.push(`supabase_org: ${org.error}`);
    }
  } catch (err) {
    errors.push(`supabase_org: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── FIX-1090: self-counted providers → platform_usage ───────────────────────
  //
  // Mapbox and Resend expose no usage number we can read (Mapbox: pk. token,
  // analytics/v1 403s; Resend: /emails lists only a retained tail), so both are
  // counted at their own call sites into `service_usage`.
  //
  // Written as source='estimated' on purpose. That is honest — these are LOWER
  // BOUNDS, not measurements — and it is also the safe choice: 'estimated' rows
  // are excluded from the escalation email and from the critical/warning
  // tallies (FIX-α), so wiring up two new counters cannot start paging anyone.
  const selfCountPeriod = currentUsagePeriod();
  let selfCounted: PlatformUsagePayload["self_counted"] = undefined;
  try {
    const [mapbox, resend] = await Promise.all([
      getServiceSelfCounts(db, "mapbox"),
      getServiceSelfCounts(db, "resend"),
    ]);
    const mapboxBillable = mapboxBillableTotal(mapbox);
    await Promise.all([
      updateUsage(db, "mapbox", "map_loads", mapboxBillable, "estimated"),
      updateUsage(db, "resend", "emails_sent", resend.byMetric["email_sent"] ?? 0, "estimated"),
    ]);
    selfCounted = {
      period: selfCountPeriod,
      mapbox: { total: mapboxBillable, by_metric: mapbox.byMetric },
      resend: { total: resend.byMetric["email_sent"] ?? 0, by_metric: resend.byMetric },
    };
  } catch (err) {
    errors.push(`self_counted: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── FIX-1089: the recurring charges that are not metrics ────────────────────
  const subscriptionsRead = await getPlatformSubscriptions(db);
  if (subscriptionsRead.error) {
    errors.push(`platform_subscriptions: ${subscriptionsRead.error}`);
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

  // ── FIX-1089: rate + implied cost, per metric ───────────────────────────────
  //
  // Every row on this card has shown a quantity, a limit and a bar, and no
  // price — so no row could answer what it was costing. Two sources of truth
  // and no third (see platform-rates.ts): Vercel's own charge lines, and the
  // `overage_unit_cost` already sitting in platform_limits. A metric with
  // neither gets no rate; nothing is inferred from a published price list.
  //
  // `implied_cost_basis` is the field that keeps this safe. "rate × usage" and
  // "money owed" are different numbers here — a Supabase overage is owed, a
  // Vercel list value is absorbed by the $20 credit, a GitHub gross is
  // discounted to zero — and summing them as one kind of dollar is exactly the
  // double-count FIX-1050 had to remove from total_overage_cost. The roll-up
  // below selects by basis; it never sums implied_cost_usd blindly.
  {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const vercelWindowDays = vercelUsage?.window_days ?? 0;
    // Same projection the quantities got, so a row's cost and its quantity are
    // always on the same basis.
    const projectVercel = (raw: number): number =>
      vercelWindowDays > 0 ? (raw / vercelWindowDays) * daysInMonth : raw;
    const vercelRawQty: Record<string, number> = vercelUsage
      ? {
          fluid_cpu_seconds: vercelUsage.fluid_cpu_seconds,
          function_invocations: vercelUsage.function_invocations,
          origin_transfer_bytes: vercelUsage.origin_transfer_bytes,
          edge_requests: vercelUsage.edge_requests,
          edge_cpu_ms: vercelUsage.edge_cpu_ms,
          build_minutes: vercelUsage.build_minutes,
          web_analytics_events: vercelUsage.web_analytics_events,
          isr_reads: vercelUsage.isr_reads,
          fluid_memory_gb_hrs: vercelUsage.fluid_memory_gb_hrs,
        }
      : {};

    for (const m of finalMetrics) {
      // Vercel: measured off the account's own charge lines. Never a published
      // rate — Vercel prices by region ($0.15/GB in iad1, $0.35/GB in icn1), so
      // list price is not the price this account pays.
      if (m.service === "vercel" && vercelUsage) {
        const windowUsd = vercelUsage.cost_by_metric[
          m.metric as keyof typeof vercelUsage.cost_by_metric
        ];
        if (typeof windowUsd === "number") {
          const rate = measuredRate(windowUsd, vercelRawQty[m.metric] ?? 0, m.unit);
          if (rate) m.rate = rate;
          const projected = projectVercel(windowUsd);
          m.list_cost_usd = Math.round(projected * 10000) / 10000;
          // NOT money owed: this consumption is drawn against the $20 credit the
          // Pro subscription buys. What Vercel is actually owed is one number,
          // vercel_billing.projected_billable_overage_usd, and it is added to
          // the roll-up exactly once.
          m.implied_cost_usd = 0;
          m.implied_cost_basis = "credit_absorbed";
        }
        continue;
      }

      // Anthropic: the metric IS dollars. api_usage_logs priced per row by
      // ai-pricing.ts, so there is nothing to multiply — it is the actual spend.
      if (m.service === "anthropic" && m.metric === "monthly_spend_usd") {
        if (m.value !== null) {
          m.implied_cost_usd = m.value;
          m.implied_cost_basis = "actual";
        }
        continue;
      }

      // GitHub: the billing API states both the rate and the dollars, so the
      // Actions row can show $30.82 of runner time at list against $0.00 billed
      // — which is the whole story of a public repo, and neither half alone is.
      if (m.service === "github" && m.metric === "action_minutes") {
        if (githubUsage?.minutes_price_per_unit) {
          m.rate = {
            usd_per_unit: githubUsage.minutes_price_per_unit,
            // FIX-1104: trimNumber, not `${n}`. GitHub states $0.006/minute;
            // the IEEE double for it stringifies as 0.005999999999999999, and
            // a rate renders as fact.
            label: `$${trimNumber(githubUsage.minutes_price_per_unit)} / minute`,
            source: "api",
            free_units: null,
          };
        }
        if (githubMinutesGrossUsd !== null) m.list_cost_usd = githubMinutesGrossUsd;
        if (githubMinutesBilledUsd !== null) {
          m.implied_cost_usd = githubMinutesBilledUsd;
          m.implied_cost_basis = githubMinutesBilledUsd > 0 ? "actual" : "free_tier";
        }
        continue;
      }

      // Everything else: normalize the rate platform_limits already carries.
      // This introduces no new number — calculateOverageCost has been using the
      // same one all along; it was simply never printed next to the row.
      const rate = configuredRateFromLimit(m);
      if (rate) {
        m.rate = rate;
        m.implied_cost_usd = m.overage_cost;
        m.implied_cost_basis = "overage";
      } else if (
        m.value !== null &&
        m.included_limit > 0 &&
        m.billing_cycle !== "none" &&
        m.billing_cycle !== "realtime"
      ) {
        // A hard ALLOWANCE with no overage price: the vendor blocks rather than
        // bills (Resend's 3,000, Upstash's 500,000 with auto_upgrade off). $0 is
        // the true cost and there is no rate to invent.
        //
        // The billing_cycle guard matters. 'none' and 'realtime' rows are GAUGES,
        // not allowances — cloudflare.edge_mitigated_pct, supabase.cpu_pct,
        // supabase.db_connections. Calling 70.8% of mitigated traffic "free tier,
        // $0" is a category error: there is no tier and nothing was consumed.
        // Caught in the local smoke, where those three showed up priced.
        m.implied_cost_usd = 0;
        m.implied_cost_basis = "free_tier" satisfies ImpliedCostBasis;
      }
    }
  }

  const byService: Record<string, PlatformMetric[]> = {};
  for (const m of finalMetrics) {
    if (!byService[m.service]) byService[m.service] = [];
    byService[m.service]!.push(m);
  }

  const metricsWithValues = finalMetrics.filter((m) => m.value !== null);

  // FIX-1050 (T3) — one definition of "overage" in the dollar rollup.
  //
  // What this scalar has always been: Σ calculateOverageCost(value, limit) —
  // units consumed above a plan's included quota × that vendor's published list
  // price per unit. It has never read Vercel's EffectiveCost, so FIX-1046 did
  // NOT leave it computing a gross list figure. What FIX-1046 did leave is
  // subtler: the one vendor whose billing we now model correctly was still
  // being counted here on the other basis.
  //
  // `vercel.origin_transfer_bytes` (pro) carries $0.15/GB above 1 TiB. Every
  // dollar of that transfer is ALSO inside the consumption FIX-1046 draws
  // against the $20 included credit, so summing both bills the same bytes twice
  // under two different definitions of the word. It reads $0 today only because
  // the account is at 3.1 GB of a 1 TiB allowance — the disagreement is latent,
  // not absent, and it surfaces exactly when the number starts to matter.
  //
  // So Vercel contributes exactly one figure: its credit-aware billable
  // overage. Every other service keeps the per-metric quota model, which is the
  // most correct model available for them (there is no credit-aware billing
  // computation for Supabase or Cloudflare). MTD rather than the projection,
  // because every other contributor is "cost of what has been consumed so far
  // this cycle"; folding a month-end forecast into that sum would make one
  // scalar mean two things — the failure this task exists to prevent.
  //
  // If the Vercel API call failed, `vercelBilling` is undefined and Vercel
  // contributes 0. That is correct rather than lossy: the per-metric Vercel
  // values come from the same failed call, so there is no fresher figure to
  // fall back to, and the tick's `errors` array already records the failure.
  let totalOverageCost = 0;
  for (const m of metricsWithValues) {
    if (m.service === "vercel") continue;
    totalOverageCost += m.overage_cost;
  }
  totalOverageCost += vercelBilling?.billable_overage_mtd_usd ?? 0;

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

  // ── FIX-1089: billing cycles, with provenance ───────────────────────────────
  //
  // Everything here has been quietly anchored to the calendar month, and two
  // providers are not on it. Both were found by asking the vendor: Vercel says
  // Aug 14 – Sep 14, and Upstash's allotment rolls on the 13th (the monthly
  // anniversary of its creation_time). `source` is what lets the UI caveat the
  // assumed windows instead of rendering all of them with equal authority.
  const cycleNow = new Date();
  const cycles: Record<string, ProviderCycle> = {
    supabase: calendarMonthCycle(
      cycleNow,
      "Assumed: calendar month. The Management API exposes the org plan but " +
        "every billing endpoint 404s (org-scope subscription/usage/addons, " +
        "project-scope subscription), so there is no cycle to read. Probed " +
        "2026-08-22.",
    ),
    anthropic: calendarMonthCycle(
      cycleNow,
      "Calendar month, and exact: spend is summed from api_usage_logs since " +
        "date_trunc('month', NOW()), so the window is the cycle by construction.",
    ),
    cloudflare: calendarMonthCycle(
      cycleNow,
      "Calendar month for the R2 free-tier allowances. The hourly edge counters " +
        "in cloudflare_edge are instantaneous gauges with no cycle at all — see " +
        "the cloudflare_edge entry.",
    ),
    cloudflare_edge: {
      rolling: true,
      label: "hourly",
      detail:
        "No billing cycle. These are complete-clock-hour gauges driving the " +
        "mitigation loop, not a metered allowance — pacing or projecting them " +
        "against a month would be meaningless.",
    },
    github: calendarMonthCycle(
      cycleNow,
      "Calendar month: personal-account GitHub billing runs on it, and the " +
        "enhanced-billing endpoint is queried by year+month.",
    ),
    resend: calendarMonthCycle(
      cycleNow,
      "Calendar month: self-counted into service_usage keyed 'YYYY-MM'.",
    ),
    mapbox: calendarMonthCycle(
      cycleNow,
      "Calendar month: self-counted into service_usage keyed 'YYYY-MM'.",
    ),
  };
  {
    const vercelCycle = vendorWindowCycle(
      vercelPeriodStartMs,
      vercelPeriodEndMs,
      cycleNow,
      "Stated by the vendor: GET /v2/teams/{id} billing.period. Note the " +
        "quantities on the Vercel rows are still PROJECTED from a trailing " +
        "~7-day charges window onto a calendar month — the cycle shown here is " +
        "the real billing window, and re-basing the projection onto it is " +
        "deliberately a separate change (it would move the tuned alert bands).",
    );
    cycles["vercel"] =
      vercelCycle ??
      calendarMonthCycle(
        cycleNow,
        "Fallback: the team billing endpoint did not return a period this tick. " +
          "The real Vercel cycle is NOT the calendar month.",
      );
    const upstashCreatedAt = upstashPayload?.usage?.created_at ?? null;
    if (upstashCreatedAt) {
      cycles["upstash"] = anniversaryCycle(
        new Date(upstashCreatedAt),
        cycleNow,
        `Derived from the management API's creation_time (${upstashCreatedAt}): ` +
          "the 500,000-command allotment is per BILLING PERIOD and rolls on that " +
          "day of the month, not on the 1st. This is the answer to 'when does " +
          "the rate limiter come back' — the calendar-month answer is wrong.",
        "api",
      );
    }
  }

  // ── FIX-1089: the true monthly cost to run ──────────────────────────────────
  //
  // subscriptions + billable usage. The headline this replaces was
  // "anthropic actual + Σ non-vercel overages + vercel projected bill", which
  // read $22.71/month on prod 2026-08-22 while omitting Supabase Pro's $25
  // entirely — because the payload had no way to express a charge that is not a
  // metric. The old fields are left populated below; nothing is removed.
  const costTotals = computePlatformCostTotals({
    subscriptions: subscriptionsRead.items,
    metrics: finalMetrics.map((m) => ({
      service: m.service,
      metric: m.metric,
      label: m.display_label ?? m.metric,
      ...(m.implied_cost_usd !== undefined ? { implied_cost_usd: m.implied_cost_usd } : {}),
      ...(m.implied_cost_basis !== undefined
        ? { implied_cost_basis: m.implied_cost_basis }
        : {}),
      ...(m.rate ? { rate_source: m.rate.source } : {}),
    })),
    vercelBillableUsd: vercelBilling
      ? vercelBilling.projected_billable_overage_usd
      : null,
    githubBilledUsd: githubBilledUsd,
    ...(githubUsage ? { githubGrossUsd: githubUsage.gross_usd } : {}),
  });
  if (subscriptionsRead.error) {
    costTotals.omissions.push(
      `Every subscription — platform_subscriptions could not be read (${subscriptionsRead.error}).`,
    );
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
    ...(supabaseDiskPayload ? { supabase_disk: supabaseDiskPayload } : {}),
    ...(vercelBreakdown ? { vercel_breakdown: vercelBreakdown } : {}),
    ...(upstashPayload ? { upstash: upstashPayload } : {}),
    ...(cloudflareEdge ? { cloudflare_edge: cloudflareEdge } : {}),
    ...(cfMitigation ? { cf_mitigation: cfMitigation } : {}),
    ...(vercelBilling ? { vercel_billing: vercelBilling } : {}),
    ...(burnRate ? { burn_rate: burnRate } : {}),
    // FIX-1089 / FIX-1090 — all additive; every pre-R4a field above is
    // untouched so the dashboard keeps rendering correctly off an OLD snapshot
    // payload until the next GHA cron tick lands.
    subscriptions_usd: costTotals.subscriptions_usd,
    billable_usage_usd: costTotals.billable_usage_usd,
    total_monthly_usd: costTotals.total_monthly_usd,
    cost_omissions: costTotals.omissions,
    cycles,
    ...(vercelAccount ? { vercel_account: vercelAccount } : {}),
    ...(supabaseAccount ? { supabase_account: supabaseAccount } : {}),
    ...(githubUsage ? { github: githubUsage } : {}),
    ...(selfCounted ? { self_counted: selfCounted } : {}),
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
