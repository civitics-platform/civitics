import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@civitics/db";
import type { CookieStore } from "@civitics/db";
import { recordAbuseEvent } from "@/lib/abuse-events";

/**
 * Handles implicit-flow auth redirects where tokens are in the URL hash.
 *
 * When Supabase sends a magic link via the implicit flow:
 *   http://localhost:3000/#access_token=xxx&refresh_token=xxx&type=magiclink
 *
 * The client-side AuthHashHandler redirects here with the tokens as query params,
 * so this server route can verify the session and set proper auth cookies.
 *
 * Usage: GET /auth/callback-hash?access_token=xxx&refresh_token=xxx&next=/
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const accessToken = searchParams.get("access_token");
  const refreshToken = searchParams.get("refresh_token");
  const next = searchParams.get("next") ?? "/";

  if (!accessToken) {
    // No token — redirect to sign-in
    return NextResponse.redirect(`${origin}/auth/sign-in?error=missing-token`);
  }

  const cookieStore = await cookies();
  const pending: Parameters<NonNullable<CookieStore["setAll"]>>[0] = [];

  const adapter: CookieStore = {
    getAll: () => cookieStore.getAll(),
    setAll: (c) => pending.push(...c),
  };

  const supabase = createServerClient(adapter);

  // Set the session from the tokens — this triggers cookie generation
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken || "",
  });

  if (error) {
    console.error("callback-hash: setSession error:", error);
    return NextResponse.redirect(`${origin}/auth/sign-in?error=invalid-token`);
  }

  // Upsert user profile row on first sign-in
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("users").upsert(
        {
          id: user.id,
          email: user.email,
          display_name:
            (user.user_metadata?.full_name as string) || undefined,
          avatar_url: (user.user_metadata?.avatar_url as string) || undefined,
          auth_provider: (user.app_metadata?.provider as string) || "email",
          last_seen: new Date().toISOString(),
        },
        { onConflict: "id", ignoreDuplicates: false }
      );
    } catch {
      // Auth still succeeds even if profile upsert fails
    }
  }

  // FIX-880: observe-only sign-in landing. Never blocks or fails the auth flow.
  await recordAbuseEvent({
    action: "auth_callback",
    headers: request.headers,
    userId: user?.id ?? null,
    meta: { route: "callback_hash" },
  });

  // Build redirect response with auth cookies
  const redirectTo = next.startsWith("/") ? `${origin}${next}` : origin;
  const response = NextResponse.redirect(redirectTo);

  // Apply the buffered session cookies to the redirect response
  pending.forEach(({ name, value, options }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response.cookies.set(name, value, options as any);
  });

  return response;
}
