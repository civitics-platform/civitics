/**
 * GET /api/admin/kill-switches/recent
 *
 * Returns recent kill-switch OFF flips (last hour) for the dashboard's
 * admin-only banner. Moved off the SSR path (FIX-347) so the dashboard's
 * edge-cached HTML never carries admin-rendered banner data — the client
 * component fetches this on mount and renders post-hydration when the
 * cookie session belongs to the admin.
 *
 * Auth: Supabase Auth session cookie; user.email must match ADMIN_EMAIL.
 *   Returns 404 (not 401/403) on auth failure so the route isn't discoverable
 *   from outside — matches /api/admin/me + /api/admin/kill-switches.
 *
 * Behavior: same query the SSR `getRecentKillSwitchEvents()` previously ran
 * — `kill_switch_events` rows with `flipped_at >= now - 1 hour` AND
 * `flipped_to = false`, ordered `flipped_at DESC LIMIT 10`. Re-enables are
 * non-events for an "operator awareness" surface (re-enable means someone
 * already knew and acted).
 *
 * Why admin client for the read: `kill_switch_events` RLS is `USING(false)`;
 * the admin email gate above is the authorization check.
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";

export type KillSwitchEvent = {
  id: number;
  switch_name: string;
  trigger_metric: string | null;
  trigger_value: number | null;
  threshold_pct: number | null;
  flipped_to: boolean;
  source: "auto" | "manual";
  flipped_at: string;
};

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(): Promise<NextResponse> {
  const adminEmail = process.env["ADMIN_EMAIL"];
  if (!adminEmail) return notFound();

  const supabase = createServerClient(cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.email !== adminEmail) return notFound();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const { data } = await db
      .from("kill_switch_events")
      .select(
        "id, switch_name, trigger_metric, trigger_value, threshold_pct, flipped_to, source, flipped_at",
      )
      .gte("flipped_at", new Date(Date.now() - 3_600_000).toISOString())
      .eq("flipped_to", false)
      .order("flipped_at", { ascending: false })
      .limit(10);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: KillSwitchEvent[] = (data ?? []).map((r: any) => ({
      id: r.id as number,
      switch_name: r.switch_name as string,
      trigger_metric: (r.trigger_metric as string | null) ?? null,
      trigger_value: r.trigger_value === null ? null : Number(r.trigger_value),
      threshold_pct: (r.threshold_pct as number | null) ?? null,
      flipped_to: r.flipped_to as boolean,
      source: r.source as "auto" | "manual",
      flipped_at: r.flipped_at as string,
    }));

    return NextResponse.json({ events });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
