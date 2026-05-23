/**
 * GET  /api/platform/usage  — Platform resource usage with limits
 * POST /api/platform/usage  — Admin: update/verify/upgrade (requires X-Admin-Key)
 *
 * GET reads the latest row from platform_usage_snapshot (populated every
 * 10 minutes by /api/cron/platform-snapshot, FIX-281). When the snapshot
 * is missing or older than 20 minutes (two missed cron ticks) the route
 * falls back to a live recompute via computePlatformUsagePayload so the
 * dashboard still works during a cron outage. Edge-cached for 60s with
 * 5-min SWR (matches FIX-243 pattern).
 */

export const dynamic = "force-dynamic";

import { createAdminClient } from "@civitics/db";
import {
  updateUsage,
  verifyUsage,
  upgradeServicePlan,
  computePlatformUsagePayload,
  type PlanTier,
  type PlatformUsagePayload,
} from "@civitics/db";
import { NextResponse } from "next/server";
import { withDbTimeout } from "@/lib/supabase-check";
import {
  SNAPSHOT_STALE_MS,
  SNAPSHOT_FALLBACK_TIMEOUT_MS,
} from "../../claude/status/_lib/status-snapshot";

// platform_usage_snapshot is written by the same /api/cron/platform-snapshot
// route as status_snapshot, so it inherits the same staleness window
// (FIX-327 — bumped from 20 min to 4 h to absorb GHA cron drift).

// Edge cache: snapshot only changes every 10 min; 60s s-maxage absorbs the
// dashboard-load burst without ever serving meaningfully stale data.
const CACHE_HEADER = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

type SnapshotRow = {
  fetched_at: string;
  payload: PlatformUsagePayload;
};

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const db = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDb = db as any;

    const snapRes = await withDbTimeout<{
      data: SnapshotRow | null;
      error: { message: string } | null;
    }>(
      anyDb
        .from("platform_usage_snapshot")
        .select("fetched_at, payload")
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );

    const snapshot = snapRes?.data ?? null;
    const fresh =
      snapshot &&
      Date.now() - new Date(snapshot.fetched_at).getTime() < SNAPSHOT_STALE_MS;

    if (fresh && snapshot) {
      return NextResponse.json(snapshot.payload, {
        headers: { "Cache-Control": CACHE_HEADER },
      });
    }

    // FIX-327: cap live-compute fallback at 5 s. On timeout, serve the
    // stale snapshot if we have one; only 503 when there is no snapshot.
    const TIMEOUT = Symbol("usage-fallback-timeout");
    const result = await Promise.race<
      Awaited<ReturnType<typeof computePlatformUsagePayload>> | typeof TIMEOUT
    >([
      computePlatformUsagePayload(db),
      new Promise<typeof TIMEOUT>((resolve) =>
        setTimeout(() => resolve(TIMEOUT), SNAPSHOT_FALLBACK_TIMEOUT_MS),
      ),
    ]);
    if (result === TIMEOUT) {
      console.warn(
        "[platform/usage] live-compute fallback timed out after",
        SNAPSHOT_FALLBACK_TIMEOUT_MS,
        "ms",
        snapshot ? { fetched_at: snapshot.fetched_at, served_stale: true } : { snapshot: null },
      );
      if (snapshot) {
        return NextResponse.json(snapshot.payload, {
          headers: { "Cache-Control": CACHE_HEADER },
        });
      }
      return NextResponse.json(
        { served_stale: false, error: "snapshot unavailable" },
        { status: 503 },
      );
    }
    console.warn(
      "[platform/usage] snapshot missing or stale, served live recompute",
      snapshot ? { fetched_at: snapshot.fetched_at } : { snapshot: null },
    );
    return NextResponse.json(result.payload, {
      headers: { "Cache-Control": CACHE_HEADER },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// ── POST (admin only) ─────────────────────────────────────────────────────────

export async function POST(request: Request) {
  // Simple admin auth: X-Admin-Key header must match ADMIN_SECRET env var
  const adminKey = request.headers.get("x-admin-key");
  const adminSecret = process.env["ADMIN_SECRET"];

  if (!adminSecret || adminKey !== adminSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { action, service, metric, value, plan } = body as {
    action: string;
    service?: string;
    metric?: string;
    value?: number;
    plan?: string;
  };

  try {
    switch (action) {
      case "update_usage": {
        if (!service || !metric || value === undefined) {
          return NextResponse.json(
            { error: "service, metric, value required" },
            { status: 400 },
          );
        }
        await updateUsage(db, service, metric, value, "manual");
        return NextResponse.json({ ok: true, action: "update_usage", service, metric, value });
      }

      case "verify_usage": {
        if (!service || !metric) {
          return NextResponse.json(
            { error: "service, metric required" },
            { status: 400 },
          );
        }
        await verifyUsage(db, service, metric, "admin");
        return NextResponse.json({ ok: true, action: "verify_usage", service, metric });
      }

      case "upgrade_plan": {
        if (!service || !plan) {
          return NextResponse.json(
            { error: "service, plan required" },
            { status: 400 },
          );
        }
        await upgradeServicePlan(db, service, plan as PlanTier);
        return NextResponse.json({ ok: true, action: "upgrade_plan", service, plan });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

