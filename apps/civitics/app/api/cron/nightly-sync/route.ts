/**
 * Vercel cron route — nightly data sync trigger.
 *
 * Schedule: 0 2 * * * (2am UTC daily) — configured in /vercel.json
 *
 * Security: CRON_SECRET header checked against Authorization header.
 * Vercel automatically sends the Authorization header for cron jobs.
 *
 * Architecture: This route records the cron trigger in pipeline_state and
 * data_sync_log. The standalone scheduler (packages/data/src/scheduler.ts)
 * picks up the trigger and calls runNightlySync() which records results back
 * to pipeline_state key 'cron_last_run' for the dashboard.
 *
 * Autonomous mode: Sets process.env.AUTONOMOUS=true so the cost gate skips
 * terminal prompts and uses pre-configured rules (see cost-config.ts autonomous section).
 *
 * Required env vars:
 *   CRON_SECRET — generate with: openssl rand -hex 32
 *                 Add to .env.local and Vercel dashboard.
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

  // Tell the cost gate we are in autonomous/cron mode.
  // The standalone scheduler process reads this when it picks up the trigger.
  process.env["AUTONOMOUS"] = "true";

  const startedAt = new Date();

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

    // Record the trigger in data_sync_log so the scheduler knows a run is due
    await anyDb.from("data_sync_log").insert({
      pipeline_name: "nightly-sync",
      status:        "triggered",
      started_at:    startedAt.toISOString(),
      metadata:      {
        triggered_by: "vercel-cron",
        schedule:     "0 2 * * *",
        autonomous:   true,
      },
    });
  } catch (err) {
    // Non-critical — log but don't fail the response
    console.error(
      "[cron/nightly-sync] failed to write trigger log:",
      err instanceof Error ? err.message : err
    );
  }

  return NextResponse.json({
    triggered:    true,
    triggeredAt:  startedAt.toISOString(),
    autonomous:   true,
    note: "Nightly sync triggered. Scheduler picks it up within minutes. Results written to pipeline_state.cron_last_run.",
  });
}
