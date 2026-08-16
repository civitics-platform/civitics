/**
 * FIX-1044 D2 — the burn-rate rule.
 *
 * The load-bearing cases are the two NEGATIVES: a quiet-baseline artefact (huge
 * multiple, trivial dollars) and an expensive-but-typical day (real dollars,
 * ordinary multiple). Either one firing on its own would train the recipient to
 * ignore this alert, which is the only way a cost alarm actually fails.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBurnRate,
  computeBurnRateDeltas,
  BURN_ABSOLUTE_FLOOR_USD,
  BURN_MULTIPLE,
  type BurnRateDay,
} from "./burn-rate";

/**
 * Build a cumulative MTD series from per-day CONSUMPTION amounts, adding the
 * $20/31 subscription accrual on top — exactly the shape the charges API
 * returns, so these tests exercise the base subtraction too.
 */
function series(dailyUsage: number[]): BurnRateDay[] {
  const BASE_PER_DAY = 20 / 31;
  let gross = 0;
  let base = 0;
  return dailyUsage.map((u, i) => {
    base += BASE_PER_DAY;
    gross += u + BASE_PER_DAY;
    return { mtd_day: i + 1, gross_usd: gross, base_usd: base };
  });
}

const QUIET = [0.33, 0.31, 0.35, 0.3, 0.34, 0.32, 0.33];

describe("computeBurnRateDeltas", () => {
  test("differentiates the cumulative series into per-day consumption", () => {
    const d = computeBurnRateDeltas(series([0.5, 0.5, 0.5]));
    assert.equal(d.length, 2, "first day is dropped — it has no predecessor");
    for (const x of d) assert.ok(Math.abs(x.usage_usd - 0.5) < 1e-9);
  });

  test("the subscription accrual is removed, not differentiated into the deltas", () => {
    // A flat-zero-consumption month must read as $0.00/day, not $0.6452/day.
    const d = computeBurnRateDeltas(series([0, 0, 0, 0]));
    for (const x of d) assert.ok(Math.abs(x.usage_usd) < 1e-9, `got ${x.usage_usd}`);
  });

  test("drops the first day rather than reporting the whole MTD total as one day's burn", () => {
    // After a retention prune the earliest retained row is mid-month and
    // cumulative. Treating it as a delta would report ~$5 of burn in a day.
    const d = computeBurnRateDeltas([
      { mtd_day: 9, gross_usd: 9.0, base_usd: 5.8 },
      { mtd_day: 10, gross_usd: 9.4, base_usd: 6.45 },
    ]);
    assert.equal(d.length, 1);
    assert.ok(d[0]!.usage_usd < 0.1);
  });

  test("skips a non-consecutive pair rather than attributing a multi-day gap to one day", () => {
    const d = computeBurnRateDeltas([
      { mtd_day: 1, gross_usd: 1, base_usd: 0.65 },
      { mtd_day: 4, gross_usd: 8, base_usd: 2.6 },
      { mtd_day: 5, gross_usd: 8.5, base_usd: 3.23 },
    ]);
    assert.deepEqual(
      d.map((x) => x.mtd_day),
      [5],
    );
  });
});

describe("evaluateBurnRate", () => {
  test("stays quiet without enough history to trust a median", () => {
    const v = evaluateBurnRate(series([0.3, 0.3]));
    assert.equal(v.elevated, false);
    assert.match(v.reason, /history/);
  });

  test("stays quiet on a flat baseline", () => {
    const v = evaluateBurnRate(series(QUIET));
    assert.equal(v.elevated, false);
    assert.match(v.reason, /Normal/);
  });

  test("FIRES on the measured 2026-08-15 spike day", () => {
    // The audit's own numbers: $1.2137 of consumption against a $0.33 trailing
    // median = 3.7x. This is the case the whole layer exists for.
    const v = evaluateBurnRate(series([...QUIET, 1.2137]));
    assert.equal(v.elevated, true);
    assert.ok((v.multiple ?? 0) > 3.4 && (v.multiple ?? 0) < 4.0, `multiple ${v.multiple}`);
    assert.match(v.reason, /clears BOTH/);
  });

  test("FIRES harder on a full unmitigated crawl day", () => {
    // Projected day-16 excess from the audit: ~$13.40.
    const v = evaluateBurnRate(series([...QUIET, 13.4]));
    assert.equal(v.elevated, true);
    assert.ok((v.multiple ?? 0) > 30);
  });

  test("does NOT fire on a big multiple with trivial dollars", () => {
    // 9x the median, but $0.90 — under the floor. A quiet week dragging the
    // median down must not turn every ordinary day into a page.
    const v = evaluateBurnRate(series([0.1, 0.08, 0.12, 0.1, 0.09, 0.11, 0.1, 0.9]));
    assert.equal(v.elevated, false);
    assert.ok((v.multiple ?? 0) >= BURN_MULTIPLE, "the multiple condition was met");
    assert.match(v.reason, /under the .* floor/);
  });

  test("does NOT fire on real dollars at an ordinary multiple", () => {
    // $1.30 clears the floor but is only ~1.3x a $1.00 median — an expensive
    // platform whose expensive day is just Tuesday.
    const v = evaluateBurnRate(series([1.0, 1.1, 0.95, 1.05, 1.0, 0.9, 1.0, 1.3]));
    assert.equal(v.elevated, false);
    assert.ok(v.latest_delta_usd! >= BURN_ABSOLUTE_FLOOR_USD, "the floor condition was met");
    assert.match(v.reason, /under 3x/);
  });

  test("a zero median cannot divide by zero into a spurious page", () => {
    const v = evaluateBurnRate(series([0, 0, 0, 0, 0, 0, 0, 5]));
    assert.equal(v.multiple, null);
    assert.equal(v.elevated, false, "no median ⇒ no multiple ⇒ no alert");
  });

  test("the median ignores the day being judged", () => {
    // If the latest day leaked into its own median, a single huge day would
    // pull the denominator up and damp the very signal it should raise.
    const v = evaluateBurnRate(series([...QUIET, 13.4]));
    assert.ok(
      (v.trailing_median_usd ?? 0) < 0.4,
      `median ${v.trailing_median_usd} should reflect only the quiet days`,
    );
  });

  test("thresholds are overridable for a verify run", () => {
    const v = evaluateBurnRate(series([...QUIET, 0.5]), { floorUsd: 0.4, multiple: 1.2 });
    assert.equal(v.elevated, true);
  });

  test("projects the latest day to a 30-day run-rate", () => {
    const v = evaluateBurnRate(series([...QUIET, 1.0]));
    assert.ok(Math.abs((v.projected_monthly_usd ?? 0) - 30) < 0.001);
  });
});
