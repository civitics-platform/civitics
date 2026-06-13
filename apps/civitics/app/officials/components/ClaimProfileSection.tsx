"use client";

import { useEffect, useState } from "react";
import { StampMark } from "../../components/brand/StampMark";

// Desk-mockup `.stampb` badge idiom (FIX-564): bordered, letterspaced mono
// caps. Green-ink = verified/claimed, accent red = pending/action-needed.
const STAMPB =
  "inline-flex items-center gap-1.5 rounded-[2px] border-[1.5px] px-2.5 py-1 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em]";

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
      <div className="mt-4 border border-green-ink/30 bg-green-ink/5 px-4 py-3">
        <span className={`${STAMPB} border-green-ink text-green-ink`}>
          <StampMark size={12} />
          Official — Claimed
        </span>
        <p className="mt-2 text-xs text-ink-soft">
          You are verified as this official. You can answer constituent questions on this page.
          {status.expiresAt && <> Verification expires {formatDate(status.expiresAt)}.</>}
        </p>
      </div>
    );
  }

  if (status.kind === "pending") {
    return (
      <div className="mt-4 border border-accent/30 bg-accent/5 px-4 py-3">
        <span className={`${STAMPB} border-accent text-accent`}>
          <StampMark size={12} />
          Claim under review
        </span>
        <p className="mt-2 text-xs text-ink-soft">
          Your claim on this profile is awaiting review. You&apos;ll have access
          once it&apos;s approved.
        </p>
        {outcome?.kind === "submitted" && (
          <p className="mt-1 text-xs text-ink-soft">
            Submitted just now — exact-email matches approve instantly; everything
            else is reviewed by a human.
          </p>
        )}
      </div>
    );
  }

  if (status.kind === "anon") {
    return (
      <p className="mt-3 text-xs text-ink-soft/70">
        Are you {officialName}?{" "}
        <a
          href={`/auth/sign-in?next=/officials/${officialId}`}
          className="font-medium text-accent hover:underline"
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
        <p className="mb-1 text-xs text-accent">
          Your previous claim was declined. You can submit again with more context.
        </p>
      )}
      {status.kind === "expired" && (
        <p className="mb-1 text-xs text-ink-soft">
          Your verification has expired. Re-claim the profile to restore access.
        </p>
      )}

      {!formOpen ? (
        <button
          onClick={() => setFormOpen(true)}
          className="text-xs font-medium text-accent hover:underline"
        >
          Is this you? Claim this profile →
        </button>
      ) : (
        <div className="border border-rule bg-card p-4">
          <p className="font-serif text-sm font-semibold text-ink">
            Claim {officialName}&apos;s profile
          </p>
          <p className="mt-1 text-xs text-ink-soft">
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
            className="mt-3 w-full border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft/60 focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={submitClaim}
              disabled={submitting || !justification.trim()}
              className="bg-ink px-3 py-1.5 text-xs font-medium text-paper hover:bg-accent disabled:opacity-50 transition-colors"
            >
              {submitting ? "Submitting…" : "Submit claim"}
            </button>
            <button
              onClick={() => {
                setFormOpen(false);
                setOutcome(null);
              }}
              disabled={submitting}
              className="text-xs text-ink-soft hover:text-ink"
            >
              Cancel
            </button>
            <span className="ml-auto font-mono text-[10px] text-ink-soft/70 tabular-nums">
              {justification.length}/{JUSTIFICATION_MAX}
            </span>
          </div>
          {outcome?.kind === "error" && (
            <p className="mt-2 text-xs text-accent">{outcome.message}</p>
          )}
        </div>
      )}

      {outcome?.kind === "approved" && (
        <p className="mt-2 text-xs font-medium text-green-ink">
          ✓ Verified — your email exactly matched this official&apos;s listed email.
        </p>
      )}
    </div>
  );
}
