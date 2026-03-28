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
  pct: number;
  status: "healthy" | "warning" | "critical";
  overage_cost: number;
  source_display: SourceDisplay;
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
