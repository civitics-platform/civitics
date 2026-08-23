/**
 * FIX-1089 — per-metric unit rates.
 *
 * The property that matters most is not "the arithmetic is right", it is that
 * **a configured rate reproduces the overage total sitting next to it**. The
 * rate and `calculateOverageCost` are two renderings of the same
 * `overage_unit_cost`, and if their unit conversions ever drift the card prints
 * a price that does not multiply up to the dollar figure beside it. The
 * round-trip test below is what pins that.
 *
 * The Vercel invoiceItem tests decode a units convention that is documented
 * nowhere, using the two lines whose value is independently known.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  configuredRateFromLimit,
  measuredRate,
  invoiceItemUsdPerUnit,
  invoiceItemFlatUsd,
} from "./platform-rates";
import { calculateOverageCost } from "./platform-usage";

const GIB = 1024 ** 3;

test("per_gb: $0.125/GB on supabase.db_size_bytes", () => {
  const r = configuredRateFromLimit({
    overage_unit_cost: 0.125,
    overage_unit: "per_gb",
    included_limit: 8 * GIB,
    billing_cycle: "monthly_reset",
  });
  assert.ok(r);
  assert.equal(r.usd_per_unit, 0.125 / GIB);
  assert.equal(r.label, "$0.125 / GB");
  assert.equal(r.source, "configured");
  assert.equal(r.free_units, 8 * GIB);
});

test("a configured rate multiplies back up to calculateOverageCost", () => {
  // If these two ever disagree, the card shows a price that does not reproduce
  // the total printed next to it.
  const rows = [
    { overage_unit_cost: 0.125, overage_unit: "per_gb", included_limit: 8 * GIB, value: 29.63 * GIB },
    { overage_unit_cost: 0.09, overage_unit: "per_gb", included_limit: 250 * GIB, value: 400 * GIB },
    { overage_unit_cost: 0.0045, overage_unit: "per_1m", included_limit: 1_000_000, value: 4_500_000 },
    { overage_unit_cost: 0.00036, overage_unit: "per_1m", included_limit: 10_000_000, value: 25_000_000 },
    { overage_unit_cost: 0.0005, overage_unit: "per_request", included_limit: 50_000, value: 90_000 },
    { overage_unit_cost: 0.00325, overage_unit: "per_request", included_limit: 100_000, value: 130_000 },
  ] as const;

  for (const row of rows) {
    const limit = { ...row, overage_cap: null, billing_cycle: "monthly_reset" };
    const rate = configuredRateFromLimit(limit);
    assert.ok(rate, `${row.overage_unit} should yield a rate`);
    const viaRate = rate.usd_per_unit * (row.value - row.included_limit);
    const viaOverage = calculateOverageCost(row.value, limit);
    assert.ok(
      Math.abs(viaRate - viaOverage) < 1e-9,
      `${row.overage_unit}: rate→${viaRate} vs overage→${viaOverage}`,
    );
  }
});

test("per_day_reset is flagged, because printing it as monthly understates ~30x", () => {
  // github.storage_bytes: GitHub bills Actions+Packages storage per GB PER DAY.
  const r = configuredRateFromLimit({
    overage_unit_cost: 0.008,
    overage_unit: "per_gb",
    included_limit: 524288000,
    billing_cycle: "per_day_reset",
  });
  assert.ok(r);
  assert.equal(r.per_day, true);
  assert.equal(r.label, "$0.008 / GB / day");
});

test("no overage price means no rate — never a zero, never a guess", () => {
  // Hard limits and block-don't-bill free tiers. A $0.00/unit label would read
  // as "this is free", which is a different claim from "this is not priced".
  const none = { included_limit: 3000, billing_cycle: "monthly_reset" };
  assert.equal(configuredRateFromLimit({ ...none, overage_unit_cost: null, overage_unit: null }), null);
  assert.equal(configuredRateFromLimit({ ...none, overage_unit_cost: 0, overage_unit: "per_gb" }), null);
  assert.equal(
    configuredRateFromLimit({ ...none, overage_unit_cost: Number.NaN, overage_unit: "per_gb" }),
    null,
  );
});

test("a sub-cent rate is never formatted down to '$0'", () => {
  // The label is what a human reads, so "$0 / bytes" on a metric that costs
  // money is a lie the number underneath does not tell. Per-byte rates run to
  // 1e-11 — fixed decimal places round them to zero, which is exactly what the
  // first local smoke printed for vercel.origin_transfer_bytes.
  const perByte = configuredRateFromLimit({
    overage_unit_cost: 0.06,
    overage_unit: "per_gb",
    included_limit: 0,
    billing_cycle: "monthly_reset",
  });
  assert.ok(perByte);
  assert.equal(perByte.label, "$0.06 / GB", "the LABEL quotes the priced unit, not the native one");

  const measured = measuredRate(0.38, 6592008981, "bytes");
  assert.ok(measured);
  assert.notEqual(measured.label, "$0 / bytes");
  assert.match(measured.label, /e-|\d/, `got ${measured.label}`);
  assert.ok(!/^\$0(\.0+)? /.test(measured.label), `formatted to zero: ${measured.label}`);

  // And across the whole span these rates actually occupy.
  for (const v of [0.0106, 0.006, 0.0000006, 3.5e-5, 5.4e-11, 8e-8]) {
    const r = measuredRate(v, 1, "unit");
    assert.ok(r && !/^\$0(\.0+)? /.test(r.label), `${v} formatted to zero: ${r?.label}`);
  }
});

test("the -1 unlimited sentinel is not reported as -1 free units", () => {
  const r = configuredRateFromLimit({
    overage_unit_cost: 0.006,
    overage_unit: "per_minute",
    included_limit: -1,
    billing_cycle: "monthly_reset",
  });
  assert.ok(r);
  assert.equal(r.free_units, null);
});

// ── Measured rates ────────────────────────────────────────────────────────────

test("measuredRate divides the vendor's dollars by the vendor's quantity", () => {
  // Vercel Fluid Active CPU: $0.128/CPU-hour = $0.0000355…/second. Nothing here
  // knows that number — it falls out of two fields in the same response.
  const r = measuredRate(1.28, 36000, "seconds");
  assert.ok(r);
  assert.ok(Math.abs(r.usd_per_unit - 0.128 / 3600) < 1e-12);
  assert.equal(r.source, "api");
});

test("measuredRate refuses a zero quantity instead of rendering Infinity", () => {
  assert.equal(measuredRate(5, 0, "requests"), null);
  assert.equal(measuredRate(5, -1, "requests"), null);
  assert.equal(measuredRate(Number.NaN, 10, "requests"), null);
  // A genuinely-free metric has no rate rather than a $0 one.
  assert.equal(measuredRate(0, 1000, "requests"), null);
});

// ── Vercel invoiceItems encoding ──────────────────────────────────────────────

test("invoiceItems prices are CENTS — pinned by the two known lines", () => {
  // `pro` is the $20/month Pro subscription. `includedAllocationUsd` is the $20
  // credit FIX-1046 hardcoded as VERCEL_PRO_INCLUDED_USD. Both only parse if
  // price is in cents, which is how the convention was established at all.
  assert.equal(invoiceItemFlatUsd({ price: 2000, quantity: 1 }), 20);
  assert.equal(invoiceItemFlatUsd({ price: 2000, quantity: 0 }), 0, "teamSeats on a solo account");
});

test("batch divides the price across the units it covers", () => {
  // edgeMiddlewareInvocations: price 65, batch 1_000_000 → $0.65 per million.
  assert.equal(invoiceItemUsdPerUnit({ price: 65, batch: 1_000_000 }), 0.65 / 1_000_000);
  // edgeFunctionExecutionUnits: price 200, batch 1_000_000 → $2.00 per million.
  assert.equal(invoiceItemUsdPerUnit({ price: 200, batch: 1_000_000 }), 2 / 1_000_000);
  // fastOriginTransfer: price 6, no batch → $0.06 per GB.
  assert.equal(invoiceItemUsdPerUnit({ price: 6 }), 0.06);
  // A batch of 0 would divide by zero; treat it as 1.
  assert.equal(invoiceItemUsdPerUnit({ price: 6, batch: 0 }), 0.06);
});

test("a malformed invoiceItem yields null, not a bogus price", () => {
  assert.equal(invoiceItemUsdPerUnit(undefined), null);
  assert.equal(invoiceItemUsdPerUnit({}), null);
  assert.equal(invoiceItemFlatUsd(undefined), null);
});
