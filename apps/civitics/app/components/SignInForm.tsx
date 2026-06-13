"use client";

import { useState } from "react";
import { createBrowserClient } from "@civitics/db";
import { Turnstile } from "./Turnstile";
import { checkSignInPreflight } from "../auth/actions";

interface SignInFormProps {
  /** Path to redirect to after sign-in (default: current page) */
  next?: string;
  /** Called after magic link is sent (for modal success handling) */
  onSent?: (email: string) => void;
}

type FormState = "idle" | "loading" | "sent" | "verifying" | "error";

// FIX-568: present only when provisioned. Absent (e.g. a preview env without the
// key) → widget doesn't render and the send proceeds tokenless, so the form keeps
// working. When present, Supabase's [auth.captcha] enforces the token server-side.
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

export function SignInForm({ next = "/", onSent }: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [sentEmail, setSentEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  // FIX-568: Turnstile token (managed mode usually auto-solves within ~1s).
  // `turnstileKey` remounts the widget to mint a fresh single-use token on retry.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [turnstileKey, setTurnstileKey] = useState(0);

  const captchaRequired = Boolean(TURNSTILE_SITE_KEY);

  function resetTurnstile() {
    setCaptchaToken(null);
    setTurnstileKey((k) => k + 1);
  }

  function getCallbackUrl() {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    // When Turnstile is configured, a token is required before Supabase will
    // accept the send. Managed mode normally has it ready; guard just in case.
    if (captchaRequired && !captchaToken) {
      setState("error");
      setErrorMsg("Please complete the verification, then try again.");
      return;
    }
    setState("loading");
    setErrorMsg("");

    // FIX-568 preflight (server-side): disposable-email block + per-IP/email send
    // throttle. Fails OPEN on limiter trouble; rejects with neutral copy.
    const preflight = await checkSignInPreflight(email.trim());
    if (!preflight.ok) {
      setState("error");
      setErrorMsg(preflight.error ?? "Could not send the sign-in link. Try again.");
      resetTurnstile();
      return;
    }

    const supabase = createBrowserClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: getCallbackUrl(),
        ...(captchaToken ? { captchaToken } : {}),
      },
    });

    if (error) {
      setState("error");
      setErrorMsg(error.message);
      // The token was consumed by the attempt — mint a fresh one for retry.
      resetTurnstile();
    } else {
      setSentEmail(email.trim());
      setState("sent");
      setOtpCode("");
      onSent?.(email.trim());
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    const code = otpCode.trim();
    if (code.length !== 6) return;
    setState("verifying");
    setErrorMsg("");

    const supabase = createBrowserClient();
    const { error } = await supabase.auth.verifyOtp({
      email: sentEmail,
      token: code,
      type: "email",
    });

    if (error) {
      setState("sent");
      setErrorMsg(error.message);
    } else {
      // Session cookie is now set; reload at the target so server components
      // pick up the new auth state on first paint.
      window.location.assign(next);
    }
  }

  // OAuth initiation does not flow through GoTrue's captcha-gated endpoints
  // (supabase-js signInWithOAuth has no captchaToken option), and OAuth is
  // disabled in config.toml this PR — so no token is threaded here.
  async function handleOAuth(provider: "google" | "github") {
    const supabase = createBrowserClient();
    await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: getCallbackUrl() },
    });
  }

  function reset() {
    setState("idle");
    setEmail("");
    setOtpCode("");
    setErrorMsg("");
    resetTurnstile();
  }

  if (state === "sent" || state === "verifying") {
    return (
      <div className="py-2 text-center">
        <p className="mb-3 text-3xl">✓</p>
        <p className="font-serif text-lg font-semibold text-ink">Check your email</p>
        <p className="mt-2 text-sm text-ink-soft">We sent a sign-in link and a 6-digit code to</p>
        <p className="mt-1 text-sm font-medium text-ink">{sentEmail}</p>

        <form onSubmit={handleVerifyOtp} className="mt-5 space-y-3 text-left">
          <label htmlFor="otp" className="block text-sm font-medium text-ink">
            Enter the 6-digit code
          </label>
          <input
            id="otp"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="one-time-code"
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            autoFocus
            className="w-full border-[1.5px] border-ink bg-card px-4 py-3 text-center text-lg font-mono tracking-widest text-ink placeholder:text-rule focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={state === "verifying" || otpCode.length !== 6}
            className="w-full bg-ink px-4 py-3 text-sm font-semibold text-paper transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "verifying" ? "Verifying…" : "Verify and sign in"}
          </button>
          {errorMsg && (
            <p className="text-sm text-accent">{errorMsg}</p>
          )}
        </form>

        <p className="mt-4 text-xs text-ink-soft">
          Or click the magic link in your email instead. Both expire in 1 hour.
        </p>
        <button
          onClick={reset}
          className="mt-3 text-sm text-accent underline hover:text-ink"
        >
          Wrong email? Start over
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Magic link — primary method */}
      <form onSubmit={handleMagicLink} className="space-y-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your email"
          required
          autoFocus
          className="w-full border-[1.5px] border-ink bg-card px-4 py-3 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none"
        />

        {/* FIX-568: Turnstile widget (managed/invisible). Rendered only when a
            site key is provisioned, so envs without it keep a working form. */}
        {TURNSTILE_SITE_KEY && (
          <Turnstile
            key={turnstileKey}
            siteKey={TURNSTILE_SITE_KEY}
            action="sign_in"
            onToken={setCaptchaToken}
            onExpire={() => setCaptchaToken(null)}
            // Auth must FAIL CLOSED: a widget error leaves captchaToken null so
            // the send stays blocked (the front door working as intended).
            onError={() => setCaptchaToken(null)}
          />
        )}

        <button
          type="submit"
          disabled={state === "loading" || !email.trim() || (captchaRequired && !captchaToken)}
          className="w-full bg-ink px-4 py-3 text-sm font-semibold text-paper transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === "loading" ? "Sending…" : "Send sign-in link →"}
        </button>
      </form>

      {state === "error" && (
        <p className="text-sm text-accent">
          {errorMsg || "Something went wrong. Try again."}
        </p>
      )}

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-rule" />
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft">or continue with</span>
        <div className="h-px flex-1 bg-rule" />
      </div>

      {/* OAuth — secondary methods */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => handleOAuth("google")}
          className="flex w-full items-center justify-center gap-3 border-[1.5px] border-ink bg-card px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-paper-2"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Continue with Google
        </button>

        <button
          type="button"
          onClick={() => handleOAuth("github")}
          className="flex w-full items-center justify-center gap-3 border-[1.5px] border-ink bg-card px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-paper-2"
        >
          <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
          </svg>
          Continue with GitHub
        </button>
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-ink-soft">
        No password required. No account needed to read or submit comments.
      </p>
    </div>
  );
}
