import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@civitics/db";
import type { CookieStore } from "@civitics/db";
import { recordAbuseEvent } from "@/lib/abuse-events";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const cookieStore = await cookies();

    // Collect cookies Supabase wants to set during session exchange.
    // cookies() from next/headers is read-only in Route Handlers — we can't
    // call .setAll() on it directly. Instead we buffer them here and apply
    // them to the NextResponse before returning.
    const pending: Parameters<NonNullable<CookieStore["setAll"]>>[0] = [];

    const adapter: CookieStore = {
      getAll: () => cookieStore.getAll(),
      setAll: (c) => pending.push(...c),
    };

    const supabase = createServerClient(adapter);
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Upsert user profile row on first sign-in
      const { data: { user } } = await supabase.auth.getUser();

      if (user) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any).from("users").upsert(
            {
              id:            user.id,
              email:         user.email,
              display_name:  user.user_metadata?.full_name as string | undefined,
              avatar_url:    user.user_metadata?.avatar_url as string | undefined,
              auth_provider: (user.app_metadata?.provider as string) || "email",
              last_seen:     new Date().toISOString(),
            },
            { onConflict: "id", ignoreDuplicates: false }
          );
        } catch {
          // Auth still succeeds even if profile upsert fails
        }
      }

      // FIX-880: observe-only sign-in landing (the highest-value, lowest-volume
      // linkage record). Never blocks or fails the auth flow.
      await recordAbuseEvent({
        action: "auth_callback",
        headers: request.headers,
        userId: user?.id ?? null,
        meta: { route: "callback" },
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

  // Auth error — send back to sign-in page
  return NextResponse.redirect(`${origin}/auth/sign-in?error=auth`);
}
