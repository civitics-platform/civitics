/**
 * Cron-triggered platform usage + status snapshot.
 *
 * Fires every 30 minutes from the half-hourly `platform-snapshot` cron entry
 * in apps/civitics/vercel.json, which invokes this endpoint with
 * `Authorization: Bearer <CRON_SECRET>` — the same header the GHA workflow
 * used, so the move needed no protocol change here.
 *
 * FIX-1127 (2026-08-29) moved the schedule off GHA. The original reason for
 * GHA was Vercel Hobby rejecting sub-daily cron expressions; the project has
 * been on Pro since the April cutover, and GHA had stopped honouring its own
 * ten-minute schedule badly enough to matter — eight scheduled firings in 51
 * hours (mean ~6.4 h, shortest gap 3.2 h). The driver stays EXTERNAL to the
 * database on purpose: a pg_cron job that curls this route would couple the
 * tick to the health of the very database whose distress the dashboard exists
 * to show (the FIX-1120 lesson).
 *
 * .github/workflows/platform-snapshot.yml still exists — it carries the
 * request-path probe (FIX-1026), which is unrelated to this route.
 *
 * RECEIPT for the cadence claim above, since the whole point of FIX-1127 is
 * that a cron expression is not evidence: the first unattended firing after
 * the cutover landed a status_snapshot row at 2026-08-29T22:30:58Z, on the
 * :30 boundary, from deployment a82999b0 — nobody dispatched it and the GHA
 * trigger job no longer exists. Re-check the same way (a boundary row nobody
 * asked for) if this ever needs re-proving.
 *
 * Two independent writes:
 *  1. platform_usage_snapshot (FIX-281) — vendor-API + DB-sum aggregation
 *     that used to run inside /api/platform/usage on every request.
 *  2. status_snapshot (FIX-297) — 11-section /api/claude/status/* payload
 *     that used to run on every dashboard load and every status request.
 *
 * Each write is wrapped in its own try/catch so one failing doesn't block
 * the other. Returns a lightweight ack — full payloads live in the snapshot
 * rows themselves.
 *
 * FIX-1292 R7 (2026-10-10 → 10-11): the body is runPlatformSnapshot() in
 * ./_lib, and this route runs both halves through it. For one day
 * vercel.json fired ./usage (write 1 and the alert passes) at 7,37 and
 * ./status (write 2) at 22,52 instead of this path, so the ring could show
 * which half carries the half-hour swap-in burst. cc-216 read verdict (B),
 * the status half, and restored this path's half-hourly entry.
 */

export const dynamic = "force-dynamic";

import type { NextRequest, NextResponse } from "next/server";
import { runPlatformSnapshot } from "./_lib/run-platform-snapshot";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return runPlatformSnapshot(request, { half: "both" });
}
