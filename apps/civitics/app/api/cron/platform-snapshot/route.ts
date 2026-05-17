/**
 * Cron-triggered platform usage snapshot.
 *
 * Fires every 10 minutes from .github/workflows/platform-snapshot.yml, which
 * curls this endpoint with `Authorization: Bearer <CRON_SECRET>`. Vercel
 * Hobby blocks sub-daily cron expressions, so the schedule lives in GHA
 * rather than vercel.json. The auth shape is identical to the
 * Vercel-internal cron header (Bearer + CRON_SECRET), so swapping back to
 * a vercel.json entry on Pro would be a one-line change.
 *
 * Runs the full vendor-API + DB-sum aggregation that used to happen inside
 * /api/platform/usage GET on every request, and persists the result to
 * platform_usage_snapshot. The dashboard GET now reads the latest row
 * instead of recomputing.
 *
 * Returns a lightweight ack — the full payload lives in the snapshot row
 * itself; cron responses shouldn't carry the dashboard payload as well.
 */

export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient, writePlatformUsageSnapshot } from "@civitics/db";
import { sendEmail, renderKillSwitchEmail } from "@/lib/email";

const SITE_URL_FALLBACK = "https://civitics-civitics.vercel.app";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;

  if (!process.env["CRON_SECRET"] || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = createAdminClient();
    const result = await writePlatformUsageSnapshot(db);

    // FIX-288: email the admin on any auto-trip flip. Best-effort —
    // sendEmail no-ops when RESEND_API_KEY/RESEND_FROM are missing and
    // the gate is a separate per-environment toggle so a verified Resend
    // setup doesn't start paging the moment the API key is added.
    if (process.env["EMAIL_ALERTS_ENABLED"] === "true") {
      const adminEmail = process.env["ADMIN_EMAIL"];
      if (adminEmail) {
        const siteUrl = process.env["NEXT_PUBLIC_SITE_URL"] ?? SITE_URL_FALLBACK;
        const flips = result.payload.auto_trip_decisions.filter(
          (d) => d.action === "flip",
        );
        await Promise.allSettled(
          flips.map(async (d) => {
            const { subject, html } = renderKillSwitchEmail({
              switch_name: d.switch_name,
              trigger_metric: d.trigger_metric,
              trigger_value: d.trigger_value,
              threshold_pct: d.threshold_pct,
              flipped_to: false,
              source: "auto",
              flipped_at: result.payload.timestamp,
              siteUrl,
            });
            const sendResult = await sendEmail({ to: adminEmail, subject, html });
            if (!sendResult.sent) {
              console.warn(
                `[kill-switch email] not sent (${d.switch_name}): ${sendResult.reason}`,
              );
            }
          }),
        );
      }
    }

    return NextResponse.json({
      ok: true,
      fetched_at: result.payload.timestamp,
      any_critical: result.any_critical,
      any_warning: result.any_warning,
      total_overage_cost: result.total_overage_cost,
      // PR 3 (FIX-286): one-glance log signal so we don't need to query
      // kill_switch_events from the GHA workflow log to spot a flip.
      auto_trips_flipped: result.auto_trips_flipped,
      partial: result.error !== null,
      error: result.error,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
