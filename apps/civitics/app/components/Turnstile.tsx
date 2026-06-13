"use client";

// FIX-568: reusable Cloudflare Turnstile widget — raw script-tag integration, no
// npm dependency (the script is loaded once, lazily, and cached across mounts).
// Managed/invisible mode (`appearance: interaction-only`) keeps human friction
// near-zero. Used by SignInForm (auth front door) and reused by the FIX-569
// first-writes content challenge.
//
// Tokens are SINGLE-USE: after a token is consumed by a submit, remount the
// widget (change its React `key`) to mint a fresh one for any retry.

import { useEffect, useRef } from "react";

interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  "timeout-callback"?: () => void;
  action?: string;
  theme?: "auto" | "light" | "dark";
  size?: "normal" | "flexible" | "compact";
  appearance?: "always" | "execute" | "interaction-only";
}

declare global {
  interface Window {
    turnstile?: {
      render: (el: string | HTMLElement, opts: TurnstileRenderOptions) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

// Load the Turnstile script exactly once per page; subsequent mounts reuse it.
function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("turnstile load failed")));
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("turnstile load failed"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface TurnstileProps {
  siteKey: string;
  /** Receives a fresh verification token (managed mode usually auto-solves). */
  onToken: (token: string) => void;
  /** Token expired (single-use / TTL) — clear any cached token here. */
  onExpire?: () => void;
  /** Script or challenge failed — the caller should fail OPEN for non-auth uses. */
  onError?: () => void;
  /** Optional Turnstile action label for analytics/segmentation. */
  action?: string;
  className?: string;
}

export function Turnstile({
  siteKey,
  onToken,
  onExpire,
  onError,
  action,
  className,
}: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Hold the latest callbacks in a ref so re-renders don't re-mint the widget.
  const callbacksRef = useRef({ onToken, onExpire, onError });
  callbacksRef.current = { onToken, onExpire, onError };

  useEffect(() => {
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        if (widgetIdRef.current) return; // guard against double-render in StrictMode
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          appearance: "interaction-only",
          callback: (token) => callbacksRef.current.onToken(token),
          "expired-callback": () => callbacksRef.current.onExpire?.(),
          "error-callback": () => callbacksRef.current.onError?.(),
        });
      })
      .catch(() => callbacksRef.current.onError?.());

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* widget already gone — noop */
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, action]);

  return <div ref={containerRef} className={className} />;
}
