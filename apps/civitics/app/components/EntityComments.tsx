"use client";

// Unified comments UI (C0 / FIX-521) — one component over the entity_comments
// substrate, replacing CivicComments / OfficialComments / ArgumentBoard. Typed
// kind composer, two-axis (agree / valuable) ratings, constituent badge, flag
// menu, bridge/newest/top sort (bridge default), list⇄map view switch (C1 Wave
// B debate map), optional constituent lens, optional stance-grouped (for/against)
// visual mode for initiatives. Pseudonymous display_name only.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ALLOWED_KINDS,
  DEFAULT_KIND,
  kindLabel,
  MAX_THREAD_DEPTH,
  type EntityCommentType,
} from "@civitics/db";
import { DebateMap } from "./DebateMap";
import { FOCUS_COMMENT_EVENT, commentDomId, type FocusCommentDetail } from "./comment-focus";

// C1 Wave B (FIX-529): a comment "bridges divides" when its cross-stance balance
// (map_y) is high.
const BRIDGE_MARKER_MIN = 0.6;

// ─── Types ────────────────────────────────────────────────────────────────────

type RatingSummary = {
  agree_up: number;
  agree_down: number;
  valuable_up: number;
  valuable_down: number;
  legacy_upvotes: number;
  // C1 (FIX-525): count of position changes attributed to this comment.
  deltas: number;
};

type Comment = {
  id: string;
  entity_type: string;
  entity_id: string;
  parent_id: string | null;
  thread_root_id: string | null;
  kind: string;
  kind_label: string;
  stance: string | null;
  body: string;
  status: string;
  author_id: string;
  author_name: string;
  is_constituent: boolean;
  rating_summary: RatingSummary;
  // C1 Wave B (FIX-528): nightly bridge scorer output; NULL until scored.
  bridge_score: number | null;
  map_x: number | null;
  map_y: number | null;
  created_at: string;
  updated_at: string;
  replies: Comment[];
};

export interface EntityCommentsProps {
  entityType: EntityCommentType;
  entityId: string;
  allowedKinds?: readonly string[];
  stanceEnabled?: boolean;
  lensEnabled?: boolean;
  /** Initiative-style for/against grouped layout. */
  stanceGrouped?: boolean;
  /** Read-only stages hide the composer. */
  composerEnabled?: boolean;
  heading?: string;
  subheading?: string;
  /** Start collapsed (jurisdiction / institution pages). */
  startCollapsed?: boolean;
  signInNext?: string;
}

// ─── Presentation config (badge colors are presentation → kept in the UI) ─────

const KIND_BADGE: Record<string, string> = {
  discussion: "bg-gray-50 text-gray-600 border-gray-200",
  support: "bg-emerald-100 text-emerald-800 border-emerald-200",
  oppose: "bg-red-100 text-red-800 border-red-200",
  concern: "bg-amber-100 text-amber-800 border-amber-200",
  amendment: "bg-indigo-100 text-indigo-800 border-indigo-200",
  question: "bg-gray-100 text-gray-700 border-gray-200",
  evidence: "bg-slate-100 text-slate-800 border-slate-200",
  precedent: "bg-stone-100 text-stone-800 border-stone-200",
  tradeoff: "bg-pink-100 text-pink-800 border-pink-200",
  stakeholder_impact: "bg-teal-100 text-teal-800 border-teal-200",
  experience: "bg-sky-100 text-sky-800 border-sky-200",
  cause: "bg-orange-100 text-orange-800 border-orange-200",
  solution: "bg-violet-100 text-violet-800 border-violet-200",
};

const STANCE_LABEL: Record<string, string> = {
  support: "Supports",
  oppose: "Opposes",
  conditional: "Conditional",
  neutral: "Neutral",
};

const FLAG_REASON_OPTIONS = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "off_topic", label: "Off-topic" },
  { value: "misinformation", label: "Misinformation" },
  { value: "other", label: "Other" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelTime(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function badgeClass(kind: string): string {
  return KIND_BADGE[kind] ?? "bg-gray-100 text-gray-700 border-gray-200";
}

function redirectToSignIn(next: string) {
  window.location.href = `/auth/sign-in?next=${encodeURIComponent(next)}`;
}

// ─── Rating controls (two-axis, optimistic, auth-gated) ───────────────────────

function RatingControls({
  comment,
  signInNext,
}: {
  comment: Comment;
  signInNext: string;
}) {
  const [summary, setSummary] = useState<RatingSummary>(comment.rating_summary);
  const [myAgree, setMyAgree] = useState<number>(0);
  const [myValuable, setMyValuable] = useState<number>(0);
  const [busy, setBusy] = useState(false);

  async function send(axis: "agree" | "valuable", next: number) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/comments/${comment.id}/rate`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [axis]: next }),
      });
      if (res.status === 401) {
        redirectToSignIn(signInNext);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.rating_summary) setSummary(data.rating_summary);
    } finally {
      setBusy(false);
    }
  }

  function toggle(axis: "agree" | "valuable", value: 1 | -1) {
    const cur = axis === "agree" ? myAgree : myValuable;
    const next = cur === value ? 0 : value;
    if (axis === "agree") setMyAgree(next);
    else setMyValuable(next);
    void send(axis, next);
  }

  const agreeNet = summary.agree_up - summary.agree_down;
  const valuableNet = summary.valuable_up - summary.valuable_down + summary.legacy_upvotes;

  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="flex items-center gap-1" title="Do you agree?">
        <button
          type="button"
          onClick={() => toggle("agree", 1)}
          disabled={busy}
          className={`rounded px-1 ${myAgree === 1 ? "bg-emerald-100 text-emerald-700" : "text-gray-400 hover:text-emerald-600"}`}
          aria-label="Agree"
        >
          ▲
        </button>
        <span className="tabular-nums text-gray-500">{agreeNet}</span>
        <button
          type="button"
          onClick={() => toggle("agree", -1)}
          disabled={busy}
          className={`rounded px-1 ${myAgree === -1 ? "bg-red-100 text-red-700" : "text-gray-400 hover:text-red-600"}`}
          aria-label="Disagree"
        >
          ▼
        </button>
      </div>
      <button
        type="button"
        onClick={() => toggle("valuable", 1)}
        disabled={busy}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${myValuable === 1 ? "bg-indigo-100 text-indigo-700" : "text-gray-400 hover:text-indigo-600"}`}
        title="Valuable to the discussion (even if you disagree)"
      >
        ★ <span className="tabular-nums">{valuableNet}</span>
      </button>
    </div>
  );
}

// ─── Flag menu ────────────────────────────────────────────────────────────────

function FlagMenu({ commentId, signInNext }: { commentId: string; signInNext: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [reason, setReason] = useState("spam");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (done) return <span className="text-[10px] text-gray-400">Flagged · thanks</span>;

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/comments/${commentId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, note: note.trim() || undefined }),
      });
      if (res.status === 401) {
        redirectToSignIn(signInNext);
        return;
      }
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
        aria-label="Flag comment"
      >
        ⚑ Flag
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-20 w-60 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs"
          >
            {FLAG_REASON_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Add context (optional)"
            className="mt-2 w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs resize-none"
          />
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

// ─── Composer ─────────────────────────────────────────────────────────────────

function Composer({
  entityType,
  entityId,
  parentId,
  allowedKinds,
  stanceEnabled,
  signInNext,
  onPosted,
  onCancel,
  compact,
}: {
  entityType: EntityCommentType;
  entityId: string;
  parentId?: string;
  allowedKinds: readonly string[];
  stanceEnabled: boolean;
  signInNext: string;
  onPosted: (c: Comment) => void;
  onCancel?: () => void;
  compact?: boolean;
}) {
  const [kind, setKind] = useState<string>(DEFAULT_KIND);
  const [stance, setStance] = useState<string>("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kinds = allowedKinds.length > 0 ? allowedKinds : [DEFAULT_KIND];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (body.trim().length < 10) {
      setError("At least 10 characters required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          parent_id: parentId,
          kind,
          stance: stanceEnabled && stance ? stance : undefined,
          body: body.trim(),
        }),
      });
      if (res.status === 401) {
        redirectToSignIn(signInNext);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to post.");
        return;
      }
      onPosted(data.comment);
      setBody("");
      setKind(DEFAULT_KIND);
      setStance("");
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className={compact ? "mt-2" : "rounded-xl border border-gray-200 bg-white p-4 shadow-sm"}>
      {kinds.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                kind === k ? "border-indigo-400 bg-indigo-50 text-indigo-700" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {kindLabel(k)}
            </button>
          ))}
        </div>
      )}
      {stanceEnabled && (
        <select
          value={stance}
          onChange={(e) => setStance(e.target.value)}
          className="mb-2 block rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
        >
          <option value="">No stance</option>
          <option value="support">Support</option>
          <option value="oppose">Oppose</option>
          <option value="conditional">Conditional</option>
          <option value="neutral">Neutral</option>
        </select>
      )}
      <textarea
        rows={compact ? 3 : 4}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={2000}
        placeholder={parentId ? "Write a reply… (10–2000 characters)" : "Add a comment… (10–2000 characters)"}
        className="block w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs tabular-nums ${body.length > 1900 ? "text-red-400" : "text-gray-400"}`}>{body.length}/2000</span>
        <div className="flex gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel} className="rounded-lg border border-gray-200 px-3 py-1 text-xs text-gray-500 hover:bg-gray-50">
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={saving || body.trim().length < 10}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? "Posting…" : parentId ? "Reply" : "Post"}
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </form>
  );
}

// ─── Comment card (recursive) ─────────────────────────────────────────────────

function CommentCard({
  comment,
  entityType,
  entityId,
  allowedKinds,
  stanceEnabled,
  signInNext,
  onReplyPosted,
  highlightId,
  depth = 0,
}: {
  comment: Comment;
  entityType: EntityCommentType;
  entityId: string;
  allowedKinds: readonly string[];
  stanceEnabled: boolean;
  signInNext: string;
  onReplyPosted: (parentId: string, reply: Comment) => void;
  highlightId: string | null;
  depth?: number;
}) {
  const [showReply, setShowReply] = useState(false);
  const collapsed = comment.status === "needs_review";
  const selected = highlightId === comment.id;
  const ref = useRef<HTMLDivElement>(null);
  const bridges = comment.map_y != null && comment.map_y >= BRIDGE_MARKER_MIN;

  // When the map or highlights strip selects this comment, bring it into view.
  useEffect(() => {
    if (selected && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [selected]);

  return (
    <div
      ref={ref}
      id={commentDomId(comment.id)}
      className={`scroll-mt-24 rounded-lg border bg-white p-3 shadow-sm transition-shadow ${
        selected ? "border-indigo-400 ring-2 ring-indigo-300" : depth > 0 ? "border-gray-100" : "border-gray-200"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeClass(comment.kind)}`}>
            {comment.kind_label}
          </span>
          {comment.stance && STANCE_LABEL[comment.stance] && (
            <span className="inline-block rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600">
              {STANCE_LABEL[comment.stance]}
            </span>
          )}
          {comment.is_constituent && (
            <span className="inline-block rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700" title="Verified constituent at post time">
              ✓ Constituent
            </span>
          )}
          {comment.rating_summary.deltas > 0 && (
            <span
              className="inline-block rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700"
              title="Readers changed their position and credited this comment"
            >
              ↺ changed {comment.rating_summary.deltas} {comment.rating_summary.deltas === 1 ? "mind" : "minds"}
            </span>
          )}
          {bridges && (
            <span
              className="inline-block rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700"
              title="Valued by people on both sides of this debate"
            >
              ⇄ bridges divides
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-gray-300">{formatRelTime(comment.created_at)}</span>
      </div>

      <div className="mb-1 text-xs font-medium text-gray-500">{comment.author_name}</div>

      {collapsed ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-amber-600">This comment was flagged and is under review — show anyway</summary>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed text-gray-800">{comment.body}</p>
        </details>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">{comment.body}</p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <RatingControls comment={comment} signInNext={signInNext} />
          {depth < MAX_THREAD_DEPTH && (
            <button onClick={() => setShowReply((v) => !v)} className="text-xs text-gray-400 hover:text-gray-600">
              Reply
            </button>
          )}
        </div>
        <FlagMenu commentId={comment.id} signInNext={signInNext} />
      </div>

      {showReply && (
        <Composer
          entityType={entityType}
          entityId={entityId}
          parentId={comment.id}
          allowedKinds={allowedKinds}
          stanceEnabled={stanceEnabled}
          signInNext={signInNext}
          compact
          onCancel={() => setShowReply(false)}
          onPosted={(reply) => {
            onReplyPosted(comment.id, reply);
            setShowReply(false);
          }}
        />
      )}

      {comment.replies.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-gray-100 pl-3">
          {comment.replies.map((r) => (
            <CommentCard
              key={r.id}
              comment={r}
              entityType={entityType}
              entityId={entityId}
              allowedKinds={allowedKinds}
              stanceEnabled={stanceEnabled}
              signInNext={signInNext}
              onReplyPosted={onReplyPosted}
              highlightId={highlightId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── EntityComments ───────────────────────────────────────────────────────────

export function EntityComments({
  entityType,
  entityId,
  allowedKinds,
  stanceEnabled = false,
  lensEnabled = false,
  stanceGrouped = false,
  composerEnabled = true,
  heading = "Community comments",
  subheading,
  startCollapsed = false,
  signInNext,
}: EntityCommentsProps) {
  const kinds = allowedKinds ?? ALLOWED_KINDS[entityType];
  const next = signInNext ?? (typeof window !== "undefined" ? window.location.pathname : "/");

  const [open, setOpen] = useState(!startCollapsed);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // C1 Wave B (FIX-529): bridge is the default sort; list is the default view.
  const [sort, setSort] = useState<"bridge" | "newest" | "top">("bridge");
  const [view, setView] = useState<"list" | "map">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lens, setLens] = useState<"all" | "constituents">("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // The map / highlights strip ask the list to select + scroll to a comment.
  // Switch to the list view and mark the target selected.
  useEffect(() => {
    function onFocus(e: Event) {
      const id = (e as CustomEvent<FocusCommentDetail>).detail?.id;
      if (!id) return;
      setView("list");
      setOpen(true);
      setSelectedId(id);
    }
    window.addEventListener(FOCUS_COMMENT_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_COMMENT_EVENT, onFocus);
  }, []);

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, sort, lens });
        if (!reset && cursor) sp.set("cursor", cursor);
        const res = await fetch(`/api/comments?${sp.toString()}`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Failed to load comments.");
          return;
        }
        setComments((prev) => (reset ? data.comments : [...prev, ...data.comments]));
        setNextCursor(data.nextCursor ?? null);
      } catch {
        setError("Failed to load comments.");
      } finally {
        setLoading(false);
      }
    },
    [entityType, entityId, sort, lens, cursor],
  );

  // Reload from scratch when sort/lens change.
  useEffect(() => {
    setCursor(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId, sort, lens]);

  function handlePosted(c: Comment) {
    setComments((prev) => [c, ...prev]);
  }
  function addReply(list: Comment[], parentId: string, reply: Comment): Comment[] {
    return list.map((c) => {
      if (c.id === parentId) return { ...c, replies: [...c.replies, reply] };
      if (c.replies.length > 0) return { ...c, replies: addReply(c.replies, parentId, reply) };
      return c;
    });
  }
  function handleReplyPosted(parentId: string, reply: Comment) {
    setComments((prev) => addReply(prev, parentId, reply));
  }

  const grouped = useMemo(() => {
    if (!stanceGrouped) return null;
    // C1 (FIX-526): side is derived PURELY from stance now — 'support'/'oppose'
    // are no longer kinds. Comments without a stance fall into the discussion column.
    const isFor = (c: Comment) => c.stance === "support";
    const isAgainst = (c: Comment) => c.stance === "oppose";
    return {
      support: comments.filter(isFor),
      oppose: comments.filter(isAgainst),
      other: comments.filter((c) => !isFor(c) && !isAgainst(c)),
    };
  }, [comments, stanceGrouped]);

  const cardProps = {
    entityType,
    entityId,
    allowedKinds: kinds,
    stanceEnabled,
    signInNext: next,
    onReplyPosted: handleReplyPosted,
    highlightId: selectedId,
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-2 text-left"
          aria-expanded={open}
        >
          <h2 className="text-base font-bold text-gray-900">{heading}</h2>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
            {comments.length}
          </span>
          {startCollapsed && <span className="text-xs text-gray-400">{open ? "▲" : "▼"}</span>}
        </button>
        {open && (
          <div className="flex items-center gap-2 text-xs">
            {lensEnabled && (
              <button
                type="button"
                onClick={() => setLens((l) => (l === "all" ? "constituents" : "all"))}
                className={`rounded-full border px-2 py-0.5 ${lens === "constituents" ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500"}`}
              >
                {lens === "constituents" ? "Constituents only" : "Everyone"}
              </button>
            )}
            {/* List ⇄ map view switch (list default; map one click away). */}
            <div className="flex rounded-full border border-gray-200">
              {(["list", "map"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded-full px-2 py-0.5 capitalize ${view === v ? "bg-indigo-600 text-white" : "text-gray-500"}`}
                  aria-pressed={view === v}
                >
                  {v}
                </button>
              ))}
            </div>
            {view === "list" && (
              <div className="flex rounded-full border border-gray-200">
                {(["bridge", "newest", "top"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSort(s)}
                    className={`rounded-full px-2 py-0.5 capitalize ${sort === s ? "bg-gray-900 text-white" : "text-gray-500"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {subheading && open && <p className="mb-3 text-xs text-gray-500">{subheading}</p>}

      {!open ? null : view === "map" ? (
        <DebateMap entityType={entityType} entityId={entityId} lens={lens} />
      ) : (
        <>
          {composerEnabled && (
            <div className="mb-5">
              <Composer
                entityType={entityType}
                entityId={entityId}
                allowedKinds={kinds}
                stanceEnabled={stanceEnabled}
                signInNext={next}
                onPosted={handlePosted}
              />
            </div>
          )}

          {loading && comments.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">Loading comments…</div>
          ) : error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : comments.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
              No comments yet. <span className="text-gray-500">Be the first.</span>
            </div>
          ) : grouped ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">For</h3>
                <div className="space-y-2">
                  {grouped.support.map((c) => <CommentCard key={c.id} comment={c} {...cardProps} />)}
                  {grouped.support.length === 0 && <p className="text-xs text-gray-400">None yet.</p>}
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-700">Against</h3>
                <div className="space-y-2">
                  {grouped.oppose.map((c) => <CommentCard key={c.id} comment={c} {...cardProps} />)}
                  {grouped.oppose.length === 0 && <p className="text-xs text-gray-400">None yet.</p>}
                </div>
              </div>
              {grouped.other.length > 0 && (
                <div className="md:col-span-2">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Discussion</h3>
                  <div className="space-y-2">
                    {grouped.other.map((c) => <CommentCard key={c.id} comment={c} {...cardProps} />)}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {comments.map((c) => <CommentCard key={c.id} comment={c} {...cardProps} />)}
            </div>
          )}

          {nextCursor && sort === "newest" && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => { setCursor(nextCursor); void load(false); }}
                className="rounded-lg border border-gray-200 px-4 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
              >
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
