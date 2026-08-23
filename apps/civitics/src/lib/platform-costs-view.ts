/**
 * Presentation derivation for the Platform Costs section (FIX-1091 / FIX-1092).
 *
 * ── WHY THIS IS A SEPARATE, PURE MODULE ──────────────────────────────────────
 *
 * Everything here answers a question the payload does not answer directly —
 * which severity a metric belongs in, where a bar's fill ends when the value is
 * 3.7x its included limit, whether pacing a row against its cycle would be a
 * lie. Those are judgements, and a judgement that lives inside JSX cannot be
 * pinned by a test. The R4a data plane put its own judgements
 * (`computeMetricStatus`, `computePlatformCostTotals`) in pure modules for the
 * same reason; this is the display-side mirror.
 *
 * NO React, no clock, no network. Every time-dependent number is read off the
 * payload (`cycles[*].elapsed_pct`, `days_remaining`) rather than computed from
 * `Date.now()` — the section renders a PERSISTED snapshot, so "now" belongs to
 * the tick that wrote it, not to the browser reading it.
 *
 * ── SEVERITY IS NOT THE BAND LADDER, ON PURPOSE ──────────────────────────────
 *
 * `computeMetricStatus` answers "is this row inside its alert bands". This
 * module answers "is this row costing money". Those are different questions and
 * the difference is load-bearing: `supabase.db_size_bytes` bills $2.70/month
 * today and its bands (500/750, deliberately re-based by FIX-1089 because its
 * honest 370% under 80/95 would be a PERMANENT critical) correctly call it
 * healthy. A user looking at a cost card wants the $2.70 named; the email
 * alerter does not want to be woken by it. So `over` here includes
 * "generating real money" as well as "band-critical", and nothing in this file
 * feeds back into the band evaluation or the email-alert machinery.
 */

import type { PlatformMetric } from "@civitics/db";

// ── Payload shapes (structural — only what this module reads) ─────────────────

export type DatedCycle = {
  start: string;
  end: string;
  source: "api" | "configured" | "calendar";
  label: string;
  detail: string;
  elapsed_pct: number;
  days_remaining: number;
};

export type RollingCycle = { rolling: true; label: string; detail: string };

export type ProviderCycle = DatedCycle | RollingCycle;

export type CostsPayloadView = {
  plan?: string;
  metrics?: PlatformMetric[];
  by_service?: Record<string, PlatformMetric[]>;
  cycles?: Record<string, ProviderCycle>;
  subscriptions_usd?: {
    total: number;
    items: Array<{
      service: string;
      name: string;
      monthly_usd: number;
      cadence: string;
      source: string;
      in_headline: boolean;
      note: string | null;
    }>;
  };
  billable_usage_usd?: {
    total: number;
    items: Array<{
      service: string;
      metric: string | null;
      label: string;
      usd: number;
      basis: string;
      source: string;
      note: string | null;
    }>;
  };
  total_monthly_usd?: number;
  cost_omissions?: string[];
  vercel_billing?: {
    included_credit_usd: number;
    credit_remaining_usd: number;
    credit_used_pct: number;
    billable_overage_mtd_usd: number;
    projected_billable_overage_usd: number;
    projected_total_bill_usd: number;
    projectable: boolean;
  };
  burn_rate?: {
    latest_delta_usd: number | null;
    trailing_median_usd: number | null;
    multiple: number | null;
    elevated: boolean;
    reason: string;
  };
  cf_mitigation?: {
    action: string;
    reason: string;
    observed_level: string | null;
    tripped_at: string | null;
    breach_hours: number;
    required_breach_hours: number;
    writes_enabled: boolean;
    write_scope_confirmed?: boolean | null;
  };
  vercel_account?: { plan: string; plan_iteration: string | null };
  supabase_account?: {
    plan: string;
    compute_addon: { id: string; name: string; monthly_usd: number | null } | null;
  };
  upstash?: { usage?: { plan?: string } | null };
  plan_overrides?: Record<string, string>;
  self_counted?: {
    period: string;
    mapbox: { total: number; by_metric: Record<string, number> };
    resend: { total: number; by_metric: Record<string, number> };
  };
};

/** Formatters the caller supplies so this module stays free of @civitics/ui. */
export type Formatters = {
  value: (value: number, unit: string) => string;
  usd: (usd: number) => string;
};

// ── Metric predicates ─────────────────────────────────────────────────────────

export function metricTag(m: Pick<PlatformMetric, "service" | "metric">): string {
  return `${m.service}.${m.metric}`;
}

export function metricLabel(
  m: Pick<PlatformMetric, "metric" | "display_label">,
): string {
  return m.display_label ?? m.metric;
}

/**
 * Rows the card renders. FIX-1089 made the property generic (`is_displayed` on
 * platform_limits) so a wire-format companion row — one that exists to make an
 * alert expressible rather than to be read — needs no code change to be hidden.
 *
 * The `vercel.overage_present` name-check stays ONLY as the old-payload
 * fallback: this section renders a PERSISTED snapshot, and one written before
 * the column existed carries no flag at all. `!== false` is what keeps every
 * other pre-FIX-1089 row visible. No new hardcoded names belong here.
 */
export function isDisplayedMetric(
  m: Pick<PlatformMetric, "service" | "metric" | "is_displayed">,
): boolean {
  if (m.is_displayed === false) return false;
  return !(m.service === "vercel" && m.metric === "overage_present");
}

/** -1 is the "unlimited" sentinel; a percentage of unlimited is not a number. */
export function isUnlimited(m: Pick<PlatformMetric, "included_limit">): boolean {
  return !(m.included_limit > 0);
}

/**
 * A 0/1 state rather than a quantity (`upstash.limiter_degraded`). Rendering it
 * as a "1 / 1" progress bar says nothing — the same reasoning that took
 * `vercel.overage_present` off the card in FIX-1076. These render as a sentence.
 */
export function isStateMetric(m: Pick<PlatformMetric, "unit">): boolean {
  return m.unit === "state";
}

/**
 * A gauge the payload itself declares: `billing_cycle` of `none` (the Cloudflare
 * hourly edge counters) or `realtime` (Supabase CPU / connections). An
 * instantaneous reading has no cycle position, so pacing or projecting it is
 * meaningless — same call `cycles.cloudflare_edge` makes with `{rolling:true}`.
 */
export function isGaugeMetric(m: Pick<PlatformMetric, "billing_cycle">): boolean {
  return m.billing_cycle === "none" || m.billing_cycle === "realtime";
}

/**
 * The payload-provided projection for a row, or null. NEVER re-derived here:
 * FIX-1089 deliberately left the Vercel projection on its trailing-window basis
 * because it feeds tuned alert rows, and re-basing it client-side would put a
 * different number on the card than the one the alerts fire on.
 *
 * `value` IS the projection (that is what the bands are evaluated against);
 * `metadata.raw_window_value` is the un-projected truth, which is what the bar
 * fills to. Both come straight from the payload.
 */
export function projectionOf(m: PlatformMetric): { actual: number; projected: number } | null {
  const meta = m.metadata;
  if (!meta?.is_projected) return null;
  if (typeof meta.raw_window_value !== "number" || m.value === null) return null;
  return { actual: meta.raw_window_value, projected: m.value };
}

export function isRollingCycle(c: ProviderCycle): c is RollingCycle {
  return "rolling" in c;
}

/**
 * Which `cycles` entry paces a metric. Cloudflare is two providers wearing one
 * name: R2 storage and ops bill on the calendar month, while the hourly edge
 * counters are complete-clock-hour gauges with no cycle at all.
 */
export function cycleKeyForMetric(
  m: Pick<PlatformMetric, "service" | "billing_cycle">,
): string {
  if (m.service === "cloudflare" && m.billing_cycle === "none") return "cloudflare_edge";
  return m.service;
}

/** "day 9 of 31" — derived from payload fields only, never from the clock. */
export function cycleDayLabel(c: ProviderCycle | undefined): string | null {
  if (!c || isRollingCycle(c)) return null;
  const startMs = new Date(c.start).getTime();
  const endMs = new Date(c.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const total = Math.max(1, Math.round((endMs - startMs) / 86_400_000));
  const elapsed = Math.min(total, Math.max(1, total - c.days_remaining));
  return `day ${elapsed} of ${total}`;
}

// ── Meter geometry ────────────────────────────────────────────────────────────

/**
 * The included allowance occupies the left 75% of every track; the right 25% is
 * the overage zone. Fixed across all meters on purpose — a reader learns the
 * anatomy once and can then compare two rows by eye.
 */
export const INCLUDED_TRACK_PCT = 75;

/**
 * Where a value sits on the track, in percent of track width.
 *
 * Inside the allowance the scale is linear. Past it the scale COMPRESSES —
 * `r/(1+r)` of the remaining quarter, so 2x included lands at 87.5%, 4x at
 * 93.75%, and nothing can ever run off the end. The compression is why the true
 * magnitude and the implied dollars are ALWAYS printed as text beside the bar:
 * past the boundary the geometry is deliberately not to scale, and colour plus
 * length must never be the only carrier of the number.
 */
export function trackPct(value: number, includedLimit: number): number {
  if (!(includedLimit > 0) || !Number.isFinite(value) || value <= 0) return 0;
  if (value <= includedLimit) {
    return (value / includedLimit) * INCLUDED_TRACK_PCT;
  }
  const over = (value - includedLimit) / includedLimit;
  return INCLUDED_TRACK_PCT + (100 - INCLUDED_TRACK_PCT) * (over / (1 + over));
}

export type MeterTone = "over" | "watch" | "ok";

/**
 * Slack before "ahead of pace" turns a bar amber. Without it every row that is
 * a single point ahead of the day count flips colour, which trains people to
 * ignore amber.
 */
export const PACE_SLACK_PCT = 5;

export function meterTone(args: {
  value: number;
  includedLimit: number;
  pacePct: number | null;
}): MeterTone {
  const { value, includedLimit, pacePct } = args;
  if (!(includedLimit > 0)) return "ok";
  const pct = (value / includedLimit) * 100;
  if (pct > 100) return "over";
  if (pct >= 90) return "watch";
  if (pacePct !== null && pct > pacePct + PACE_SLACK_PCT) return "watch";
  return "ok";
}

/**
 * The pace tick position, or null when pacing this row would lie. Three reasons
 * it can be null, all of them the payload's own statements:
 *
 *  - the provider's cycle is `{rolling:true}` (Cloudflare's hourly gauges);
 *  - the row is a payload-declared gauge (`billing_cycle` none/realtime);
 *  - the row's PROVIDER reports quantities on a projection basis that is not
 *    this cycle. Vercel is that provider: FIX-1089 states its cycle as
 *    Aug 14 – Sep 14 while the quantities remain projected onto a calendar
 *    month, and re-basing them is deliberately out of scope because it would
 *    move tuned alert bands. Pacing a calendar-month quantity against a
 *    mid-month billing window compares two different clocks.
 *
 * The third rule is per-PROVIDER and not per-row on purpose, and it is derived
 * from the data rather than from a service name: `serviceIsProjected` is true
 * when ANY row of the provider carries `metadata.is_projected`. Vercel's
 * `included_usage_usd` is a month-end projection too — its own `notes` say so —
 * but it reaches the payload through vercel-billing.ts and carries no metadata
 * flag, so a per-row test would pace exactly the row whose 95% reading matters
 * most against a cycle it is not measured on.
 */
export function pacePctFor(
  m: PlatformMetric,
  cycle: ProviderCycle | undefined,
  serviceIsProjected = false,
): number | null {
  if (!cycle || isRollingCycle(cycle)) return null;
  if (isGaugeMetric(m)) return null;
  if (serviceIsProjected || m.metadata?.is_projected) return null;
  const pct = cycle.elapsed_pct;
  return Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : null;
}

/** True when any of a provider's rows is projected — see `pacePctFor`. */
export function serviceIsProjected(metrics: PlatformMetric[]): boolean {
  return metrics.some((m) => m.metadata?.is_projected === true);
}

export type MeterGeometry = {
  /** Where the fill ends, percent of track width. */
  fillPct: number;
  /** Percent of track width for the dashed included-limit mark. */
  includedPct: number;
  /** Pace tick position in percent of track width, or null. */
  pacePct: number | null;
  /** Projection marker position in percent of track width, or null. */
  projectionPct: number | null;
  tone: MeterTone;
  /** The number the fill represents (un-projected where a projection exists). */
  fillValue: number;
  /** Percent of the included allowance the fill value represents. */
  pctOfIncluded: number;
  overLimit: boolean;
};

export function meterGeometry(
  m: PlatformMetric,
  cycle: ProviderCycle | undefined,
  providerIsProjected = false,
): MeterGeometry | null {
  if (m.value === null || isUnlimited(m) || isStateMetric(m)) return null;
  const projection = projectionOf(m);
  const fillValue = projection ? projection.actual : m.value;
  const pace = pacePctFor(m, cycle, providerIsProjected);
  const included = m.included_limit;
  return {
    fillPct: trackPct(fillValue, included),
    includedPct: INCLUDED_TRACK_PCT,
    pacePct: pace === null ? null : (pace / 100) * INCLUDED_TRACK_PCT,
    projectionPct: projection ? trackPct(projection.projected, included) : null,
    tone: meterTone({
      // Colour follows whichever number is larger — a fill inside the allowance
      // whose own projection lands in the overage zone is not a green row.
      value: projection ? Math.max(projection.actual, projection.projected) : fillValue,
      includedLimit: included,
      pacePct: pace,
    }),
    fillValue,
    pctOfIncluded: (fillValue / included) * 100,
    overLimit: fillValue > included || (projection ? projection.projected > included : false),
  };
}

// ── Per-metric money, phrased by basis ────────────────────────────────────────

export type CostPhraseTone = "billed" | "neutral" | "dim";

export type CostPhrase = {
  /** Ready-to-render rate, e.g. "$0.125 / GB". Null when no rate is known. */
  rate: string | null;
  /** The money clause, already formatted. Null when nothing can be said. */
  cost: string | null;
  tone: CostPhraseTone;
};

/**
 * What a row costs, phrased by `implied_cost_basis`.
 *
 * The bases are NOT interchangeable and the card must not let them look it: an
 * `overage` dollar is on an invoice, a `credit_absorbed` dollar is list value a
 * plan credit already paid for, and a `free_tier` dollar is $0 owed by
 * definition. Summing them is exactly the double-count FIX-1050 removed from
 * `total_overage_cost`, so the presentation mirrors the server-side rule rather
 * than re-deciding it.
 *
 * A basis this function does not recognise prints the rate and NO dollars.
 * Guessing which kind of dollar an unknown basis is would be the whole bug.
 */
export function costPhrase(m: PlatformMetric, fmt: Formatters): CostPhrase {
  const rate = m.rate?.label ?? null;
  const basis = m.implied_cost_basis;
  const implied = typeof m.implied_cost_usd === "number" ? m.implied_cost_usd : null;
  const list = typeof m.list_cost_usd === "number" ? m.list_cost_usd : null;

  if (basis === "overage" || basis === "actual") {
    if (implied !== null && implied > 0) {
      return { rate, cost: `${fmt.usd(implied)}/mo`, tone: "billed" };
    }
    return { rate, cost: rate ? "no overage" : null, tone: "dim" };
  }

  if (basis === "credit_absorbed") {
    const amount = list !== null && list > 0 ? list : implied;
    return {
      rate,
      cost:
        amount !== null && amount > 0
          ? `${fmt.usd(amount)} absorbed by the plan credit`
          : "absorbed by the plan credit",
      tone: "neutral",
    };
  }

  if (basis === "free_tier") {
    // A row with no rate AND no list value has nothing to say about money —
    // "within the free tier" on `supabase.disk_used_bytes` is noise, not
    // information, because no price exists for that row in either direction.
    if (list !== null && list > 0) {
      return { rate, cost: `${fmt.usd(list)} at list, within the free tier`, tone: "dim" };
    }
    return { rate, cost: rate ? "within the free tier" : null, tone: "dim" };
  }

  // Unrecognised or absent basis: the rate, if we have one, and nothing else.
  return { rate, cost: null, tone: "dim" };
}

/** True when a metric is generating money on an invoice right now. */
export function isBilling(m: PlatformMetric): boolean {
  const basis = m.implied_cost_basis;
  if (basis !== "overage" && basis !== "actual") return false;
  return typeof m.implied_cost_usd === "number" && m.implied_cost_usd > 0;
}

// ── Headline metric selection ─────────────────────────────────────────────────

/**
 * Which rows earn a meter on the collapsed card: money first, then pressure.
 * Data-driven rather than a per-service list so a new metric ranks itself.
 */
export function rankMetrics(metrics: PlatformMetric[]): PlatformMetric[] {
  return [...metrics].sort((a, b) => {
    const aUsd = isBilling(a) ? (a.implied_cost_usd ?? 0) : 0;
    const bUsd = isBilling(b) ? (b.implied_cost_usd ?? 0) : 0;
    if (aUsd !== bUsd) return bUsd - aUsd;
    const aCrit = a.status === "critical" ? 1 : 0;
    const bCrit = b.status === "critical" ? 1 : 0;
    if (aCrit !== bCrit) return bCrit - aCrit;
    const aPct = a.value === null || isUnlimited(a) ? -1 : a.pct;
    const bPct = b.value === null || isUnlimited(b) ? -1 : b.pct;
    if (aPct !== bPct) return bPct - aPct;
    return a.sort_order - b.sort_order;
  });
}

// ── Per-provider cost ─────────────────────────────────────────────────────────

export type ServiceCost = {
  service: string;
  subscriptions: number;
  usage: number;
  total: number;
  subItems: Array<{ name: string; usd: number; note: string | null; source: string }>;
  usageItems: Array<{ label: string; usd: number; basis: string; note: string | null }>;
};

/**
 * Per-provider true cost, sliced out of the SAME itemized lists the headline
 * sums. Deriving the card figures from the headline's own inputs is what makes
 * the cards add up to the headline; computing them a second way is how the old
 * card ended up with a total that no card explained.
 *
 * Returns null when the payload predates FIX-1089 — the caller falls back to
 * the pre-R4a per-card arithmetic for that one snapshot-tick window.
 */
export function serviceCosts(payload: CostsPayloadView): Map<string, ServiceCost> | null {
  const subs = payload.subscriptions_usd;
  const usage = payload.billable_usage_usd;
  if (!subs && !usage) return null;

  const out = new Map<string, ServiceCost>();
  const get = (service: string): ServiceCost => {
    let row = out.get(service);
    if (!row) {
      row = { service, subscriptions: 0, usage: 0, total: 0, subItems: [], usageItems: [] };
      out.set(service, row);
    }
    return row;
  };

  for (const item of subs?.items ?? []) {
    const row = get(item.service);
    if (item.in_headline) row.subscriptions += item.monthly_usd;
    row.subItems.push({
      name: item.name,
      usd: item.monthly_usd,
      note: item.note,
      source: item.source,
    });
  }
  for (const item of usage?.items ?? []) {
    const row = get(item.service);
    row.usage += item.usd;
    row.usageItems.push({
      label: item.label,
      usd: item.usd,
      basis: item.basis,
      note: item.note,
    });
  }
  for (const row of out.values()) row.total = row.subscriptions + row.usage;
  return out;
}

/** Plan label for a card header, from whichever block states it. */
export function planLabelFor(payload: CostsPayloadView, service: string): string | null {
  if (service === "vercel" && payload.vercel_account) {
    const { plan, plan_iteration } = payload.vercel_account;
    return [titleCase(plan), plan_iteration ? titleCase(plan_iteration) : null]
      .filter(Boolean)
      .join(" ");
  }
  if (service === "supabase" && payload.supabase_account) {
    return titleCase(payload.supabase_account.plan);
  }
  if (service === "upstash" && payload.upstash?.usage?.plan) {
    return `${titleCase(payload.upstash.usage.plan)} tier`;
  }
  const override = payload.plan_overrides?.[service];
  if (override) return titleCase(override);
  if (payload.plan) return payload.plan === "free" ? "free tier" : titleCase(payload.plan);
  return null;
}

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// ── The alerts strip ──────────────────────────────────────────────────────────

export type AlertSeverity = "over" | "watch" | "steady";

export type CostAlert = {
  severity: AlertSeverity;
  /** Stable key for React and for tests. */
  key: string;
  /** `service.metric` when a metric owns the line; null for vendor-level state. */
  tag: string | null;
  text: string;
  /** Long-form provenance for a title attribute. */
  detail?: string;
};

/**
 * The three-severity strip that replaces the anonymous "N metrics over limit"
 * banners. Every line names what it is about; a count with no name cannot be
 * acted on, which is how a $2.70/month overage sat unnamed on the card.
 *
 * Display-side only — see the module header on why `over` is not `critical`.
 */
export function deriveAlerts(payload: CostsPayloadView, fmt: Formatters): CostAlert[] {
  const alerts: CostAlert[] = [];
  const metrics = (payload.metrics ?? []).filter(isDisplayedMetric);
  const seen = new Set<string>();
  const cycles = payload.cycles ?? {};

  // ── over: real money, then band-critical ────────────────────────────────────
  for (const m of metrics.filter(isBilling).sort(
    (a, b) => (b.implied_cost_usd ?? 0) - (a.implied_cost_usd ?? 0),
  )) {
    const tag = metricTag(m);
    seen.add(tag);
    const over =
      m.value !== null && !isUnlimited(m)
        ? `${fmt.value(m.value - m.included_limit, m.unit)} over the ${fmt.value(
            m.included_limit,
            m.unit,
          )} included`
        : "above the included allowance";
    alerts.push({
      severity: "over",
      key: `billing:${tag}`,
      tag,
      text: `${metricLabel(m)} — ${over} → ${fmt.usd(m.implied_cost_usd ?? 0)}/mo`,
      ...(m.rate?.label ? { detail: `Rate ${m.rate.label} (${m.rate.source}).` } : {}),
    });
  }

  for (const m of metrics.filter((x) => x.status === "critical")) {
    const tag = metricTag(m);
    if (seen.has(tag)) continue;
    seen.add(tag);
    alerts.push({
      severity: "over",
      key: `critical:${tag}`,
      tag,
      text: `${metricLabel(m)} — ${describeMetricState(m, cycles, fmt)}${bandClause(m, "critical")}`,
      ...(m.notes ? { detail: m.notes } : {}),
    });
  }

  // ── watch: bands, credit pressure, elevated burn, crossing projections ──────
  for (const m of metrics.filter((x) => x.status === "warning")) {
    const tag = metricTag(m);
    if (seen.has(tag)) continue;
    seen.add(tag);
    alerts.push({
      severity: "watch",
      key: `warning:${tag}`,
      tag,
      text: `${metricLabel(m)} — ${describeMetricState(m, cycles, fmt)}${bandClause(m, "warning")}`,
      ...(m.notes ? { detail: m.notes } : {}),
    });
  }

  const billing = payload.vercel_billing;
  if (billing && billing.credit_used_pct >= 90) {
    alerts.push({
      severity: "watch",
      key: "credit",
      tag: "vercel.included_usage_usd",
      text: `${Math.round(billing.credit_used_pct)}% of the ${fmt.usd(
        billing.included_credit_usd,
      )} Vercel usage credit is spent — ${fmt.usd(billing.credit_remaining_usd)} left this cycle`,
    });
  }

  for (const m of metrics) {
    const tag = metricTag(m);
    if (seen.has(tag)) continue;
    const projection = projectionOf(m);
    if (!projection || isUnlimited(m)) continue;
    if (projection.projected <= m.included_limit) continue;
    seen.add(tag);
    alerts.push({
      severity: "watch",
      key: `projected:${tag}`,
      tag,
      text: `${metricLabel(m)} — projected ${fmt.value(
        projection.projected,
        m.unit,
      )} by cycle end, above the ${fmt.value(m.included_limit, m.unit)} included`,
      detail: "Projection is the payload's own; it is not re-derived here.",
    });
  }

  const burn = payload.burn_rate;
  if (burn?.elevated && burn.latest_delta_usd !== null) {
    alerts.push({
      severity: "watch",
      key: "burn",
      tag: null,
      text: `Spend is running at ${fmt.usd(burn.latest_delta_usd)}/day${
        burn.multiple !== null ? ` — ${burn.multiple.toFixed(1)}× the trailing median` : ""
      }`,
      detail: burn.reason,
    });
  }

  // ── steady: sentences, never bars ───────────────────────────────────────────
  if (burn && !burn.elevated && burn.latest_delta_usd !== null) {
    alerts.push({
      severity: "steady",
      key: "burn-normal",
      tag: null,
      text: `Spend is running at ${fmt.usd(burn.latest_delta_usd)}/day${
        burn.multiple !== null ? ` — ${burn.multiple.toFixed(1)}× the trailing median` : ""
      }, within normal range`,
      detail: burn.reason,
    });
  }

  if (billing) {
    const overage = billing.billable_overage_mtd_usd;
    alerts.push({
      severity: overage > 0 ? "watch" : "steady",
      key: "first-cent",
      tag: "vercel.billable_overage_usd",
      text:
        overage > 0
          ? `Billable Vercel overage has started — ${fmt.usd(overage)} so far this cycle`
          : `No billable Vercel overage this cycle — ${fmt.usd(
              billing.credit_remaining_usd,
            )} of the ${fmt.usd(billing.included_credit_usd)} credit still unspent`,
    });
  }

  const cf = payload.cf_mitigation;
  if (cf) {
    alerts.push({
      severity: cf.tripped_at ? "over" : cf.breach_hours > 0 ? "watch" : "steady",
      key: "cf-loop",
      tag: null,
      text: cf.tripped_at
        ? `Edge mitigation TRIPPED at ${cf.tripped_at.slice(11, 16)} UTC`
        : !cf.writes_enabled
          ? "Edge mitigation loop is disarmed — it will alert but not act"
          : cf.write_scope_confirmed === false
            ? "Edge mitigation loop is alert-only — the Cloudflare token lacks Zone Settings:Edit"
            : `Edge mitigation loop armed${
                cf.write_scope_confirmed === true ? " and write scope verified" : ""
              }${cf.observed_level ? ` · Cloudflare at ${cf.observed_level}` : ""}${
                cf.breach_hours > 0
                  ? ` · ${cf.breach_hours}/${cf.required_breach_hours} breach hours`
                  : ""
              }`,
      detail: cf.reason,
    });
  }

  const order: Record<AlertSeverity, number> = { over: 0, watch: 1, steady: 2 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

/**
 * The band clause on an alert line, omitted for state rows. "past its 100%
 * critical band" is meaningless next to a 0/1 flag — the percentage is an
 * encoding artefact there, not a reading.
 */
function bandClause(m: PlatformMetric, band: "warning" | "critical"): string {
  if (isStateMetric(m) || m.value === null) return "";
  const pct = band === "critical" ? m.critical_pct : m.warning_pct;
  return band === "critical" ? ` — past its ${pct}% critical band` : ` — warning band at ${pct}%`;
}

/**
 * A percentage that never rounds a below-the-line reading up to the line.
 * `upstash.period_commands` at 99.79% printing "100%" beside a limit it has not
 * yet reached is the kind of small lie that costs an incident its five minutes.
 */
export function fmtPct(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  if (pct < 100 && Math.round(pct) >= 100) {
    const oneDp = Math.round(pct * 10) / 10;
    return `${(oneDp >= 100 ? 99.9 : oneDp).toFixed(1)}%`;
  }
  return `${Math.round(pct)}%`;
}

/** "498,964 of 500,000 (99.8%)" for quantities; "signal ON" for state rows. */
function describeMetricState(
  m: PlatformMetric,
  cycles: Record<string, ProviderCycle>,
  fmt: Formatters,
): string {
  if (m.value === null) return "no reading";
  if (isStateMetric(m)) {
    return m.value >= m.included_limit ? "signal ON" : "signal off";
  }
  if (isUnlimited(m)) return fmt.value(m.value, m.unit);
  const base = `${fmt.value(m.value, m.unit)} of ${fmt.value(
    m.included_limit,
    m.unit,
  )} (${fmtPct(m.pct)})`;
  const cycle = cycles[cycleKeyForMetric(m)];
  if (cycle && !isRollingCycle(cycle)) {
    return `${base}, ${cycle.days_remaining}d left in the cycle`;
  }
  return base;
}
