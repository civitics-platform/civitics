/**
 * Tests for the Platform Costs presentation derivations (FIX-1091 / FIX-1092).
 *
 * The rows here are the LIVE prod payload of 2026-08-23 02:41 UTC, trimmed to
 * the fields each assertion needs — same discipline as
 * packages/db/src/vercel-billing.test.ts, whose first row is the prod reading
 * that motivated the fix. A table built from real values is what stops a
 * plausible-but-wrong rewrite from passing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlatformMetric } from "@civitics/db";
import {
  INCLUDED_TRACK_PCT,
  costPhrase,
  cycleDayLabel,
  cycleKeyForMetric,
  deriveAlerts,
  fmtPct,
  isBilling,
  isDisplayedMetric,
  isGaugeMetric,
  meterGeometry,
  meterTone,
  pacePctFor,
  planLabelFor,
  projectionOf,
  rankMetrics,
  serviceCosts,
  serviceIsProjected,
  trackPct,
  type CostsPayloadView,
  type ProviderCycle,
} from "./platform-costs-view";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const fmt = {
  value: (v: number, unit: string) =>
    unit === "bytes" ? `${(v / 1073741824).toFixed(1)} GB` : `${Math.round(v).toLocaleString()}`,
  usd: (n: number) => `$${n.toFixed(2)}`,
};

function metric(over: Partial<PlatformMetric> & { service: string; metric: string }): PlatformMetric {
  return {
    id: `${over.service}:${over.metric}`,
    plan: "pro",
    included_limit: 100,
    display_limit: null,
    unit: "requests",
    overage_unit_cost: null,
    overage_unit: null,
    overage_cap: null,
    display_label: null,
    display_group: null,
    warning_pct: 80,
    critical_pct: 95,
    billing_cycle: "monthly_reset",
    sort_order: 1,
    notes: null,
    is_active: true,
    value: 0,
    source: "api",
    verified_at: null,
    verified_by: null,
    stale_after_days: null,
    recorded_at: null,
    pct: 0,
    status: "healthy",
    overage_cost: 0,
    source_display: {
      label: "Live",
      color: "green",
      icon: "●",
      tooltip: "",
      isStale: false,
      needsVerification: false,
    },
    ...over,
  } as PlatformMetric;
}

/** supabase.db_size_bytes exactly as prod served it on 2026-08-23. */
const dbSize = metric({
  service: "supabase",
  metric: "db_size_bytes",
  display_label: "Database Size",
  unit: "bytes",
  value: 31815928979,
  included_limit: 8589934592,
  display_limit: 56950861824,
  pct: 370.38616113131866,
  // The bands FIX-1089 re-based: 370% is the steady state, so this row is
  // HEALTHY while owing $2.70/month. That divergence is the whole reason
  // `over` is not `critical`.
  warning_pct: 500,
  critical_pct: 750,
  status: "healthy",
  overage_cost: 2.7038616113131866,
  implied_cost_usd: 2.7038616113131866,
  implied_cost_basis: "overage",
  rate: {
    usd_per_unit: 1.1641532182693481e-10,
    label: "$0.125 / GB",
    source: "configured",
    free_units: 8589934592,
  },
});

/** github.action_minutes — $30.87 at list, $0.00 owed on a public repo. */
const actionMinutes = metric({
  service: "github",
  metric: "action_minutes",
  display_label: "Actions Minutes",
  unit: "minutes",
  value: 5145,
  included_limit: -1,
  pct: 0,
  implied_cost_usd: 0,
  implied_cost_basis: "free_tier",
  list_cost_usd: 30.87,
  rate: { usd_per_unit: 0.006, label: "$0.006 / minute", source: "api", free_units: null },
});

/** vercel.fluid_memory_gb_hrs — metered at list, drawn against the credit. */
const fluidMemory = metric({
  service: "vercel",
  metric: "fluid_memory_gb_hrs",
  display_label: "Fluid Provisioned Memory",
  unit: "gb_hours",
  value: 197.58912356796807,
  included_limit: 360,
  pct: 54.885867657769,
  implied_cost_usd: 0,
  implied_cost_basis: "credit_absorbed",
  list_cost_usd: 2.0952,
  rate: {
    usd_per_unit: 0.010603598762149025,
    label: "$0.0106 / gb_hours",
    source: "api",
    free_units: null,
  },
  metadata: { is_projected: true, window_days: 22, raw_window_value: 140.22453930629993 },
});

const periodCommands = metric({
  service: "upstash",
  metric: "period_commands",
  display_label: "Monthly Commands",
  unit: "commands",
  value: 498964,
  included_limit: 500000,
  pct: 99.7928,
  status: "critical",
  critical_pct: 95,
});

const limiterDegraded = metric({
  service: "upstash",
  metric: "limiter_degraded",
  display_label: "Edge Limiter",
  unit: "state",
  value: 1,
  included_limit: 1,
  pct: 100,
  warning_pct: 1,
  critical_pct: 100,
  status: "critical",
});

const overagePresent = metric({
  service: "vercel",
  metric: "overage_present",
  display_label: "In Overage",
  unit: "state",
  value: 0,
  included_limit: 1,
  is_displayed: false,
});

const includedUsage = metric({
  service: "vercel",
  metric: "included_usage_usd",
  display_label: "Usage vs $20 Credit",
  unit: "usd",
  value: 19.0772,
  included_limit: 20,
  pct: 95.386,
  warning_pct: 80,
  critical_pct: 100,
  status: "warning",
});

const cpuPct = metric({
  service: "supabase",
  metric: "cpu_pct",
  display_label: "CPU usage",
  unit: "percent",
  value: 2.89,
  included_limit: 100,
  pct: 2.89,
  billing_cycle: "realtime",
});

const originHourly = metric({
  service: "cloudflare",
  metric: "origin_requests_hourly",
  display_label: "Origin Requests / hr",
  unit: "requests_per_hour",
  value: 63,
  included_limit: 3000,
  pct: 2.1,
  billing_cycle: "none",
  warning_pct: 50,
  critical_pct: 100,
});

const supabaseCycle: ProviderCycle = {
  start: "2026-08-01T00:00:00.000Z",
  end: "2026-09-01T00:00:00.000Z",
  source: "calendar",
  label: "Aug 1 – Sep 1",
  detail: "",
  elapsed_pct: 71.33,
  days_remaining: 8,
};

const vercelCycle: ProviderCycle = {
  start: "2026-08-14T07:00:00.000Z",
  end: "2026-09-14T07:00:00.000Z",
  source: "api",
  label: "Aug 14 – Sep 14",
  detail: "",
  elapsed_pct: 28.45,
  days_remaining: 22,
};

const rolling: ProviderCycle = { rolling: true, label: "hourly", detail: "" };

/** A row as a pre-FIX-1089 snapshot carries it: no is_displayed column at all. */
function withoutDisplayFlag(m: PlatformMetric): PlatformMetric {
  const copy = { ...m };
  delete copy.is_displayed;
  return copy;
}

// ── Display filter (FIX-1092) ─────────────────────────────────────────────────

test("is_displayed:false hides a wire-format companion row", () => {
  assert.equal(isDisplayedMetric(overagePresent), false);
});

test("the overage_present name-check still hides an OLD payload's row", () => {
  // A snapshot written before the is_displayed column existed carries no flag.
  assert.equal(isDisplayedMetric(withoutDisplayFlag(overagePresent)), false);
});

test("a pre-FIX-1089 row with no flag at all stays visible", () => {
  assert.equal(isDisplayedMetric(withoutDisplayFlag(dbSize)), true);
});

// ── Meter geometry ────────────────────────────────────────────────────────────

test("the included allowance is the left three-quarters of every track", () => {
  assert.equal(trackPct(50, 100), INCLUDED_TRACK_PCT / 2);
  assert.equal(trackPct(100, 100), INCLUDED_TRACK_PCT);
});

test("over-limit fills compress into the zone and can never run off the end", () => {
  assert.equal(trackPct(200, 100), 87.5); // 2x
  assert.equal(trackPct(400, 100), 93.75); // 4x
  assert.ok(trackPct(1e9, 100) < 100);
  assert.ok(trackPct(1e9, 100) > 99.9);
});

test("db_size at 370% lands inside the overage zone", () => {
  const g = meterGeometry(dbSize, supabaseCycle);
  assert.ok(g);
  assert.equal(g.tone, "over");
  assert.ok(g.fillPct > INCLUDED_TRACK_PCT);
  assert.ok(g.fillPct < 100);
  assert.ok(g.overLimit);
});

test("tone: at-or-behind pace is green, ahead of pace is amber", () => {
  assert.equal(meterTone({ value: 50, includedLimit: 100, pacePct: 71 }), "ok");
  assert.equal(meterTone({ value: 80, includedLimit: 100, pacePct: 30 }), "watch");
  // Within the slack band, not amber — a single point ahead must not flip it.
  assert.equal(meterTone({ value: 33, includedLimit: 100, pacePct: 30 }), "ok");
  // ≥90% of included is amber regardless of pace.
  assert.equal(meterTone({ value: 91, includedLimit: 100, pacePct: 99 }), "watch");
  assert.equal(meterTone({ value: 101, includedLimit: 100, pacePct: 99 }), "over");
});

test("unlimited and state rows get no meter", () => {
  assert.equal(meterGeometry(actionMinutes, undefined), null);
  assert.equal(meterGeometry(limiterDegraded, undefined), null);
});

// ── Pace suppression — the three ways pacing would lie ────────────────────────

test("a rolling provider drops the pace tick", () => {
  assert.equal(pacePctFor(originHourly, rolling), null);
});

test("a payload-declared gauge drops the pace tick", () => {
  assert.equal(isGaugeMetric(cpuPct), true);
  assert.equal(pacePctFor(cpuPct, supabaseCycle), null);
});

test("a projected row drops the pace tick — its basis is not this cycle", () => {
  // FIX-1089 states Vercel's cycle as Aug 14 – Sep 14 while the quantities stay
  // projected from a calendar-month window. Pacing one against the other would
  // compare two different clocks.
  assert.equal(pacePctFor(fluidMemory, vercelCycle), null);
});

test("an ordinary metered row keeps its pace tick", () => {
  assert.equal(pacePctFor(dbSize, supabaseCycle), 71.33);
});

test("the projection rule is per-PROVIDER, derived from the rows", () => {
  // vercel.included_usage_usd is a month-end projection too — its own notes say
  // so — but it reaches the payload through vercel-billing.ts with no metadata
  // flag. A per-row test would pace exactly the row whose 95% matters most
  // against a cycle it is not measured on.
  assert.equal(serviceIsProjected([fluidMemory, includedUsage]), true);
  assert.equal(pacePctFor(includedUsage, vercelCycle), 28.45);
  assert.equal(pacePctFor(includedUsage, vercelCycle, true), null);
  assert.equal(meterGeometry(includedUsage, vercelCycle, true)?.pacePct, null);
  // …and a provider with no projected rows is unaffected.
  assert.equal(serviceIsProjected([dbSize, cpuPct]), false);
});

test("a percentage below the limit never rounds up to it", () => {
  assert.equal(fmtPct(99.7928), "99.8%");
  assert.equal(fmtPct(99.98), "99.9%");
  assert.equal(fmtPct(100), "100%");
  assert.equal(fmtPct(370.386), "370%");
  assert.equal(fmtPct(0.2), "<1%");
  assert.equal(fmtPct(0), "0%");
});

test("the projection marker uses the payload's own numbers, not a re-derivation", () => {
  const p = projectionOf(fluidMemory);
  assert.deepEqual(p, { actual: 140.22453930629993, projected: 197.58912356796807 });
  const g = meterGeometry(fluidMemory, vercelCycle);
  assert.ok(g);
  // Fill is the un-projected truth; the marker is the projection.
  assert.equal(g.fillValue, 140.22453930629993);
  assert.ok(g.projectionPct !== null && g.projectionPct > g.fillPct);
});

test("cycleDayLabel counts days from payload fields only", () => {
  assert.equal(cycleDayLabel(vercelCycle), "day 9 of 31");
  assert.equal(cycleDayLabel(supabaseCycle), "day 23 of 31");
  assert.equal(cycleDayLabel(rolling), null);
});

test("Cloudflare's hourly rows pace against cloudflare_edge, R2 against cloudflare", () => {
  assert.equal(cycleKeyForMetric(originHourly), "cloudflare_edge");
  assert.equal(
    cycleKeyForMetric({ service: "cloudflare", billing_cycle: "monthly_reset" }),
    "cloudflare",
  );
});

// ── Basis-aware money (FIX-1092) ──────────────────────────────────────────────

test("an overage basis renders as billed money", () => {
  const p = costPhrase(dbSize, fmt);
  assert.equal(p.rate, "$0.125 / GB");
  assert.equal(p.cost, "$2.70/mo");
  assert.equal(p.tone, "billed");
});

test("a credit_absorbed basis renders the list value, neutrally — never as owed", () => {
  const p = costPhrase(fluidMemory, fmt);
  assert.equal(p.tone, "neutral");
  assert.match(p.cost ?? "", /absorbed by the plan credit/);
  assert.match(p.cost ?? "", /\$2\.10/);
});

test("a free_tier basis shows gross-at-list and claims no money owed", () => {
  const p = costPhrase(actionMinutes, fmt);
  assert.equal(p.tone, "dim");
  assert.equal(p.cost, "$30.87 at list, within the free tier");
});

test("an unrecognised basis prints the rate and NO dollars", () => {
  const weird = metric({
    service: "x",
    metric: "y",
    implied_cost_usd: 999,
    implied_cost_basis: "who_knows" as never,
    rate: { usd_per_unit: 1, label: "$1 / unit", source: "configured", free_units: null },
  });
  const p = costPhrase(weird, fmt);
  assert.equal(p.rate, "$1 / unit");
  assert.equal(p.cost, null);
});

test("no rate means no dollars, ever", () => {
  const p = costPhrase(metric({ service: "x", metric: "y" }), fmt);
  assert.equal(p.rate, null);
  assert.equal(p.cost, null);
});

test("only overage/actual dollars count as billing", () => {
  assert.equal(isBilling(dbSize), true);
  assert.equal(isBilling(fluidMemory), false);
  assert.equal(isBilling(actionMinutes), false);
});

// ── Headline ranking ──────────────────────────────────────────────────────────

test("money outranks pressure when picking the headline meters", () => {
  const ranked = rankMetrics([cpuPct, dbSize, periodCommands]);
  assert.equal(ranked[0]?.metric, "db_size_bytes");
  assert.equal(ranked[1]?.metric, "period_commands");
});

// ── Per-provider cost ─────────────────────────────────────────────────────────

const prodPayload: CostsPayloadView = {
  plan: "free",
  plan_overrides: { vercel: "pro", supabase: "pro" },
  metrics: [dbSize, periodCommands, limiterDegraded, includedUsage, overagePresent, fluidMemory],
  cycles: { supabase: supabaseCycle, vercel: vercelCycle, cloudflare_edge: rolling },
  subscriptions_usd: {
    total: 45,
    items: [
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
        note: "Craig-stated.",
      },
      {
        service: "supabase",
        name: "Compute (Micro)",
        monthly_usd: 0,
        cadence: "monthly",
        source: "api",
        in_headline: true,
        note: "Covered by the $10 compute credit.",
      },
    ],
  },
  billable_usage_usd: {
    total: 2.7,
    items: [
      {
        service: "supabase",
        metric: "db_size_bytes",
        label: "Database Size",
        usd: 2.7,
        basis: "overage",
        source: "configured",
        note: null,
      },
    ],
  },
  total_monthly_usd: 47.7,
  cost_omissions: [],
  vercel_billing: {
    included_credit_usd: 20,
    credit_remaining_usd: 6.4614,
    credit_used_pct: 67.6931,
    billable_overage_mtd_usd: 0,
    projected_billable_overage_usd: 0,
    projected_total_bill_usd: 20,
    projectable: true,
  },
  burn_rate: {
    latest_delta_usd: 0.0948,
    trailing_median_usd: 0.2275,
    multiple: 0.4168,
    elevated: false,
    reason: "day 22 consumption vs a 7-day median. Normal.",
  },
  vercel_account: { plan: "pro", plan_iteration: "plus" },
  supabase_account: { plan: "pro", compute_addon: { id: "ci_micro", name: "Micro", monthly_usd: 9.81 } },
  upstash: { usage: { plan: "free" } },
};

test("per-provider cost is sliced from the same lists the headline sums", () => {
  const costs = serviceCosts(prodPayload);
  assert.ok(costs);
  assert.equal(costs.get("vercel")?.total, 20);
  assert.equal(Number(costs.get("supabase")?.total.toFixed(2)), 27.7);
  // And the cards add up to the headline. That is the point of deriving them
  // from the headline's own inputs rather than computing them a second way.
  const sum = [...costs.values()].reduce((acc, c) => acc + c.total, 0);
  assert.equal(Number(sum.toFixed(2)), prodPayload.total_monthly_usd);
});

test("an old-shape payload yields no per-service costs, so the caller can fall back", () => {
  assert.equal(serviceCosts({ metrics: [dbSize] }), null);
});

test("plan labels come from whichever block states them", () => {
  // FIX-1104: "Pro", not "Pro Plus". `plan_iteration` is Vercel's pricing-model
  // generation marker, not a tier — the account's invoice line is keyed `pro`
  // at $20, which is what the cost decomposition on the same page prints.
  // Concatenating them put two names for one plan on one screen.
  assert.equal(planLabelFor(prodPayload, "vercel"), "Pro");
  assert.equal(prodPayload.vercel_account?.plan_iteration, "plus", "still in the payload");
  assert.equal(planLabelFor(prodPayload, "supabase"), "Pro");
  assert.equal(planLabelFor(prodPayload, "upstash"), "Free tier");
  assert.equal(planLabelFor(prodPayload, "resend"), "free tier");
});

// ── The alerts strip ──────────────────────────────────────────────────────────

test("a BILLING metric is an `over` line even while its bands sleep", () => {
  const alerts = deriveAlerts(prodPayload, fmt);
  const line = alerts.find((a) => a.tag === "supabase.db_size_bytes");
  assert.ok(line, "db_size must appear");
  assert.equal(line.severity, "over");
  assert.equal(line.text.includes("$2.70/mo"), true);
  // …and its band status is healthy. Band state and billing state differ by design.
  assert.equal(dbSize.status, "healthy");
});

test("band-critical rows are `over`; band-warning rows are `watch`", () => {
  const alerts = deriveAlerts(prodPayload, fmt);
  assert.equal(alerts.find((a) => a.tag === "upstash.period_commands")?.severity, "over");
  assert.equal(alerts.find((a) => a.tag === "vercel.included_usage_usd")?.severity, "watch");
});

test("a state row's alert names the signal, not a percentage band", () => {
  const alerts = deriveAlerts(prodPayload, fmt);
  const line = alerts.find((a) => a.tag === "upstash.limiter_degraded");
  assert.ok(line);
  assert.match(line.text, /signal ON/);
  assert.doesNotMatch(line.text, /critical band/);
});

test("the first-cent line is a sentence, and is steady at zero overage", () => {
  const alerts = deriveAlerts(prodPayload, fmt);
  const line = alerts.find((a) => a.key === "first-cent");
  assert.ok(line);
  assert.equal(line.severity, "steady");
  assert.match(line.text, /No billable Vercel overage this cycle/);
});

test("the first cent flips that line to watch", () => {
  const alerts = deriveAlerts(
    {
      ...prodPayload,
      vercel_billing: { ...prodPayload.vercel_billing!, billable_overage_mtd_usd: 0.01 },
    },
    fmt,
  );
  const line = alerts.find((a) => a.key === "first-cent");
  assert.equal(line?.severity, "watch");
});

test("credit pressure only alerts at 90% or more", () => {
  assert.equal(deriveAlerts(prodPayload, fmt).some((a) => a.key === "credit"), false);
  const hot = deriveAlerts(
    {
      ...prodPayload,
      vercel_billing: { ...prodPayload.vercel_billing!, credit_used_pct: 93 },
    },
    fmt,
  );
  assert.equal(hot.some((a) => a.key === "credit"), true);
});

test("elevated burn is a watch line; normal burn is a steady sentence", () => {
  assert.equal(deriveAlerts(prodPayload, fmt).find((a) => a.key === "burn-normal")?.severity, "steady");
  const hot = deriveAlerts(
    { ...prodPayload, burn_rate: { ...prodPayload.burn_rate!, elevated: true } },
    fmt,
  );
  assert.equal(hot.find((a) => a.key === "burn")?.severity, "watch");
});

test("hidden companion rows never reach the alerts strip", () => {
  const alerts = deriveAlerts(prodPayload, fmt);
  assert.equal(alerts.some((a) => a.tag === "vercel.overage_present"), false);
});

test("an old-shape payload derives an empty-but-valid strip without throwing", () => {
  const alerts = deriveAlerts({ metrics: [dbSize] }, fmt);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.severity, "over");
});

test("every alert line names something — no anonymous counts", () => {
  for (const a of deriveAlerts(prodPayload, fmt)) {
    assert.ok(a.text.length > 0);
    assert.doesNotMatch(a.text, /^\d+ metrics?/);
  }
});
