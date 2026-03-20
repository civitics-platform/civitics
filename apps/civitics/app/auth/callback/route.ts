import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@civitics/db";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const cookieStore = cookies();
    const supabase = createServerClient(cookieStore);

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Upsert user profile on sign-in
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const db = supabase as any;
          await db.from("users").upsert(
            {
              id: user.id,
              email: user.email,
              display_name: user.user_metadata?.full_name as string | undefined,
              avatar_url: user.user_metadata?.avatar_url as string | undefined,
              auth_provider:
                (user.app_metadata?.provider as string) || "email",
              last_seen: new Date().toISOString(),
            },
            { onConflict: "id", ignoreDuplicates: false }
          );
        } catch {
          // Auth still succeeds even if profile upsert fails
        }
      }

      // Redirect back to where they came from
      const redirectTo = next.startsWith("/") ? `${origin}${next}` : origin;
      return NextResponse.redirect(redirectTo);
    }
  }

  // Auth error — send back to sign-in page
  return NextResponse.redirect(`${origin}/auth/sign-in?error=auth`);
}
