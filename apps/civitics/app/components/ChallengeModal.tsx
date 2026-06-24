"use client";

// FIX-576: visible Turnstile challenge modal, mounted once at the app root.
//
// Stays dormant until `challengedFetch`'s managed (invisible, off-screen)
// attempt escalates to an *interactive* challenge that an off-screen widget
// can't complete. The fetch layer then calls `requestInteractiveChallenge()`
// (via the challenge-controller bridge), which opens this modal with a visible,
// solvable widget; on solve we return the token for the fetch layer's single
// replay and close. Dismiss / error / no site key → resolve `null` → the write
// surfaces its original 403, i.e. today's behavior. The common auto-solve case
// never opens this modal, so no friction is added to the 95% path.
//
// Copy is deliberately neutral (brand rule: no karma/tier/trust language) — the
// challenge is an access-rate control, never a judgment of the user.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Turnstile } from "./Turnstile";
import { setChallengeOpener } from "@/lib/challenge-controller";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

export function ChallengeModal() {
  const [open, setOpen] = useState(false);
  // Bump on each open so <Turnstile> remounts and mints a fresh single-use token.
  const [nonce, setNonce] = useState(0);
  const resolverRef = useRef<((token: string | null) => void) | null>(null);

  // Resolve the pending request exactly once, then close.
  const settle = useCallback((token: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    resolve?.(token);
  }, []);

  // Register with the controller so challengedFetch can open us. No site key →
  // never register, so requestInteractiveChallenge() resolves null (fail-safe).
  useEffect(() => {
    if (!SITE_KEY) return;
    setChallengeOpener((resolve) => {
      // One challenge at a time; reject overlapping requests fail-safe.
      if (resolverRef.current) {
        resolve(null);
        return;
      }
      resolverRef.current = resolve;
      setNonce((n) => n + 1);
      setOpen(true);
    });
    return () => {
      setChallengeOpener(null);
      // Release any in-flight waiter if we unmount mid-challenge.
      if (resolverRef.current) settle(null);
    };
  }, [settle]);

  // Escape == dismiss.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, settle]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !SITE_KEY || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) settle(null);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Quick check"
    >
      <div className="relative w-full max-w-sm border-2 border-ink bg-card p-6 shadow-[0_14px_30px_rgba(28,26,22,0.18)]">
        <button
          onClick={() => settle(null)}
          className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center text-ink-soft transition-colors hover:bg-paper-2 hover:text-ink"
          aria-label="Close"
        >
          ✕
        </button>

        <div className="mb-4 text-center">
          <h2 className="font-serif text-lg font-semibold text-ink">Quick check</h2>
          <p className="mt-1 text-xs text-ink-soft">Confirm you’re human to post.</p>
        </div>

        <div className="flex min-h-[70px] justify-center">
          <Turnstile
            key={nonce}
            siteKey={SITE_KEY}
            action="content-write"
            onToken={(token) => settle(token)}
            onError={() => settle(null)}
            onExpire={() => setNonce((n) => n + 1)}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
