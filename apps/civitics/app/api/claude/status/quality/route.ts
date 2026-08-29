/**
 * GET /api/claude/status/quality
 *
 * Heavier half of the dashboard health endpoint: data quality coverage,
 * self-tests (sampled-official search, chord industry data, derived-edge drift,
 * pg_cron health, comment-period count sanity, search-index freshness), and
 * chord top flows. Holds the graph RPCs and semantic checks.
 *
 * Reads from status_snapshot with a SNAPSHOT_STALE_MS staleness fallback to a
 * live computeStatusPayload recompute — same shape as /core (FIX-297). That
 * threshold is 4 h and has been since FIX-327; this comment said 30 min until
 * FIX-1094. Response envelope is unchanged.
 *
 * Rate limit shared with /api/claude/status and /core (60 req/hour/IP).
 *
 * See FIX-082 for the split rationale.
 */

export const revalidate = 300;
// FIX-1120 — see /core route: explicit budget so the 30 s cold-compute cap is
// provably under the function timeout and the 503 can actually be returned.
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

  // FIX-1120: plain-promise variant. See /core route for the full mechanism.
  const snapshot = await withDbTimeoutValue(
    readStatusSnapshot(db),
    2000,
    "status/quality:snapshot",
  );

  const fresh =
    snapshot &&
    Date.now() - new Date(snapshot.fetched_at).getTime() < SNAPSHOT_STALE_MS;

  let payload;
  let snapshotQueryTimeMs: number | null = null;
  let fetchedAt: string = now.toISOString();
  let servedStale = false;
  if (snapshot) {
    // FIX-1120: stale is served as-is. The 5 s recompute race it replaced could
    // not win against an 8.9–18.8 s compute; it only delayed this same answer.
    payload = snapshot.payload;
    snapshotQueryTimeMs = snapshot.query_time_ms;
    fetchedAt = snapshot.fetched_at;
    servedStale = !fresh;
    if (!fresh) {
      console.warn("[status/quality] snapshot stale, served as-is", {
        fetched_at: snapshot.fetched_at,
      });
    }
  } else {
    // No snapshot row at all. Only path that still recomputes live, now capped
    // above the measured cost so the 503 below is genuinely reachable.
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
        "[status/quality] no snapshot and live compute timed out after",
        SNAPSHOT_COLD_COMPUTE_TIMEOUT_MS,
        "ms",
      );
      return NextResponse.json({ error: "snapshot unavailable" }, { status: 503 });
    }
    console.warn("[status/quality] no snapshot row, served live recompute");
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
    quality: payload.quality,
    self_tests: payload.self_tests,
    chord: payload.chord,
  });
}
