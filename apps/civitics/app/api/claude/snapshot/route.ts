/**
 * GET /api/claude/snapshot
 *
 * Thin alias for /api/graph/snapshot that accepts entity names instead of UUIDs.
 * Maps the `entity` param → `entity_name` (fuzzy-matched internally by the snapshot route).
 *
 * Examples:
 *   /api/claude/snapshot?entity=warren
 *   /api/claude/snapshot?entity=mcconnell&viz=force
 *   /api/claude/snapshot?viz=chord
 *   /api/claude/snapshot?viz=treemap
 *   /api/claude/snapshot?entity=epa&viz=force&depth=2
 *
 * All other params are forwarded as-is to /api/graph/snapshot.
 * Rate limiting is handled by the upstream snapshot route (10 req/min/IP).
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const inUrl = new URL(request.url);
  const entity = inUrl.searchParams.get("entity");

  // Build forwarding URL to /api/graph/snapshot
  const snapshotUrl = new URL("/api/graph/snapshot", inUrl.origin);

  // Copy all params except `entity`
  for (const [key, value] of inUrl.searchParams.entries()) {
    if (key !== "entity") {
      snapshotUrl.searchParams.set(key, value);
    }
  }

  // Map entity → entity_name
  if (entity) {
    snapshotUrl.searchParams.set("entity_name", entity);
  }

  // Forward original client IP so the upstream rate limiter sees the right address
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";

  let resp: Response;
  try {
    resp = await fetch(snapshotUrl.toString(), {
      headers: {
        ...(clientIp ? { "x-forwarded-for": clientIp } : {}),
        // Prevent caching at the fetch layer
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to reach /api/graph/snapshot",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  // Stream the upstream response body back with the same status/headers
  const body = await resp.text();

  // Try to parse JSON so we can return a proper JSON response
  try {
    const json = JSON.parse(body) as unknown;
    return NextResponse.json(json, {
      status: resp.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Upstream returned non-JSON (e.g. an error page) — pass through as text
    return new NextResponse(body, {
      status: resp.status,
      headers: { "content-type": "text/plain" },
    });
  }
}
