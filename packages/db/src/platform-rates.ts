/**
 * Per-metric unit rates for the Platform Costs card (FIX-1089).
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────
 *
 * Every row on the card shows a quantity, a limit and a bar, and no price. So a
 * row cannot answer the only question anyone actually asks of it: what is this
 * costing me. `overage_cost` existed but only ever appeared as one collapsed
 * total, and it is silently $0 for every metric a plan credit absorbs — which
 * is most of them.
 *
 * ── THE RULE: NEVER INVENT A RATE ────────────────────────────────────────────
 *
 * A wrong price is worse than no price, because a price renders as fact. Same
 * principle as `calculateCostUsd` throwing on an unpriced model rather than
 * billing it at the cheapest rate (ai-pricing.ts). So there are exactly two
 * sources here and no third:
 *
 *   'api'         — measured off the vendor this tick. For Vercel that is not a
 *                   published rate card at all, it is EffectiveCost ÷
 *                   ConsumedQuantity from the account's own charge lines:
 *                   what they charged, divided by what we used.
 *   'configured'  — platform_limits.overage_unit_cost, which is already in the
 *                   database and already drives calculateOverageCost. This
 *                   module only NORMALIZES it to $/native-unit so the card can
 *                   print it; it does not introduce a new number.
 *
 * A metric with neither gets no rate and no implied cost, and the omission is
 * reported in the payload rather than papered over with a guess.
 *
 * ── WHY THE BASIS FIELD IS NOT DECORATION ────────────────────────────────────
 *
 * "rate × usage" and "money owed" are different numbers on this stack, and the
 * gap is not small:
 *
 *   supabase.db_size_bytes  29.6 GiB × $0.125/GB → OWED, above an 8 GiB quota
 *   vercel.fluid_cpu_seconds  metered at list → drawn against a $20 credit,
 *                             owed $0 until the credit is spent
 *   github.action_minutes     5,136 min × $0.006 = $30.82 gross → $0.00 net,
 *                             fully discounted on a public repo
 *
 * Summing those three as if they were the same kind of dollar is exactly the
 * double-count FIX-1050 removed from `total_overage_cost`. So every implied
 * cost carries the basis it was computed on, and the true-cost roll-up
 * (platform-costs.ts) selects by basis rather than summing blindly.
 *
 * Pure functions only — no network, no DB, no clock.
 */

import type { PlatformLimit } from "./platform-usage";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RateSource = "api" | "configured";

/**
 * How a metric's `implied_cost_usd` was arrived at. Read this before adding a
 * metric's dollars to any total.
 *
 *  - `overage`         rate × units above included_limit. Money owed.
 *  - `actual`          the vendor reported the dollars directly. Money owed.
 *  - `credit_absorbed` list value of consumption drawn against a plan credit.
 *                      NOT money owed — the owed figure for that vendor is its
 *                      credit-aware billing block (vercel_billing).
 *  - `free_tier`       inside an allowance that blocks rather than bills, so
 *                      the cost is $0 and no overage rate exists to apply.
 */
export type ImpliedCostBasis =
  | "overage"
  | "actual"
  | "credit_absorbed"
  | "free_tier";

export type MetricRate = {
  /** USD per ONE unit of the metric's own `unit` column (byte, request, ms…). */
  usd_per_unit: number;
  /** Human form for the card, e.g. "$0.125 / GB". Rendered verbatim. */
  label: string;
  source: RateSource;
  /** Units included before the rate bites, in the metric's native unit. */
  free_units: number | null;
  /**
   * true when `usd_per_unit` is per-unit-per-DAY rather than per-cycle — the
   * shape `billing_cycle='per_day_reset'` encodes (github.storage_bytes bills
   * Actions+Packages storage at $0.008/GB/day). Printing a per-day rate as if
   * it were monthly understates by ~30x.
   */
  per_day?: true;
};

// ── Unit normalization ────────────────────────────────────────────────────────

/**
 * Bytes per GB. 1024³, matching `calculateOverageCost`'s `per_gb` divisor and
 * `vercel-usage.ts`'s BYTES_PER_GB. Vendors are inconsistent about whether
 * their "GB" is 10⁹ or 2³⁰; what matters here is that the rate and the overage
 * math agree, so both use the same constant and neither is silently 7% off the
 * other.
 */
const BYTES_PER_GB = 1024 ** 3;

/**
 * Divisor taking `overage_unit_cost` (priced per `overage_unit`) down to a
 * price per ONE native unit. Mirrors the switch in `calculateOverageCost`
 * exactly — if these two ever disagree, the card prints a rate that does not
 * reproduce the overage total sitting next to it.
 */
function unitsPerOverageUnit(overageUnit: string | null): number {
  switch (overageUnit) {
    case "per_gb":
      return BYTES_PER_GB;
    case "per_1m":
    case "per_1m_requests":
      return 1_000_000;
    case "per_minute":
      return 60;
    case "per_request":
    case "per_usd":
      return 1;
    default:
      return 1;
  }
}

/** Human label for a configured rate, e.g. "$0.125 / GB". */
function rateLabel(cost: number, overageUnit: string | null, perDay: boolean): string {
  const amount = `$${trimNumber(cost)}`;
  const per = (() => {
    switch (overageUnit) {
      case "per_gb":
        return "GB";
      case "per_1m":
      case "per_1m_requests":
        return "1M";
      case "per_minute":
        return "minute";
      case "per_request":
        return "request";
      case "per_usd":
        return "$1";
      default:
        return "unit";
    }
  })();
  return `${amount} / ${per}${perDay ? " / day" : ""}`;
}

/**
 * Format a rate without rounding it away.
 *
 * These rates span eleven orders of magnitude — $0.125 per GB down to
 * $5.4e-11 per byte for the same underlying price — so a fixed number of
 * DECIMAL places is not a formatting preference, it is a correctness bug: a
 * `toFixed(8)` on the per-byte rate produces "0.00000000", which renders as
 * "$0 / bytes" and reads as "this is free". Measured in the local smoke before
 * this was fixed.
 *
 * So: significant digits, not decimal places, and exponential notation once a
 * value is small enough that a decimal string would be unreadable anyway.
 *
 * FIX-1104: exported. Both rate builders in this file already used it, but
 * platform-snapshot.ts was assembling the github.action_minutes rate label
 * inline and interpolating the raw double, so the card printed
 * "$0.005999999999999999 / minute" for a rate GitHub states as $0.006. One
 * formatter, imported by everything that prints a rate — a second local
 * `${n}` is how this comes back.
 */
export function trimNumber(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 0.01) return String(Math.round(n * 10000) / 10000);
  if (abs >= 1e-7) {
    // Three significant digits, then drop the trailing zeros toFixed adds.
    const decimals = Math.min(20, Math.ceil(-Math.log10(abs)) + 2);
    return n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  }
  return n.toExponential(2);
}

// ── Configured rates (from platform_limits) ───────────────────────────────────

/**
 * The rate already encoded on a `platform_limits` row, normalized to $/unit.
 *
 * Returns null when the row carries no `overage_unit_cost` — a hard limit, a
 * free allowance that blocks instead of billing, or simply a metric nobody has
 * priced. That null is the honest answer and the card shows no price.
 */
export function configuredRateFromLimit(
  limit: Pick<
    PlatformLimit,
    "overage_unit_cost" | "overage_unit" | "included_limit" | "billing_cycle"
  >,
): MetricRate | null {
  const cost = limit.overage_unit_cost;
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }
  const perDay = limit.billing_cycle === "per_day_reset";
  const divisor = unitsPerOverageUnit(limit.overage_unit);
  return {
    usd_per_unit: cost / divisor,
    label: rateLabel(cost, limit.overage_unit, perDay),
    source: "configured",
    // -1 is the "unlimited" sentinel; it is not a quantity of free units.
    free_units: limit.included_limit >= 0 ? limit.included_limit : null,
    ...(perDay ? { per_day: true as const } : {}),
  };
}

// ── Measured rates (from a vendor's own charge lines) ─────────────────────────

/**
 * Rate implied by what a vendor actually charged for what we actually used.
 *
 * This is the strongest kind of rate available: it needs no rate card, cannot
 * drift when the vendor reprices, and is per-account (Vercel's regional price
 * matrix means the published list price is not the price we pay). Returns null
 * on a zero or non-finite quantity — dividing by it would produce Infinity and
 * render as a confidently wrong price.
 */
export function measuredRate(
  usd: number,
  quantity: number,
  unitLabel: string,
): MetricRate | null {
  if (!Number.isFinite(usd) || !Number.isFinite(quantity) || quantity <= 0) return null;
  const perUnit = usd / quantity;
  if (!Number.isFinite(perUnit) || perUnit <= 0) return null;
  return {
    usd_per_unit: perUnit,
    label: `$${trimNumber(perUnit)} / ${unitLabel}`,
    source: "api",
    free_units: null,
  };
}

// ── Vercel invoiceItems rate table ────────────────────────────────────────────

/**
 * One line of `GET /v2/teams/{id}` → `billing.invoiceItems`.
 *
 * The encoding is not documented anywhere and was established against prod on
 * 2026-08-22 by reading the two lines whose value is independently known:
 * `pro` (price 2000, quantity 1) is the $20/month Pro subscription, and
 * `includedAllocationUsd` (price 0, quantity 20) is the $20 usage credit
 * FIX-1046 hardcoded as VERCEL_PRO_INCLUDED_USD. Both only parse if **price is
 * in cents**. `batch` is how many units one `price` covers (65 / 1,000,000 for
 * edge middleware invocations = $0.65 per million); absent means 1.
 * `threshold` is units included before charging (edgeRequest: 10,000,000).
 */
export type VercelInvoiceItem = {
  price?: number;
  batch?: number;
  threshold?: number;
  quantity?: number;
  hidden?: boolean;
};

/** USD per unit for an invoiceItem line. Null when the shape is unusable. */
export function invoiceItemUsdPerUnit(item: VercelInvoiceItem | undefined): number | null {
  if (!item || typeof item.price !== "number" || !Number.isFinite(item.price)) return null;
  const batch = typeof item.batch === "number" && item.batch > 0 ? item.batch : 1;
  return item.price / 100 / batch;
}

/** Total USD for an invoiceItem line priced as a flat quantity (`pro`, seats). */
export function invoiceItemFlatUsd(item: VercelInvoiceItem | undefined): number | null {
  if (!item || typeof item.price !== "number" || !Number.isFinite(item.price)) return null;
  const qty = typeof item.quantity === "number" ? item.quantity : 1;
  return (item.price / 100) * qty;
}
