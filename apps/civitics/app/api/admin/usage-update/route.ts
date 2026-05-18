/**
 * POST /api/admin/usage-update
 *
 * Admin path for updating a single platform_usage row from the dashboard's
 * ManualMetricsPanel (FIX-296). Mirrors the cookie-based admin email gate
 * used by /api/admin/kill-switches rather than the X-Admin-Key shared-secret
 * pattern used by /api/platform/usage POST — admin secrets shouldn't ride in
 * the client bundle.
 *
 * Body: { service: string, metric: string, value: number }
 *
 * Auth: Supabase Auth session cookie; user.email must match ADMIN_EMAIL.
 *   Returns 404 (not 401/403) on auth failure so the route isn't discoverable
 *   from outside — matches /api/admin/kill-switches.
 *
 * Behavior: calls updateUsage() with source='manual'. updateUsage() resets
 * verified_at to null on manual writes (see packages/db/src/platform-usage.ts);
 * we then call verifyUsage() so the operator's own confirmation also serves
 * as verification — saves them clicking Verify separately. The
 * stale-after-days clock resets on every update.
 */

export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import {
  createServerClient,
  createAdminClient,
  updateUsage,
  verifyUsage,
} from "@civitics/db";

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

  let body: { service?: unknown; metric?: unknown; value?: unknown };
  try {
    body = (await request.json()) as {
      service?: unknown;
      metric?: unknown;
      value?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { service, metric, value } = body;
  if (typeof service !== "string" || typeof metric !== "string") {
    return NextResponse.json(
      { error: "service and metric must be strings" },
      { status: 400 },
    );
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return NextResponse.json(
      { error: "value must be a non-negative number" },
      { status: 400 },
    );
  }

  try {
    const db = createAdminClient();
    await updateUsage(db, service, metric, value, "manual");
    await verifyUsage(db, service, metric, user.email);

    return NextResponse.json({
      ok: true,
      service,
      metric,
      value,
      verified_at: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
