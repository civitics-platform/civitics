"use client";

// Investigations MVP PR2 (FIX-580) — two-axis (agree / valuable) rating control
// per evidence card. Mirrors the comment RatingControls affordance, calling
// PUT /api/evidence/[id]/rate (which requires BOTH axes per call and returns the
// fresh aggregate). Adds the 429 daily-cap feedback the comment control omits, and
// an explicit text equivalent for the rating bars (a11y).

import { useState } from "react";
import { challengedFetch } from "@/lib/challenged-fetch";
import type { EvidenceRatingSummary, EvidenceViewerRating } from "../_lib/presentation";

function redirectToSignIn(next: string) {
  window.location.href = `/auth/sign-in?next=${encodeURIComponent(next)}`;
}

export function EvidenceRating({
  evidenceId,
  summary,
  myRating,
  signInNext,
}: {
  evidenceId: string;
  summary: EvidenceRatingSummary;
  // FIX-801: the viewer's own persisted ballot, resolved server-side in
  // loadCaseFile. Seeds the control so a rated card renders selected on reload
  // instead of resetting to unrated. Defaults to zeros for anon / unrated.
  myRating?: EvidenceViewerRating;
  signInNext: string;
}) {
  const [agg, setAgg] = useState<EvidenceRatingSummary>(summary);
  const [myAgree, setMyAgree] = useState(myRating?.agree ?? 0);
  const [myValuable, setMyValuable] = useState(myRating?.valuable ?? 0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const agreeNet = agg.agree_up - agg.agree_down;
  const valuableNet = agg.valuable_up - agg.valuable_down;

  async function send(nextAgree: number, nextValuable: number) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await challengedFetch(`/api/evidence/${evidenceId}/rate`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agree: nextAgree, valuable: nextValuable }),
      });
      if (res.status === 401) {
        redirectToSignIn(signInNext);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        rating_summary?: EvidenceRatingSummary;
        error?: string;
      };
      if (!res.ok) {
        setNote(res.status === 429 ? data.error ?? "Daily rating limit reached." : data.error ?? "Couldn't save your rating.");
        return;
      }
      if (data.rating_summary) setAgg(data.rating_summary);
    } catch {
      setNote("Network error.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(axis: "agree" | "valuable", value: 1 | -1) {
    const curAgree = myAgree;
    const curValuable = myValuable;
    const nextAgree = axis === "agree" ? (curAgree === value ? 0 : value) : curAgree;
    const nextValuable = axis === "valuable" ? (curValuable === value ? 0 : value) : curValuable;
    setMyAgree(nextAgree);
    setMyValuable(nextValuable);
    void send(nextAgree, nextValuable);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1" role="group" aria-label="Do you agree with this claim?">
          <button
            type="button"
            onClick={() => toggle("agree", 1)}
            disabled={busy}
            aria-pressed={myAgree === 1}
            className={`rounded px-1 ${myAgree === 1 ? "bg-green-ink/15 text-green-ink" : "text-ink-soft hover:text-green-ink"}`}
            aria-label="Agree"
          >
            ▲
          </button>
          <span className="tabular-nums text-ink-soft">{agreeNet}</span>
          <button
            type="button"
            onClick={() => toggle("agree", -1)}
            disabled={busy}
            aria-pressed={myAgree === -1}
            className={`rounded px-1 ${myAgree === -1 ? "bg-accent/15 text-accent" : "text-ink-soft hover:text-accent"}`}
            aria-label="Disagree"
          >
            ▼
          </button>
        </div>
        <button
          type="button"
          onClick={() => toggle("valuable", 1)}
          disabled={busy}
          aria-pressed={myValuable === 1}
          aria-label="Mark valuable to the case file"
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${myValuable === 1 ? "bg-civic-blue/15 text-civic-blue" : "text-ink-soft hover:text-civic-blue"}`}
          title="Valuable to the case file (even if you disagree)"
        >
          ★ <span className="tabular-nums">{valuableNet}</span>
        </button>
        {/* Text equivalent of the two rating bars (a11y). */}
        <span className="sr-only">
          Agree score {agreeNet}. Valuable score {valuableNet}.
        </span>
      </div>
      {note && <p className="text-[11px] text-accent">{note}</p>}
    </div>
  );
}
