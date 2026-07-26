/**
 * packages/ai/src/cost-config.ts
 *
 * Central cost configuration for all AI pipelines.
 * Every limit and threshold lives here — nowhere else.
 *
 * PRICES ARE NOT DEFINED IN THIS FILE (FIX-893). They live in
 * `packages/db/src/ai-pricing.ts` and are re-exported below, because two
 * packages/db modules also need them and `@civitics/ai` already depends on
 * `@civitics/db` (importing the other way would be circular). See that file's
 * header for the full reasoning. There is still exactly one definition of a
 * price; this module stays the documented entry point for pipeline code, and
 * `COST_CONFIG.model_pricing` / `calculateCostUsd` behave as before — except
 * that an unrecognised model now throws instead of billing at Haiku rates.
 *
 * To change a price, edit packages/db/src/ai-pricing.ts.
 */

import {
  MODEL_PRICING,
  calculateCostUsd,
  DEFAULT_AI_MODEL,
  UnknownModelPricingError,
  calculateLoggedCostUsd,
  hasKnownPricing,
  MAX_KNOWN_PRICING,
  type ModelPricing,
} from "@civitics/db";

// Re-exported so existing importers of "@civitics/ai/cost-config" keep working.
export {
  calculateCostUsd,
  calculateLoggedCostUsd,
  hasKnownPricing,
  UnknownModelPricingError,
  DEFAULT_AI_MODEL,
  MODEL_PRICING,
  MAX_KNOWN_PRICING,
};
export type { ModelPricing };

export const COST_CONFIG = {
  // Monthly hard limit in USD — ALL pipelines stop if hit, no exceptions
  monthly_hard_limit_usd: 3.50,

  // Warning alert threshold — dashboard banner appears
  monthly_warning_usd: 2.50,

  // Auto-approve runs under this cost — no confirmation prompt needed
  // Good for tiny nightly runs (e.g. incremental summaries)
  auto_approve_under_usd: 0.05,

  // Pause pipeline if actual cost exceeds estimate by this ratio at midpoint
  // 1.5 = pause at 50% over estimate
  variance_pause_threshold: 1.5,

  // How many sample calls to make before estimating full batch cost
  // 3 is accurate enough and fast enough
  estimate_sample_size: 3,

  // Per-pipeline run limits in USD — hard stop per individual run
  // regardless of remaining monthly budget
  per_run_limits: {
    ai_summaries:  0.50,
    ai_tagger:     0.50,
    ai_classifier: 0.25,
    ai_narrative:  0.10,
    default:       0.20,
  },

  // Anthropic model pricing — see packages/db/src/ai-pricing.ts (FIX-893).
  // NOT defined here. There is deliberately no `default` entry: a model absent
  // from the map used to bill at Haiku rates, so any unlisted model (e.g. the
  // claude-opus-4-7 rows already in entity_tags) was priced as the cheapest
  // model available. calculateCostUsd now throws instead.
  model_pricing: MODEL_PRICING,

  // Alert channels — Phase 1: console + supabase only
  // Phase 2: add email + webhook
  alerts: {
    console:  true,
    supabase: true,
    email:    false,
    webhook:  false,
  },

  // Autonomous mode — rules used in cron/CI environments instead of terminal prompts.
  // These are defaults; admins can override via pipeline_state key 'cost_config_overrides'.
  autonomous: {
    // Max estimated cost to auto-approve without any human review
    max_auto_approve_usd: 0.10,

    // Skip AI pipeline if remaining monthly budget falls below this
    min_budget_remaining_usd: 0.50,

    // Skip if entity count is suspiciously high (something unusual may have happened)
    max_entity_count: 50,

    // Skip if the last run of this pipeline failed or was paused
    skip_if_last_run_failed: true,

    // Skip if last run actual cost exceeded estimate by this ratio
    // 1.5 = last run was 50% over estimate
    skip_if_variance_over: 1.5,

    // Use 1 sample call instead of 3 — saves time and cost in cron runs
    sample_size_override: 1,
  },
} as const;

// calculateCostUsd now lives in packages/db/src/ai-pricing.ts and is
// re-exported at the top of this file (FIX-893).

export type PipelineName = keyof typeof COST_CONFIG.per_run_limits;

/**
 * Return the effective cost config, merging hardcoded defaults with any
 * admin overrides stored in pipeline_state key 'cost_config_overrides'.
 * Overrides allow adjusting thresholds from the dashboard without code changes.
 *
 * Falls back to base COST_CONFIG on any DB error.
 */
export async function getEffectiveConfig(): Promise<typeof COST_CONFIG> {
  try {
    const { createAdminClient } = await import("@civitics/db");
    const supabase = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("pipeline_state")
      .select("value")
      .eq("key", "cost_config_overrides")
      .single();

    if (!data?.value) return COST_CONFIG;

    return {
      ...COST_CONFIG,
      ...(data.value as Partial<typeof COST_CONFIG>),
      // Deep-merge nested sections so partial overrides work
      autonomous: {
        ...COST_CONFIG.autonomous,
        ...((data.value as Partial<typeof COST_CONFIG>).autonomous ?? {}),
      },
      per_run_limits: {
        ...COST_CONFIG.per_run_limits,
        ...((data.value as Partial<typeof COST_CONFIG>).per_run_limits ?? {}),
      },
    } as typeof COST_CONFIG;
  } catch {
    return COST_CONFIG;
  }
}
