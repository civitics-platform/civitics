/**
 * Vercel account-level billing facts (FIX-1089).
 *
 * `GET /v2/teams/{teamId}` → `billing`. Distinct from `vercel-usage.ts`, which
 * reads CONSUMPTION; this reads the CONTRACT: which plan, which billing period,
 * what the subscription costs, how much usage credit it includes, and the
 * account's own rate table.
 *
 * ── THE BILLING PERIOD, AND A PREMISE THIS CONTRADICTS ───────────────────────
 *
 * `vercel-billing.ts` states: "The 2026-08-15 audit noted the Vercel usage page
 * describes a billing cycle of Aug 14 – Sep 14, which is a DIFFERENT basis.
 * Nothing in the charges API discriminates between them." The charges API
 * still doesn't — but THIS endpoint does, and it agrees with the usage page:
 *
 *     billing.period = { start: 1786690800000, end: 1789369200000 }
 *                    =   2026-08-14T07:00:00Z … 2026-09-14T07:00:00Z
 *
 * Read 2026-08-22. So the cycle is knowable after all, and the calendar-month
 * projection basis is an approximation rather than the only option.
 *
 * This module deliberately does NOT change that projection. `computeVercelBilling`
 * feeds `billable_overage_usd` and `overage_present`, both of which are alerting
 * rows with tuned bands; re-basing the divisor would silently move every one of
 * those thresholds. It is surfaced as `cycle` so the card can be honest about
 * the window, and re-basing the projection is its own change with its own
 * verification.
 *
 * ── THE RATE TABLE ───────────────────────────────────────────────────────────
 *
 * `billing.invoiceItems` is a per-account price list — and per-account matters,
 * because Vercel prices by region (`fastDataTransfer` runs $0.15/GB in iad1 and
 * $0.35/GB in icn1), so a published list price is not the price we pay. Two
 * lines are decoded here because their value is independently known and they
 * pin the encoding: `pro` (price 2000, quantity 1) is the $20/month
 * subscription, and `includedAllocationUsd` (price 0, quantity 20) is the $20
 * credit FIX-1046 hardcoded as VERCEL_PRO_INCLUDED_USD. Both parse only if
 * price is in CENTS.
 *
 * Per-METRIC rates are NOT taken from here. They are measured in
 * `vercel-usage.ts` as EffectiveCost ÷ ConsumedQuantity off the account's own
 * charge lines, which needs no mapping table and cannot drift — see
 * platform-rates.ts. Mapping ~65 invoiceItem keys onto 9 metrics by name would
 * be exactly the guessing this program is trying to stop (`webAnalyticsEvent`
 * at $0.00003 and `analyticsUsage` at $0.000065 are both plausible candidates
 * for `web_analytics_events`, and they differ by 200x).
 *
 * 5-minute in-memory cache, matching every other vendor helper here. Never
 * throws; a missing token returns `{ error }` per the FIX-284 convention so the
 * snapshot treats it as benign.
 */

import { invoiceItemFlatUsd, type VercelInvoiceItem } from "./platform-rates";

const BASE = "https://api.vercel.com";
const CACHE_TTL_MS = 5 * 60 * 1000;

export type VercelAccount = {
  plan: string;
  /** e.g. "plus" on this account. Vercel's sub-tier within Pro. */
  plan_iteration: string | null;
  status: string | null;
  /** Billing period in epoch ms, straight from the vendor. Null if absent. */
  period_start_ms: number | null;
  period_end_ms: number | null;
  /** invoiceItems.pro — the subscription, in USD/cycle. Null if not present. */
  subscription_usd: number | null;
  /** invoiceItems.includedAllocationUsd.quantity — the usage credit, USD. */
  included_credit_usd: number | null;
  fetched_at: string;
};

export type VercelAccountError = { error: string };

let cached: VercelAccount | null = null;
let cacheExpiresAt = 0;

export function clearVercelAccountCache(): void {
  cached = null;
  cacheExpiresAt = 0;
}

type TeamResponse = {
  billing?: {
    plan?: string;
    planIteration?: string;
    status?: string;
    period?: { start?: number; end?: number };
    invoiceItems?: Record<string, VercelInvoiceItem>;
  };
};

export async function getVercelAccount(): Promise<VercelAccount | VercelAccountError> {
  if (cached && Date.now() < cacheExpiresAt) return cached;

  const token = process.env["VERCEL_API_TOKEN"];
  if (!token) return { error: "VERCEL_API_TOKEN not set" };
  const teamId = process.env["VERCEL_TEAM_ID"];
  // The personal-account endpoint (/v2/user) reports plan "hobby" with a null
  // period even while the TEAM this project lives in is on Pro — verified on
  // prod. Reading the wrong one would report the wrong plan and no cycle at
  // all, so refuse rather than guess.
  if (!teamId) return { error: "VERCEL_TEAM_ID not set (team billing is where the plan lives)" };

  try {
    const res = await fetch(`${BASE}/v2/teams/${teamId}`, {
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip" },
      cache: "no-store",
    } as RequestInit & { cache?: "no-store" });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      return { error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const json = (await res.json()) as TeamResponse;
    const b = json.billing;
    if (!b) return { error: "team response carried no billing object" };

    const items = b.invoiceItems ?? {};
    // The subscription line is keyed by the plan name itself (`pro`), matching
    // the FOCUS ServiceName that `isPlanBaseService` already recognises.
    const planKey = (b.plan ?? "").toLowerCase();
    const subscription = invoiceItemFlatUsd(items[planKey]);
    // Seats bill at the same per-unit price; quantity is 0 on a solo account.
    const seats = invoiceItemFlatUsd(items["teamSeats"]) ?? 0;

    const creditItem = items["includedAllocationUsd"];
    const credit =
      creditItem && typeof creditItem.quantity === "number" && creditItem.quantity > 0
        ? creditItem.quantity
        : null;

    const result: VercelAccount = {
      plan: b.plan ?? "unknown",
      plan_iteration: b.planIteration ?? null,
      status: b.status ?? null,
      period_start_ms: typeof b.period?.start === "number" ? b.period.start : null,
      period_end_ms: typeof b.period?.end === "number" ? b.period.end : null,
      subscription_usd: subscription === null ? null : subscription + seats,
      included_credit_usd: credit,
      fetched_at: new Date().toISOString(),
    };

    cached = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
