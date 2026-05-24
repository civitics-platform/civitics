/**
 * GET /api/admin/me
 *
 * Returns the admin's email if the cookie session belongs to ADMIN_EMAIL.
 * Used by the shared `useIsAdmin()` hook so client components can gate
 * admin UI without trusting any client-side flag (the previous
 * `window.CIVITICS_ADMIN` surface was read in three places but set nowhere).
 *
 * Auth: Supabase Auth session cookie; user.email must match ADMIN_EMAIL.
 *   Returns 404 (not 401/403) on auth failure so the route isn't discoverable
 *   from outside — matches the convention in /api/admin/kill-switches and
 *   /admin/pipeline-health.
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(): Promise<NextResponse> {
  const adminEmail = process.env["ADMIN_EMAIL"];
  if (!adminEmail) return notFound();

  const supabase = createServerClient(cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.email !== adminEmail) return notFound();

  return NextResponse.json({ email: user.email });
}
