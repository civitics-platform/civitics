/**
 * GET  /api/platform/cloudflare  — Live Cloudflare R2 metrics (debug / force-refresh)
 * POST /api/platform/cloudflare  — Admin: clear the 5-min in-memory cache
 *
 * Mirrors /api/platform/supabase. The Operations dashboard reads aggregated
 * totals via the snapshot pipeline; this route exposes the raw helper output
 * (including per-bucket breakdown) for debugging and on-demand refresh.
 */

export const dynamic = "force-dynamic";

import {
  getCloudflareR2Usage,
  clearCloudflareUsageCache,
} from "@civitics/db";
import { NextResponse } from "next/server";

export async function GET() {
  const result = await getCloudflareR2Usage();
  return NextResponse.json({
    r2: result,
    fetched_at: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const adminKey = request.headers.get("X-Admin-Key");
  if (adminKey !== process.env["ADMIN_SECRET"]) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  clearCloudflareUsageCache();

  return NextResponse.json({
    success: true,
    message: "Cloudflare R2 cache cleared. Next /api/platform/cloudflare hit will re-fetch.",
  });
}
