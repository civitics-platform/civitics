import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImpliedCostBasis, MetricRate } from "./platform-rates";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlanTier = "free" | "pro" | "team" | "enterprise";
export type UsageSource = "api" | "webhook" | "estimated" | "manual";

export interface PlatformLimit {
  id: string;
  service: string;
  metric: string;
  plan: string;
  included_limit: number;
  // FIX-353: optional override for the %-bar denominator. NULL = use
  // included_limit (current behavior for every metric except a couple
  // Supabase ones). Set per-metric by the snapshot writer when the
  // billing-overage and capacity denominators legitimately differ.
  // FIX-1089: display_limit NO LONGER drives `pct` — see the
  // computeMetricPercents comment for why one row cannot have two
  // denominators. FIX-1104 retired the `capacity_pct` it briefly fed; the
  // column stays as the declared capacity denominator (read by
  // `effectiveLimit`, written each tick by FIX-353) with no percentage of its
  // own.
  display_limit: number | null;
  unit: string;
  overage_unit_cost: number | null;
  overage_unit: string | null;
  overage_cap: number | null;
  display_label: string | null;
  display_group: string | null;
  warning_pct: number;
  critical_pct: number;
  billing_cycle: string;
  sort_order: number;
  notes: string | null;
  is_active: boolean;
  // false when the upstream service exposes no public API for this metric
  // (e.g. Supabase egress as of May 2026). Lets the card distinguish
  // "manual because the API doesn't exist" from "manual because we forgot".
  has_public_api: boolean;
  // FIX-1089: false for wire-format companion rows that exist to make an alert
  // expressible, not to be read (vercel.overage_present — a 0/1 whose only job
  // is that $0.01 of a $20 credit rounds to 0% on an INTEGER warning_pct).
  // FIX-1076 filtered that row out of the card BY NAME; this is the generic
  // property so the next one is handled without a code change. API-only: the
  // row stays in `metrics`, in alerting and in the status roll-up.
  //
  // Optional on the type because the payload is PERSISTED: a snapshot written
  // before this column existed deserializes without it, and `!== false` is the
  // reading that keeps those old rows visible.
  is_displayed?: boolean;
}

export interface PlatformUsage {
  service: string;
  metric: string;
  value: number;
  source: UsageSource;
  verified_at: string | null;
  verified_by: string | null;
  stale_after_days: number | null;
  recorded_at: string;
  period_start: string | null;
}

export interface PlatformMetric extends PlatformLimit {
  value: number | null;
  source: UsageSource | null;
  verified_at: string | null;
  verified_by: string | null;
  stale_after_days: number | null;
  recorded_at: string | null;
  /**
   * value ÷ included_limit × 100. THE metric's own quota, always.
   *
   * FIX-1089: this used to divide by `display_limit ?? included_limit`, so
   * supabase.db_size_bytes rendered "29.6 GB / 8.0 GB" beside a 56% bar — the
   * label on one denominator (the 8 GiB quota), the bar on another (the 53 GiB
   * provisioned disk FIX-353 writes there each tick). Nothing on the row said
   * which, and 56% and 370% are different answers to different questions.
   *
   * Can exceed 100, and does: over-limit is reported honestly and the UI caps
   * the BAR, not the number. 0 when the limit is the -1 "unlimited" sentinel.
   */
  pct: number;
  status: "healthy" | "warning" | "critical";
  overage_cost: number;
  source_display: SourceDisplay;
  /**
   * FIX-1089: what one unit of this metric costs, and what that works out to
   * this cycle. Both absent when no rate is known — never guessed. Read
   * `implied_cost_basis` before adding `implied_cost_usd` to any total: a
   * `credit_absorbed` dollar and an `overage` dollar are not the same dollar,
   * and summing them is the double-count FIX-1050 removed.
   */
  rate?: MetricRate;
  implied_cost_usd?: number;
  implied_cost_basis?: ImpliedCostBasis;
  /**
   * List value of this metric's consumption when it differs from what is owed
   * — GitHub Actions runs $30.82 gross and $0.00 net on a public repo, and
   * showing only one of those tells half the story.
   */
  list_cost_usd?: number;
  // FIX-356: per-metric extras stitched on at snapshot-write time. Only the
  // supabase.cpu_pct row populates this today (windowed-max CPU sub-label);
  // other metrics leave it undefined. Optional shape — additive across
  // future metrics that want their own pass-through fields.
  metadata?: {
    cpu_max_1h?: number;
    cpu_max_24h?: number;
    // FIX-648: Vercel run-rate projection context. billing/charges only returns
    // a trailing ~N-day window, so `value` is that window's total PROJECTED to a
    // 30-day run-rate; these carry the un-projected truth for an honest sub-label.
    is_projected?: boolean;
    window_days?: number;
    raw_window_value?: number;
    // monthly_spend_usd only: the BilledCost (actual overage the Spend-Management
    // cap watches; $0 within plan) over the window, and the per-service spend
    // breakdown ("what spiked"), each projected to a monthly run-rate.
    billed_window_usd?: number;
    cost_breakdown?: { service: string; usd: number }[];
  };
}

export interface SourceDisplay {
  label: string;
  color: "green" | "amber" | "gray";
  icon: string;
  tooltip: string;
  isStale: boolean;
  needsVerification: boolean;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Get all metrics for the current billing period with usage data.
 * Returns limits joined with the current month's usage.
 */
export async function getPlatformUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  plan: PlanTier = "free",
): Promise<PlatformMetric[]> {
  const monthStart = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  ).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = supabase as any;

  const [limitsRes, usageRes] = await Promise.all([
    anyDb
      .from("platform_limits")
      .select("*")
      .eq("plan", plan)
      .eq("is_active", true)
      .order("service")
      .order("sort_order"),
    anyDb
      .from("platform_usage")
      .select("service, metric, value, source, verified_at, verified_by, stale_after_days, recorded_at")
      .eq("period_start", monthStart),
  ]);

  // FIX-545: silent-zero here fed the auto-trip evaluator an empty metric
  // set, silently skipping the safety pass. Fail the snapshot tick instead.
  if (limitsRes.error) throw new Error(`platform_limits read: ${limitsRes.error.message}`);
  if (usageRes.error) throw new Error(`platform_usage read: ${usageRes.error.message}`);
  const limits: PlatformLimit[] = limitsRes.data ?? [];
  const usageRows: PlatformUsage[] = usageRes.data ?? [];

  // Index usage by service+metric for fast lookup
  const usageMap = new Map<string, PlatformUsage>();
  for (const u of usageRows) {
    usageMap.set(`${u.service}:${u.metric}`, u);
  }

  return limits.map((limit) => {
    const usage = usageMap.get(`${limit.service}:${limit.metric}`) ?? null;
    const value = usage?.value ?? null;
    const { pct } = computeMetricPercents(value, limit);
    const status = computeMetricStatus(pct, limit);
    const overage_cost = calculateOverageCost(value ?? 0, limit);
    const source_display = getSourceDisplay(
      usage?.source ?? "manual",
      usage?.verified_at ?? null,
      usage?.stale_after_days ?? null,
      limit.has_public_api,
    );

    return {
      ...limit,
      value,
      source: usage?.source ?? null,
      verified_at: usage?.verified_at ?? null,
      verified_by: usage?.verified_by ?? null,
      stale_after_days: usage?.stale_after_days ?? null,
      recorded_at: usage?.recorded_at ?? null,
      pct,
      status,
      overage_cost,
      source_display,
    };
  });
}

/**
 * Upsert a single metric's value for the current billing period.
 */
export async function updateUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  service: string,
  metric: string,
  value: number,
  source: UsageSource = "manual",
): Promise<void> {
  const monthStart = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  ).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = supabase as any;

  await anyDb.from("platform_usage").upsert(
    {
      service,
      metric,
      value,
      source,
      // Reset verification on manual update
      verified_at: source === "manual" ? null : new Date().toISOString(),
      verified_by: source === "api" ? "system" : null,
      period_start: monthStart,
      recorded_at: new Date().toISOString(),
    },
    { onConflict: "service,metric,period_start" },
  );
}

/**
 * Mark a metric as manually verified against the service dashboard.
 */
export async function verifyUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  service: string,
  metric: string,
  verifiedBy: string = "admin",
): Promise<void> {
  const monthStart = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1,
  ).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = supabase as any;

  await anyDb
    .from("platform_usage")
    .update({
      verified_at: new Date().toISOString(),
      verified_by: verifiedBy,
    })
    .eq("service", service)
    .eq("metric", metric)
    .eq("period_start", monthStart);
}

/**
 * Switch a service to a different plan tier.
 * Does NOT change the usage rows — only affects which limits are displayed.
 * The plan is stored in pipeline_state and read by the API route.
 */
export async function upgradeServicePlan(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  service: string,
  newPlan: PlanTier,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = supabase as any;

  // Read current plan config
  const { data: existing } = await anyDb
    .from("pipeline_state")
    .select("value")
    .eq("key", "platform_plan")
    .maybeSingle();

  const current = (existing?.value as Record<string, string> | null) ?? {};
  const updated = { ...current, [service]: newPlan };

  await anyDb.from("pipeline_state").upsert(
    { key: "platform_plan", value: updated },
    { onConflict: "key" },
  );
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * The percentage a metric row carries, and which denominator it uses.
 *
 * FIX-1089 — THE MISJOIN THIS FIXES. `pct` used to divide by
 * `display_limit ?? included_limit` while the row's LABEL printed
 * `included_limit`, so prod rendered:
 *
 *     Database Size    29.6 GB / 8.0 GB          [============      ] 56%
 *
 * 29.6/8 is 370%, not 56%. The 56 came from the 53 GiB provisioned disk that
 * FIX-353 writes into `display_limit` every tick for capacity context. Both
 * numbers were individually correct answers to different questions, printed
 * side by side with nothing saying which was which — and the bar, being the
 * thing people actually read, was answering the question nobody asked of that
 * row ("how full is the disk"; `supabase.disk_used_bytes` already answers it).
 *
 * So `pct` is now always value ÷ its own included_limit.
 *
 * FIX-1104 — AND THE CAPACITY READING IS GONE. FIX-1089 kept it alive as
 * `capacity_pct` on the theory that a number worth computing was being
 * discarded. Three weeks of it being computed on every tick and rendered by
 * nothing settled that: it was `db_size_bytes ÷ provisioned disk`, and the
 * Disk Utilization row is `disk_used_bytes ÷ the same provisioned disk`. Same
 * denominator, and a numerator that is a strict SUBSET of the other's — the DB
 * files without the WAL, indexes and temp that share the volume. It never
 * answered "how full is the disk"; the Disk row does, honestly, and off the
 * larger numerator. So it is not a second capacity signal, it is a quieter
 * version of one already on the card, sitting on the row whose meter is
 * (correctly) the 8 GiB billing quota. Removing it is safe: no renderer reads
 * it, and the one-tick-old persisted payload still carries the field, which
 * deserializes harmlessly into a type that no longer declares it.
 *
 * `display_limit` itself stays — `effectiveLimit` still exposes it, and
 * FIX-353 still writes it, because "the capacity denominator" is a real thing
 * to be able to ask for even with no percentage hanging off it.
 *
 * `pct` may exceed 100 and is not clamped: over-limit is reported truthfully
 * and it is the BAR the UI caps, not the number. Extracted as a pure function
 * (same reasoning as `computeMetricStatus` in FIX-1050) so the denominator
 * choice is pinned by a test rather than by a comment.
 */
export function computeMetricPercents(
  value: number | null,
  limit: Pick<PlatformLimit, "included_limit">,
): { pct: number } {
  // included_limit <= 0 is the -1 "unlimited" sentinel (github.action_minutes,
  // vercel.function_invocations on pro, supabase.api_requests_7d). A percentage
  // of unlimited is not 0 so much as undefined, but 0 is what every consumer
  // already special-cases on `included_limit === -1`, so it stays 0.
  const pct =
    value !== null && limit.included_limit > 0
      ? (value / limit.included_limit) * 100
      : 0;
  return { pct };
}

/**
 * The band ladder: which status a metric's percentage falls into.
 *
 * Extracted from `getPlatformUsage` (FIX-1050) so the band edges are testable
 * without a database. Behaviour is unchanged — critical is checked first, and
 * both comparisons are `>=`, which is why a `warning_pct` of 0 would put every
 * row including a zero-valued one in the warning band. That property is the
 * reason the first-cent Vercel alert needed a 0/1 companion row rather than a
 * fractional threshold; see the FIX-1050 migration.
 */
export function computeMetricStatus(
  pct: number,
  bands: Pick<PlatformLimit, "warning_pct" | "critical_pct">,
): PlatformMetric["status"] {
  if (pct >= bands.critical_pct) return "critical";
  if (pct >= bands.warning_pct) return "warning";
  return "healthy";
}

/**
 * FIX-353: display_limit if set, else included_limit.
 *
 * FIX-1089 took this OFF the `pct` path. It is the CAPACITY denominator only —
 * "how full is the thing this lives on". `pct`, the label, the bands and the
 * overage math all read `included_limit` directly, so a row can no longer print
 * one denominator and bar another. Kept exported because "the capacity
 * denominator, whichever it is" is still a real question a caller can ask —
 * FIX-1104 retired the percentage that used to be derived from it, not the
 * denominator itself.
 */
export function effectiveLimit(
  row: Pick<PlatformLimit, "included_limit" | "display_limit">,
): number {
  return row.display_limit ?? row.included_limit;
}

/**
 * Calculate overage cost for a metric given its current value.
 * Returns 0 if no overage or no overage pricing defined.
 *
 * billing_cycle handling:
 *   - 'monthly_reset' / 'rolling_30d' / 'cumulative' (or unset): overage_unit_cost
 *     is treated as cost-per-unit for the current cycle. Default behavior.
 *   - 'per_day_reset': overage_unit_cost is cost-per-unit-per-DAY (currently
 *     only github.storage_bytes — GitHub bills Actions+Packages storage at
 *     $0.008/GB/day). The displayed overage projects the daily cost out to
 *     the end of the current calendar month so the dashboard shows the bill
 *     that will actually arrive, not today's micro-fraction.
 */
export function calculateOverageCost(
  value: number,
  limit: Pick<
    PlatformLimit,
    | "included_limit"
    | "overage_unit_cost"
    | "overage_unit"
    | "overage_cap"
    | "billing_cycle"
  >,
): number {
  if (!limit.overage_unit_cost) return 0;
  if (value <= limit.included_limit) return 0;

  const overage = value - limit.included_limit;

  let overageUnits: number;

  switch (limit.overage_unit) {
    case "per_gb":
      overageUnits = overage / 1073741824;
      break;
    case "per_1m":
    case "per_1m_requests":
      overageUnits = overage / 1000000;
      break;
    case "per_minute":
      overageUnits = overage / 60;
      break;
    case "per_request":
      overageUnits = overage;
      break;
    case "per_usd":
      overageUnits = overage;
      break;
    default:
      overageUnits = overage;
  }

  let cost = overageUnits * limit.overage_unit_cost;

  if (limit.billing_cycle === "per_day_reset") {
    const now = new Date();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const daysRemaining = Math.max(1, monthEnd.getDate() - now.getDate() + 1);
    cost = cost * daysRemaining;
  }

  if (limit.overage_cap !== null) {
    return Math.min(cost, limit.overage_cap);
  }

  return cost;
}

/**
 * Get display info for a usage source — label, color, icon, tooltip.
 *
 * `hasPublicApi` defaults to true. Set to false (from platform_limits) when
 * the upstream service exposes no programmatic way to fetch this metric, so
 * a `manual` entry isn't a backlog item — it's the only path. In that case
 * we render a permanent gray "Manual (no API)" badge instead of letting the
 * row drift into amber-stale every week.
 */
export function getSourceDisplay(
  source: UsageSource,
  verifiedAt: string | null,
  staleAfterDays: number | null,
  hasPublicApi: boolean = true,
): SourceDisplay {
  const now = new Date();

  if (source === "manual" && !hasPublicApi) {
    return {
      label: "Manual (no API)",
      color: "gray",
      icon: "✎",
      tooltip:
        "This service exposes no public API for this metric. Update from the service dashboard.",
      isStale: false,
      needsVerification: false,
    };
  }

  switch (source) {
    case "api":
      return {
        label: "Live",
        color: "green",
        icon: "●",
        tooltip: "Fetched live from service API",
        isStale: false,
        needsVerification: false,
      };

    case "webhook":
      return {
        label: "Live",
        color: "green",
        icon: "●",
        tooltip: "Pushed by service webhook",
        isStale: false,
        needsVerification: false,
      };

    case "estimated":
      return {
        // No leading "~" here — every renderer prints `icon` then `label`,
        // so carrying the tilde in both produced a literal "~ ~ Est."
        // on the estimated metric rows (FIX-1076).
        label: "Est.",
        color: "gray",
        icon: "~",
        tooltip: "Calculated from our pipeline logs. Accuracy ±15%.",
        isStale: false,
        needsVerification: false,
      };

    case "manual": {
      if (!verifiedAt) {
        return {
          label: "Unverified",
          color: "amber",
          icon: "⚠",
          tooltip: "Entered manually. Check service dashboard to verify.",
          isStale: false,
          needsVerification: true,
        };
      }

      const verifiedDate = new Date(verifiedAt);
      const daysSince =
        (now.getTime() - verifiedDate.getTime()) / 86400000;

      const isStale =
        staleAfterDays !== null && daysSince > staleAfterDays;

      return {
        label: isStale
          ? `Verified ${Math.floor(daysSince)}d ago`
          : `Verified ${verifiedDate.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}`,
        color: isStale ? "amber" : "green",
        icon: isStale ? "⚠" : "✓",
        tooltip: isStale
          ? "Manual entry is getting stale. Re-verify against service dashboard."
          : "Manually verified against service dashboard.",
        isStale,
        needsVerification: isStale,
      };
    }
  }
}
