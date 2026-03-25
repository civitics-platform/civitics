export const dynamic = "force-dynamic";

/**
 * POST /api/admin/run-pipeline
 *
 * Triggers a manual pipeline run from the dashboard.
 * Admin-only — requires the authenticated user's email to match ADMIN_EMAIL env var.
 *
 * Architecture: Writes a trigger to pipeline_state with the requested pipeline name
 * and a unique run_id. The standalone scheduler picks this up and executes the pipeline.
 * The dashboard polls /api/admin/run-status/[runId] for results.
 *
 * Since manual dashboard runs have no terminal, the cost gate uses the autonomous
 * auto-approve limit (max_auto_approve_usd from cost-config). The cost estimate
 * is shown to the user in the confirm dialog before they click the button.
 *
 * Body: { pipeline: string }
 * Returns: { run_id: string; status: "started" | "queued" }
 */

import { createServerClient } from "@civitics/db";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

const VALID_PIPELINES = [
  "congress",
  "regulations",
  "fec",
  "usaspending",
  "courtlistener",
  "openstates",
  "connections",
  "tag-rules",
  "tag-ai",
  "tag-industry",
  "ai-summaries",
  "nightly",
] as const;

type Pipeline = typeof VALID_PIPELINES[number];

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (supabaseUnavailable()) return unavailableResponse();
  // Auth check — must be signed in as ADMIN_EMAIL
  const adminEmail = process.env["ADMIN_EMAIL"];
  if (!adminEmail) {
    return NextResponse.json({ error: "ADMIN_EMAIL not configured" }, { status: 503 });
  }

  const supabase = createServerClient(cookies());
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.email !== adminEmail) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // Parse body
  let body: { pipeline?: string };
  try {
    body = await request.json() as { pipeline?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pipeline = body.pipeline as Pipeline | undefined;
  if (!pipeline || !VALID_PIPELINES.includes(pipeline)) {
    return NextResponse.json(
      { error: `Unknown pipeline. Valid options: ${VALID_PIPELINES.join(", ")}` },
      { status: 400 }
    );
  }

  const runId = crypto.randomUUID();
  const triggeredAt = new Date().toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = (await import("@civitics/db")).createAdminClient() as any;

  // Queue the trigger in pipeline_state — standalone scheduler picks this up
  // The trigger key includes run_id so multiple triggers don't overwrite each other
  await adminDb.from("pipeline_state").upsert(
    {
      key: `manual_trigger_${runId}`,
      value: {
        run_id:       runId,
        pipeline,
        triggered_by: user.email,
        triggered_at: triggeredAt,
        status:       "queued",
        // Dashboard runs use autonomous limit (no terminal for interactive prompts)
        autonomous:   true,
      },
      updated_at: triggeredAt,
    },
    { onConflict: "key" }
  );

  // Also write the latest trigger so the scheduler can find it efficiently
  await adminDb.from("pipeline_state").upsert(
    {
      key: "manual_trigger_latest",
      value: {
        run_id:       runId,
        pipeline,
        triggered_by: user.email,
        triggered_at: triggeredAt,
        status:       "queued",
      },
      updated_at: triggeredAt,
    },
    { onConflict: "key" }
  );

  return NextResponse.json({
    run_id:  runId,
    status:  "queued",
    message: `Pipeline '${pipeline}' queued. The standalone scheduler will pick this up within minutes.`,
  });
}

/**
 * GET /api/admin/run-pipeline?run_id=xxx
 *
 * Poll for the result of a manual pipeline run.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (supabaseUnavailable()) return unavailableResponse();
  const adminEmail = process.env["ADMIN_EMAIL"];
  if (!adminEmail) {
    return NextResponse.json({ error: "ADMIN_EMAIL not configured" }, { status: 503 });
  }

  const supabase = createServerClient(cookies());
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.email !== adminEmail) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const runId = request.nextUrl.searchParams.get("run_id");
  if (!runId) {
    return NextResponse.json({ error: "run_id required" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = (await import("@civitics/db")).createAdminClient() as any;
  const { data } = await adminDb
    .from("pipeline_state")
    .select("value")
    .eq("key", `manual_trigger_${runId}`)
    .single();

  if (!data) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json(data.value, { headers: { "Cache-Control": "no-store" } });
}
