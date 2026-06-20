"use client";

// C1 Wave D (FIX-538): citizen↔answerer Q&A lane.
//
// Citizens ask a public question; the verified answerer (a holder of the active
// answerer grant for that entity — issued manually in beta) answers on the
// record. "Awaiting response" is itself a visible record: the archive and the
// silence signal work with zero answerer engagement.
//
// Q&A is a MODE over entity_comments, not new tables (decision 1): a question is
// kind='question'; an answer is a reply with kind='answer', gated server-side
// (submit_comment's has_active_answerer_grant) to the per-type grant holder.
// Want-answered reuses the comment rating (valuable=+1 — decision 6); flagging
// reuses the comment flag. Pseudonymous display names only (decision 10).
//
// FIX-610: generalized from officials-only to every entity_type that can hold an
// answerer grant — official, institution (agencies + governing bodies), and
// jurisdiction. The entity_type is threaded through so the question/answer posts
// and the read RPC target the right entity + answerer role.

import { useCallback, useEffect, useState } from "react";
import { BODY_MIN, BODY_MAX } from "@civitics/db";
import { challengedFetch } from "@/lib/challenged-fetch";
import { SyntheticMark } from "./integrity/Synthetic";

type Answer = {
  id: string;
  body: string;
  created_at: string;
  is_official: boolean;
  author_name: string;
  author_is_synthetic?: boolean;
};

type Question = {
  id: string;
  body: string;
  status: string;
  created_at: string;
  want_count: number;
  answered: boolean;
  answered_at: string | null;
  is_constituent: boolean;
  asker_name: string;
  asker_is_synthetic?: boolean;
  answers: Answer[];
};

type QuestionsResponse = {
  can_answer: boolean;
  total: number;
  awaiting: number;
  questions: Question[];
  // FIX-540: keyset cursor; null when the last page is loaded.
  nextCursor: string | null;
};

type SortKey = "wanted" | "newest" | "unanswered";

// The entity_types the Q&A lane supports (mirrors the answerer-grant mapping in
// submit_comment / has_active_answerer_grant). All accept kind='question'; an
// answer requires the matching answerer grant.
export type QAEntityType = "official" | "institution" | "jurisdiction";

export interface QASectionProps {
  entityId: string;
  entityType: QAEntityType;
  entityName: string;
  signInNext?: string;
}

const FLAG_REASONS = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "off_topic", label: "Off-topic" },
  { value: "misinformation", label: "Misinformation" },
  { value: "other", label: "Other" },
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "wanted", label: "Most wanted" },
  { key: "unanswered", label: "Awaiting" },
  { key: "newest", label: "Newest" },
];

function redirectToSignIn(next: string) {
  window.location.href = `/auth/sign-in?next=${encodeURIComponent(next)}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

// ─── Per-question flag menu (reuses the comment flag endpoint) ────────────────
function FlagMenu({ questionId, signInNext }: { questionId: string; signInNext: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("spam");
  const [busy, setBusy] = useState(false);

  if (done) return <span className="text-[10px] text-ink-soft/60">Flagged · thanks</span>;

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/comments/${questionId}/flag`, {
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
        aria-label="Flag question"
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

// ─── Ask composer (kind='question') ───────────────────────────────────────────
function AskComposer({
  entityId,
  entityType,
  signInNext,
  onAsked,
}: {
  entityId: string;
  entityType: QAEntityType;
  signInNext: string;
  onAsked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (body.trim().length < BODY_MIN) {
      setError(`At least ${BODY_MIN} characters.`);
      return;
    }
    setBusy(true);
    try {
      const res = await challengedFetch(`/api/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, kind: "question", body: body.trim() }),
      });
      if (res.status === 401) return redirectToSignIn(signInNext);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to post your question.");
        return;
      }
      setBody("");
      setDone(true);
      setOpen(false);
      onAsked();
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
        className="bg-ink px-3 py-1.5 text-xs font-semibold text-paper hover:bg-accent transition-colors"
      >
        {done ? "Ask another question" : "Ask a question"}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="border border-rule bg-card p-3">
      <label className="mb-1 block text-xs font-medium text-ink-soft">
        Ask {`a public question`} — it stays on the record whether or not it&apos;s answered.
      </label>
      <textarea
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
        maxLength={BODY_MAX}
        placeholder="e.g. Will you support the transit funding bill this session?"
        className="block w-full resize-none border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-soft/50 focus:border-ink focus:bg-card focus:outline-none focus:ring-1 focus:ring-ink"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs tabular-nums ${body.length > BODY_MAX - 100 ? "text-accent" : "text-ink-soft/60"}`}>
          {body.length}/{BODY_MAX}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setOpen(false)} className="border border-rule px-3 py-1 text-xs text-ink-soft hover:bg-paper-2">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || body.trim().length < BODY_MIN}
            className="bg-ink px-3 py-1.5 text-xs font-semibold text-paper hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {busy ? "Posting…" : "Post question"}
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-accent">{error}</p>}
    </form>
  );
}

// ─── Official answer composer (only rendered when can_answer) ──────────────────
function AnswerComposer({
  entityId,
  entityType,
  questionId,
  entityName,
  signInNext,
  onAnswered,
}: {
  entityId: string;
  entityType: QAEntityType;
  questionId: string;
  entityName: string;
  signInNext: string;
  onAnswered: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (body.trim().length < BODY_MIN) {
      setError(`At least ${BODY_MIN} characters.`);
      return;
    }
    setBusy(true);
    try {
      const res = await challengedFetch(`/api/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          kind: "answer",
          parent_id: questionId,
          body: body.trim(),
        }),
      });
      if (res.status === 401) return redirectToSignIn(signInNext);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to post your answer.");
        return;
      }
      setBody("");
      setOpen(false);
      onAnswered();
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
        onClick={() => setOpen(true)}
        className="mt-2 border border-green-ink/30 bg-green-ink/10 px-3 py-1 text-xs font-semibold text-green-ink hover:bg-green-ink/20"
      >
        Answer as {entityName}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 border border-green-ink/25 bg-green-ink/5 p-3">
      <label className="mb-1 block text-xs font-medium text-green-ink">
        Official response — posted on the record as {entityName}
      </label>
      <textarea
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
        maxLength={BODY_MAX}
        className="block w-full resize-none border border-green-ink/25 bg-card px-3 py-2 text-sm text-ink focus:border-green-ink focus:outline-none focus:ring-1 focus:ring-green-ink"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="border border-rule px-3 py-1 text-xs text-ink-soft hover:bg-paper-2">
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || body.trim().length < BODY_MIN}
          className="bg-green-ink px-3 py-1.5 text-xs font-semibold text-paper hover:bg-green-ink/90 disabled:opacity-50"
        >
          {busy ? "Posting…" : "Post answer"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-accent">{error}</p>}
    </form>
  );
}

// ─── Question card ─────────────────────────────────────────────────────────────
function QuestionCard({
  q,
  entityId,
  entityType,
  canAnswer,
  entityName,
  signInNext,
  onChanged,
}: {
  q: Question;
  entityId: string;
  entityType: QAEntityType;
  canAnswer: boolean;
  entityName: string;
  signInNext: string;
  onChanged: () => void;
}) {
  const [wantCount, setWantCount] = useState(q.want_count);
  const [wanted, setWanted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function wantAnswered() {
    if (busy || wanted) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/comments/${q.id}/rate`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valuable: 1 }),
      });
      if (res.status === 401) return redirectToSignIn(signInNext);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setWanted(true);
        const up = data?.rating_summary?.valuable_up;
        setWantCount(typeof up === "number" ? up : wantCount + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border border-rule bg-card p-4">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {q.answered ? (
          <span className="rounded-full border border-green-ink/25 bg-green-ink/10 px-2 py-0.5 text-[10px] font-semibold text-green-ink">
            ✓ Answered
          </span>
        ) : (
          <span className="rounded-full border border-amber/60 bg-amber/25 px-2 py-0.5 text-[10px] font-medium text-ink">
            Awaiting response since {formatDate(q.created_at)}
          </span>
        )}
        {q.status === "needs_review" && (
          <span className="rounded-full border border-rule bg-paper-2 px-2 py-0.5 text-[10px] font-medium text-ink-soft">
            Under review
          </span>
        )}
      </div>

      <p className="text-sm font-medium leading-relaxed text-ink">{q.body}</p>

      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-soft">
        <span>Asked by {q.asker_name}</span>
        {q.asker_is_synthetic && <SyntheticMark size="xs" />}
        {q.is_constituent && (
          <span className="rounded-full border border-civic-blue/25 bg-civic-blue/10 px-1.5 py-0.5 text-[10px] font-medium text-civic-blue" title="Asked by a verified constituent">
            ✓ Constituent
          </span>
        )}
      </div>

      {/* Official-response lane */}
      {q.answers.length > 0 && (
        <div className="mt-3 space-y-2">
          {q.answers.map((a) => (
            <div key={a.id} className="border-l-4 border-green-ink bg-green-ink/5 p-3">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="rounded-full bg-green-ink px-2 py-0.5 text-[10px] font-semibold text-paper">
                  Official response
                </span>
                <span className="text-[11px] text-green-ink">{a.author_name}</span>
                {a.author_is_synthetic && <SyntheticMark size="xs" />}
                <span className="text-[10px] text-ink-soft/60">· {formatDate(a.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{a.body}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={wantAnswered}
          disabled={busy}
          aria-pressed={wanted}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            wanted
              ? "border-ink bg-ink text-paper"
              : "border-rule text-ink-soft hover:bg-paper-2"
          }`}
        >
          ▲ I want this answered · {wantCount}
        </button>
        <FlagMenu questionId={q.id} signInNext={signInNext} />
      </div>

      {canAnswer && (
        <AnswerComposer
          entityId={entityId}
          entityType={entityType}
          questionId={q.id}
          entityName={entityName}
          signInNext={signInNext}
          onAnswered={onChanged}
        />
      )}
    </li>
  );
}

// ─── QASection ─────────────────────────────────────────────────────────────────
export function QASection({ entityId, entityType, entityName, signInNext }: QASectionProps) {
  const next = signInNext ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  const [data, setData] = useState<QuestionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("wanted");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, sort });
      const res = await fetch(`/api/questions?${sp.toString()}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to load questions.");
        return;
      }
      setData(json as QuestionsResponse);
    } catch {
      setError("Failed to load questions.");
    } finally {
      setLoading(false);
    }
  }, [entityId, entityType, sort]);

  useEffect(() => { void load(); }, [load]);

  // FIX-540: append the next keyset page. ask/answer actions still call load()
  // (full reset to page one) — fine for the rare write, cheap for the read.
  async function loadMore() {
    const cursor = data?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, sort, cursor });
      const res = await fetch(`/api/questions?${sp.toString()}`);
      const json = (await res.json()) as QuestionsResponse;
      if (res.ok) {
        setData((prev) =>
          prev
            ? {
                ...json,
                questions: [
                  ...prev.questions,
                  ...json.questions.filter((q) => !prev.questions.some((p) => p.id === q.id)),
                ],
              }
            : json,
        );
      }
    } catch {
      // Cursor stays — the button remains available to retry.
    } finally {
      setLoadingMore(false);
    }
  }

  const total = data?.total ?? 0;
  const awaiting = data?.awaiting ?? 0;
  const canAnswer = data?.can_answer ?? false;
  const questions = data?.questions ?? [];

  return (
    <section className="border border-rule bg-paper-2 p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-ink">Questions for {entityName}</h3>
        <AskComposer entityId={entityId} entityType={entityType} signInNext={next} onAsked={load} />
      </div>
      <p className="mb-3 text-xs text-ink-soft">
        {total > 0
          ? `${total} ${total === 1 ? "question" : "questions"} · ${awaiting} awaiting response`
          : "Ask a public question — on the record, answered or not."}
      </p>

      {total > 0 && (
        <div className="mb-3 flex gap-1.5">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSort(s.key)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                sort === s.key ? "bg-ink text-paper" : "bg-card text-ink-soft border border-rule hover:bg-paper-2"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="py-6 text-center text-sm text-ink-soft/60">Loading…</div>
      ) : error ? (
        <div className="border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-accent">{error}</div>
      ) : questions.length === 0 ? (
        <div className="border border-dashed border-rule bg-card px-4 py-8 text-center text-sm text-ink-soft/60">
          No questions yet. <span className="text-ink-soft">Be the first to ask {entityName} a question.</span>
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {questions.map((q) => (
              <QuestionCard
                key={q.id}
                q={q}
                entityId={entityId}
                entityType={entityType}
                canAnswer={canAnswer}
                entityName={entityName}
                signInNext={next}
                onChanged={load}
              />
            ))}
          </ul>
          {data?.nextCursor && (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="border border-rule px-4 py-1.5 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more questions"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
