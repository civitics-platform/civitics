/**
 * FIX-1292 R7 — the status half of /api/cron/platform-snapshot.
 *
 * Runs writeStatusSnapshot alone. Fired at 22,52 by apps/civitics/vercel.json
 * for the 24 h R7 window. The usage half and the alert passes are ../usage,
 * at 7,37. The body is runPlatformSnapshot() in ../_lib; see ../route.ts for
 * the snapshot itself.
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
