/**
 * FIX-1046 — Vercel Pro billing math.
 *
 * Table-driven, and the first row is the LIVE PROD READING on 2026-08-16, so
 * this suite fails if anyone reintroduces the "gross list value is the bill"
 * reading that made the dashboard claim $31.38 on a $20.00 month.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeVercelBilling,
  isPlanBaseService,
  VERCEL_PRO_INCLUDED_USD,
} from "./vercel-billing";

const near = (actual: number, expected: number, eps = 0.005): void => {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ~${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
};

describe("computeVercelBilling", () => {
  test("the measured prod case: $15.19 gross MTD is $0.00 billable", () => {
    // platform_usage_snapshot on prod, fetched_at 2026-08-16 03:13 UTC:
    //   raw_window_value (Σ EffectiveCost MTD) = 15.1852
    //   Pro line, projected                    = 20.00  ⇒ MTD = 20 × 15/31 = 9.6774
    //   window_days                            = 15
    const b = computeVercelBilling({
      effectiveMtdUsd: 15.1852,
      planBaseMtdUsd: 9.6774,
      windowDays: 15,
      daysInCycle: 31,
    });

    near(b.usage_mtd_usd, 5.5078);
    near(b.credit_remaining_usd, 14.4922);
    assert.equal(b.billable_overage_mtd_usd, 0, "nothing was owed");

    near(b.projected_usage_usd, 11.3828);
    assert.equal(
      b.projected_billable_overage_usd,
      0,
      "THE headline: $0.00 owed, not $31.38",
    );
    near(b.projected_total_bill_usd, 20.0);
    // Cross-check against what the card used to display.
    near(b.projected_gross_usd, 31.3828);
  });

  test("the subscription line never draws down the credit it buys", () => {
    // Day 1 of a cycle: only the base has accrued. Counting it as usage would
    // read as "3% of the credit already gone" on a month with zero consumption.
    const b = computeVercelBilling({
      effectiveMtdUsd: 0.6452,
      planBaseMtdUsd: 0.6452,
      windowDays: 1,
      daysInCycle: 31,
    });
    assert.equal(b.usage_mtd_usd, 0);
    assert.equal(b.credit_used_pct, 0);
    near(b.credit_remaining_usd, VERCEL_PRO_INCLUDED_USD);
    near(b.projected_total_bill_usd, 20.0);
  });

  test("real overage is reported once usage exceeds the credit", () => {
    // The 2026-08-15 crawl unmitigated: the audit projected ~$640/month.
    const b = computeVercelBilling({
      effectiveMtdUsd: 9.6774 + 320,
      planBaseMtdUsd: 9.6774,
      windowDays: 15,
      daysInCycle: 31,
    });
    near(b.usage_mtd_usd, 320);
    assert.equal(b.credit_remaining_usd, 0);
    near(b.billable_overage_mtd_usd, 300);
    near(b.projected_usage_usd, 661.33, 0.5);
    near(b.projected_billable_overage_usd, 641.33, 0.5);
    near(b.projected_total_bill_usd, 661.33, 0.5);
  });

  test("exactly at the credit is not an overage", () => {
    const b = computeVercelBilling({
      effectiveMtdUsd: 20,
      planBaseMtdUsd: 0,
      windowDays: 31,
      daysInCycle: 31,
    });
    assert.equal(b.projected_billable_overage_usd, 0);
    assert.equal(b.credit_used_pct, 100);
    assert.equal(b.credit_remaining_usd, 0);
  });

  test("a dollar over the credit is a dollar of overage", () => {
    const b = computeVercelBilling({
      effectiveMtdUsd: 21,
      planBaseMtdUsd: 0,
      windowDays: 31,
      daysInCycle: 31,
    });
    near(b.projected_billable_overage_usd, 1);
  });

  test("windowDays 0 (quantity-only fallback) refuses to invent a run-rate", () => {
    const b = computeVercelBilling({
      effectiveMtdUsd: 12,
      planBaseMtdUsd: 4,
      windowDays: 0,
      daysInCycle: 31,
    });
    assert.equal(b.projectable, false);
    assert.equal(b.projected_usage_usd, b.usage_mtd_usd, "passed through unprojected");
  });

  test("a plan base larger than the gross total clamps instead of going negative", () => {
    // Defensive: a negative usage figure would render as free credit appearing
    // from nowhere and would make credit_remaining exceed the credit itself.
    const b = computeVercelBilling({
      effectiveMtdUsd: 5,
      planBaseMtdUsd: 9,
      windowDays: 10,
      daysInCycle: 30,
    });
    assert.equal(b.usage_mtd_usd, 0);
    assert.ok(b.credit_remaining_usd <= VERCEL_PRO_INCLUDED_USD);
  });

  test("the credit is configurable — platform_limits can retune it without a deploy", () => {
    const b = computeVercelBilling({
      effectiveMtdUsd: 60,
      planBaseMtdUsd: 20,
      windowDays: 30,
      daysInCycle: 30,
      includedCreditUsd: 30,
    });
    near(b.projected_billable_overage_usd, 10);
    assert.equal(b.included_credit_usd, 30);
  });

  test("projection scales linearly with elapsed days", () => {
    const half = computeVercelBilling({
      effectiveMtdUsd: 10,
      planBaseMtdUsd: 0,
      windowDays: 15,
      daysInCycle: 30,
    });
    near(half.projected_usage_usd, 20);
  });
});

describe("isPlanBaseService", () => {
  test("matches the bare plan names Vercel emits", () => {
    for (const s of ["Pro", "pro", " Pro ", "Hobby", "Enterprise"]) {
      assert.equal(isPlanBaseService(s), true, s);
    }
  });

  test("does NOT match consumption lines that merely contain the word", () => {
    // The reason matching is anchored: a substring test on "pro" swallows this
    // and silently inflates remaining credit by a real consumption line.
    for (const s of [
      "Fluid Provisioned Memory",
      "Fluid Active CPU",
      "Observability Events",
      "Edge Requests",
      "ISR Writes",
      "Speed Insights Data Points",
      "Build CPU Minutes",
      "Fast Origin Transfer",
    ]) {
      assert.equal(isPlanBaseService(s), false, s);
    }
  });
});
