/**
 * GET  /api/platform/supabase-prometheus  — Live Supabase Prometheus metrics
 *                                            (debug / force-refresh)
 * POST /api/platform/supabase-prometheus  — Admin: clear the 5-min in-memory cache
 *
 * Mirrors /api/platform/supabase. The Platform Costs card already gets fresh
 * Prometheus-sourced values via the platform-snapshot cron writing through
 * to platform_usage. This route exposes the raw helper output (egress
 * month-to-date delta, db_connections gauge, disk_used_bytes derived from
 * /data mount, plus the raw counter) for ad-hoc sanity checks.
 *
 * Never returns 500 — helper failures come back as { error } inside the payload.
 */

export const dynamic = "force-dynamic";

import {
  createAdminClient,
  getSupabasePrometheusMetrics,
  clearSupabasePrometheusCache,
} from "@civitics/db";
import { NextResponse } from "next/server";

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;
  const result = await getSupabasePrometheusMetrics(supabase);
  return NextResponse.json({
    prometheus: result,
    fetched_at: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const adminKey = request.headers.get("X-Admin-Key");
  if (adminKey !== process.env["ADMIN_SECRET"]) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  clearSupabasePrometheusCache();

  return NextResponse.json({
    success: true,
    message:
      "Supabase Prometheus cache cleared. Next /api/platform/supabase-prometheus hit will re-fetch.",
  });
}
