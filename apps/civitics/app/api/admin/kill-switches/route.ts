/**
 * POST /api/admin/kill-switches
 *
 * Flip a runtime kill switch on or off.
 *
 * Body: { name: KillSwitchName, enabled: boolean }
 *
 * Auth: Supabase Auth session cookie; user.email must match ADMIN_EMAIL.
 *   Returns 404 (not 401/403) on auth failure so the route isn't discoverable
 *   from outside — matches the convention in /admin/pipeline-health.
 *
 * After the flip succeeds, the helper busts its 30s module cache so the
 * Vercel function instance that handled the POST sees the new value
 * immediately. Other instances pick it up on their next cache tick. Layered
 * env-var override (env=false > DB=false > on) means the env var still wins
 * — flipping a DB switch on while CRON_DISABLED=true / AI_SUMMARIES_ENABLED=false
 * is a no-op until the env var is also cleared.
 */

export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import {
  createServerClient,
  createAdminClient,
  setKillSwitch,
  type KillSwitchName,
} from "@civitics/db";
import { sendEmail, renderKillSwitchEmail } from "@/lib/email";

const SITE_URL_FALLBACK = "https://civitics-civitics.vercel.app";

const ALLOWED_NAMES: ReadonlyArray<KillSwitchName> = [
  "ai_summaries",
  "ai_narrative",
  "ai_tagger",
  "connection_graph_live",
  "cron",
];

function isAllowedName(s: unknown): s is KillSwitchName {
  return typeof s === "string" && (ALLOWED_NAMES as readonly string[]).includes(s);
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const adminEmail = process.env["ADMIN_EMAIL"];
  if (!adminEmail) return notFound();

  const supabase = createServerClient(cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.email !== adminEmail) return notFound();

  let body: { name?: unknown; enabled?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; enabled?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isAllowedName(body.name)) {
    return NextResponse.json(
      { error: `name must be one of: ${ALLOWED_NAMES.join(", ")}` },
      { status: 400 },
    );
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }

  try {
    const db = createAdminClient();
    const { event_id, flipped_at } = await setKillSwitch(
      db,
      body.name,
      body.enabled,
    );

    // FIX-288: notify admin on manual flips. Auto-trips are handled by the
    // cron route's own email fan-out. Fire-and-forget — email failure logs
    // a warning but never blocks the flip response (audit is best-effort,
    // same posture as the kill_switch_events insert).
    if (
      process.env["EMAIL_ALERTS_ENABLED"] === "true" &&
      adminEmail
    ) {
      const siteUrl = process.env["NEXT_PUBLIC_SITE_URL"] ?? SITE_URL_FALLBACK;
      const { subject, html } = renderKillSwitchEmail({
        switch_name: body.name,
        trigger_metric: null,
        trigger_value: null,
        threshold_pct: null,
        flipped_to: body.enabled,
        source: "manual",
        flipped_at: flipped_at ?? new Date().toISOString(),
        siteUrl,
      });
      const sendResult = await sendEmail({ to: adminEmail, subject, html });
      if (!sendResult.sent) {
        console.warn(
          `[kill-switch email] manual flip not sent (${body.name}): ${sendResult.reason}`,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      name: body.name,
      enabled: body.enabled,
      // PR 3 (FIX-287): event_id lets the browser reflect the new banner
      // entry immediately without a full page refresh. Null if the
      // kill_switch_events insert failed (audit is best-effort, the flip
      // itself stands).
      event_id,
      flipped_at,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
