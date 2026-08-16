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
