/**
 * GET /api/claude/status/quality
 *
 * Heavier half of the dashboard health endpoint: data quality coverage,
 * self-tests (incl. Warren search, chord industry data, derived-edge drift),
 * and chord top flows. Holds the graph RPCs and semantic checks.
 *
 * Reads from status_snapshot with a 30-min staleness fallback to a live
 * computeStatusPayload recompute — same shape as /core (FIX-297). Response
 * envelope is unchanged.
 *
 * Rate limit shared with /api/claude/status and /core (60 req/hour/IP).
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
    // FIX-327: cap live-compute fallback. See /core route for context.
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
        "[status/quality] live-compute fallback timed out after",
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
        "[status/quality] snapshot missing or stale, served live recompute",
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
    quality: payload.quality,
    self_tests: payload.self_tests,
    chord: payload.chord,
  });
}
