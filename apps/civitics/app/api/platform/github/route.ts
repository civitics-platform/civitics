/**
 * GET  /api/platform/github  — Live GitHub Actions metrics (debug / force-refresh)
 * POST /api/platform/github  — Admin: clear the 5-min in-memory cache
 *
 * Mirrors /api/platform/cloudflare. The Operations dashboard reads aggregated
 * github.action_minutes + github.storage_bytes via the snapshot pipeline;
 * this route exposes the raw helper output (including per-OS minutes
 * breakdown + paid-storage USD estimate) for debugging and on-demand refresh.
 */

export const dynamic = "force-dynamic";

import {
  getGitHubUsage,
  clearGitHubUsageCache,
} from "@civitics/db";
import { NextResponse } from "next/server";

export async function GET() {
  const result = await getGitHubUsage();
  return NextResponse.json({
    github: result,
    fetched_at: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  const adminKey = request.headers.get("X-Admin-Key");
  if (adminKey !== process.env["ADMIN_SECRET"]) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  clearGitHubUsageCache();

  return NextResponse.json({
    success: true,
    message: "GitHub usage cache cleared. Next /api/platform/github hit will re-fetch.",
  });
}
