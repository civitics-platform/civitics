"use server";

import { cookies, headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { isDisposableEmail } from "@/lib/disposable-email";
import { checkRateLimit } from "@/lib/ratelimit";

// Neutral copy — never reveals WHICH gate tripped (a probe shouldn't learn
// whether a domain is blocklisted vs the IP/email is over-limit).
const NEUTRAL_DISPOSABLE =
  "Please use a permanent email address to sign in.";
const NEUTRAL_OVER_LIMIT =
  "Too many sign-in attempts. Please wait a few minutes and try again.";

function clientIpFrom(headerList: Headers): string {
  return (
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headerList.get("x-real-ip") ??
    "unknown"
  );
}

/**
 * FIX-568 — OTP-send preflight (server-side). The LIVE send is client-side in
 * SignInForm (the sendSignInEmail action below is currently unused), so the
 * disposable-email block + app-side send throttles can only run on a server hop:
 * SignInForm awaits this BEFORE calling supabase.auth.signInWithOtp.
 *
 * Layers, in order: (a) disposable-domain block (vendored list, no network);
 * (b) per-IP send limit (5 / 10 min) and per-email send limit (3 / hour) via the
 * FIX-570 Upstash limiter, which FAILS OPEN — an Upstash outage degrades to
 * "Supabase `[auth.rate_limit]` + Turnstile only", never blocks legitimate sign-in.
 * Supabase's native captcha + rate-limit remain the unbypassable front door; this
 * is the app-controlled belt-and-braces layer.
 */
export async function checkSignInPreflight(
  email: string,
): Promise<{ ok: boolean; error: string | null }> {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return { ok: false, error: "Enter a valid email address." };
  }

  if (isDisposableEmail(normalized)) {
    return { ok: false, error: NEUTRAL_DISPOSABLE };
  }

  const headerList = await headers();
  const ip = clientIpFrom(headerList);
  const [ipLimit, emailLimit] = await Promise.all([
    checkRateLimit("auth_send_ip", ip),
    checkRateLimit("auth_send_email", normalized),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    return { ok: false, error: NEUTRAL_OVER_LIMIT };
  }

  return { ok: true, error: null };
}

/**
 * Server Action: send a magic-link / OTP email.
 *
 * NOTE (FIX-568): currently UNUSED — SignInForm performs the send client-side.
 * It is kept (and hardened: preflight + captchaToken passthrough) so that if any
 * surface ever routes a send through here, it inherits the same gates rather
 * than being a second, unprotected send path.
 *
 * We use a plain supabase-js createClient (NOT @supabase/ssr's createServerClient)
 * because createServerClient hard-codes flowType:'pkce', which embeds a PKCE
 * challenge in the email link. That challenge needs to be stored in a cookie
 * and matched on the callback — unreliable in Next.js SSR.
 *
 * The plain createClient defaults to flowType:'implicit', so signInWithOtp
 * sends a magic link that goes through Supabase's own /auth/v1/verify endpoint,
 * then redirects back with tokens in the URL hash fragment:
 *
 *   http://localhost:3000/#access_token=xxx&...
 *
 * AuthHashHandler (in the root layout) intercepts the hash fragment and
 * redirects to /auth/callback-hash, which sets proper server-side cookies.
 *
 * We embed the post-sign-in destination as ?sign_in_next= in the emailRedirectTo
 * URL so AuthHashHandler can read it from URL params — no localStorage required.
 * The cookie fallback (/auth/confirm reads it) is kept for any token-hash flows.
 *
 * supabase/config.toml allows http://localhost:3000/** so the redirect_to URL
 * with query params is accepted by the local auth server.
 */
export async function sendSignInEmail(
  email: string,
  next?: string,
  captchaToken?: string,
): Promise<{ error: string | null }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    return { error: "Supabase environment variables are not configured." };
  }

  // Same gates as the live client path (disposable + send throttles).
  const preflight = await checkSignInPreflight(email);
  if (!preflight.ok) {
    return { error: preflight.error };
  }

  // Cookie fallback for /auth/confirm (token-hash flow).
  if (next && next.startsWith("/") && next !== "/") {
    const cookieStore = await cookies();
    cookieStore.set("sign_in_next", next, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600, // 10 minutes
      path: "/",
    });
  }

  // Build emailRedirectTo with next embedded as a URL param.
  // Supabase will use this as redirect_to after verifying the token, so
  // the user lands at e.g. http://localhost:3000/?sign_in_next=/initiatives/abc
  // AuthHashHandler reads sign_in_next from the URL and passes it to
  // /auth/callback-hash, which redirects there after setting cookies.
  const headersList = await headers();
  const origin = headersList.get("origin") ?? "";
  const emailRedirectTo =
    next && next.startsWith("/") && next !== "/" && origin
      ? `${origin}/?sign_in_next=${encodeURIComponent(next)}`
      : undefined;

  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      // flowType intentionally omitted — defaults to 'implicit' in auth-js v2
    },
  });

  // captchaToken is required by Supabase when [auth.captcha] is enabled
  // (config.toml). Passed through so this path stays valid against captcha.
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      ...(emailRedirectTo ? { emailRedirectTo } : {}),
      ...(captchaToken ? { captchaToken } : {}),
    },
  });

  return { error: error?.message ?? null };
}
