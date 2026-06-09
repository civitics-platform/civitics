"use client";

// C1 Wave C (FIX-535): statement mode — the Polis-lite agree/disagree/pass layer.
//
// A low-friction, ~30-second-per-statement surface for the ~95% who'll never
// write a comment. Each statement is a short proposition the crowd votes on with
// agree (+1) / pass (0) / disagree (-1). After voting, a thin result bar reveals
// the crowd split. Users can propose a statement (rate-limited) or promote their
// own comment elsewhere. NO clustering / consensus ranking — that's C3 (decision 4).
// Pseudonymous author display only.

import { useCallback, useEffect, useState } from "react";
import { STATEMENT_MAX_LEN, STATEMENT_MIN_LEN, type EntityCommentType } from "@civitics/db";

type VoteSummary = { agree: number; disagree: number; pass: number };

type Statement = {
  id: string;
  body: string;
  status: string;
  source_comment_id: string | null;
  vote_summary: VoteSummary;
  is_constituent: boolean;
  author_name: string;
  my_vote: number | null;
  created_at: string;
};

export interface StatementModeProps {
  entityType: EntityCommentType;
  entityId: string;
  signInNext: string;
  lens?: "all" | "constituents";
  heading?: string;
  subheading?: string;
}

const FLAG_REASONS = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "off_topic", label: "Off-topic" },
  { value: "misinformation", label: "Misinformation" },
  { value: "other", label: "Other" },
];

function redirectToSignIn(next: string) {
  window.location.href = `/auth/sign-in?next=${encodeURIComponent(next)}`;
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

// ─── Result bar (agree / pass / disagree) with text equivalent ────────────────
function ResultBar({ summary }: { summary: VoteSummary }) {
  const total = summary.agree + summary.pass + summary.disagree;
  const a = pct(summary.agree, total);
  const p = pct(summary.pass, total);
  const d = pct(summary.disagree, total);
  return (
    <div className="mt-3">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100"
        role="img"
        aria-label={`${a}% agree, ${p}% pass, ${d}% disagree, ${total} ${total === 1 ? "vote" : "votes"}`}
      >
        <div className="bg-emerald-500" style={{ width: `${a}%` }} />
        <div className="bg-gray-300" style={{ width: `${p}%` }} />
        <div className="bg-red-500" style={{ width: `${d}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-gray-500">
        <span className="text-emerald-700">{a}% agree</span>
        <span>{p}% pass</span>
        <span className="text-red-700">{d}% disagree</span>
      </div>
      <p className="mt-0.5 text-[10px] text-gray-400">{total} {total === 1 ? "vote" : "votes"}</p>
    </div>
  );
}

// ─── Per-statement flag menu ──────────────────────────────────────────────────
function FlagMenu({ statementId, signInNext }: { statementId: string; signInNext: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("spam");
  const [busy, setBusy] = useState(false);

  if (done) return <span className="text-[10px] text-gray-400">Flagged · thanks</span>;

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/statements/${statementId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (res.status === 401) return redirectToSignIn(signInNext);
      if (res.ok) {
        setDone(true);
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[10px] text-gray-300 hover:text-red-600"
        aria-label="Flag statement"
      >
        ⚑ Flag
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-20 w-52 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs"
            aria-label="Flag reason"
          >
            {FLAG_REASONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={busy} className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50">
              {busy ? "…" : "Submit"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Propose-a-statement composer ─────────────────────────────────────────────
function ProposeStatement({
  entityType,
  entityId,
  signInNext,
  onProposed,
}: {
  entityType: EntityCommentType;
  entityId: string;
  signInNext: string;
  onProposed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (body.trim().length < STATEMENT_MIN_LEN) {
      setError(`At least ${STATEMENT_MIN_LEN} characters.`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/statements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, body: body.trim() }),
      });
      if (res.status === 401) return redirectToSignIn(signInNext);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 429 ? (data.error ?? "Daily statement limit reached.") : (data.error ?? "Failed to submit."));
        return;
      }
      setBody("");
      setDone(true);
      setOpen(false);
      onProposed();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setDone(false); }}
        className="mt-3 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-indigo-300 hover:text-indigo-700"
      >
        {done ? "Propose another statement" : "+ Propose a statement"}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
      <label className="mb-1 block text-xs font-medium text-gray-600">
        Propose a short, voteable proposition
      </label>
      <textarea
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, STATEMENT_MAX_LEN))}
        maxLength={STATEMENT_MAX_LEN}
        placeholder="e.g. This proposal should include a sunset clause."
        className="block w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs tabular-nums ${body.length > STATEMENT_MAX_LEN - 20 ? "text-amber-500" : "text-gray-400"}`}>
          {body.length}/{STATEMENT_MAX_LEN}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-500 hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || body.trim().length < STATEMENT_MIN_LEN}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit"}
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </form>
  );
}

// ─── StatementMode ────────────────────────────────────────────────────────────
export function StatementMode({
  entityType,
  entityId,
  signInNext,
  lens = "all",
  heading = "Quick take",
  subheading = "Agree, pass, or disagree — 30 seconds, no writing required.",
}: StatementModeProps) {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, lens });
      const res = await fetch(`/api/statements?${sp.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load statements.");
        return;
      }
      setStatements(data.statements ?? []);
      setIndex(0);
    } catch {
      setError("Failed to load statements.");
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, lens]);

  useEffect(() => { void load(); }, [load]);

  async function vote(statement: Statement, value: -1 | 0 | 1) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/statements/${statement.id}/vote`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vote: value }),
      });
      if (res.status === 401) return redirectToSignIn(signInNext);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatements((prev) =>
          prev.map((s) =>
            s.id === statement.id
              ? { ...s, my_vote: value, vote_summary: data.vote_summary ?? s.vote_summary }
              : s,
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const total = statements.length;
  const current = total > 0 ? statements[Math.min(index, total - 1)] : null;
  const votedCount = statements.filter((s) => s.my_vote != null).length;

  return (
    <section className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900">{heading}</h3>
        {total > 0 && (
          <span className="text-[11px] tabular-nums text-gray-400">
            {votedCount}/{total} voted
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-gray-500">{subheading}</p>

      {loading ? (
        <div className="py-6 text-center text-sm text-gray-400">Loading…</div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : total === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-400">
          No statements yet. <span className="text-gray-500">Propose the first one below.</span>
          <ProposeStatement entityType={entityType} entityId={entityId} signInNext={signInNext} onProposed={load} />
        </div>
      ) : current ? (
        <>
          <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center gap-1.5">
              {current.status === "needs_review" && (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                  Under review
                </span>
              )}
              {current.is_constituent && (
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700" title="Proposed by a verified constituent">
                  ✓ Constituent
                </span>
              )}
              {current.source_comment_id && (
                <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-500" title="Promoted from a comment">
                  ↑ from a comment
                </span>
              )}
            </div>

            <p className="text-base font-medium leading-relaxed text-gray-900">{current.body}</p>

            <div className="mt-3 grid grid-cols-3 gap-2">
              {([
                { v: 1 as const, label: "Agree", on: "bg-emerald-600 text-white border-emerald-600", off: "border-emerald-200 text-emerald-700 hover:bg-emerald-50" },
                { v: 0 as const, label: "Pass", on: "bg-gray-600 text-white border-gray-600", off: "border-gray-200 text-gray-600 hover:bg-gray-100" },
                { v: -1 as const, label: "Disagree", on: "bg-red-600 text-white border-red-600", off: "border-red-200 text-red-700 hover:bg-red-50" },
              ]).map((b) => (
                <button
                  key={b.v}
                  type="button"
                  onClick={() => vote(current, b.v)}
                  disabled={busy}
                  aria-pressed={current.my_vote === b.v}
                  aria-label={b.label}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${current.my_vote === b.v ? b.on : b.off}`}
                >
                  {b.label}
                </button>
              ))}
            </div>

            {current.my_vote != null && <ResultBar summary={current.vote_summary} />}

            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={index === 0}
                  className="rounded px-1.5 py-0.5 hover:bg-gray-100 disabled:opacity-30"
                  aria-label="Previous statement"
                >
                  ← Prev
                </button>
                <span className="tabular-nums">{Math.min(index + 1, total)} of {total}</span>
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
                  disabled={index >= total - 1}
                  className="rounded px-1.5 py-0.5 hover:bg-gray-100 disabled:opacity-30"
                  aria-label="Next statement"
                >
                  Next →
                </button>
              </div>
              <FlagMenu statementId={current.id} signInNext={signInNext} />
            </div>
          </div>

          {index >= total - 1 && votedCount === total && (
            <p className="mt-3 text-center text-xs text-emerald-700">✓ You&apos;ve weighed in on every statement.</p>
          )}

          <ProposeStatement entityType={entityType} entityId={entityId} signInNext={signInNext} onProposed={load} />
        </>
      ) : null}
    </section>
  );
}
