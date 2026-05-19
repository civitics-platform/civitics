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
  type StatusSnapshotRow,
} from "../_lib/status-snapshot";

const SNAPSHOT_STALE_MS = 30 * 60 * 1000;

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
  if (fresh && snapshot) {
    payload = snapshot.payload;
    snapshotQueryTimeMs = snapshot.query_time_ms;
  } else {
    console.warn(
      "[status/core] snapshot missing or stale, falling back to live recompute",
      snapshot ? { fetched_at: snapshot.fetched_at } : { snapshot: null },
    );
    const live = await computeStatusPayload(db);
    payload = live.payload;
    snapshotQueryTimeMs = live.query_time_ms;
  }

  return NextResponse.json({
    meta: {
      query_time_ms: Date.now() - t0,
      snapshot_compute_ms: snapshotQueryTimeMs,
      fetched_at: fresh && snapshot ? snapshot.fetched_at : now.toISOString(),
      from_snapshot: !!(fresh && snapshot),
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
