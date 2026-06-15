"use client";

/**
 * InitiativeCommentPanel — Sprint 10
 *
 * Shown on initiative pages in the mobilise stage when at least one linked
 * proposal has an active comment period (i.e. regulations_gov_id set and
 * comment_period_end is either null or in the future).
 *
 * Reuses the /api/proposals/[id]/comment endpoint — the comment is about the
 * linked federal proposal, submitted in the context of this initiative.
 *
 * Core principle: official comment submission is always free. No auth required.
 */

import { useState } from "react";

export type CommentableProposal = {
  id:                  string;
  title:               string;
  bill_number:         string | null;
  short_title:         string | null;
  regulations_gov_id:  string | null;
  congress_gov_url:    string | null;
  comment_period_end:  string | null;
};

type Props = {
  initiativeTitle:   string;
  initiativeSummary: string | null;
  proposals:         CommentableProposal[];
};

// Filter to proposals that actually accept comments and haven't expired
function isCommentable(p: CommentableProposal): boolean {
  if (!p.regulations_gov_id && !p.congress_gov_url) return false;
  if (p.comment_period_end) {
    return new Date(p.comment_period_end) > new Date();
  }
  return true; // no end date = open period assumed
}

function proposalLabel(p: CommentableProposal): string {
  if (p.bill_number) return `${p.bill_number} · ${p.short_title ?? p.title}`;
  return p.short_title ?? p.title;
}

const INITIATIVE_TEMPLATE = (initiativeTitle: string, summary: string | null) =>
  `I am writing to support the civic initiative: "${initiativeTitle}".` +
  (summary ? `\n\nThis initiative aims to: ${summary}` : "") +
  "\n\nI urge the agency to consider this perspective:\n\n[Share your thoughts here]\n\nThank you for considering public input on this matter.";

// ─── Component ────────────────────────────────────────────────────────────────

export function InitiativeCommentPanel({
  initiativeTitle,
  initiativeSummary,
  proposals,
}: Props) {
  const eligible = proposals.filter(isCommentable);
  if (eligible.length === 0) return null;

  return (
    <CommentPanelInner
      initiativeTitle={initiativeTitle}
      initiativeSummary={initiativeSummary}
      proposals={eligible}
    />
  );
}

// Split into inner component so we can use hooks safely
function CommentPanelInner({
  initiativeTitle,
  initiativeSummary,
  proposals,
}: {
  initiativeTitle:   string;
  initiativeSummary: string | null;
  proposals:         CommentableProposal[];
}) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [text,        setText]        = useState(() => INITIATIVE_TEMPLATE(initiativeTitle, initiativeSummary));
  const [name,        setName]        = useState("");
  const [org,         setOrg]         = useState("");
  const [submitted,   setSubmitted]   = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [confirmNum,  setConfirmNum]  = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const selected    = proposals[selectedIdx]!;
  const submitHref  = selected.regulations_gov_id
    ? `https://www.regulations.gov/commenton/${selected.regulations_gov_id}`
    : selected.congress_gov_url;

  const daysLeft = selected.comment_period_end
    ? Math.max(0, Math.ceil((new Date(selected.comment_period_end).getTime() - Date.now()) / 86400000))
    : null;

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/proposals/${selected.id}/comment`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          comment_text:       text,
          name:               name || undefined,
          org:                org  || undefined,
          regulations_gov_id: selected.regulations_gov_id,
        }),
      });
      const data = await res.json();
      if (data.status === "submitted") {
        setConfirmNum(data.confirmation_number ?? null);
        setFallbackUrl(null);
      } else {
        setFallbackUrl(data.fallback_url ?? submitHref ?? null);
      }
    } catch {
      setFallbackUrl(submitHref ?? null);
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  // ── Success state ────────────────────────────────────────────────────────
  if (submitted) {
    const displayHref = fallbackUrl ?? submitHref;
    return (
      <div className="mt-6 border border-green-ink/25 bg-green-ink/10 p-6">
        <p className="text-center text-lg font-semibold text-green-ink">
          ✓ Thanks for participating in democracy.
        </p>
        {confirmNum ? (
          <p className="mt-1 text-center text-sm text-green-ink">
            Confirmation #: <span className="font-mono font-medium">{confirmNum}</span>
          </p>
        ) : (
          <p className="mt-1 text-center text-sm text-green-ink">
            Your comment is ready — paste it into the form at regulations.gov to submit officially.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); }}
            className="border border-green-ink/30 bg-card px-4 py-2 text-sm font-medium text-green-ink hover:bg-green-ink/10 transition-colors"
          >
            Copy comment
          </button>
          {displayHref && (
            <a
              href={displayHref}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-ink px-4 py-2 text-sm font-medium text-paper hover:bg-accent transition-colors"
            >
              Open regulations.gov →
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSubmitted(false)}
          className="mt-4 block w-full text-center text-xs text-green-ink hover:underline"
        >
          Edit my comment
        </button>
      </div>
    );
  }

  // ── Draft state ──────────────────────────────────────────────────────────
  return (
    <div className="mt-6 border border-civic-blue/20 bg-card p-5">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-ink">Submit an official comment</h3>
          <p className="mt-0.5 text-xs text-ink-soft">
            Your initiative can trigger a formal public comment to the responsible agency — free, always.
          </p>
        </div>
        {daysLeft !== null && (
          <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            daysLeft <= 7
              ? "bg-accent/10 text-accent"
              : "bg-amber/25 text-ink"
          }`}>
            {daysLeft}d left
          </span>
        )}
      </div>

      {/* Proposal selector (shown when multiple eligible) */}
      {proposals.length > 1 && (
        <div className="mb-4">
          <label className="mb-1 block text-xs font-semibold text-ink-soft uppercase tracking-wide">
            Comment on which proposal?
          </label>
          <div className="space-y-1">
            {proposals.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedIdx(i)}
                className={`w-full border px-3 py-2 text-left text-xs transition-colors ${
                  i === selectedIdx
                    ? "border-ink bg-ink/5 text-ink font-semibold"
                    : "border-rule bg-card text-ink-soft hover:border-ink"
                }`}
              >
                {proposalLabel(p)}
                {p.comment_period_end && (
                  <span className="ml-1.5 text-ink-soft/60">
                    · ends {new Date(p.comment_period_end).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Selected proposal pill */}
      {proposals.length === 1 && (
        <div className="mb-4 border border-rule bg-paper-2 px-3 py-2">
          <p className="text-xs text-ink-soft">
            Related proposal:{" "}
            <a
              href={`/proposals/${selected.id}`}
              className="font-medium text-accent hover:underline"
            >
              {proposalLabel(selected)}
            </a>
          </p>
          {selected.comment_period_end && (
            <p className="mt-0.5 text-[11px] text-ink-soft/60">
              Comment period closes {new Date(selected.comment_period_end).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </p>
          )}
        </div>
      )}

      {/* Step 1: Draft */}
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
            Step 1 — Draft your comment
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            className="w-full border border-rule px-3 py-2 text-sm text-ink placeholder:text-ink-soft/50 focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
          />
          <p className="mt-1 text-right text-xs text-ink-soft/60">{text.length} characters</p>
        </div>

        {/* Step 2: Details */}
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
            Step 2 — Your details (optional)
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional)"
              className="border border-rule px-3 py-2 text-sm text-ink placeholder:text-ink-soft/50 focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
            />
            <input
              type="text"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="Organization (optional)"
              className="border border-rule px-3 py-2 text-sm text-ink placeholder:text-ink-soft/50 focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink"
            />
          </div>
          <p className="mt-1.5 text-xs text-ink-soft/60">
            Anonymous comments are accepted. Your identity is never required.
          </p>
        </div>

        {/* Step 3: Submit */}
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
            Step 3 — Submit
          </p>
          <button
            type="button"
            disabled={!text.trim() || submitting}
            onClick={handleSubmit}
            className="w-full bg-ink px-4 py-3 text-sm font-semibold text-paper hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
          >
            {submitting ? "Submitting…" : "Submit Official Comment →"}
          </button>
          <p className="mt-2 text-center text-xs text-ink-soft/60">
            Submits to regulations.gov · Free, always · No account required
          </p>
        </div>
      </div>
    </div>
  );
}
