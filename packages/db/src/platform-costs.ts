/**
 * True cost to run the platform (FIX-1089).
 *
 * ── THE BUG THIS CORRECTS ────────────────────────────────────────────────────
 *
 * The dashboard headline was:
 *
 *     anthropic actual  +  Σ non-vercel metric overages  +  vercel projected bill
 *
 * which on prod 2026-08-22 printed **$22.71/month**. Vercel's $20 subscription
 * is in there only by accident — it rides inside
 * `vercel_billing.projected_total_bill_usd`. **Supabase Pro's $25/month is not
 * in there at all**, and could not be: the payload had no concept of a
 * subscription, and a recurring charge with no quantity, no limit and no
 * overage cannot be expressed as a `platform_limits` row. So the single number
 * the whole card exists to produce was understating the bill by more than the
 * bill it reported.
 *
 * The corrected shape is deliberately boring:
 *
 *     total = Σ subscriptions  +  Σ billable usage
 *
 * ── WHY IT IS ITEMIZED AND NOT A SCALAR ──────────────────────────────────────
 *
 * A scalar cannot be audited. $22.71 looked plausible for two years, and the
 * only reason anyone noticed is that somebody went and read a vendor invoice.
 * Both halves ship as itemized lists so the total can be checked line by line
 * against the vendor dashboards, and so a line that ISN'T there is visible.
 *
 * ── THE DOUBLE-COUNT RULE ────────────────────────────────────────────────────
 *
 * This is where cost roll-ups go wrong, and it has gone wrong here before —
 * FIX-1050 had to stop `total_overage_cost` billing the same Vercel bytes under
 * two definitions of "overage". The rule, enforced by construction below rather
 * than by care:
 *
 *   A vendor with credit-aware billing contributes EXACTLY ONE usage figure —
 *   its credit-aware billable overage. Its per-metric list values are
 *   `credit_absorbed` and are never summed.
 *
 * That is why `billableUsageItems` selects on `implied_cost_basis` instead of
 * summing `implied_cost_usd`. A basis of `credit_absorbed` or `free_tier` is
 * real information about consumption and is $0 of money owed; only `overage`
 * and `actual` are dollars on an invoice.
 *
 * ── OMISSIONS ARE REPORTED, NOT GUESSED ──────────────────────────────────────
 *
 * Anything we cannot price is listed in `omissions` and left out of the total.
 * A total that is honestly incomplete and says so beats a total that is
 * confidently wrong — the same call `calculateCostUsd` makes when it throws on
 * an unpriced model instead of billing it at the cheapest rate.
 *
 * Pure functions: no network, no DB, no clock.
 */

import type { ImpliedCostBasis, RateSource } from "./platform-rates";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SubscriptionItem = {
  service: string;
  name: string;
  monthly_usd: number;
  cadence: "monthly" | "annual";
  source: RateSource;
  /** false = tracked but footnoted rather than summed (annual amortizations). */
  in_headline: boolean;
  note: string | null;
};

export type BillableUsageItem = {
  service: string;
  /** Metric key when it came from a metric row; null for a vendor-level figure. */
  metric: string | null;
  label: string;
  usd: number;
  basis: ImpliedCostBasis | "credit_aware_projection";
  source: RateSource;
  note: string | null;
};

export type PlatformCostTotals = {
  subscriptions_usd: {
    total: number;
    items: SubscriptionItem[];
  };
  billable_usage_usd: {
    total: number;
    items: BillableUsageItem[];
  };
  /** Subscriptions (headline ones) + billable usage. THE number. */
  total_monthly_usd: number;
  /**
   * Costs we know exist and deliberately did not price. Non-empty is not a
   * failure — it is the total telling you what it does not cover.
   */
  omissions: string[];
};

/** A metric reduced to what the roll-up needs. Keeps this module DB-free. */
export type CostContributingMetric = {
  service: string;
  metric: string;
  label: string;
  implied_cost_usd?: number;
  implied_cost_basis?: ImpliedCostBasis;
  rate_source?: RateSource;
};

export type PlatformCostInput = {
  subscriptions: SubscriptionItem[];
  metrics: CostContributingMetric[];
  /**
   * Credit-aware projected overage for the one vendor that has such a model.
   * `null` when the Vercel API call failed — in which case Vercel contributes
   * no usage line and the omission is reported. Falling back to the per-metric
   * list values would be worse than reporting nothing: they come from the SAME
   * failed call, and they are on the wrong definition of the word.
   */
  vercelBillableUsd: number | null;
  /** Set when the Vercel reading failed, so the omission can name the reason. */
  vercelUnavailableReason?: string | null;
  /** GitHub's own `netAmount` sum — actual billed dollars after free-tier discount. */
  githubBilledUsd: number | null;
  githubGrossUsd?: number | null;
};

// ── The roll-up ───────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Metric bases that represent money on an invoice. Everything else describes
 * consumption without describing a charge, and must not reach a total.
 */
const OWED_BASES: ReadonlySet<ImpliedCostBasis> = new Set<ImpliedCostBasis>([
  "overage",
  "actual",
]);

export function computePlatformCostTotals(
  input: PlatformCostInput,
): PlatformCostTotals {
  const omissions: string[] = [];

  // ── Subscriptions ───────────────────────────────────────────────────────────
  const subs = input.subscriptions.filter((s) => Number.isFinite(s.monthly_usd));
  const subsTotal = subs
    .filter((s) => s.in_headline)
    .reduce((sum, s) => sum + s.monthly_usd, 0);

  // ── Billable usage ──────────────────────────────────────────────────────────
  const usage: BillableUsageItem[] = [];

  // Per-metric quota overages + vendor-reported actuals. Vercel is excluded by
  // construction: its metrics are all `credit_absorbed`, and its single usage
  // figure is added below. If a Vercel metric ever arrives with an `overage`
  // basis, the filter below is what keeps it from being counted twice.
  for (const m of input.metrics) {
    if (m.service === "vercel") continue;
    const basis = m.implied_cost_basis;
    const usd = m.implied_cost_usd;
    if (!basis || !OWED_BASES.has(basis)) continue;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) continue;
    usage.push({
      service: m.service,
      metric: m.metric,
      label: m.label,
      usd: round2(usd),
      basis,
      source: m.rate_source ?? "configured",
      note: null,
    });
  }

  // Vercel: one figure, credit-aware, never the per-metric list values.
  if (typeof input.vercelBillableUsd === "number" && Number.isFinite(input.vercelBillableUsd)) {
    if (input.vercelBillableUsd > 0) {
      usage.push({
        service: "vercel",
        metric: null,
        label: "Usage above the included credit",
        usd: round2(input.vercelBillableUsd),
        basis: "credit_aware_projection",
        source: "api",
        note:
          "Projected month-end consumption minus the $20 the Pro subscription " +
          "includes. The subscription itself is a separate line.",
      });
    }
  } else {
    omissions.push(
      "Vercel metered usage — the billing API reading failed this tick" +
        (input.vercelUnavailableReason ? ` (${input.vercelUnavailableReason})` : "") +
        ", so no credit-aware overage could be computed. The per-metric Vercel " +
        "rows come from the same call and are not a usable substitute.",
    );
  }

  // GitHub: the billing API states net dollars outright, so this is `actual`
  // and needs no rate. It is $0 on a public repo — the gross figure is the
  // interesting one and lives in the github payload block, not in a total.
  if (typeof input.githubBilledUsd === "number" && Number.isFinite(input.githubBilledUsd)) {
    if (input.githubBilledUsd > 0) {
      usage.push({
        service: "github",
        metric: null,
        label: "Actions + storage, after free-tier discount",
        usd: round2(input.githubBilledUsd),
        basis: "actual",
        source: "api",
        note:
          typeof input.githubGrossUsd === "number"
            ? `$${round2(input.githubGrossUsd).toFixed(2)} at list before the free-tier discount.`
            : null,
      });
    }
  }

  usage.sort((a, b) => b.usd - a.usd);
  const usageTotal = usage.reduce((sum, u) => sum + u.usd, 0);

  return {
    subscriptions_usd: { total: round2(subsTotal), items: subs },
    billable_usage_usd: { total: round2(usageTotal), items: usage },
    total_monthly_usd: round2(subsTotal + usageTotal),
    omissions,
  };
}
