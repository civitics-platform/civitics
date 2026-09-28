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
  chargesWindowStartsAt,
  computeVercelBilling,
  isPlanBaseService,
  stampVercelBilling,
  vercelBillingCycle,
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

// ── FIX-1099: the vendor's cycle ────────────────────────────────────────────
//
// The wrong-but-green shape: a vendor cycle that happens to agree with the
// calendar month would pass any test that only compares the two. So every
// real-shaped fixture below starts mid-month (the account's cycle starts on
// the 14th), and the one calendar-aligned cycle is there to show the two bases
// agree ONLY then.

const Z = (iso: string): number => Date.parse(iso);

describe("vercelBillingCycle (FIX-1099)", () => {
  test("31-day cycle straddling a month end, started on the 14th — the prod Aug cycle", () => {
    // billing.period read on prod 2026-08-22: 1786690800000 … 1789369200000.
    assert.equal(Z("2026-08-14T07:00:00Z"), 1786690800000);
    assert.equal(Z("2026-09-14T07:00:00Z"), 1789369200000);
    const c = vercelBillingCycle(1786690800000, 1789369200000, new Date("2026-09-02T12:00:00Z"));
    assert.equal(c.basis, "vendor");
    assert.equal(c.days_in_cycle, 31);
    assert.equal(c.day_of_cycle, 20, "Aug 14 … Sep 2 is day 20, not day 2 of September");
    assert.equal(c.fallback_reason, null);
  });

  test("30-day cycle — the prod Sep 14 → Oct 14 cycle", () => {
    const c = vercelBillingCycle(
      Z("2026-09-14T07:00:00Z"),
      Z("2026-10-14T07:00:00Z"),
      new Date("2026-09-28T00:30:00Z"),
    );
    assert.equal(c.days_in_cycle, 30);
    assert.equal(c.day_of_cycle, 14);
  });

  test("28-day cycle (Feb 14 → Mar 14, both PST midnights)", () => {
    const c = vercelBillingCycle(
      Z("2027-02-14T08:00:00Z"),
      Z("2027-03-14T08:00:00Z"),
      new Date("2027-02-14T09:00:00Z"),
    );
    assert.equal(c.days_in_cycle, 28);
    assert.equal(c.day_of_cycle, 1);
  });

  test("a cycle spanning the DST change is 31 days + 1 hour and rounds to 31", () => {
    // Oct 14 is PDT (07:00Z), Nov 14 is PST (08:00Z).
    const c = vercelBillingCycle(
      Z("2026-10-14T07:00:00Z"),
      Z("2026-11-14T08:00:00Z"),
      new Date("2026-11-01T00:00:00Z"),
    );
    assert.equal(c.days_in_cycle, 31);
  });

  test("a calendar-aligned vendor cycle agrees with the calendar month — and only that one does", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const aligned = vercelBillingCycle(Z("2026-09-01T00:00:00Z"), Z("2026-10-01T00:00:00Z"), now);
    const calendar = vercelBillingCycle(null, null, now);
    assert.equal(aligned.basis, "vendor");
    assert.equal(calendar.basis, "calendar");
    assert.equal(aligned.days_in_cycle, calendar.days_in_cycle);
    assert.equal(aligned.day_of_cycle, calendar.day_of_cycle);

    const midMonth = vercelBillingCycle(Z("2026-09-14T07:00:00Z"), Z("2026-10-14T07:00:00Z"), now);
    assert.notEqual(midMonth.day_of_cycle, calendar.day_of_cycle);
    assert.equal(midMonth.day_of_cycle, 7, "day 7 of the vendor cycle …");
    assert.equal(calendar.day_of_cycle, 20, "… is day 20 of the month");
  });

  test("falls back to the calendar month, and says why, when the period is unusable", () => {
    const now = new Date("2026-09-20T12:00:00Z");
    const cases: Array<[number | null | undefined, number | null | undefined, RegExp]> = [
      [null, null, /no billing\.period/],
      [undefined, Z("2026-10-14T07:00:00Z"), /no billing\.period/],
      [Number.NaN, Z("2026-10-14T07:00:00Z"), /not finite/],
      [Z("2026-10-14T07:00:00Z"), Z("2026-09-14T07:00:00Z"), /end is not after/],
      // The vendor had not rolled the period: it ended before now.
      [Z("2026-08-14T07:00:00Z"), Z("2026-09-14T07:00:00Z"), /does not contain now/],
    ];
    for (const [s, e, why] of cases) {
      const c = vercelBillingCycle(s, e, now);
      assert.equal(c.basis, "calendar");
      assert.match(c.fallback_reason ?? "", why);
      assert.equal(c.days_in_cycle, 30, "September");
      assert.equal(c.start_ms, Z("2026-09-01T00:00:00Z"));
      assert.equal(c.end_ms, Z("2026-10-01T00:00:00Z"));
    }
  });
});

describe("chargesWindowStartsAt (FIX-1099)", () => {
  const start = Z("2026-09-14T07:00:00Z");
  test("accepts the cycle's first day under either label convention", () => {
    assert.equal(chargesWindowStartsAt("2026-09-14T07:00:00.000Z", 13, start), true);
    assert.equal(chargesWindowStartsAt("2026-09-14T00:00:00.000Z", 13, start), true);
  });
  test("rejects a truncated window (the trailing-7-day shape FIX-648 once saw)", () => {
    assert.equal(chargesWindowStartsAt("2026-09-21T07:00:00.000Z", 7, start), false);
  });
  test("rejects a window that ignored `from` and ran from the 1st", () => {
    assert.equal(chargesWindowStartsAt("2026-08-31T07:00:00.000Z", 27, start), false);
  });
  test("an empty window in the cycle's first hours is a true zero", () => {
    assert.equal(chargesWindowStartsAt(null, 0, start), true);
  });
  test("an unparseable label is not evidence", () => {
    assert.equal(chargesWindowStartsAt("not a date", 3, start), false);
  });
});

describe("the two bases on prod's own numbers (FIX-1099 replay anchors)", () => {
  test("2026-09-28 00:30Z: both bases sit well inside every band", () => {
    // platform_usage_snapshot, prod. Calendar: MTD usage $7.2378 over 27 charge
    // days (Aug 31 PDT … Sep 26 PDT). Vendor: the MTD read $3.3402 at the
    // boundary (through Sep 13 PDT), so the cycle-to-date is $3.8976 over 13.
    const calendar = computeVercelBilling({
      effectiveMtdUsd: 24.9367,
      planBaseMtdUsd: 17.6989,
      windowDays: 27,
      daysInCycle: 30,
    });
    near(calendar.projected_usage_usd, 8.042);
    const vendor = computeVercelBilling({
      effectiveMtdUsd: 3.8976 + 8.6666,
      planBaseMtdUsd: 8.6666,
      windowDays: 13,
      daysInCycle: 30,
    });
    near(vendor.projected_usage_usd, 8.9945);
    assert.equal(calendar.projected_billable_overage_usd, 0);
    assert.equal(vendor.projected_billable_overage_usd, 0);
  });

  test("day 1 of the Sep 14 cycle: the vendor basis projects one day x 30 — the flip", () => {
    // Sep 14 PDT alone: $0.7752 of usage, $0.65 of it the once-per-cycle
    // Speed Insights Plus Events charge. The calendar basis saw it as day 15.
    const vendor = computeVercelBilling({
      effectiveMtdUsd: 0.7752 + 0.6667,
      planBaseMtdUsd: 0.6667,
      windowDays: 1,
      daysInCycle: 30,
    });
    near(vendor.projected_usage_usd, 23.256);
    assert.ok(
      vendor.projected_usage_usd >= VERCEL_PRO_INCLUDED_USD,
      "≥ 100% of the credit: included_usage_usd CRITICAL on the vendor basis",
    );
    const calendar = computeVercelBilling({
      effectiveMtdUsd: 4.1154 + 9.6989,
      planBaseMtdUsd: 9.6989,
      windowDays: 15,
      daysInCycle: 30,
    });
    near(calendar.projected_usage_usd, 8.2308);
    assert.ok(
      calendar.projected_usage_usd < 0.8 * VERCEL_PRO_INCLUDED_USD,
      "healthy on the calendar basis",
    );
  });
});

describe("stampVercelBilling (FIX-1099)", () => {
  test("the payload says which cycle it divided by", () => {
    const b = computeVercelBilling({
      effectiveMtdUsd: 1,
      planBaseMtdUsd: 0.5,
      windowDays: 1,
      daysInCycle: 30,
    });
    const cycle = vercelBillingCycle(
      Z("2026-09-14T07:00:00Z"),
      Z("2026-10-14T07:00:00Z"),
      new Date("2026-09-15T08:00:00Z"),
    );
    const s = stampVercelBilling(b, cycle, 1);
    assert.equal(s.basis, "vendor");
    assert.equal(s.mtd_basis, "charges");
    assert.equal(s.billing_period_start, "2026-09-14T07:00:00.000Z");
    assert.equal(s.billing_period_end, "2026-10-14T07:00:00.000Z");
    assert.equal(s.days_in_cycle, 30);
    assert.equal(s.window_days, 1);
    assert.equal(s.fallback_reason, null);
    near(s.projected_usage_usd, b.projected_usage_usd);
  });
});
