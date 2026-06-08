"use client";

// @deprecated (C0 / FIX-521) — superseded by the unified EntityComments
// component (stage-aware vocab + stance-grouped mode) over the entity_comments
// substrate. No longer imported by the initiative detail page. Left in place
// per the no-delete rule; remove in a later cleanup PR.

import { useState, useEffect, useCallback, useMemo } from "react";

// ─── Types & Config ──────────────────────────────────────────────────────────

type CommentRow = {
  id: string;
  parent_id: string | null;
  comment_type: string | null;
  body: string;
  author_id: string | null;
  is_deleted: boolean;
  flag_count: number;
  vote_count: number;
  created_at: string;
  replies: CommentRow[];
};

type Stage = "problem" | "draft" | "deliberate" | "mobilise" | "resolved";

type TypeConfig = {
  label: string;
  placeholder: string;
  badgeClass: string; // Tailwind classes for the type badge
};

// Must match the ALLOWED_TYPES map in the API route.
const TYPE_CONFIG: Record<string, TypeConfig> = {
  support: {
    label: "Support",
    placeholder: "Make the case for this initiative — why should it move forward?",
    badgeClass: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  oppose: {
    label: "Oppose",
    placeholder: "Explain your objection — what's wrong with this approach?",
    badgeClass: "bg-red-100 text-red-800 border-red-200",
  },
  concern: {
    label: "Concern",
    placeholder: "I support the goal, but I'm worried about… (not full opposition)",
    badgeClass: "bg-amber-100 text-amber-800 border-amber-200",
  },
  amendment: {
    label: "Suggested Change",
    placeholder: "Propose a specific edit or addition to the initiative text…",
    badgeClass: "bg-indigo-100 text-indigo-800 border-indigo-200",
  },
  question: {
    label: "Question",
    placeholder: "What needs clarification before this can move forward?",
    badgeClass: "bg-gray-100 text-gray-700 border-gray-200",
  },
  evidence: {
    label: "Evidence / Data",
    placeholder: "Share research, data, or precedent relevant to this…",
    badgeClass: "bg-slate-100 text-slate-800 border-slate-200",
  },
  precedent: {
    label: "Precedent",
    placeholder: "Has this been tried elsewhere? What was the outcome?",
    badgeClass: "bg-stone-100 text-stone-800 border-stone-200",
  },
  tradeoff: {
    label: "Tradeoff",
    placeholder: "Acknowledge a cost or downside of this approach, even if you support it…",
    badgeClass: "bg-pink-100 text-pink-800 border-pink-200",
  },
  stakeholder_impact: {
    label: "Who's Affected",
    placeholder: "Describe how this affects a specific group or community…",
    badgeClass: "bg-teal-100 text-teal-800 border-teal-200",
  },
  experience: {
    label: "My Experience",
    placeholder: "Describe how this problem has affected you or others you know…",
    badgeClass: "bg-sky-100 text-sky-800 border-sky-200",
  },
  cause: {
    label: "Root Cause",
    placeholder: "What do you think is driving this problem?",
    badgeClass: "bg-orange-100 text-orange-800 border-orange-200",
  },
  solution: {
    label: "Proposed Solution",
    placeholder: "What approach could address this? Be specific if you can…",
    badgeClass: "bg-violet-100 text-violet-800 border-violet-200",
  },
};

const DEFAULT_PLACEHOLDER: Record<Stage, string> = {
  problem: "Share your thoughts on this problem…",
  draft: "Share your thoughts on this initiative…",
  deliberate: "Share your thoughts on this initiative…",
  mobilise: "Share your thoughts on this initiative…",
  resolved: "Share your thoughts on this initiative…",
};

const STAGE_TYPES: Record<Stage, readonly string[]> = {
  problem: ["experience", "cause", "solution", "question", "evidence", "stakeholder_impact"],
  draft: [],
  deliberate: [
    "support", "oppose", "concern", "amendment",
    "question", "evidence", "precedent", "tradeoff", "stakeholder_impact",
  ],
  mobilise: [
    "support", "oppose", "concern", "amendment",
    "question", "evidence", "precedent", "tradeoff", "stakeholder_impact",
  ],
  resolved: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function typeLabel(type: string | null): string {
  if (!type) return "Discussion";
  return TYPE_CONFIG[type]?.label ?? type;
}

function typeBadgeClass(type: string | null): string {
  if (!type) return "bg-gray-50 text-gray-600 border-gray-200";
  return TYPE_CONFIG[type]?.badgeClass ?? "bg-gray-100 text-gray-700 border-gray-200";
}

// ─── VoteButton ───────────────────────────────────────────────────────────────

function VoteButton({
  initiativeId,
  argId,
  initialCount,
  isDeleted,
}: {
  initiativeId: string;
  argId: string;
  initialCount: number;
  isDeleted: boolean;
}) {
  const [count, setCount]     = useState(initialCount);
  const [voted, setVoted]     = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/initiatives/${initiativeId}/arguments/${argId}/vote`)
      .then((r) => r.json())
      .then((d) => setVoted(d.voted ?? false))
      .catch(() => {/* ignore */});
  }, [initiativeId, argId]);

  async function toggle() {
    if (loading || isDeleted) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/arguments/${argId}/vote`, {
        method: "POST",
      });
      if (res.status === 401) {
        window.location.href = `/auth/sign-in?next=/initiatives/${initiativeId}`;
        return;
      }
      const data = await res.json();
      if (res.ok) {
        setVoted(data.voted);
        setCount(data.vote_count);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={loading || isDeleted}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors disabled:opacity-40 ${
        voted
          ? "bg-indigo-100 text-indigo-700"
          : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"
      }`}
      title={voted ? "Remove vote" : "Upvote this comment"}
    >
      <svg className="h-3 w-3" fill={voted ? "currentColor" : "none"} viewBox="0 0 20 20"
        stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l5-5 5 5M5 9l5-5 5 5" />
      </svg>
      <span>{count}</span>
    </button>
  );
}

// ─── FlagButton ───────────────────────────────────────────────────────────────

function FlagButton({
  initiativeId,
  argId,
  authorId,
  currentUserId,
}: {
  initiativeId: string;
  argId: string;
  authorId: string | null;
  currentUserId: string | null;
}) {
  const [flagged, setFlagged] = useState(false);
  const [open, setOpen]       = useState(false);

  const isOwn = currentUserId && authorId === currentUserId;
  if (isOwn) return null;

  async function submitFlag(flagType: string) {
    setOpen(false);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/arguments/${argId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flag_type: flagType }),
      });
      if (res.ok) setFlagged(true);
    } catch {/* ignore */}
  }

  if (flagged) {
    return <span className="text-xs text-gray-400">Flagged</span>;
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-gray-300 hover:text-gray-500 transition-colors"
        title="Flag this comment"
      >
        ⚑
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-10 w-44 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
          {[
            { value: "off_topic",  label: "Off topic" },
            { value: "misleading", label: "Misleading" },
            { value: "duplicate",  label: "Duplicate" },
            { value: "other",      label: "Other" },
          ].map(({ value, label }) => (
            <button
              key={value}
              onClick={() => submitFlag(value)}
              className="block w-full px-3 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setOpen(false)}
            className="block w-full border-t border-gray-100 px-3 py-1.5 text-left text-xs text-gray-400 hover:bg-gray-50 mt-1"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ─── TypeBadge ────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string | null }) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${typeBadgeClass(type)}`}>
      {typeLabel(type)}
    </span>
  );
}

// ─── ReplyForm ────────────────────────────────────────────────────────────────

function ReplyForm({
  initiativeId,
  parentId,
  stage,
  onSubmitted,
  onCancel,
}: {
  initiativeId: string;
  parentId: string;
  stage: Stage;
  onSubmitted: (newReply: CommentRow) => void;
  onCancel: () => void;
}) {
  const stageTypes = STAGE_TYPES[stage];
  const [commentType, setCommentType] = useState<string>(""); // "" = no type
  const [body, setBody]       = useState("");
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const placeholder = commentType
    ? TYPE_CONFIG[commentType]?.placeholder ?? "Write a reply…"
    : "Write a reply… (10–1000 characters)";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (body.trim().length < 10) { setError("At least 10 characters required."); return; }

    setSaving(true);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/arguments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          parent_id: parentId,
          comment_type: commentType || undefined,
        }),
      });
      if (res.status === 401) {
        window.location.href = `/auth/sign-in?next=/initiatives/${initiativeId}`;
        return;
      }
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to post reply."); return; }
      onSubmitted({
        id: data.comment.id,
        parent_id: data.comment.parent_id,
        comment_type: data.comment.comment_type ?? null,
        body: data.comment.body,
        author_id: data.comment.author_id ?? null,
        is_deleted: false,
        flag_count: 0,
        vote_count: 0,
        created_at: data.comment.created_at,
        replies: [],
      });
      setBody("");
      setCommentType("");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 pl-6 border-l-2 border-gray-100">
      {stageTypes.length > 0 && (
        <div className="mb-2">
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
            Reply type (optional)
          </label>
          <select
            value={commentType}
            onChange={(e) => setCommentType(e.target.value)}
            className="block w-full rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          >
            <option value="">Discussion (no type)</option>
            {stageTypes.map((t) => (
              <option key={t} value={t}>{TYPE_CONFIG[t]?.label ?? t}</option>
            ))}
          </select>
        </div>
      )}
      <textarea
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={1000}
        placeholder={placeholder}
        className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none"
        autoFocus
      />
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          type="submit"
          disabled={saving || body.trim().length < 10}
          className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? "Posting…" : "Post reply"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-500 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── CommentCard ──────────────────────────────────────────────────────────────

function CommentCard({
  comment,
  initiativeId,
  stage,
  currentUserId,
  onReplySubmitted,
  depth = 0,
}: {
  comment: CommentRow;
  initiativeId: string;
  stage: Stage;
  currentUserId: string | null;
  onReplySubmitted: (parentId: string, newReply: CommentRow) => void;
  depth?: number;
}) {
  const [showReply, setShowReply] = useState(false);
  const canReply = stage === "problem" || stage === "deliberate" || stage === "mobilise";
  const isNested = depth > 0;

  return (
    <div className={`rounded-lg border bg-white p-3 shadow-sm transition-colors ${isNested ? "border-gray-100 hover:border-gray-200" : "border-gray-200 hover:border-gray-300"}`}>
      <div className="mb-2 flex items-center justify-between">
        <TypeBadge type={comment.comment_type} />
        <span className="text-xs text-gray-300">{formatRelTime(comment.created_at)}</span>
      </div>

      <p className={`text-sm leading-relaxed ${comment.is_deleted ? "italic text-gray-400" : "text-gray-800"}`}>
        {comment.body}
      </p>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <VoteButton
            initiativeId={initiativeId}
            argId={comment.id}
            initialCount={comment.vote_count}
            isDeleted={comment.is_deleted}
          />
          {!comment.is_deleted && canReply && (
            <button
              onClick={() => setShowReply((v) => !v)}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Reply
            </button>
          )}
        </div>
        {!comment.is_deleted && (
          <FlagButton
            initiativeId={initiativeId}
            argId={comment.id}
            authorId={comment.author_id}
            currentUserId={currentUserId}
          />
        )}
      </div>

      {showReply && (
        <ReplyForm
          initiativeId={initiativeId}
          parentId={comment.id}
          stage={stage}
          onSubmitted={(newReply) => {
            onReplySubmitted(comment.id, newReply);
            setShowReply(false);
          }}
          onCancel={() => setShowReply(false)}
        />
      )}

      {comment.replies.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-gray-100 pl-3">
          {comment.replies.map((reply) => (
            <CommentCard
              key={reply.id}
              comment={reply}
              initiativeId={initiativeId}
              stage={stage}
              currentUserId={currentUserId}
              onReplySubmitted={onReplySubmitted}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SubmitCommentForm ────────────────────────────────────────────────────────

function SubmitCommentForm({
  initiativeId,
  stage,
  onSubmitted,
}: {
  initiativeId: string;
  stage: Stage;
  onSubmitted: (comment: CommentRow) => void;
}) {
  const stageTypes = STAGE_TYPES[stage];
  const [commentType, setCommentType] = useState<string>(""); // "" = no type
  const [body, setBody]     = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const placeholder = commentType
    ? TYPE_CONFIG[commentType]?.placeholder ?? DEFAULT_PLACEHOLDER[stage]
    : DEFAULT_PLACEHOLDER[stage];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (body.trim().length < 10) { setError("At least 10 characters required."); return; }

    setSaving(true);
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/arguments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          comment_type: commentType || undefined,
        }),
      });
      if (res.status === 401) {
        window.location.href = `/auth/sign-in?next=/initiatives/${initiativeId}`;
        return;
      }
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to post comment."); return; }
      onSubmitted({
        id: data.comment.id,
        parent_id: null,
        comment_type: data.comment.comment_type ?? null,
        body: data.comment.body,
        author_id: data.comment.author_id ?? null,
        is_deleted: false,
        flag_count: 0,
        vote_count: 0,
        created_at: data.comment.created_at,
        replies: [],
      });
      setBody("");
      setCommentType("");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Add a comment
      </p>

      {/* Type selector */}
      {stageTypes.length > 0 && (
        <div className="mb-3">
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
            Type
          </label>
          <select
            value={commentType}
            onChange={(e) => setCommentType(e.target.value)}
            className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          >
            <option value="">Discussion (no type)</option>
            {stageTypes.map((t) => (
              <option key={t} value={t}>{TYPE_CONFIG[t]?.label ?? t}</option>
            ))}
          </select>
        </div>
      )}

      {/* Textarea */}
      <textarea
        rows={4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={1000}
        placeholder={placeholder}
        className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs tabular-nums ${body.length > 950 ? "text-red-400" : "text-gray-400"}`}>
          {body.length}/1000
        </span>
      </div>

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={saving || body.trim().length < 10}
        className="mt-3 w-full rounded-lg bg-indigo-600 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? "Posting…" : "Post comment"}
      </button>
    </form>
  );
}

// ─── FilterPills ──────────────────────────────────────────────────────────────

function FilterPills({
  counts,
  total,
  activeFilter,
  onChange,
}: {
  counts: Record<string, number>;
  total: number;
  activeFilter: string | null;
  onChange: (next: string | null) => void;
}) {
  // Build ordered list of pills: stable order via TYPE_CONFIG keys, plus any
  // unknown types (projected from legacy data) at the end.
  const knownOrdered = Object.keys(TYPE_CONFIG).filter((t) => (counts[t] ?? 0) > 0);
  const unknown = Object.keys(counts).filter(
    (t) => t !== "__discussion__" && !(t in TYPE_CONFIG) && (counts[t] ?? 0) > 0
  );
  const pills: Array<{ key: string | null; label: string; count: number }> = [
    { key: null, label: "All", count: total },
    ...knownOrdered.map((t) => ({ key: t, label: TYPE_CONFIG[t]?.label ?? t, count: counts[t] ?? 0 })),
    ...unknown.map((t) => ({ key: t, label: t, count: counts[t] ?? 0 })),
  ];
  // "Discussion" (untyped) pill only if there are untyped comments
  if ((counts.__discussion__ ?? 0) > 0) {
    pills.push({ key: "__discussion__", label: "Discussion", count: counts.__discussion__ ?? 0 });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
      {pills.map((p) => {
        const active = activeFilter === p.key;
        return (
          <button
            key={p.key ?? "all"}
            type="button"
            onClick={() => onChange(p.key)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
              active
                ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
            }`}
          >
            {p.label} <span className="ml-1 tabular-nums text-gray-400">{p.count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── ArgumentBoard ────────────────────────────────────────────────────────────

interface ArgumentBoardProps {
  initiativeId: string;
  stage: string;
  currentUserId: string | null;
}

export function ArgumentBoard({ initiativeId, stage, currentUserId }: ArgumentBoardProps) {
  const stageTyped = (["problem", "draft", "deliberate", "mobilise", "resolved"].includes(stage)
    ? stage
    : "draft") as Stage;

  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const canSubmit = stageTyped === "problem" || stageTyped === "deliberate" || stageTyped === "mobilise";

  const fetchComments = useCallback(async () => {
    try {
      const res = await fetch(`/api/initiatives/${initiativeId}/arguments`);
      const data = await res.json();
      if (res.ok) {
        setComments(data.comments ?? []);
      } else {
        setError(data.error ?? "Failed to load comments.");
      }
    } catch {
      setError("Failed to load comments.");
    } finally {
      setLoading(false);
    }
  }, [initiativeId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  // Counts per type (top-level only). Untyped tracked under "__discussion__".
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const row of comments) {
      const key = row.comment_type ?? "__discussion__";
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [comments]);

  const filtered = useMemo(() => {
    if (activeFilter === null) return comments;
    if (activeFilter === "__discussion__") {
      return comments.filter((c) => c.comment_type === null);
    }
    return comments.filter((c) => c.comment_type === activeFilter);
  }, [comments, activeFilter]);

  function handleNewComment(newComment: CommentRow) {
    // Prepend the fresh comment so the author sees it immediately, even though
    // it has 0 votes and would otherwise sink below older comments. The list
    // re-sorts on the next fetch.
    setComments((prev) => [newComment, ...prev]);
  }

  function addReplyToTree(comments: CommentRow[], parentId: string, newReply: CommentRow): CommentRow[] {
    return comments.map((c) => {
      if (c.id === parentId) return { ...c, replies: [...c.replies, newReply] };
      if (c.replies.length > 0) return { ...c, replies: addReplyToTree(c.replies, parentId, newReply) };
      return c;
    });
  }

  function handleReplySubmitted(parentId: string, newReply: CommentRow) {
    setComments((prev) => addReplyToTree(prev, parentId, newReply));
  }

  const header = stageTyped === "problem" ? "Community input" : "Argument board";
  const subheader = stageTyped === "problem"
    ? "Share experiences, causes, solutions, and evidence. Upvote what resonates."
    : "Best-supported comments rise. Upvote reasoning you find most compelling.";

  return (
    <div className="mt-10">
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-gray-900">{header}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{subheader}</p>
        </div>
        <span className="rounded-full bg-gray-100 px-3 py-0.5 text-xs font-semibold text-gray-600">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Draft lockout */}
      {stageTyped === "draft" && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          Comments open once this initiative is in deliberation.
        </div>
      )}

      {/* Filter pills */}
      {comments.length > 0 && (
        <div className="mb-4">
          <FilterPills
            counts={counts}
            total={comments.length}
            activeFilter={activeFilter}
            onChange={setActiveFilter}
          />
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="text-center py-10 text-sm text-gray-400">Loading comments…</div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : comments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center">
          <p className="text-sm text-gray-400">
            No comments yet. <span className="text-gray-500">Be the first.</span>
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 px-4 py-6 text-center">
          <p className="text-xs text-gray-400">
            No comments match this filter.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              initiativeId={initiativeId}
              stage={stageTyped}
              currentUserId={currentUserId}
              onReplySubmitted={handleReplySubmitted}
            />
          ))}
        </div>
      )}

      {/* Submit form */}
      {canSubmit && (
        <div className="mt-6">
          <SubmitCommentForm
            initiativeId={initiativeId}
            stage={stageTyped}
            onSubmitted={handleNewComment}
          />
        </div>
      )}
    </div>
  );
}
