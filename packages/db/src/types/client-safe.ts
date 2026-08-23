/**
 * Client-safe types — pure TypeScript interfaces only.
 *
 * NO imports from other @civitics/db files.
 * NO imports from @supabase/supabase-js or @supabase/ssr.
 * NO function exports.
 *
 * Import from "@civitics/db/types" in any "use client" component that
 * needs these types. Using the root "@civitics/db" import in a client
 * component pulls in storage.ts → @aws-sdk/client-s3 (Node.js builtins)
 * which webpack cannot bundle for the browser.
 */

// ── Platform usage ─────────────────────────────────────────────────────────────

export type PlanTier = "free" | "pro" | "team" | "enterprise";
export type UsageSource = "api" | "webhook" | "estimated" | "manual";

export interface PlatformLimit {
  id: string;
  service: string;
  metric: string;
  plan: string;
  included_limit: number;
  /** FIX-1089: CAPACITY denominator only — it no longer drives `pct`. */
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
  /**
   * FIX-1089: false for wire-format companion rows that exist to make an alert
   * expressible rather than to be read (vercel.overage_present). Optional
   * because persisted snapshots written before the column existed lack it —
   * read as `is_displayed !== false` so those old rows stay visible.
   */
  is_displayed?: boolean;
}

// ── Per-metric rates (FIX-1089) ────────────────────────────────────────────────

export type RateSource = "api" | "configured";

/**
 * How `implied_cost_usd` was derived. Read it before adding the number to any
 * total — a `credit_absorbed` dollar and an `overage` dollar are not the same
 * dollar, and summing them is the double-count FIX-1050 removed.
 */
export type ImpliedCostBasis =
  | "overage"
  | "actual"
  | "credit_absorbed"
  | "free_tier";

export interface MetricRate {
  usd_per_unit: number;
  /** Ready-to-render, e.g. "$0.125 / GB". */
  label: string;
  source: RateSource;
  free_units: number | null;
  per_day?: true;
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

export interface SourceDisplay {
  label: string;
  color: "green" | "amber" | "gray";
  icon: string;
  tooltip: string;
  isStale: boolean;
  needsVerification: boolean;
}

export interface PlatformMetric extends PlatformLimit {
  value: number | null;
  source: UsageSource | null;
  verified_at: string | null;
  verified_by: string | null;
  stale_after_days: number | null;
  recorded_at: string | null;
  /**
   * value ÷ included_limit × 100 — the metric's OWN quota, the same number its
   * label prints. FIX-1089: it used to divide by `display_limit ?? included_limit`,
   * which is how supabase.db_size_bytes came to render "29.6 GB / 8.0 GB" beside
   * a 56% bar. Can exceed 100; cap the BAR, not the number.
   */
  pct: number;
  /** FIX-1089: value ÷ display_limit × 100. Only on rows that set one. */
  capacity_pct?: number;
  status: "healthy" | "warning" | "critical";
  overage_cost: number;
  source_display: SourceDisplay;
  /** FIX-1089. All optional: absent when no rate is known — never guessed. */
  rate?: MetricRate;
  implied_cost_usd?: number;
  implied_cost_basis?: ImpliedCostBasis;
  /** List value of the consumption when it differs from what is owed. */
  list_cost_usd?: number;
}

// ── Anthropic usage ────────────────────────────────────────────────────────────

export type AnthropicModelUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

export type AnthropicWindowUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  by_model: AnthropicModelUsage[];
};

export type AnthropicBudget = {
  limit_usd: number;
  spent_usd: number;
  remaining_usd: number;
  pct_used: number;
  warning: boolean;
  critical: boolean;
};

export type AnthropicUsageSuccess = {
  last_hour: AnthropicWindowUsage;
  last_24h: AnthropicWindowUsage;
  this_month: AnthropicWindowUsage;
  budget: AnthropicBudget;
  source: "api";
  fetched_at: string;
};

export type AnthropicUsageError = {
  error: string;
  source: "unavailable" | "api_error";
  fetched_at: string;
};

export type AnthropicUsageResponse = AnthropicUsageSuccess | AnthropicUsageError;
