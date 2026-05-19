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
      "[status/quality] snapshot missing or stale, falling back to live recompute",
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
    quality: payload.quality,
    self_tests: payload.self_tests,
    chord: payload.chord,
  });
}
