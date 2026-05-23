/**
 * GET /api/claude/status/core
 *
 * Lightweight half of the dashboard health endpoint: counts, pipeline state,
 * AI budget, activity, resource warnings, officials breakdown. No graph RPCs,
 * no semantic checks — see /api/claude/status/quality for those.
 *
 * Reads the latest row from status_snapshot (populated every 10 min by
 * /api/cron/platform-snapshot, FIX-297). When the snapshot is missing or
 * older than 30 min (three missed cron ticks), falls back to a live recompute
 * via computeStatusPayload so the dashboard still works during a cron
 * outage. Response shape is unchanged so DashboardClient + useDashboardData
 * continue to work without modification.
 *
 * Rate limit shared with /api/claude/status and /quality (60 req/hour/IP).
 *
 * See FIX-082 for the split rationale.
 */

export const revalidate = 300;

import { createAdminClient } from "@civitics/db";
import { NextResponse } from "next/server";
import { getIp, rateOk } from "../_lib/ratelimit";
import { withDbTimeout } from "@/lib/supabase-check";
import {
  computeStatusPayload,
  readStatusSnapshot,
  SNAPSHOT_STALE_MS,
  SNAPSHOT_FALLBACK_TIMEOUT_MS,
  type StatusSnapshotRow,
} from "../_lib/status-snapshot";

export async function GET(request: Request) {
  const ip = getIp(request);
  if (!rateOk(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded — 60 requests per hour per IP" },
      { status: 429 },
    );
  }

  const t0 = Date.now();
  const db = createAdminClient();
  const now = new Date();

  const snapshot = await withDbTimeout<StatusSnapshotRow | null>(
    readStatusSnapshot(db),
    2000,
  );

  const fresh =
    snapshot &&
    Date.now() - new Date(snapshot.fetched_at).getTime() < SNAPSHOT_STALE_MS;

  let payload;
  let snapshotQueryTimeMs: number | null = null;
  let fetchedAt: string = now.toISOString();
  let servedStale = false;
  if (fresh && snapshot) {
    payload = snapshot.payload;
    snapshotQueryTimeMs = snapshot.query_time_ms;
    fetchedAt = snapshot.fetched_at;
  } else {
    // FIX-327: cap live-compute fallback. On timeout, fall back to the
    // last-known-good snapshot (served_stale=true) rather than hanging the
    // request for 30+ seconds.
    const TIMEOUT = Symbol("status-fallback-timeout");
    const result = await Promise.race<
      Awaited<ReturnType<typeof computeStatusPayload>> | typeof TIMEOUT
    >([
      computeStatusPayload(db),
      new Promise<typeof TIMEOUT>((resolve) =>
        setTimeout(() => resolve(TIMEOUT), SNAPSHOT_FALLBACK_TIMEOUT_MS),
      ),
    ]);
    if (result === TIMEOUT) {
      console.warn(
        "[status/core] live-compute fallback timed out after",
        SNAPSHOT_FALLBACK_TIMEOUT_MS,
        "ms",
        snapshot ? { fetched_at: snapshot.fetched_at, served_stale: true } : { snapshot: null },
      );
      if (!snapshot) {
        return NextResponse.json(
          { error: "snapshot unavailable" },
          { status: 503 },
        );
      }
      payload = snapshot.payload;
      snapshotQueryTimeMs = snapshot.query_time_ms;
      fetchedAt = snapshot.fetched_at;
      servedStale = true;
    } else {
      console.warn(
        "[status/core] snapshot missing or stale, served live recompute",
        snapshot ? { fetched_at: snapshot.fetched_at } : { snapshot: null },
      );
      payload = result.payload;
      snapshotQueryTimeMs = result.query_time_ms;
    }
  }

  const snapshotAgeMinutes =
    fresh || servedStale
      ? Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 60_000)
      : null;

  return NextResponse.json({
    meta: {
      query_time_ms: Date.now() - t0,
      snapshot_compute_ms: snapshotQueryTimeMs,
      fetched_at: fetchedAt,
      from_snapshot: !!(fresh && snapshot) || servedStale,
      snapshot_age_minutes: snapshotAgeMinutes,
      served_stale: servedStale,
      timestamp: now.toISOString(),
    },
    version: payload.version,
    database: payload.database,
    connection_types: payload.connection_types,
    pipelines: payload.pipelines,
    ai_costs: payload.ai_costs,
    activity: payload.activity,
    resource_warnings: payload.resource_warnings,
    officials_breakdown: payload.officials_breakdown,
  });
}
