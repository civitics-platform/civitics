/**
 * GET /api/claude/status/core
 *
 * Lightweight half of the dashboard health endpoint: counts, pipeline state,
 * AI budget, activity, resource warnings, officials breakdown. No graph RPCs,
 * no semantic checks — see /api/claude/status/quality for those.
 *
 * Reads the latest row from status_snapshot (populated every 10 min by
 * /api/cron/platform-snapshot, FIX-297). When the snapshot is missing or older
 * than SNAPSHOT_STALE_MS, falls back to a live recompute via
 * computeStatusPayload so the dashboard still works during a cron outage. That
 * threshold is 4 h and has been since FIX-327 — this comment said "30 min
 * (three missed cron ticks)" until FIX-1094 corrected it. Response shape is
 * unchanged so DashboardClient + useDashboardData continue to work without
 * modification.
 *
 * Rate limit shared with /api/claude/status and /quality (60 req/hour/IP).
 *
 * See FIX-082 for the split rationale.
 */

export const revalidate = 300;
// FIX-1120 — the cold-start recompute below is capped at
// SNAPSHOT_COLD_COMPUTE_TIMEOUT_MS (30 s). Declare the function budget
// explicitly so that cap is provably under it and the 503 is reachable,
// rather than depending on whatever Vercel's project-level default happens
// to be. Only the no-snapshot-at-all path can run that long.
export const maxDuration = 60;

import { createAdminClient } from "@civitics/db";
import { NextResponse } from "next/server";
import { getIp, rateOk } from "../_lib/ratelimit";
import { withDbTimeoutValue } from "@/lib/supabase-check";
import {
  computeStatusPayload,
  readStatusSnapshot,
  SNAPSHOT_STALE_MS,
  SNAPSHOT_COLD_COMPUTE_TIMEOUT_MS,
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

  // FIX-1120: withDbTimeoutValue, not withDbTimeout — readStatusSnapshot is a
  // plain promise, already unwrapped. The builder-shaped wrapper's timeout
  // sentinel was truthy here, which made `fresh` NaN-false, forced a
  // guaranteed-to-lose recompute race, and then walked past `if (!snapshot)`
  // into a TypeError on payload.version — a 500 where a 503 was written.
  const snapshot = await withDbTimeoutValue(
    readStatusSnapshot(db),
    2000,
    "status/core:snapshot",
  );

  const fresh =
    snapshot &&
    Date.now() - new Date(snapshot.fetched_at).getTime() < SNAPSHOT_STALE_MS;

  let payload;
  let snapshotQueryTimeMs: number | null = null;
  let fetchedAt: string = now.toISOString();
  let servedStale = false;
  if (snapshot) {
    // FIX-1120: a stale snapshot is served immediately. It used to race a live
    // recompute capped at 5 s first — but computeStatusPayload measurably costs
    // 8.9–18.8 s on prod, so that race could only ever end in this same branch,
    // 5 s later. Removing it costs nothing and saves the 5 s.
    payload = snapshot.payload;
    snapshotQueryTimeMs = snapshot.query_time_ms;
    fetchedAt = snapshot.fetched_at;
    servedStale = !fresh;
    if (!fresh) {
      console.warn("[status/core] snapshot stale, served as-is", {
        fetched_at: snapshot.fetched_at,
      });
    }
  } else {
    // No snapshot row at all — cold start, or the read itself timed out. This
    // is the only path that still recomputes live, and its cap is now above
    // the measured cost rather than below it, so the timeout means "genuinely
    // could not build a payload" and the 503 is the honest answer.
    const TIMEOUT = Symbol("status-cold-compute-timeout");
    const result = await Promise.race<
      Awaited<ReturnType<typeof computeStatusPayload>> | typeof TIMEOUT
    >([
      computeStatusPayload(db),
      new Promise<typeof TIMEOUT>((resolve) =>
        setTimeout(() => resolve(TIMEOUT), SNAPSHOT_COLD_COMPUTE_TIMEOUT_MS),
      ),
    ]);
    if (result === TIMEOUT) {
      console.warn(
        "[status/core] no snapshot and live compute timed out after",
        SNAPSHOT_COLD_COMPUTE_TIMEOUT_MS,
        "ms",
      );
      return NextResponse.json({ error: "snapshot unavailable" }, { status: 503 });
    }
    console.warn("[status/core] no snapshot row, served live recompute");
    payload = result.payload;
    snapshotQueryTimeMs = result.query_time_ms;
  }

  const snapshotAgeMinutes = snapshot
    ? Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 60_000)
    : null;

  return NextResponse.json({
    meta: {
      query_time_ms: Date.now() - t0,
      snapshot_compute_ms: snapshotQueryTimeMs,
      fetched_at: fetchedAt,
      from_snapshot: !!snapshot,
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
    // FIX-090 — the stat-card sparkline series. Rides on /core because the
    // cards it garnishes are core's own `database` figures; putting it on
    // /quality would make the hero row wait on the slower of the two calls.
    // Undefined on any snapshot written before this shipped — the client treats
    // absence as "draw no sparkline".
    daily_counts: payload.daily_counts,
  });
}
