"use client";
// Next.js App Router requires error boundaries to be client components.
// No NavBar or data-fetching imports — this page renders when the rest of the
// app may be broken.

import { useEffect } from "react";
import { StampMark } from "./components/brand/StampMark";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    // Log to console for debugging (not to an external service in dev)
    console.error("[Civitics] Unhandled error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-lg border border-rule bg-card p-10 text-center">
        <div className="mb-6 flex justify-center text-accent">
          <StampMark size={56} />
        </div>

        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-soft">
          Unexpected fault — nothing was lost
        </p>
        <h1 className="mt-3 font-serif text-3xl font-black uppercase tracking-[0.06em] text-accent">
          Filing Error
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">
          Something went wrong while preparing this page. Try again, or head
          back to the ledger.
        </p>

        {/* Error digest — safe to show in prod, does not expose stack traces */}
        {error.digest && (
          <p className="mx-auto mt-6 inline-block border border-rule bg-paper-2 px-3 py-2 font-mono text-xs text-ink-soft">
            Error code: {error.digest}
          </p>
        )}

        <div className="mt-8 flex items-center justify-center gap-3 border-t border-rule pt-6">
          <button
            onClick={reset}
            className="bg-ink px-4 py-2 text-sm font-medium text-paper transition-colors hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Try again
          </button>
          <a
            href="/"
            className="border border-rule bg-card px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Return to the ledger →
          </a>
        </div>
      </div>
    </div>
  );
}
