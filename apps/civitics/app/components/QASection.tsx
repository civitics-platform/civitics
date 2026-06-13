"use client";

// C1 Wave D (FIX-538): citizen↔official Q&A lane.
//
// The first citizen↔official surface. Citizens ask a public question; the
// verified official (a holder of an active 'official' grant — issued manually in
// beta) answers on the record. "Awaiting response" is itself a visible record:
// the archive and the silence signal work with zero official engagement.
//
// Q&A is a MODE over entity_comments, not new tables (decision 1): a question is
// kind='question'; an official answer is a reply with kind='answer', gated by
// RLS to grant holders. Want-answered reuses the comment rating (valuable=+1 —
// decision 6); flagging reuses the comment flag. Officials-only this wave
// (decision 2). Pseudonymous display names only (decision 10).

import { useCallback, useEffect, useState } from "react";
import { BODY_MIN, BODY_MAX } from "@civitics/db";
import { challengedFetch } from "@/lib/challenged-fetch";

type Answer = {
  id: string;
  body: string;
  created_at: string;
  is_official: boolean;
  author_name: string;
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

export interface QASectionProps {
  entityId: string;
  officialName: string;
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

  if (done) return <span className="text-[10px] text-gray-400">Flagged · thanks</span>;

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
        className="text-[10px] text-gray-300 hover:text-red-600"
        aria-label="Flag question"
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

// ─── Ask composer (kind='question') ───────────────────────────────────────────
function AskComposer({
  entityId,
  signInNext,
  onAsked,
}: {
  entityId: string;
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
        body: JSON.stringify({ entity_type: "official", entity_id: entityId, kind: "question", body: body.trim() }),
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
        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
      >
        {done ? "Ask another question" : "Ask a question"}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-gray-200 bg-white p-3">
      <label className="mb-1 block text-xs font-medium text-gray-600">
        Ask {`a public question`} — it stays on the record whether or not it&apos;s answered.
      </label>
      <textarea
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
        maxLength={BODY_MAX}
        placeholder="e.g. Will you support the transit funding bill this session?"
        className="block w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs tabular-nums ${body.length > BODY_MAX - 100 ? "text-amber-500" : "text-gray-400"}`}>
          {body.length}/{BODY_MAX}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-500 hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || body.trim().length < BODY_MIN}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "Posting…" : "Post question"}
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </form>
  );
}

// ─── Official answer composer (only rendered when can_answer) ──────────────────
function AnswerComposer({
  entityId,
  questionId,
  officialName,
  signInNext,
  onAnswered,
}: {
  entityId: string;
  questionId: string;
  officialName: string;
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
          entity_type: "official",
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
        className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
      >
        Answer as {officialName}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
      <label className="mb-1 block text-xs font-medium text-emerald-800">
        Official response — posted on the record as {officialName}
      </label>
      <textarea
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
        maxLength={BODY_MAX}
        className="block w-full resize-none rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm text-gray-900 focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-500 hover:bg-gray-50">
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || body.trim().length < BODY_MIN}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? "Posting…" : "Post answer"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </form>
  );
}

// ─── Question card ─────────────────────────────────────────────────────────────
function QuestionCard({
  q,
  entityId,
  canAnswer,
  officialName,
  signInNext,
  onChanged,
}: {
  q: Question;
  entityId: string;
  canAnswer: boolean;
  officialName: string;
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
    <li className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {q.answered ? (
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
            ✓ Answered
          </span>
        ) : (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            Awaiting response since {formatDate(q.created_at)}
          </span>
        )}
        {q.status === "needs_review" && (
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-500">
            Under review
          </span>
        )}
      </div>

      <p className="text-sm font-medium leading-relaxed text-gray-900">{q.body}</p>

      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500">
        <span>Asked by {q.asker_name}</span>
        {q.is_constituent && (
          <span className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700" title="Asked by a verified constituent">
            ✓ Constituent
          </span>
        )}
      </div>

      {/* Official-response lane */}
      {q.answers.length > 0 && (
        <div className="mt-3 space-y-2">
          {q.answers.map((a) => (
            <div key={a.id} className="rounded-lg border-l-4 border-emerald-400 bg-emerald-50/50 p-3">
              <div className="mb-1 flex items-center gap-1.5">
                <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                  Official response
                </span>
                <span className="text-[11px] text-emerald-800">{a.author_name}</span>
                <span className="text-[10px] text-gray-400">· {formatDate(a.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">{a.body}</p>
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
              ? "border-indigo-600 bg-indigo-600 text-white"
              : "border-indigo-200 text-indigo-700 hover:bg-indigo-50"
          }`}
        >
          ▲ I want this answered · {wantCount}
        </button>
        <FlagMenu questionId={q.id} signInNext={signInNext} />
      </div>

      {canAnswer && (
        <AnswerComposer
          entityId={entityId}
          questionId={q.id}
          officialName={officialName}
          signInNext={signInNext}
          onAnswered={onChanged}
        />
      )}
    </li>
  );
}

// ─── QASection ─────────────────────────────────────────────────────────────────
export function QASection({ entityId, officialName, signInNext }: QASectionProps) {
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
      const sp = new URLSearchParams({ official_id: entityId, sort });
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
  }, [entityId, sort]);

  useEffect(() => { void load(); }, [load]);

  // FIX-540: append the next keyset page. ask/answer actions still call load()
  // (full reset to page one) — fine for the rare write, cheap for the read.
  async function loadMore() {
    const cursor = data?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const sp = new URLSearchParams({ official_id: entityId, sort, cursor });
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
    <section className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-gray-900">Questions for {officialName}</h3>
        <AskComposer entityId={entityId} signInNext={next} onAsked={load} />
      </div>
      <p className="mb-3 text-xs text-gray-500">
        {total > 0
          ? `${total} ${total === 1 ? "question" : "questions"} · ${awaiting} awaiting response`
          : "Ask this official a public question — on the record, answered or not."}
      </p>

      {total > 0 && (
        <div className="mb-3 flex gap-1.5">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSort(s.key)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                sort === s.key ? "bg-gray-800 text-white" : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-100"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="py-6 text-center text-sm text-gray-400">Loading…</div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : questions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-400">
          No questions yet. <span className="text-gray-500">Be the first to ask {officialName} a question.</span>
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {questions.map((q) => (
              <QuestionCard
                key={q.id}
                q={q}
                entityId={entityId}
                canAnswer={canAnswer}
                officialName={officialName}
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
                className="rounded-lg border border-gray-200 px-4 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
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
