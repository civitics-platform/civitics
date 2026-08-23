/**
 * Recurring platform subscriptions (FIX-1089).
 *
 * Reads `platform_subscriptions` — the charges that are not metrics. See the
 * migration header for why they need a table of their own rather than a
 * constant: a subscription has no quantity, no limit and no overage, so it
 * cannot be a `platform_limits` row, which is exactly why Supabase Pro's
 * $25/month was invisible to every total the platform has printed.
 *
 * Never throws. A read failure degrades to an empty list plus an error string,
 * and the caller reports the omission — the snapshot tick must still land.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SubscriptionItem } from "./platform-costs";

export type SubscriptionsRead = {
  items: SubscriptionItem[];
  error: string | null;
};

type Row = {
  service: string;
  name: string;
  monthly_usd: number | string;
  cadence: string;
  source: string;
  in_headline: boolean;
  notes: string | null;
  sort_order: number;
};

export async function getPlatformSubscriptions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<SubscriptionsRead> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  try {
    const { data, error } = await anyDb
      .from("platform_subscriptions")
      .select("service, name, monthly_usd, cadence, source, in_headline, notes, sort_order")
      .eq("is_active", true)
      .order("sort_order");

    if (error) return { items: [], error: error.message };

    const items: SubscriptionItem[] = ((data ?? []) as Row[]).map((r) => ({
      service: r.service,
      name: r.name,
      // NUMERIC arrives as a string over PostgREST on some driver versions.
      monthly_usd: Number(r.monthly_usd),
      cadence: r.cadence === "annual" ? "annual" : "monthly",
      source: r.source === "api" ? "api" : "configured",
      in_headline: r.in_headline !== false,
      note: r.notes,
    }));
    return { items, error: null };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Update a subscription's price from a live vendor reading.
 *
 * Only ever called with a number the vendor stated this tick (Vercel's
 * `invoiceItems.pro`), so the seeded fallback in the migration self-corrects
 * the moment Vercel reprices, without a deploy. Best-effort: a failed write
 * leaves the seeded value, which is the last known good.
 */
export async function updateSubscriptionPrice(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  service: string,
  name: string,
  monthlyUsd: number,
): Promise<void> {
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  try {
    await anyDb
      .from("platform_subscriptions")
      .update({ monthly_usd: monthlyUsd, source: "api", updated_at: new Date().toISOString() })
      .eq("service", service)
      .eq("name", name);
  } catch {
    // Non-fatal by design — see the doc comment.
  }
}
