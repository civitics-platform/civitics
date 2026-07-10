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
import { challengedFetch } from "@/lib/challenged-fetch";
import { fetchViewerEngagement } from "@/lib/viewer-overlay";
import { SyntheticMark } from "./integrity/Synthetic";
import {
  createBrowserClient,
  STATEMENT_MAX_LEN,
  STATEMENT_MIN_LEN,
  type EntityCommentType,
} from "@civitics/db";

type VoteSummary = { agree: number; disagree: number; pass: number };

type Statement = {
  id: string;
  body: string;
  status: string;
  source_comment_id: string | null;
  vote_summary: VoteSummary;
  is_constituent: boolean;
  author_name: string;
  author_is_synthetic?: boolean;
  // FIX-788: NOT in the /api/statements payload anymore (that response is
  // edge-cached and viewer-independent) — hydrated client-side from the
  // no-store /api/viewer/engagement overlay, then kept current by vote().
  my_vote: number | null;
  created_at: string;
};

// The cached list payload: a Statement minus the viewer-keyed field.
type PublicStatement = Omit<Statement, "my_vote">;

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
        className="flex h-2 w-full overflow-hidden rounded-full bg-paper-2"
        role="img"
        aria-label={`${a}% agree, ${p}% pass, ${d}% disagree, ${total} ${total === 1 ? "vote" : "votes"}`}
      >
        <div className="bg-green-ink" style={{ width: `${a}%` }} />
        <div className="bg-ink/30" style={{ width: `${p}%` }} />
        <div className="bg-accent" style={{ width: `${d}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-ink-soft">
        <span className="text-green-ink">{a}% agree</span>
        <span>{p}% pass</span>
        <span className="text-accent">{d}% disagree</span>
      </div>
      <p className="mt-0.5 text-[10px] text-ink-soft/60">{total} {total === 1 ? "vote" : "votes"}</p>
    </div>
  );
}

// ─── Per-statement flag menu ──────────────────────────────────────────────────
function FlagMenu({ statementId, signInNext }: { statementId: string; signInNext: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("spam");
  const [busy, setBusy] = useState(false);

  if (done) return <span className="text-[10px] text-ink-soft/60">Flagged · thanks</span>;

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
        className="text-[10px] text-ink-soft/50 hover:text-accent"
        aria-label="Flag statement"
      >
        ⚑ Flag
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-20 w-52 border border-rule bg-card p-3 shadow-lg">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full border border-rule bg-card px-2 py-1 text-xs text-ink"
            aria-label="Flag reason"
          >
            {FLAG_REASONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="border border-rule px-2 py-1 text-[11px] text-ink-soft hover:bg-paper-2">
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={busy} className="bg-accent px-2 py-1 text-[11px] font-medium text-paper hover:bg-accent/90 disabled:opacity-50">
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
  /** FIX-541: passes the posted {id, body} up for an optimistic append; null
   *  when the POST succeeded but returned no id (caller falls back to load()). */
  onProposed: (posted: { id: string; body: string } | null) => void;
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
    const trimmed = body.trim();
    try {
      const res = await challengedFetch(`/api/statements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, body: trimmed }),
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
      onProposed(typeof data.id === "string" && data.id ? { id: data.id, body: trimmed } : null);
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
        className="mt-3 border border-dashed border-rule px-3 py-1.5 text-xs font-medium text-ink-soft hover:border-ink hover:text-ink"
      >
        {done ? "Propose another statement" : "+ Propose a statement"}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 border border-rule bg-card p-3">
      <label className="mb-1 block text-xs font-medium text-ink-soft">
        Propose a short, voteable proposition
      </label>
      <textarea
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, STATEMENT_MAX_LEN))}
        maxLength={STATEMENT_MAX_LEN}
        placeholder="e.g. This proposal should include a sunset clause."
        className="block w-full resize-none border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-soft/50 focus:border-ink focus:bg-card focus:outline-none focus:ring-1 focus:ring-ink"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs tabular-nums ${body.length > STATEMENT_MAX_LEN - 20 ? "text-accent" : "text-ink-soft/60"}`}>
          {body.length}/{STATEMENT_MAX_LEN}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setOpen(false)} className="border border-rule px-3 py-1 text-xs text-ink-soft hover:bg-paper-2">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || body.trim().length < STATEMENT_MIN_LEN}
            className="bg-ink px-3 py-1.5 text-xs font-semibold text-paper hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {busy ? "Submitting…" : "Submit"}
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-accent">{error}</p>}
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
  // FIX-540: keyset cursor from the RPC; Load more appends into the stepper.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // FIX-788: hydrate the caller's ballots onto already-rendered rows. Fired
  // after the (cached, viewer-independent) list lands — merges by id, so a late
  // response for a superseded list is a harmless no-op. Signed-out users make
  // zero overlay calls (fetchViewerEngagement short-circuits on the local
  // session read) and the empty overlay renders exactly today's anon state.
  const hydrateMyVotes = useCallback((ids: string[]) => {
    void fetchViewerEngagement({ statementIds: ids }).then(({ votes }) => {
      if (Object.keys(votes).length === 0) return;
      setStatements((prev) =>
        prev.map((s) => {
          const v = votes[s.id];
          return v !== undefined ? { ...s, my_vote: v } : s;
        }),
      );
    });
  }, []);

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
      const list = ((data.statements ?? []) as PublicStatement[]).map(
        (s): Statement => ({ ...s, my_vote: null }),
      );
      setStatements(list);
      setNextCursor(data.nextCursor ?? null);
      setIndex(0);
      hydrateMyVotes(list.map((s) => s.id));
    } catch {
      setError("Failed to load statements.");
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, lens]);

  useEffect(() => { void load(); }, [load]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const sp = new URLSearchParams({
        entity_type: entityType,
        entity_id: entityId,
        lens,
        cursor: nextCursor,
      });
      const res = await fetch(`/api/statements?${sp.toString()}`);
      const data = await res.json();
      if (res.ok) {
        const incoming = ((data.statements ?? []) as PublicStatement[]).map(
          (s): Statement => ({ ...s, my_vote: null }),
        );
        // Dedupe by id: an optimistically appended statement (zero votes →
        // sorted last) can legitimately arrive again on a later page.
        setStatements((prev) => [
          ...prev,
          ...incoming.filter((s) => !prev.some((p) => p.id === s.id)),
        ]);
        setNextCursor(data.nextCursor ?? null);
        hydrateMyVotes(incoming.map((s) => s.id));
      }
    } catch {
      // Leave the cursor in place — the button stays available to retry.
    } finally {
      setLoadingMore(false);
    }
  }

  // FIX-541: optimistic append — POST /api/statements already returned the new
  // id, so build the local payload (zeroed votes, no constituent badge until
  // the next full load) instead of refetching the whole list. The author name
  // mirrors the server's derivation: users.display_name is seeded from auth
  // user_metadata.full_name, falling back to the citizen-<id8> pseudonym.
  // load() stays the error-recovery path.
  async function handleProposed(posted: { id: string; body: string } | null) {
    if (!posted) {
      void load();
      return;
    }
    let authorName = "You";
    try {
      const { data: { user } } = await createBrowserClient().auth.getUser();
      if (user) {
        const meta = (user.user_metadata?.full_name as string | undefined)?.trim();
        authorName = meta || `citizen-${user.id.slice(0, 8)}`;
      }
    } catch {
      // keep the fallback
    }
    const local: Statement = {
      id: posted.id,
      body: posted.body,
      status: "visible",
      source_comment_id: null,
      vote_summary: { agree: 0, disagree: 0, pass: 0 },
      is_constituent: false,
      author_name: authorName,
      my_vote: null,
      created_at: new Date().toISOString(),
    };
    setStatements((prev) =>
      prev.some((s) => s.id === local.id) ? prev : [...prev, local],
    );
    // Step to the new statement so it's visible immediately.
    setIndex(statements.length);
  }

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
    <section className="border border-rule bg-paper-2 p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-bold text-ink">{heading}</h3>
        {total > 0 && (
          <span className="text-[11px] tabular-nums text-ink-soft/60">
            {votedCount}/{total} voted
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-ink-soft">{subheading}</p>

      {loading ? (
        <div className="py-6 text-center text-sm text-ink-soft/60">Loading…</div>
      ) : error ? (
        <div className="border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-accent">{error}</div>
      ) : total === 0 ? (
        <div className="border border-dashed border-rule bg-card px-4 py-6 text-center text-sm text-ink-soft/60">
          No statements yet. <span className="text-ink-soft">Propose the first one below.</span>
          <ProposeStatement entityType={entityType} entityId={entityId} signInNext={signInNext} onProposed={handleProposed} />
        </div>
      ) : current ? (
        <>
          <div className="border border-rule bg-card p-4">
            <div className="mb-2 flex items-center gap-1.5">
              {current.status === "needs_review" && (
                <span className="rounded-full border border-amber/60 bg-amber/25 px-2 py-0.5 text-[10px] font-medium text-ink">
                  Under review
                </span>
              )}
              {current.is_constituent && (
                <span className="rounded-full border border-civic-blue/25 bg-civic-blue/10 px-2 py-0.5 text-[10px] font-medium text-civic-blue" title="Proposed by a verified constituent">
                  ✓ Constituent
                </span>
              )}
              {current.source_comment_id && (
                <span className="rounded-full border border-rule bg-paper-2 px-2 py-0.5 text-[10px] font-medium text-ink-soft" title="Promoted from a comment">
                  ↑ from a comment
                </span>
              )}
              {current.author_is_synthetic && <SyntheticMark size="xs" />}
            </div>

            <p className="text-base font-medium leading-relaxed text-ink">{current.body}</p>

            <div className="mt-3 grid grid-cols-3 gap-2">
              {([
                { v: 1 as const, label: "Agree", on: "bg-green-ink text-paper border-green-ink", off: "border-green-ink/25 text-green-ink hover:bg-green-ink/10" },
                { v: 0 as const, label: "Pass", on: "bg-ink text-paper border-ink", off: "border-rule text-ink-soft hover:bg-paper-2" },
                { v: -1 as const, label: "Disagree", on: "bg-accent text-paper border-accent", off: "border-accent/25 text-accent hover:bg-accent/10" },
              ]).map((b) => (
                <button
                  key={b.v}
                  type="button"
                  onClick={() => vote(current, b.v)}
                  disabled={busy}
                  aria-pressed={current.my_vote === b.v}
                  aria-label={b.label}
                  className={`border px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${current.my_vote === b.v ? b.on : b.off}`}
                >
                  {b.label}
                </button>
              ))}
            </div>

            {current.my_vote != null && <ResultBar summary={current.vote_summary} />}

            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-ink-soft/60">
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.max(0, i - 1))}
                  disabled={index === 0}
                  className="px-1.5 py-0.5 hover:bg-paper-2 disabled:opacity-30"
                  aria-label="Previous statement"
                >
                  ← Prev
                </button>
                <span className="tabular-nums">{Math.min(index + 1, total)} of {total}</span>
                <button
                  type="button"
                  onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
                  disabled={index >= total - 1}
                  className="px-1.5 py-0.5 hover:bg-paper-2 disabled:opacity-30"
                  aria-label="Next statement"
                >
                  Next →
                </button>
              </div>
              <FlagMenu statementId={current.id} signInNext={signInNext} />
            </div>
          </div>

          {/* FIX-540: at the end of the loaded stepper, pull the next page in. */}
          {index >= total - 1 && nextCursor && (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="border border-rule px-4 py-1.5 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more statements"}
              </button>
            </div>
          )}

          {index >= total - 1 && !nextCursor && votedCount === total && (
            <p className="mt-3 text-center text-xs text-green-ink">✓ You&apos;ve weighed in on every statement.</p>
          )}

          <ProposeStatement entityType={entityType} entityId={entityId} signInNext={signInNext} onProposed={handleProposed} />
        </>
      ) : null}
    </section>
  );
}
