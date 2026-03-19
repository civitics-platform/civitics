import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@civitics/db";

// Handles email confirmation via token_hash (alternative to PKCE code flow).
// Supabase uses this for magic links in some configurations and for
// email change confirmations.

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = searchParams.get("next") ?? "/";

  if (token_hash && type) {
    const cookieStore = cookies();
    const supabase = createServerClient(cookieStore);

    const { error } = await supabase.auth.verifyOtp({
      token_hash,
      // EmailOtpType covers magic link, signup, recovery, invite, email_change
      type: type as "email" | "recovery" | "invite" | "email_change" | "signup",
    });

    if (!error) {
      const redirectTo = next.startsWith("/") ? `${origin}${next}` : origin;
      return NextResponse.redirect(redirectTo);
    }
  }

  return NextResponse.redirect(`${origin}/auth/sign-in?error=auth`);
}
