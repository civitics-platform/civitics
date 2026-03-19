"use client";

import { useState } from "react";
import { createBrowserClient } from "@civitics/db";

interface SignInFormProps {
  /** Path to redirect to after sign-in (default: current page) */
  next?: string;
  /** Called after magic link is sent (for modal success handling) */
  onSent?: (email: string) => void;
}

type FormState = "idle" | "loading" | "sent" | "error";

export function SignInForm({ next = "/", onSent }: SignInFormProps) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [sentEmail, setSentEmail] = useState("");

  function getCallbackUrl() {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setState("loading");
    setErrorMsg("");

    const supabase = createBrowserClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: getCallbackUrl() },
    });

    if (error) {
      setState("error");
      setErrorMsg(error.message);
    } else {
      setSentEmail(email.trim());
      setState("sent");
      onSent?.(email.trim());
    }
  }

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
    setErrorMsg("");
  }

  if (state === "sent") {
    return (
      <div className="py-2 text-center">
        <p className="mb-3 text-3xl">✓</p>
        <p className="text-base font-semibold text-gray-900">Check your email</p>
        <p className="mt-2 text-sm text-gray-500">We sent a sign-in link to</p>
        <p className="mt-1 text-sm font-medium text-gray-900">{sentEmail}</p>
        <p className="mt-3 text-sm text-gray-500 leading-relaxed">
          Click the link in your email to sign in. It expires in 1 hour.
        </p>
        <button
          onClick={reset}
          className="mt-4 text-sm text-indigo-600 underline hover:text-indigo-700"
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
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={state === "loading" || !email.trim()}
          className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === "loading" ? "Sending…" : "Send sign-in link →"}
        </button>
      </form>

      {state === "error" && (
        <p className="text-sm text-red-600">
          {errorMsg || "Something went wrong. Try again."}
        </p>
      )}

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-200" />
        <span className="text-xs text-gray-400">or continue with</span>
        <div className="h-px flex-1 bg-gray-200" />
      </div>

      {/* OAuth — secondary methods */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => handleOAuth("google")}
          className="flex w-full items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
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
          className="flex w-full items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
          </svg>
          Continue with GitHub
        </button>
      </div>

      {/* Footer note */}
      <p className="text-center text-xs text-gray-400">
        No password required. No account needed to read or submit comments.
      </p>
    </div>
  );
}
