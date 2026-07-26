/**
 * packages/db/src/ai-pricing.ts
 *
 * THE single source of truth for Anthropic model pricing (FIX-893).
 *
 * WHY THIS LIVES IN packages/db AND NOT packages/ai:
 * `packages/ai/src/cost-config.ts` claimed to be the only home for prices
 * ("Every limit, threshold, and price lives here — nowhere else") while eight
 * other files carried their own copy. Two of those copies are in packages/db
 * itself (anthropic-usage.ts, platform-snapshot.ts), and `@civitics/ai` already
 * depends on `@civitics/db` — so packages/db cannot import from packages/ai
 * without a circular workspace dependency. packages/db is the lowest package in
 * the graph, so a dependency-free constants module here is reachable from ai,
 * data, and both apps with no new edges. `cost-config.ts` re-exports everything
 * below, so it remains the documented entry point for pipeline code and every
 * existing `COST_CONFIG.model_pricing` / `calculateCostUsd` importer is
 * unchanged. There is still exactly ONE definition of a price.
 *
 * This module must stay dependency-free — no supabase, no node builtins.
 *
 * Prices verified against the Claude pricing docs on 2026-07-25.
 * Update ONLY here when Anthropic changes pricing.
 */

export type ModelPricing = {
  input_per_million: number;
  output_per_million: number;
};

/**
 * Per-million-token prices in USD.
 *
 * Haiku 4.5 was previously recorded at $0.25/$1.25 — Haiku-3-era prices applied
 * to a Haiku 4.5 model id, making every cost figure the platform produced ~4x
 * low. Haiku 4.5 bills $1.00 input / $5.00 output. Haiku 4.5 also tokenizes the
 * same text into roughly 30% more tokens than earlier models, so the effective
 * historical understatement is closer to 5x.
 *
 * Opus 4.6 was recorded at $15/$75, which is Opus 4.1's pricing — 3x OVER the
 * real $5/$25. Verified against the published pricing table 2026-07-25 along
 * with Sonnet 4.6 ($3/$15, which was already correct).
 *
 * Both the dated snapshot id and the bare alias are listed for Haiku because
 * pipelines pass the dated id while some callers pass the alias; an id missing
 * from this map now THROWS rather than silently billing at the cheapest rate.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude Haiku 4.5 — $1.00 / $5.00
  "claude-haiku-4-5-20251001": { input_per_million: 1.0, output_per_million: 5.0 },
  "claude-haiku-4-5":          { input_per_million: 1.0, output_per_million: 5.0 },
  // Claude Sonnet 4.6 — $3.00 / $15.00 (unchanged; verified 2026-07-25)
  "claude-sonnet-4-6":         { input_per_million: 3.0, output_per_million: 15.0 },
  // Claude Opus 4.6 — $5.00 / $25.00 (was wrongly $15/$75, i.e. Opus 4.1's price)
  "claude-opus-4-6":           { input_per_million: 5.0, output_per_million: 25.0 },
};

/** The model every AI pipeline in this repo actually runs on. */
export const DEFAULT_AI_MODEL = "claude-haiku-4-5-20251001";

/**
 * Thrown when a cost is requested for a model that is not in MODEL_PRICING.
 *
 * There is deliberately NO cheap default. The previous `default` entry was
 * Haiku-priced, so any model absent from the map — including the
 * `claude-opus-4-7` rows already present in `entity_tags` — was billed as if it
 * were the cheapest model available (a ~60x understatement at Opus rates).
 * Spend must fail closed: an unrecognised model is a bug to fix, not a number
 * to guess.
 */
export class UnknownModelPricingError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(
      `No pricing configured for AI model "${model}". Add it to MODEL_PRICING in ` +
        `packages/db/src/ai-pricing.ts before running work on this model — ` +
        `cost gates and budget limits cannot be enforced without a real price. ` +
        `Known models: ${Object.keys(MODEL_PRICING).join(", ")}.`,
    );
    this.name = "UnknownModelPricingError";
    this.model = model;
  }
}

/**
 * Calculate cost in USD from token counts and model name.
 * Uses exact arithmetic — no rounding, no Math.ceil.
 *
 * THROWS `UnknownModelPricingError` for an unrecognised model. Use this on
 * every write/estimate/gate path, where guessing a price defeats the limit.
 * For read-side aggregation over historical rows whose model column is not
 * under our control, use `calculateLoggedCostUsd`.
 */
export function calculateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string = DEFAULT_AI_MODEL,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) throw new UnknownModelPricingError(model);

  return (
    (inputTokens * pricing.input_per_million +
      outputTokens * pricing.output_per_million) /
    1_000_000
  );
}

/**
 * Highest per-million price across every known model. Used as the fail-closed
 * fallback when aggregating historical usage rows.
 */
export const MAX_KNOWN_PRICING: ModelPricing = Object.values(MODEL_PRICING).reduce(
  (max, p) => ({
    input_per_million: Math.max(max.input_per_million, p.input_per_million),
    output_per_million: Math.max(max.output_per_million, p.output_per_million),
  }),
  { input_per_million: 0, output_per_million: 0 },
);

/**
 * Cost of one already-logged `api_usage_logs` row.
 *
 * Differs from `calculateCostUsd` in how it treats an unknown/absent model: it
 * prices at MAX_KNOWN_PRICING instead of throwing, because these are read-path
 * aggregations (dashboards, the monthly-spend guard) where one unrecognised row
 * must not blank out a whole month's total. Erring HIGH is the safe direction
 * for a spend guard — it makes the budget bind sooner, never later. Pricing an
 * unknown model at the cheapest rate is the bug this replaces: it made an Opus
 * row read as ~1/60th of its real cost.
 *
 * A null/absent model is treated the same way — unknown, priced high.
 */
export function calculateLoggedCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string | null | undefined,
): number {
  const pricing = (model ? MODEL_PRICING[model] : undefined) ?? MAX_KNOWN_PRICING;
  return (
    (inputTokens * pricing.input_per_million +
      outputTokens * pricing.output_per_million) /
    1_000_000
  );
}

/** True when `model` has a real configured price. */
export function hasKnownPricing(model: string | null | undefined): boolean {
  return !!model && model in MODEL_PRICING;
}
