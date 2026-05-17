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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env["CRON_SECRET"] ?? ""}`;

  if (!process.env["CRON_SECRET"] || authHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = createAdminClient();
    const result = await writePlatformUsageSnapshot(db);

    return NextResponse.json({
      ok: true,
      fetched_at: result.payload.timestamp,
      any_critical: result.any_critical,
      any_warning: result.any_warning,
      total_overage_cost: result.total_overage_cost,
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
