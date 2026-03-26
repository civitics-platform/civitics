import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlanTier = "free" | "pro" | "team" | "enterprise";
export type UsageSource = "api" | "webhook" | "estimated" | "manual";

export interface PlatformLimit {
  id: string;
  service: string;
  metric: string;
  plan: string;
  included_limit: number;
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
  pct: number;
  status: "healthy" | "warning" | "critical";
  overage_cost: number;
  source_display: SourceDisplay;
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
    const pct =
      value !== null && limit.included_limit > 0
        ? (value / limit.included_limit) * 100
        : 0;
    const status: PlatformMetric["status"] =
      pct >= limit.critical_pct
        ? "critical"
        : pct >= limit.warning_pct
          ? "warning"
          : "healthy";
    const overage_cost = calculateOverageCost(value ?? 0, limit);
    const source_display = getSourceDisplay(
      usage?.source ?? "manual",
      usage?.verified_at ?? null,
      usage?.stale_after_days ?? null,
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
 * Calculate overage cost for a metric given its current value.
 * Returns 0 if no overage or no overage pricing defined.
 */
export function calculateOverageCost(
  value: number,
  limit: Pick<
    PlatformLimit,
    | "included_limit"
    | "overage_unit_cost"
    | "overage_unit"
    | "overage_cap"
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

  const cost = overageUnits * limit.overage_unit_cost;

  if (limit.overage_cap !== null) {
    return Math.min(cost, limit.overage_cap);
  }

  return cost;
}

/**
 * Get display info for a usage source — label, color, icon, tooltip.
 */
export function getSourceDisplay(
  source: UsageSource,
  verifiedAt: string | null,
  staleAfterDays: number | null,
): SourceDisplay {
  const now = new Date();

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
        label: "~ Est.",
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
