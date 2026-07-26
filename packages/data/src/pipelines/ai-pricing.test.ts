/**
 * FIX-893 — regression tests for AI model pricing.
 *
 * Two behaviours are locked down here, because both are what let the ~4x
 * understatement live undetected for months:
 *
 *  1. The rates themselves. Haiku 4.5 bills $1.00/M input and $5.00/M output.
 *     Every cost figure the platform produced was computed from $0.25/$1.25 —
 *     Haiku-3-era prices applied to a Haiku 4.5 model id.
 *  2. An unrecognised model THROWS. `model_pricing` used to carry a
 *     Haiku-priced `default` entry, so any model missing from the map billed as
 *     the cheapest model available. `claude-opus-4-7` rows already exist in the
 *     DB; priced as Haiku that is a ~60x understatement.
 *
 * Pure arithmetic against a constants module — no DB, no network.
 *
 * Lives under packages/data/src because that is the only tree the repo's test
 * runner (packages/data/run-tests.mjs) discovers; the module under test is
 * packages/db/src/ai-pricing.ts, imported through @civitics/db.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_PRICING,
  MAX_KNOWN_PRICING,
  DEFAULT_AI_MODEL,
  UnknownModelPricingError,
  calculateCostUsd,
  calculateLoggedCostUsd,
  hasKnownPricing,
} from "@civitics/db";

/** Floating-point-safe comparison for money. */
function assertUsd(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: expected $${expected}, got $${actual}`,
  );
}

// ---------------------------------------------------------------------------
// 1. The rate table: (input tokens, output tokens, model) -> expected USD
// ---------------------------------------------------------------------------

const CASES: Array<{
  input: number;
  output: number;
  model: string;
  expected: number;
  why: string;
}> = [
  // Haiku 4.5 at the corrected rates — $1.00/M in, $5.00/M out.
  { input: 1_000_000, output: 0,         model: "claude-haiku-4-5-20251001", expected: 1.0,     why: "1M Haiku input = $1.00 (was $0.25)" },
  { input: 0,         output: 1_000_000, model: "claude-haiku-4-5-20251001", expected: 5.0,     why: "1M Haiku output = $5.00 (was $1.25)" },
  { input: 1_000_000, output: 1_000_000, model: "claude-haiku-4-5-20251001", expected: 6.0,     why: "1M+1M Haiku = $6.00 (was $1.50)" },
  { input: 1_000,     output: 500,       model: "claude-haiku-4-5-20251001", expected: 0.0035,  why: "realistic tag call: 1k in + 500 out" },
  { input: 0,         output: 0,         model: "claude-haiku-4-5-20251001", expected: 0,       why: "zero tokens costs nothing" },
  // The bare alias must price identically to the dated snapshot id.
  { input: 1_000_000, output: 1_000_000, model: "claude-haiku-4-5",          expected: 6.0,     why: "Haiku alias matches dated id" },
  // Sonnet 4.6 — $3/$15. Already correct pre-FIX-893; locked so it stays that way.
  { input: 1_000_000, output: 1_000_000, model: "claude-sonnet-4-6",         expected: 18.0,    why: "Sonnet 4.6 = $3 + $15" },
  // Opus 4.6 — $5/$25. Was recorded as $15/$75 (Opus 4.1's price), 3x OVER.
  { input: 1_000_000, output: 1_000_000, model: "claude-opus-4-6",           expected: 30.0,    why: "Opus 4.6 = $5 + $25 (was $15+$75)" },
];

test("calculateCostUsd prices every known model at the published rate", () => {
  for (const c of CASES) {
    assertUsd(calculateCostUsd(c.input, c.output, c.model), c.expected, c.why);
  }
});

test("the corrected Haiku rate is 4x the old wrong one", () => {
  // Guards against a silent revert to $0.25/$1.25.
  const corrected = calculateCostUsd(1_000_000, 1_000_000, "claude-haiku-4-5-20251001");
  const oldWrong = (1_000_000 * 0.25 + 1_000_000 * 1.25) / 1_000_000; // $1.50
  assertUsd(corrected, 6.0, "corrected Haiku 1M+1M");
  assertUsd(oldWrong, 1.5, "old wrong Haiku 1M+1M");
  assert.equal(corrected / oldWrong, 4, "correction must be exactly 4x on a 1:1 token split");
});

test("the default model argument is Haiku 4.5 at corrected rates", () => {
  assert.equal(DEFAULT_AI_MODEL, "claude-haiku-4-5-20251001");
  assertUsd(calculateCostUsd(1_000_000, 1_000_000), 6.0, "default model = Haiku");
});

// ---------------------------------------------------------------------------
// 2. Unknown models fail closed
// ---------------------------------------------------------------------------

const UNKNOWN_MODELS = [
  "claude-opus-4-7",     // real: rows with this ai_model already exist in entity_tags
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-3-haiku-20240307",
  "default",             // the removed cheap-fallback key must not resolve
  "",
  "not-a-model",
];

test("calculateCostUsd throws on an unrecognised model instead of billing at the cheapest rate", () => {
  for (const model of UNKNOWN_MODELS) {
    assert.throws(
      () => calculateCostUsd(1_000, 500, model),
      UnknownModelPricingError,
      `expected a throw for unknown model "${model}"`,
    );
  }
});

test("the thrown error names the unrecognised model", () => {
  try {
    calculateCostUsd(1, 1, "claude-opus-4-7");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof UnknownModelPricingError);
    assert.equal(err.model, "claude-opus-4-7");
    assert.match(err.message, /claude-opus-4-7/);
    // The message must point at the file to edit.
    assert.match(err.message, /ai-pricing\.ts/);
  }
});

test("there is no cheap default entry in the pricing map", () => {
  assert.equal(MODEL_PRICING["default"], undefined);
  assert.equal(hasKnownPricing("default"), false);
  assert.equal(hasKnownPricing("claude-opus-4-7"), false);
  assert.equal(hasKnownPricing(null), false);
  assert.equal(hasKnownPricing("claude-haiku-4-5-20251001"), true);
});

// ---------------------------------------------------------------------------
// 3. Read-path aggregation errs HIGH, never low
// ---------------------------------------------------------------------------

test("MAX_KNOWN_PRICING is the highest rate across all known models", () => {
  assertUsd(MAX_KNOWN_PRICING.input_per_million, 5.0, "max input rate");
  assertUsd(MAX_KNOWN_PRICING.output_per_million, 25.0, "max output rate");
});

test("calculateLoggedCostUsd prices a known model exactly like calculateCostUsd", () => {
  for (const c of CASES) {
    assertUsd(
      calculateLoggedCostUsd(c.input, c.output, c.model),
      calculateCostUsd(c.input, c.output, c.model),
      `logged cost agrees for ${c.model}`,
    );
  }
});

test("calculateLoggedCostUsd prices an unknown or null model at the highest known rate", () => {
  // Erring high is the safe direction for a spend guard: the budget binds
  // sooner, never later. The bug this replaces priced unknowns as Haiku.
  const expected = (1_000_000 * 5.0 + 1_000_000 * 25.0) / 1_000_000; // $30
  for (const model of [...UNKNOWN_MODELS, null, undefined]) {
    assertUsd(
      calculateLoggedCostUsd(1_000_000, 1_000_000, model),
      expected,
      `unknown model ${String(model)} priced at max known rate`,
    );
  }
});

test("an Opus row in api_usage_logs is no longer under-read as Haiku", () => {
  // The concrete regression: 1M+1M on an unlisted Opus id used to aggregate to
  // Haiku's $1.50. It must now read at least the real Opus 4.6 cost of $30.
  const loggedNow = calculateLoggedCostUsd(1_000_000, 1_000_000, "claude-opus-4-7");
  const oldHaikuPriced = 1.5;
  assert.ok(
    loggedNow >= 30.0,
    `expected >= $30 for an Opus-tier row, got $${loggedNow}`,
  );
  assert.ok(loggedNow / oldHaikuPriced >= 20, "must be at least 20x the old under-read");
});
