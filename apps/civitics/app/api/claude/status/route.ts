/**
 * GET /api/claude/status
 *
 * Platform health diagnostic endpoint. No auth required — all civic data is public.
 * Runs all sections in parallel for speed. Target: under 2 seconds.
 *
 * Rate limit: 60 requests/hour/IP (in-memory, resets on cold start), shared with
 * /api/claude/status/core and /api/claude/status/quality.
 * Never returns 500 — always 200 with whatever data is available.
 * Sections that error are marked { error: string; partial: true }.
 *
 * This route returns the full union of /core + /quality. Kept for backward
 * compatibility with curl/monitoring callers; the dashboard hits /core and
 * /quality directly. See FIX-082.
 */

export const revalidate = 300;

import { createAdminClient } from "@civitics/db";
import { NextResponse } from "next/server";
import { getIp, rateOk } from "./_lib/ratelimit";
import {
  type Db,
  section,
  getVersion,
  getDatabase,
  getConnectionTypes,
  getPipelines,
  getAiCosts,
  getQuality,
  getSelfTests,
  getChord,
  getActivity,
  getResourceWarnings,
  getOfficialsBreakdown,
} from "./_lib/sections";

export async function GET(request: Request) {
  const ip = getIp(request);
  if (!rateOk(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded — 60 requests per hour per IP" },
      { status: 429 },
    );
  }

  const t0 = Date.now();
  const db = createAdminClient() as Db;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [
    version,
    database,
    connectionTypes,
    pipelines,
    aiCosts,
    quality,
    selfTests,
    chordSection,
    activitySection,
    resourceWarnings,
    officialsBreakdown,
  ] = await Promise.all([
    section(() => getVersion(db)),
    section(() => getDatabase(db, yesterday)),
    section(() => getConnectionTypes(db)),
    section(() => getPipelines(db)),
    section(() => getAiCosts(db, monthStart)),
    section(() => getQuality(db)),
    section(() => getSelfTests(db)),
    section(() => getChord(db)),
    section(() => getActivity(db, 7)),
    section(() => getResourceWarnings(db)),
    section(() => getOfficialsBreakdown(db)),
  ]);

  const query_time_ms = Date.now() - t0;

  return NextResponse.json({
    meta: {
      query_time_ms,
      timestamp: now.toISOString(),
    },
    version,
    database,
    connection_types: connectionTypes,
    pipelines,
    ai_costs: aiCosts,
    quality,
    self_tests: selfTests,
    chord: chordSection,
    activity: activitySection,
    resource_warnings: resourceWarnings,
    officials_breakdown: officialsBreakdown,
  });
}
