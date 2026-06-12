/**
 * Vercel cron route — nightly canary.
 *
 * Schedule: 0 2 * * * (2am UTC daily) — configured in apps/civitics/vercel.json.
 *
 * This route is a canary, not the actual scheduler. Vercel's 10s/300s function
 * timeout cannot accommodate a ~6-minute pipeline run, so the heavy lifting
 * happens in the GitHub Actions workflow `.github/workflows/nightly.yml`,
 * which runs `pnpm --filter @civitics/data data:nightly:ci` and writes
 * results to pipeline_state key 'cron_last_run'.
 *
 * What this route does: confirms Vercel's scheduler is alive by writing a
 * `triggered` row to data_sync_log and updating pipeline_state.cron_last_started.
 * If GitHub Actions fails to run, you'll see a triggered row with no matching
 * cron_last_run completion — that's the signal something's wrong.
 *
 * Security: Vercel automatically sends `Authorization: Bearer <CRON_SECRET>`
 * when CRON_SECRET is set in Vercel project env vars.
 */

export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Feature flag kill switch — set CRON_DISABLED=true to halt without a deploy
  if (process.env["CRON_DISABLED"] === "true") {
    return NextResponse.json({ skipped: true, reason: "CRON_DISABLED flag" });
  }

  // Verify this is a legitimate Vercel cron call
  const authHeader = request.headers.get("authorization");
  const expected   = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;

  if (!process.env["CRON_SECRET"] || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  let grantsExpired: number | null = null;
  let grantSweepError: string | null = null;

  try {
    const db = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDb = db as any;

    // Record cron start in pipeline_state for the dashboard
    await anyDb.from("pipeline_state").upsert(
      {
        key: "cron_last_started",
        value: {
          started_at:    startedAt.toISOString(),
          status:        "triggered",
          triggered_by:  "vercel-cron",
        },
        updated_at: startedAt.toISOString(),
      },
      { onConflict: "key" }
    );

    // Canary marker — proves Vercel's scheduler is alive. The actual nightly
    // pipeline runs in .github/workflows/nightly.yml.
    await anyDb.from("data_sync_log").insert({
      pipeline:   "nightly-sync",
      status:     "triggered",
      started_at: startedAt.toISOString(),
      metadata:   {
        triggered_by: "vercel-cron",
        schedule:     "0 2 * * *",
        runner:       "github-actions",
      },
    });
    // FIX-557: grant-expiry sweep — flips lapsed active entity_grants to
    // 'expired' (with a grant_events row each). Lives here because the Hobby
    // plan caps Vercel crons at 2 and both slots are taken. Failure is
    // reported in the payload but never fails the canary.
    const { data: expiredCount, error: sweepErr } = await anyDb.rpc(
      "expire_lapsed_grants"
    );
    if (sweepErr) {
      grantSweepError = sweepErr.message ?? "expire_lapsed_grants failed";
      console.error("[cron/nightly-sync] grant expiry sweep failed:", grantSweepError);
    } else {
      grantsExpired = typeof expiredCount === "number" ? expiredCount : 0;
    }
  } catch (err) {
    // Non-critical — log but don't fail the response
    console.error(
      "[cron/nightly-sync] failed to write trigger log:",
      err instanceof Error ? err.message : err
    );
  }

  return NextResponse.json({
    triggered:   true,
    triggeredAt: startedAt.toISOString(),
    runner:      "github-actions",
    grantsExpired,
    ...(grantSweepError ? { grantSweepError } : {}),
    note: "Canary fired. Actual nightly pipeline runs in .github/workflows/nightly.yml; results written to pipeline_state.cron_last_run.",
  });
}
