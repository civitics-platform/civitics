/**
 * FIX-1292 R7 — the status half of /api/cron/platform-snapshot.
 *
 * Runs writeStatusSnapshot alone. apps/civitics/vercel.json fired it at 22,52
 * for the R7 day (2026-10-10 → 10-11); since cc-216's revert no cron fires
 * it. The usage half and the alert passes are ../usage. The body is
 * runPlatformSnapshot() in ../_lib; see ../route.ts for the snapshot itself.
 *
 * maxDuration 300 is Vercel's fluid-compute default, which the parent runs
 * under with no export of its own. The half's wall is 10–50 s
 * (status_snapshot.query_time_ms).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

import type { NextRequest, NextResponse } from "next/server";
import { runPlatformSnapshot } from "../_lib/run-platform-snapshot";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return runPlatformSnapshot(request, { half: "status" });
}
