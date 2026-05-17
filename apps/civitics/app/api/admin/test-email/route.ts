/**
 * GET /api/admin/test-email
 *
 * Sends a hardcoded test email to ADMIN_EMAIL via the same Resend helper the
 * kill-switch alerts use. Same auth shape as /api/admin/kill-switches —
 * Supabase Auth session, user.email must match ADMIN_EMAIL, 404 on auth
 * failure so the route isn't discoverable from outside.
 *
 * Used once during FIX-288 smoke testing; left in for future "is email
 * working?" sanity checks without having to synthetically trip a switch.
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { sendEmail, renderNotificationEmail } from "@/lib/email";

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

  const siteUrl =
    process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://civitics-civitics.vercel.app";

  const html = renderNotificationEmail({
    title: "Civitics test email",
    body: `Email delivery confirmed at ${new Date().toISOString()}. If you got this, Resend is wired up correctly.`,
    link: "/dashboard?tab=operations",
    siteUrl,
  });

  const result = await sendEmail({
    to: adminEmail,
    subject: "Civitics test email",
    html,
  });

  if (result.sent) {
    return NextResponse.json({ sent: true, id: result.id });
  }
  return NextResponse.json({ sent: false, reason: result.reason }, { status: 500 });
}
