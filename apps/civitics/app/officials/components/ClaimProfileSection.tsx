"use client";

import { useEffect, useState } from "react";

// FIX-558: "Is this you?" claim affordance on the otherwise-ISR official
// page. Per-user claim state is fetched from /api/officials/claim-status at
// request time so it never enters the SSR payload (same island pattern as
// VerifyConstituentSection on /jurisdictions/[id]).
type Status =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "active"; expiresAt: string | null }
  | { kind: "revoked" }
  | { kind: "expired" };

type Outcome =
  | { kind: "approved"; expiresAt: string | null }
  | { kind: "submitted" }
  | { kind: "error"; message: string };

const JUSTIFICATION_MAX = 1000;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "Too many attempts — try again in an hour.",
  claim_exists: "You already have a claim on file for this profile.",
  justification_required: "Please include a short note about your role.",
  justification_too_long: `Keep the note under ${JUSTIFICATION_MAX} characters.`,
};

export function ClaimProfileSection({
  officialId,
  officialName,
}: {
  officialId: string;
  officialName: string;
}) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [formOpen, setFormOpen] = useState(false);
  const [justification, setJustification] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/officials/claim-status?official_id=${officialId}`);
        if (!res.ok) {
          if (!cancelled) setStatus({ kind: "anon" });
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (!data.signedIn) setStatus({ kind: "anon" });
        else if (data.status === "pending") setStatus({ kind: "pending" });
        else if (data.status === "active")
          setStatus({ kind: "active", expiresAt: data.expiresAt });
        else if (data.status === "revoked") setStatus({ kind: "revoked" });
        else if (data.status === "expired") setStatus({ kind: "expired" });
        else setStatus({ kind: "none" });
      } catch {
        if (!cancelled) setStatus({ kind: "anon" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [officialId]);

  async function submitClaim() {
    const trimmed = justification.trim();
    if (!trimmed) {
      setOutcome({ kind: "error", message: ERROR_MESSAGES["justification_required"]! });
      return;
    }
    setSubmitting(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/officials/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ official_id: officialId, justification: trimmed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setOutcome({
          kind: "error",
          message:
            ERROR_MESSAGES[data?.error as string] ??
            "Something went wrong — please try again.",
        });
        setSubmitting(false);
        return;
      }
      if (data?.approved) {
        setOutcome({ kind: "approved", expiresAt: data.expires_at ?? null });
        setStatus({ kind: "active", expiresAt: data.expires_at ?? null });
      } else {
        setOutcome({ kind: "submitted" });
        setStatus({ kind: "pending" });
      }
      setFormOpen(false);
    } catch {
      setOutcome({ kind: "error", message: "Network error — please try again." });
    }
    setSubmitting(false);
  }

  if (status.kind === "loading") return null;

  if (status.kind === "active") {
    return (
      <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-900">
          ✓ You are verified as this official
        </p>
        <p className="mt-0.5 text-xs text-emerald-700">
          You can answer constituent questions on this page.
          {status.expiresAt && <> Verification expires {formatDate(status.expiresAt)}.</>}
        </p>
      </div>
    );
  }

  if (status.kind === "pending") {
    return (
      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
        <p className="text-sm font-semibold text-amber-900">Claim under review</p>
        <p className="mt-0.5 text-xs text-amber-700">
          Your claim on this profile is awaiting review. You&apos;ll have access
          once it&apos;s approved.
        </p>
        {outcome?.kind === "submitted" && (
          <p className="mt-1 text-xs text-amber-700">
            Submitted just now — exact-email matches approve instantly; everything
            else is reviewed by a human.
          </p>
        )}
      </div>
    );
  }

  if (status.kind === "anon") {
    return (
      <p className="mt-3 text-xs text-gray-400">
        Are you {officialName}?{" "}
        <a
          href={`/auth/sign-in?next=/officials/${officialId}`}
          className="font-medium text-indigo-500 hover:underline"
        >
          Sign in with your work email to claim this profile.
        </a>
      </p>
    );
  }

  // none / revoked / expired — claimable states
  return (
    <div className="mt-3">
      {status.kind === "revoked" && (
        <p className="mb-1 text-xs text-red-600">
          Your previous claim was declined. You can submit again with more context.
        </p>
      )}
      {status.kind === "expired" && (
        <p className="mb-1 text-xs text-gray-500">
          Your verification has expired. Re-claim the profile to restore access.
        </p>
      )}

      {!formOpen ? (
        <button
          onClick={() => setFormOpen(true)}
          className="text-xs font-medium text-indigo-600 hover:underline"
        >
          Is this you? Claim this profile →
        </button>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-sm font-semibold text-gray-900">
            Claim {officialName}&apos;s profile
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Your claim is tied to the email you signed in with. If it exactly
            matches this official&apos;s listed email, you&apos;re verified
            instantly — otherwise a reviewer takes a look. Briefly note your
            role so the reviewer has context.
          </p>
          <textarea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            maxLength={JUSTIFICATION_MAX}
            rows={3}
            placeholder="e.g. I am this official — this is my office's public profile. My work email is on my official site."
            className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={submitClaim}
              disabled={submitting || !justification.trim()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {submitting ? "Submitting…" : "Submit claim"}
            </button>
            <button
              onClick={() => {
                setFormOpen(false);
                setOutcome(null);
              }}
              disabled={submitting}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
            <span className="ml-auto text-[10px] text-gray-400 tabular-nums">
              {justification.length}/{JUSTIFICATION_MAX}
            </span>
          </div>
          {outcome?.kind === "error" && (
            <p className="mt-2 text-xs text-red-600">{outcome.message}</p>
          )}
        </div>
      )}

      {outcome?.kind === "approved" && (
        <p className="mt-2 text-xs font-medium text-emerald-700">
          ✓ Verified — your email exactly matched this official&apos;s listed email.
        </p>
      )}
    </div>
  );
}
