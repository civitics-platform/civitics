"use client";

import { useEffect, useState } from "react";
import { VerifyConstituentForm } from "../../../profile/VerifyConstituentForm";

// Client island on the otherwise-static jurisdiction page. Fetches per-user
// constituent state at request time from /api/constituent-status, then renders
// one of: verified badge / verify form / sign-in prompt. The page stays
// statically renderable (ISR) because this state never enters the SSR payload.
type Status =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "unverified" }
  | { kind: "verified"; expiresAt: string | null; grantedAt: string | null };

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function VerifyConstituentSection({ jurisdictionId }: { jurisdictionId: string }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/constituent-status?jurisdiction_id=${jurisdictionId}`);
        if (!res.ok) {
          if (!cancelled) setStatus({ kind: "anon" });
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (!data.signedIn) setStatus({ kind: "anon" });
        else if (data.verified)
          setStatus({ kind: "verified", expiresAt: data.expiresAt, grantedAt: data.grantedAt });
        else setStatus({ kind: "unverified" });
      } catch {
        if (!cancelled) setStatus({ kind: "anon" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jurisdictionId]);

  if (status.kind === "loading") {
    return <div className="h-20 animate-pulse border border-rule bg-card" />;
  }

  if (status.kind === "verified") {
    return (
      <div className="border border-green-ink/25 bg-green-ink/10 p-4">
        <div className="flex items-center gap-2">
          <span className="text-green-ink">✓</span>
          <span className="text-sm font-semibold text-green-ink">Verified constituent</span>
        </div>
        <p className="mt-1 text-xs text-green-ink">
          {status.grantedAt && <>Verified {formatDate(status.grantedAt)}. </>}
          {status.expiresAt ? <>Expires {formatDate(status.expiresAt)}.</> : <>No expiry.</>}
        </p>
      </div>
    );
  }

  if (status.kind === "anon") {
    return (
      <div className="border border-rule bg-card p-4">
        <p className="text-sm text-ink-soft">
          <a href="/auth/sign-in" className="font-medium text-accent hover:underline">
            Sign in
          </a>{" "}
          to verify as a constituent of this jurisdiction.
        </p>
      </div>
    );
  }

  // unverified
  return (
    <div className="border border-rule bg-card p-4">
      <p className="mb-3 text-sm text-ink-soft">
        Verify your address to unlock constituent features for the jurisdictions you live in.
      </p>
      <VerifyConstituentForm />
    </div>
  );
}
