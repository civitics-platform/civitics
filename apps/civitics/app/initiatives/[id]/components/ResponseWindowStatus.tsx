"use client";

import { useState } from "react";

// ─── Types ─────────────────────────────────────────────────────────────────────

type ResponseType = "support" | "oppose" | "pledge" | "refer" | "no_response";

export type ResponseRow = {
  id:                  string;
  official_id:         string;
  response_type:       ResponseType;
  body_text:           string | null;
  committee_referred:  string | null;
  window_opened_at:    string;
  window_closes_at:    string;
  responded_at:        string | null;
  is_verified_staff:   boolean;
};

interface ResponseWindowStatusProps {
  initiativeId: string;
  responses:    ResponseRow[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const RESPONSE_STYLES: Record<ResponseType, { label: string; color: string }> = {
  support:     { label: "Supports",           color: "bg-green-ink/10 text-green-ink border-green-ink/25" },
  oppose:      { label: "Opposes",            color: "bg-accent/10 text-accent border-accent/25" },
  pledge:      { label: "Pledged to Sponsor", color: "bg-accent/10 text-accent border-accent/25" },
  refer:       { label: "Referred to Cmte",  color: "bg-amber/20 text-ink border-amber/60" },
  no_response: { label: "No Response",        color: "bg-paper-2 text-ink-soft border-rule" },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

// ─── WindowRow ─────────────────────────────────────────────────────────────────

function WindowRow({ r }: { r: ResponseRow }) {
  const [expanded, setExpanded] = useState(false);
  const rs         = RESPONSE_STYLES[r.response_type];
  const isOpen     = !r.responded_at && new Date(r.window_closes_at) > new Date();
  const isExpired  = !r.responded_at && new Date(r.window_closes_at) <= new Date();
  const hasResponse = !!r.responded_at;

  return (
    <div className={`rounded-lg border p-4 ${
      hasResponse ? "border-rule bg-card" :
      isOpen      ? "border-amber/60 bg-amber/20" :
                    "border-rule bg-paper-2"
    }`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${rs.color}`}>
            {rs.label}
          </span>
          {r.is_verified_staff && (
            <span className="rounded-full bg-civic-blue/10 border border-civic-blue/25 px-2 py-0.5 text-xs text-civic-blue">
              ✓ Verified staff
            </span>
          )}
          {isOpen && (
            <span className="rounded-full bg-amber/20 border border-amber/60 px-2 py-0.5 text-xs font-medium text-ink">
              ⏳ {daysUntil(r.window_closes_at)}d remaining
            </span>
          )}
          {isExpired && (
            <span className="rounded-full bg-paper-2 border border-rule px-2 py-0.5 text-xs text-ink-soft/70">
              Expired {daysAgo(r.window_closes_at)}d ago
            </span>
          )}
        </div>

        {hasResponse && r.response_type !== "no_response" && r.body_text && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-accent hover:text-accent"
          >
            {expanded ? "Hide" : "Read response"}
          </button>
        )}
      </div>

      {/* Response body */}
      {hasResponse && expanded && r.body_text && (
        <p className="mt-3 text-sm text-ink-soft leading-relaxed border-t border-rule pt-3">
          {r.body_text}
        </p>
      )}

      {r.committee_referred && (
        <p className="mt-1 text-xs text-ink-soft/70">Referred to: {r.committee_referred}</p>
      )}

      {/* Footer */}
      <p className="mt-2 text-xs text-ink-soft/70">
        {hasResponse
          ? <>Responded {formatDate(r.responded_at!)} · Window closed {formatDate(r.window_closes_at)}</>
          : isOpen
          ? <>Window opened {formatDate(r.window_opened_at)} · Closes {formatDate(r.window_closes_at)}</>
          : <>Window closed {formatDate(r.window_closes_at)} with no response</>
        }
      </p>
    </div>
  );
}

// ─── ResponseWindowStatus ──────────────────────────────────────────────────────

export function ResponseWindowStatus({ initiativeId, responses }: ResponseWindowStatusProps) {
  const [showAll, setShowAll] = useState(false);

  if (responses.length === 0) return null;

  // Categorise
  const responded   = responses.filter((r) => r.responded_at);
  const openWindows = responses.filter(
    (r) => !r.responded_at && new Date(r.window_closes_at) > new Date()
  );
  const expired     = responses.filter(
    (r) => !r.responded_at && new Date(r.window_closes_at) <= new Date()
  );

  // Earliest open window close date
  const earliestClose = openWindows.length > 0
    ? openWindows.reduce((min, r) =>
        new Date(r.window_closes_at) < new Date(min.window_closes_at) ? r : min
      )
    : null;

  // Show top-level: responded first, then open, then expired
  const sorted = [...responded, ...openWindows, ...expired];
  const visible = showAll ? sorted : sorted.slice(0, 3);

  return (
    <div className="mt-8">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">Official response windows</h2>

        {/* Summary chips */}
        <div className="flex items-center gap-2">
          {responded.length > 0 && (
            <span className="rounded-full bg-green-ink/10 border border-green-ink/25 px-2.5 py-0.5 text-xs font-medium text-green-ink">
              {responded.length} responded
            </span>
          )}
          {openWindows.length > 0 && (
            <span className="rounded-full bg-amber/20 border border-amber/60 px-2.5 py-0.5 text-xs font-medium text-ink">
              {openWindows.length} open
            </span>
          )}
          {expired.length > 0 && (
            <span className="rounded-full bg-paper-2 border border-rule px-2.5 py-0.5 text-xs text-ink-soft/70">
              {expired.length} no response
            </span>
          )}
        </div>
      </div>

      {/* Open window notice */}
      {earliestClose && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber/60 bg-amber/20 px-4 py-3">
          <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-ink">
              {openWindows.length} official{openWindows.length !== 1 ? "s" : ""} ha{openWindows.length !== 1 ? "ve" : "s"} an open 30-day response window
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              Earliest deadline: {formatDate(earliestClose.window_closes_at)} ({daysUntil(earliestClose.window_closes_at)} days). Officials who don&apos;t respond receive a permanent <strong>No Response</strong> on their profile.
            </p>
            {/* Respond link for officials */}
            <p className="mt-1.5 text-xs text-ink-soft">
              Are you an official with a response window?{" "}
              <a
                href={`/initiatives/${initiativeId}/respond`}
                className="font-semibold underline hover:text-ink"
              >
                Submit your response →
              </a>
            </p>
          </div>
        </div>
      )}

      {/* Response rows */}
      <div className="space-y-3">
        {visible.map((r) => (
          <WindowRow key={r.id} r={r} />
        ))}
      </div>

      {sorted.length > 3 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 text-xs text-accent hover:text-accent"
        >
          {showAll ? "Show fewer" : `Show all ${sorted.length} windows`}
        </button>
      )}

      {/* Permanence note */}
      {expired.length > 0 && (
        <p className="mt-3 text-xs text-ink-soft/70 italic">
          No Response records are permanent and appear on official profiles. Silence is data.
        </p>
      )}
    </div>
  );
}
