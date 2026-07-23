import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@civitics/db";
import type { CookieStore } from "@civitics/db";
import { recordAbuseEvent } from "@/lib/abuse-events";

// Handles email confirmation via token_hash (alternative to PKCE code flow).
// Supabase uses this for magic links in some configurations and for
// email change confirmations.

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = searchParams.get("next") ?? "/";

  if (token_hash && type) {
    const cookieStore = await cookies();

    // Same buffering pattern as /auth/callback — cookies() is read-only in
    // Route Handlers; collect what Supabase wants to set and apply to response.
    const pending: Parameters<NonNullable<CookieStore["setAll"]>>[0] = [];

    const adapter: CookieStore = {
      getAll: () => cookieStore.getAll(),
      setAll: (c) => pending.push(...c),
    };

    const supabase = createServerClient(adapter);
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash,
      type: type as "email" | "recovery" | "invite" | "email_change" | "signup",
    });

    if (!error) {
      // FIX-880: observe-only sign-in landing. Never blocks or fails the flow.
      await recordAbuseEvent({
        action: "auth_callback",
        headers: request.headers,
        userId: data.user?.id ?? null,
        meta: { route: "confirm" },
      });

      const redirectTo = next.startsWith("/") ? `${origin}${next}` : origin;
      const response = NextResponse.redirect(redirectTo);

      // Apply the buffered session cookies to the redirect response
      pending.forEach(({ name, value, options }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response.cookies.set(name, value, options as any);
      });

      return response;
    }
  }

  return NextResponse.redirect(`${origin}/auth/sign-in?error=auth`);
}
