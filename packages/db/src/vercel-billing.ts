/**
 * Vercel Pro billing math (FIX-1046).
 *
 * ── THE BUG THIS CORRECTS ────────────────────────────────────────────────────
 *
 * Vercel Pro is $20/month AND THAT $20 BUYS $20 OF INCLUDED USAGE. The bill is
 *
 *     $20 base  +  max(0, metered usage − $20)
 *
 * The snapshot and the dashboard both treated the *entire* EffectiveCost sum as
 * money owed. EffectiveCost is the LIST VALUE of all consumption plus the
 * prorated `Pro` subscription line, so the dashboard's headline was the gross
 * list price of everything — and every dollar of it sat below the included
 * credit. Measured on prod 2026-08-16: the card read **$31.38/mo** when the
 * actual billable overage was **$0.00** with **$8.62 of the credit still
 * unspent** at the projected month-end rate. A number that says $31 when the
 * answer is $0 cannot be used to decide anything, and — the reason this is a
 * detection fix and not a cosmetic one — it also cannot ALARM, because it is
 * already "high" on a perfectly normal month.
 *
 * ── WHY THE `Pro` LINE MUST COME OUT FIRST ───────────────────────────────────
 *
 * The FOCUS charge export carries the subscription as its own ServiceName
 * (`Pro`), accruing $20/31 = $0.6452 per day — verified against prod, where day
 * 15 read exactly $9.6774. That line is the SUBSCRIPTION, not consumption, so it
 * does not draw down the credit the subscription buys. Counting it against the
 * credit would understate remaining headroom by the full $20 and would put the
 * account permanently "at 100% of credit" from the first of every month.
 *
 *     usage = effective_total − plan_base
 *
 * ── CYCLE BASIS, STATED HONESTLY ─────────────────────────────────────────────
 *
 * `getVercelUsage` requests charges from the first of the CALENDAR month, and
 * the data agrees with that framing: `window_days` increments by exactly one per
 * calendar day and the `Pro` line prorates over 31. The 2026-08-15 audit noted
 * the Vercel usage page describes a billing cycle of Aug 14 – Sep 14, which is a
 * DIFFERENT basis. Nothing in the charges API discriminates between them. This
 * module therefore projects on the calendar month (matching the data it is
 * given) and exposes `days_in_cycle` as an input rather than hard-coding it, so
 * correcting the basis later is a one-line change at the call site and not a
 * rewrite. The credit is treated as a whole-cycle $20 and is NOT prorated —
 * Vercel grants it per cycle, not per day.
 *
 * FIX-1099 — the paragraph above is history. The vendor's cycle IS knowable
 * (vercelBillingCycle below) and is the one Vercel bills on. Which basis the
 * ALERT rows read is chosen at the call site, VERCEL_ALERT_BASIS in
 * platform-snapshot.ts, and every payload now says which one it used.
 *
 * Pure functions only: no network, no DB, no clock. That is what makes the
 * table-driven tests in vercel-billing.test.ts meaningful.
 */

/**
 * Included usage credit on Vercel Pro, in USD per billing cycle.
 *
 * Craig-stated 2026-08-16. Lives here as the single named constant AND is
 * mirrored into `platform_limits` (vercel.included_usage_usd.included_limit) so
 * the alert band can be retuned with an UPDATE instead of a deploy. The two are
 * kept in sync by `computeVercelBilling` taking the credit as an argument —
 * callers pass the platform_limits value and fall back to this.
 */
export const VERCEL_PRO_INCLUDED_USD = 20;

export type VercelBillingInput = {
  /** Σ EffectiveCost over the window, INCLUDING the `Pro` subscription line. */
  effectiveMtdUsd: number;
  /** Σ EffectiveCost of the plan-subscription line(s) only. */
  planBaseMtdUsd: number;
  /** Distinct billing days present in the charges response. 0 ⇒ unknown. */
  windowDays: number;
  /** Days in the cycle the projection extrapolates to (calendar month today). */
  daysInCycle: number;
  /** Included usage credit for the cycle. Defaults to VERCEL_PRO_INCLUDED_USD. */
  includedCreditUsd?: number;
};

export type VercelBilling = {
  /** Gross list value of everything, incl. subscription. The old headline. */
  gross_effective_mtd_usd: number;
  /** The subscription line, MTD (prorated by Vercel). */
  plan_base_mtd_usd: number;
  /** Metered consumption MTD — what actually draws down the credit. */
  usage_mtd_usd: number;
  included_credit_usd: number;
  /** Credit not yet consumed. Never negative. */
  credit_remaining_usd: number;
  /** Fraction of the credit consumed so far, 0-100+ (may exceed 100). */
  credit_used_pct: number;
  /** Money owed above the credit, MTD. $0 for a normal month. */
  billable_overage_mtd_usd: number;

  /** Consumption extrapolated to the end of the cycle at the current rate. */
  projected_usage_usd: number;
  /** THE HEADLINE: projected month-end overage above the credit. */
  projected_billable_overage_usd: number;
  /** Projected total invoice: full-cycle subscription + projected overage. */
  projected_total_bill_usd: number;
  /** Gross list value projected — kept because it is the leading indicator. */
  projected_gross_usd: number;

  /** false when windowDays is 0 (quantity-only fallback): no projection made. */
  projectable: boolean;
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function computeVercelBilling(input: VercelBillingInput): VercelBilling {
  const {
    effectiveMtdUsd,
    planBaseMtdUsd,
    windowDays,
    daysInCycle,
    includedCreditUsd = VERCEL_PRO_INCLUDED_USD,
  } = input;

  const gross = Math.max(0, effectiveMtdUsd);
  // A plan base larger than the gross total is nonsense (it is a subset of it);
  // clamp rather than emit a negative usage figure that would read as a credit.
  const base = Math.min(Math.max(0, planBaseMtdUsd), gross);
  const usage = gross - base;

  const credit = Math.max(0, includedCreditUsd);
  const creditRemaining = Math.max(0, credit - usage);
  const creditUsedPct = credit > 0 ? (usage / credit) * 100 : 0;
  const billableMtd = Math.max(0, usage - credit);

  // windowDays === 0 is the quantity-only /v1/usage fallback: no daily
  // granularity, so there is no honest rate to extrapolate. Pass the MTD
  // figures through unprojected and say so, rather than inventing a run-rate.
  const projectable = windowDays > 0 && daysInCycle > 0;
  const scale = projectable ? daysInCycle / windowDays : 1;

  const projectedUsage = usage * scale;
  const projectedBillable = Math.max(0, projectedUsage - credit);
  // The subscription is a whole-cycle charge; at month end it is the full $20
  // regardless of how far into the cycle we are, so project the base too.
  const projectedBase = base * scale;

  return {
    gross_effective_mtd_usd: round4(gross),
    plan_base_mtd_usd: round4(base),
    usage_mtd_usd: round4(usage),
    included_credit_usd: round4(credit),
    credit_remaining_usd: round4(creditRemaining),
    credit_used_pct: round4(creditUsedPct),
    billable_overage_mtd_usd: round4(billableMtd),
    projected_usage_usd: round4(projectedUsage),
    projected_billable_overage_usd: round4(projectedBillable),
    projected_total_bill_usd: round4(projectedBase + projectedBillable),
    projected_gross_usd: round4(projectedBase + projectedUsage),
    projectable,
  };
}

// ── FIX-1099: which cycle the projection extrapolates onto ──────────────────
//
// The header above says the basis is "a one-line change at the call site".
// FIX-1089 then found the vendor states the cycle outright (/v2/teams/{id} →
// billing.period, 07:00Z = Pacific midnight, e.g. Sep 14 → Oct 14), and prod
// confirms it is the cycle Vercel bills on: the `Pro` line's daily accrual
// switched from $20/31 to $20/30 on Sep 14 PDT, the first day of the new
// vendor cycle, not on Sep 1 — and the once-per-cycle `Speed Insights Plus
// Events` $0.65 lands on that same day.
//
// This function states the cycle the projection should divide by. It does NOT
// decide which basis the alert rows read — that is VERCEL_ALERT_BASIS in
// platform-snapshot.ts, and it stays on the calendar month until the alert
// bands are re-tuned against the vendor basis (the 2026-09-28 replay found a
// flip; see docs/audits/2026-09-28-fix1099-alert-replay.md).

export type VercelBillingBasis = "vendor" | "calendar";

/**
 * How the cycle-to-date dollars were obtained. Only one method exists: the
 * design anticipated summing snapshot deltas because it believed
 * /v1/billing/charges returns ~7 trailing days, but FIX-1041 measured it as
 * true month-to-date that honours `from` (window_days climbed 1…31 through
 * August and reset on 09-01). A charges read from the cycle start is the
 * cycle-to-date.
 */
export type VercelMtdBasis = "charges";

export type VercelBillingCycle = {
  basis: VercelBillingBasis;
  /** Inclusive start / exclusive end, epoch ms. */
  start_ms: number;
  end_ms: number;
  /**
   * Whole days in the cycle. Vercel's boundaries sit on Pacific midnight, so a
   * cycle that spans a DST change is 30 or 31 days ± 1 hour; rounding removes
   * the hour rather than projecting onto 30.04 days.
   */
  days_in_cycle: number;
  /** 1-based day of the cycle that `now` falls on. */
  day_of_cycle: number;
  /** Why the vendor's cycle was not used. Null on the vendor basis. */
  fallback_reason: string | null;
};

const MS_PER_DAY = 86_400_000;

/**
 * The cycle to project onto: the vendor's billing.period when it is usable,
 * otherwise the UTC calendar month — with the reason stated, so a reader never
 * mistakes the fallback for the vendor's word.
 *
 * "Usable" means finite, ordered, and CURRENT: a period that ended before
 * `now` (the vendor had not rolled it yet) is not this cycle, and projecting
 * onto it would divide by a window that is over.
 */
export function vercelBillingCycle(
  periodStartMs: number | null | undefined,
  periodEndMs: number | null | undefined,
  now: Date,
): VercelBillingCycle {
  const t = now.getTime();
  let reason: string | null = null;
  if (typeof periodStartMs !== "number" || typeof periodEndMs !== "number") {
    reason = "the vendor returned no billing.period this tick";
  } else if (!Number.isFinite(periodStartMs) || !Number.isFinite(periodEndMs)) {
    reason = "billing.period was not finite";
  } else if (periodEndMs <= periodStartMs) {
    reason = "billing.period end is not after its start";
  } else if (t < periodStartMs || t >= periodEndMs) {
    reason = "billing.period does not contain now (the vendor has not rolled it)";
  } else {
    const days = Math.round((periodEndMs - periodStartMs) / MS_PER_DAY);
    return {
      basis: "vendor",
      start_ms: periodStartMs,
      end_ms: periodEndMs,
      days_in_cycle: days,
      day_of_cycle: Math.min(days, Math.floor((t - periodStartMs) / MS_PER_DAY) + 1),
      fallback_reason: null,
    };
  }
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = Date.UTC(y, m, 1);
  const end = Date.UTC(y, m + 1, 1);
  return {
    basis: "calendar",
    start_ms: start,
    end_ms: end,
    days_in_cycle: Math.round((end - start) / MS_PER_DAY),
    day_of_cycle: Math.floor((t - start) / MS_PER_DAY) + 1,
    fallback_reason: reason,
  };
}

/**
 * Did a charges read requested `from` the cycle start actually START there?
 *
 * The earliest ChargePeriodStart must sit within a day of the requested start:
 * later means the vendor truncated the window (the trailing-7-day behaviour
 * FIX-648 once saw), earlier means it ignored `from` and returned more than the
 * cycle. Either way the dollars are not cycle-to-date. A day of tolerance
 * covers the label convention (a Pacific day may be labelled at its 07:00Z
 * start or at UTC midnight) without admitting a second day. An empty window —
 * the first hours of a cycle, before any day has closed — has nothing to check
 * and is accepted: it is a true zero.
 */
export function chargesWindowStartsAt(
  windowStart: string | null,
  windowDays: number,
  cycleStartMs: number,
): boolean {
  if (windowDays === 0 || windowStart === null) return true;
  const ws = Date.parse(windowStart);
  if (!Number.isFinite(ws)) return false;
  return Math.abs(ws - cycleStartMs) < MS_PER_DAY;
}

/**
 * What the snapshot writes beside the numbers, so a reader always knows which
 * cycle they were projected onto (rule 8: the reader must see which). Absent on
 * payloads written before FIX-1099, so every consumer treats it as optional.
 */
export type VercelBillingBasisStamp = {
  basis: VercelBillingBasis;
  mtd_basis: VercelMtdBasis;
  /** ISO bounds of the cycle the projection divides by. */
  billing_period_start: string;
  billing_period_end: string;
  days_in_cycle: number;
  /** Charge days observed inside the cycle — the projection's divisor. */
  window_days: number;
  fallback_reason: string | null;
};

export type VercelBillingStamped = VercelBilling & VercelBillingBasisStamp;

export function stampVercelBilling(
  billing: VercelBilling,
  cycle: Pick<VercelBillingCycle, "basis" | "start_ms" | "end_ms" | "days_in_cycle" | "fallback_reason">,
  windowDays: number,
): VercelBillingStamped {
  return {
    ...billing,
    basis: cycle.basis,
    mtd_basis: "charges",
    billing_period_start: new Date(cycle.start_ms).toISOString(),
    billing_period_end: new Date(cycle.end_ms).toISOString(),
    days_in_cycle: cycle.days_in_cycle,
    window_days: windowDays,
    fallback_reason: cycle.fallback_reason,
  };
}

/**
 * Does this FOCUS `ServiceName` denote the plan SUBSCRIPTION rather than
 * metered consumption?
 *
 * Vercel emits the subscription as a bare plan name — `Pro` on this account,
 * confirmed against prod where it accrues exactly $20/31 per day. Matching is
 * anchored and exact-after-trim on purpose: a substring match on "pro" would
 * swallow any future "…Provisioned…" line (there is already a `Fluid
 * Provisioned Memory`), and mis-classifying a consumption line as the base
 * would silently inflate remaining credit.
 */
export function isPlanBaseService(serviceName: string): boolean {
  return /^(hobby|pro|enterprise)$/i.test(serviceName.trim());
}
