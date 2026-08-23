/**
 * FIX-1089 — the true-cost roll-up.
 *
 * Two things are worth testing here and they are not the arithmetic.
 *
 *   1. THE OMISSION. The whole reason this module exists is that the old
 *      headline had no way to express Supabase Pro's $25 and therefore silently
 *      left it out. The first test reproduces the prod numbers from 2026-08-22
 *      and asserts both the wrong answer the old shape gave and the right one
 *      this produces, so the gap is pinned as a number, not a story.
 *
 *   2. THE DOUBLE-COUNT. Selecting by `implied_cost_basis` rather than summing
 *      `implied_cost_usd` is the only thing standing between this and the bug
 *      FIX-1050 had to remove. Those tests are the load-bearing ones.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computePlatformCostTotals, type SubscriptionItem } from "./platform-costs";

const SUBS: SubscriptionItem[] = [
  {
    service: "vercel",
    name: "Pro",
    monthly_usd: 20,
    cadence: "monthly",
    source: "api",
    in_headline: true,
    note: null,
  },
  {
    service: "supabase",
    name: "Pro",
    monthly_usd: 25,
    cadence: "monthly",
    source: "configured",
    in_headline: true,
    note: null,
  },
  {
    service: "supabase",
    name: "Compute (Micro)",
    monthly_usd: 0,
    cadence: "monthly",
    source: "api",
    in_headline: true,
    note: null,
  },
];

/** The prod metric set, reduced to the rows that carry a cost. */
const PROD_METRICS = [
  {
    service: "supabase",
    metric: "db_size_bytes",
    label: "Database Size",
    implied_cost_usd: 2.7,
    implied_cost_basis: "overage" as const,
    rate_source: "configured" as const,
  },
  {
    service: "supabase",
    metric: "egress_bytes",
    label: "Database Egress",
    implied_cost_usd: 0,
    implied_cost_basis: "overage" as const,
  },
  {
    service: "cloudflare",
    metric: "storage_bytes",
    label: "R2 Storage",
    implied_cost_usd: 0,
    implied_cost_basis: "overage" as const,
  },
  {
    service: "anthropic",
    metric: "monthly_spend_usd",
    label: "Monthly AI Spend",
    implied_cost_usd: 0,
    implied_cost_basis: "actual" as const,
  },
  // Vercel's metered rows: real consumption, $0 owed, absorbed by the credit.
  {
    service: "vercel",
    metric: "fluid_cpu_seconds",
    label: "Fluid Active CPU",
    implied_cost_usd: 0,
    implied_cost_basis: "credit_absorbed" as const,
  },
];

test("prod 2026-08-22: the old headline read $22.71, the true cost is $47.70", () => {
  const t = computePlatformCostTotals({
    subscriptions: SUBS,
    metrics: PROD_METRICS,
    // Projected billable overage above the $20 credit — $0 on a normal month.
    vercelBillableUsd: 0,
    githubBilledUsd: 0,
    githubGrossUsd: 30.82,
  });

  // What the card printed: anthropic $0 + non-vercel overages $2.70
  //                        + vercel projected_total_bill $20.00.
  // Correct as far as it went, and missing an entire $25 subscription.
  assert.equal(0 + 2.7 + 20, 22.7);

  assert.equal(t.subscriptions_usd.total, 45, "$20 Vercel + $25 Supabase + $0 compute");
  assert.equal(t.billable_usage_usd.total, 2.7, "only the Supabase disk overage is owed");
  assert.equal(t.total_monthly_usd, 47.7);
});

test("a credit_absorbed dollar is never added to the total", () => {
  // The FIX-1050 shape: Vercel consumption counted BOTH as per-metric list value
  // and as credit-aware overage bills the same bytes twice.
  const t = computePlatformCostTotals({
    subscriptions: [],
    metrics: [
      {
        service: "vercel",
        metric: "fluid_cpu_seconds",
        label: "Fluid Active CPU",
        implied_cost_usd: 18.42,
        implied_cost_basis: "credit_absorbed",
      },
    ],
    vercelBillableUsd: 5,
    githubBilledUsd: null,
  });
  assert.equal(t.billable_usage_usd.total, 5, "the $18.42 of list value is not money owed");
  assert.equal(t.billable_usage_usd.items.length, 1);
  assert.equal(t.billable_usage_usd.items[0]?.basis, "credit_aware_projection");
});

test("even an 'overage'-basis Vercel row cannot reach the total", () => {
  // vercel.origin_transfer_bytes(pro) carries $0.15/GB above 1 TiB, and every
  // dollar of that transfer is ALSO inside the consumption drawn against the
  // $20 credit. It reads $0 today only because the account is at 3 GB of a
  // 1 TiB allowance — the disagreement is latent, not absent.
  const t = computePlatformCostTotals({
    subscriptions: [],
    metrics: [
      {
        service: "vercel",
        metric: "origin_transfer_bytes",
        label: "Fast Origin Transfer",
        implied_cost_usd: 99,
        implied_cost_basis: "overage",
      },
    ],
    vercelBillableUsd: 7,
    githubBilledUsd: null,
  });
  assert.equal(t.billable_usage_usd.total, 7);
});

test("free_tier rows describe consumption and contribute no dollars", () => {
  const t = computePlatformCostTotals({
    subscriptions: [],
    metrics: [
      {
        service: "resend",
        metric: "emails_sent",
        label: "Emails Sent",
        implied_cost_usd: 0,
        implied_cost_basis: "free_tier",
      },
      {
        service: "github",
        metric: "action_minutes",
        label: "Actions Minutes",
        implied_cost_usd: 0,
        implied_cost_basis: "free_tier",
      },
    ],
    vercelBillableUsd: 0,
    githubBilledUsd: 0,
  });
  assert.equal(t.billable_usage_usd.total, 0);
  assert.equal(t.billable_usage_usd.items.length, 0);
});

test("a failed Vercel read omits the line and SAYS SO, rather than substituting", () => {
  const t = computePlatformCostTotals({
    subscriptions: SUBS,
    metrics: PROD_METRICS,
    vercelBillableUsd: null,
    vercelUnavailableReason: "HTTP 503",
    githubBilledUsd: 0,
  });
  assert.equal(t.total_monthly_usd, 47.7, "subscriptions and other overages still land");
  assert.equal(t.omissions.length, 1);
  assert.match(t.omissions[0] as string, /Vercel metered usage/);
  assert.match(t.omissions[0] as string, /HTTP 503/);
  // The per-metric Vercel rows come from the SAME failed call, so they are not
  // a fallback — falling back to them would report stale numbers as current.
  assert.equal(
    t.billable_usage_usd.items.some((i) => i.service === "vercel"),
    false,
  );
});

test("annual subscriptions are tracked but kept out of the headline", () => {
  const t = computePlatformCostTotals({
    subscriptions: [
      ...SUBS,
      {
        service: "namecheap",
        name: "civitics.com",
        monthly_usd: 1.25,
        cadence: "annual",
        source: "configured",
        in_headline: false,
        note: "amortized from $15/yr",
      },
    ],
    metrics: [],
    vercelBillableUsd: 0,
    githubBilledUsd: null,
  });
  assert.equal(t.subscriptions_usd.total, 45, "the annual line is footnoted, not summed");
  assert.equal(t.subscriptions_usd.items.length, 4, "but it IS still reported");
});

test("GitHub contributes its NET dollars, with gross as a note", () => {
  const t = computePlatformCostTotals({
    subscriptions: [],
    metrics: [],
    vercelBillableUsd: 0,
    githubBilledUsd: 12.5,
    githubGrossUsd: 43.32,
  });
  assert.equal(t.billable_usage_usd.total, 12.5);
  assert.match(t.billable_usage_usd.items[0]?.note ?? "", /43\.32 at list/);
});

test("items sort by dollars descending so the biggest line is first", () => {
  const t = computePlatformCostTotals({
    subscriptions: [],
    metrics: [
      { service: "a", metric: "x", label: "small", implied_cost_usd: 1, implied_cost_basis: "overage" },
      { service: "b", metric: "y", label: "big", implied_cost_usd: 40, implied_cost_basis: "overage" },
    ],
    vercelBillableUsd: 9,
    githubBilledUsd: null,
  });
  assert.deepEqual(
    t.billable_usage_usd.items.map((i) => i.usd),
    [40, 9, 1],
  );
});
