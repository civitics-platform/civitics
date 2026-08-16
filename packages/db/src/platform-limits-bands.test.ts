/**
 * FIX-1050 — band edges for the Vercel overage alerting pair.
 *
 * These two rows encode a behaviour that is easy to state and easy to get
 * silently wrong: an email at the FIRST CENT of real overage, and a page at
 * $10. The rows below mirror the FIX-1050 migration exactly; if the migration
 * and this file disagree, one of them is a bug.
 *
 * The interesting case is `warning_pct: 0`. It looks like the obvious way to
 * express "any overage at all" on the dollar row, and it is the reason the
 * companion row exists instead — the last test pins that down so nobody
 * "simplifies" the two rows back into one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeMetricStatus } from "./platform-usage";

/** vercel.billable_overage_usd — the PROJECTION, pages at $10. */
const DOLLAR_ROW = { included_limit: 20, warning_pct: 50, critical_pct: 50 };

/** vercel.overage_present — actual MTD, 0/1, emails at the first cent. */
const BOOLEAN_ROW = { included_limit: 1, warning_pct: 1, critical_pct: 101 };

const pct = (value: number, limit: number) => (value / limit) * 100;

/** What the snapshot writer stores into vercel.overage_present. */
const overagePresentValue = (billableMtdUsd: number) =>
  billableMtdUsd > 0 ? 1 : 0;

test("overage_present: healthy below the first cent, warning at and above it", () => {
  const cases: [number, "healthy" | "warning" | "critical"][] = [
    [0, "healthy"],
    [0.001, "warning"], // a tenth of a cent is still real overage
    [0.01, "warning"], // THE first-cent edge — this is the email
    [9.99, "warning"],
    [10, "warning"],
    [250, "warning"], // never escalates; the page belongs to the dollar row
  ];

  for (const [mtdUsd, expected] of cases) {
    const value = overagePresentValue(mtdUsd);
    assert.equal(
      computeMetricStatus(pct(value, BOOLEAN_ROW.included_limit), BOOLEAN_ROW),
      expected,
      `billable_overage_mtd_usd=${mtdUsd} → ${expected}`,
    );
  }
});

test("billable_overage_usd: healthy under $10, critical at $10 and above", () => {
  const cases: [number, "healthy" | "warning" | "critical"][] = [
    [0, "healthy"],
    [0.01, "healthy"], // the first cent is the boolean row's job, not this one
    [9.99, "healthy"],
    [10, "critical"], // THE page
    [20, "critical"], // "bill doubled" — already critical, no second alert
    [45.5, "critical"],
  ];

  for (const [projectedUsd, expected] of cases) {
    assert.equal(
      computeMetricStatus(pct(projectedUsd, DOLLAR_ROW.included_limit), DOLLAR_ROW),
      expected,
      `projected_billable_overage_usd=${projectedUsd} → ${expected}`,
    );
  }
});

test("the two rows together: exactly one alert per band, none at $0.00", () => {
  const bands = (mtdUsd: number, projectedUsd: number) => ({
    boolean: computeMetricStatus(
      pct(overagePresentValue(mtdUsd), BOOLEAN_ROW.included_limit),
      BOOLEAN_ROW,
    ),
    dollar: computeMetricStatus(
      pct(projectedUsd, DOLLAR_ROW.included_limit),
      DOLLAR_ROW,
    ),
  });

  // A normal month: nothing owed, nothing projected. Silence.
  assert.deepEqual(bands(0, 0), { boolean: "healthy", dollar: "healthy" });

  // First cent of real overage, projection still modest → one email.
  assert.deepEqual(bands(0.01, 4), { boolean: "warning", dollar: "healthy" });

  // Projection crosses $10 → the page. The boolean row does not escalate with
  // it, so this is one new alert, not two.
  assert.deepEqual(bands(6, 12), { boolean: "warning", dollar: "critical" });
});

test("warning_pct 0 would mark a zero-valued row as warning — why the companion row exists", () => {
  // The band test is `pct >= warning_pct`. This is not a rounding nicety: it is
  // the reason "just set warning_pct to 0 for the first cent" does not work.
  assert.equal(
    computeMetricStatus(0, { warning_pct: 0, critical_pct: 50 }),
    "warning",
    "pct 0 against warning_pct 0 lands in the warning band",
  );

  // And warning_pct is an INTEGER column, so 0.05% (= $0.01 of $20) cannot be
  // stored to begin with. Rounded to the nearest storable integer it becomes
  // the case above.
  assert.equal(Math.round((0.01 / 20) * 100), 0);
});

test("computeMetricStatus keeps critical ahead of warning when the bands are equal", () => {
  // DOLLAR_ROW sets warning_pct === critical_pct. Critical must win, otherwise
  // a $10 overage would email instead of page.
  assert.equal(computeMetricStatus(50, DOLLAR_ROW), "critical");
  assert.equal(computeMetricStatus(49.9, DOLLAR_ROW), "healthy");
});
