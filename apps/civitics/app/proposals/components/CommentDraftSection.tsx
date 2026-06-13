"use client";

import { useState } from "react";

type Props = {
  regulationsGovId: string | null;
  congressGovUrl: string | null;
  title: string;
  proposalId: string;
};

const TABS = ["write", "template"] as const;
type Tab = (typeof TABS)[number];

const TEMPLATES = {
  support: (title: string) =>
    `I am writing to express my support for the proposed rule: "${title}".\n\nI believe this rule will have a positive impact because:\n\n[Explain your reasons here]\n\nThank you for considering public input on this important matter.`,
  oppose: (title: string) =>
    `I am writing to express my opposition to the proposed rule: "${title}".\n\nI am concerned about this rule because:\n\n[Explain your concerns here]\n\nI respectfully urge the agency to reconsider this proposal.`,
  info: (title: string) =>
    `I am writing regarding the proposed rule: "${title}".\n\nI request additional information on the following points:\n\n[List your questions here]\n\nThank you for your transparency and responsiveness to public inquiry.`,
};

export function CommentDraftSection({ regulationsGovId, congressGovUrl, title, proposalId }: Props) {
  const [tab, setTab] = useState<Tab>("write");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmationNumber, setConfirmationNumber] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const submitHref = regulationsGovId
    ? `https://www.regulations.gov/commenton/${regulationsGovId}`
    : congressGovUrl ?? null;

  if (!submitHref) {
    return (
      <div className="border border-rule bg-paper-2 p-5 text-sm text-ink-soft">
        Comment submission URL not available for this proposal. Check{" "}
        <a
          href="https://www.regulations.gov"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          regulations.gov
        </a>{" "}
        directly.
      </div>
    );
  }

  if (submitted) {
    const displayHref = fallbackUrl ?? submitHref;
    return (
      <div className="border border-green-ink/30 bg-green-ink/5 p-6 text-center">
        <p className="text-lg font-semibold text-green-ink">
          ✓ Thanks for participating in democracy.
        </p>
        {confirmationNumber ? (
          <p className="mt-1 text-sm text-green-ink/90">
            Confirmation #: <span className="font-mono font-medium">{confirmationNumber}</span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-green-ink/90">
            Your comment has been prepared. Paste it into the form at regulations.gov to submit
            officially.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={() => {
              if (typeof navigator !== "undefined") {
                navigator.clipboard.writeText(text).catch(() => {});
              }
            }}
            className="border border-green-ink/40 bg-card px-4 py-2 text-sm font-medium text-green-ink hover:bg-green-ink/5 transition-colors"
          >
            Copy comment text
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
          onClick={() => setSubmitted(false)}
          className="mt-3 text-xs text-green-ink hover:underline"
        >
          Edit my comment
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Step 1: Draft */}
      <div>
        <p className="font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70 mb-2">
          Step 1 — Draft your comment
        </p>

        {/* Tab bar */}
        <div className="flex gap-1 bg-paper-2 p-1 mb-3 w-fit">
          {(["write", "template"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                if (t === "template" && !text) setText(TEMPLATES.support(title));
              }}
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t
                  ? "bg-card text-ink shadow-sm"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              {t === "write" ? "Write My Own" : "Use Template"}
            </button>
          ))}
          <span className="px-3 py-1.5 text-sm font-medium text-ink-soft/50 cursor-default">
            AI Help
            <span className="ml-1 text-[10px] font-normal">(coming soon)</span>
          </span>
        </div>

        {tab === "template" && (
          <div className="flex gap-2 mb-2">
            {(["support", "oppose", "info"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setText(TEMPLATES[t](title))}
                className="border border-rule bg-card px-2.5 py-1 text-xs font-medium text-ink-soft hover:border-accent hover:text-accent transition-colors capitalize"
              >
                {t === "info" ? "Request info" : t}
              </button>
            ))}
          </div>
        )}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Share your perspective on this proposal. What impact will it have on you, your community, or your industry?"
          rows={7}
          className="w-full border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft/60 focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <p className="mt-1 text-right font-mono text-xs tabular-nums text-ink-soft/70">
          {text.length} characters
        </p>
      </div>

      {/* Step 2: Details */}
      <div>
        <p className="font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70 mb-2">
          Step 2 — Your details (optional)
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            className="border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft/60 focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <input
            type="text"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="Organization (optional)"
            className="border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft/60 focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <p className="mt-1.5 text-xs text-ink-soft/70">
          Anonymous comments are accepted. Your identity is never required.
        </p>
      </div>

      {/* Step 3: Submit */}
      <div>
        <p className="font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70 mb-2">
          Step 3 — Submit
        </p>
        <button
          disabled={!text.trim() || isSubmitting}
          onClick={async () => {
            setIsSubmitting(true);
            try {
              const res = await fetch(`/api/proposals/${proposalId}/comment`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  comment_text: text,
                  name: name || undefined,
                  org: org || undefined,
                  regulations_gov_id: regulationsGovId,
                }),
              });
              const data = await res.json();
              if (data.status === "submitted") {
                setConfirmationNumber(data.confirmation_number ?? null);
                setFallbackUrl(null);
              } else {
                // failed or no_api_key — always provide fallback
                setFallbackUrl(data.fallback_url ?? submitHref);
              }
            } catch {
              setFallbackUrl(submitHref);
            } finally {
              setIsSubmitting(false);
              setSubmitted(true);
            }
          }}
          className="w-full bg-ink px-4 py-3 text-sm font-semibold text-paper hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isSubmitting ? "Submitting..." : "Submit Official Comment →"}
        </button>
        <p className="mt-2 text-center text-xs text-ink-soft/70">
          Opens regulations.gov · Free, always · No account required
        </p>
      </div>
    </div>
  );
}
