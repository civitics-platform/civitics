"use client";

// Unified comments UI (C0 / FIX-521) — one component over the entity_comments
// substrate, replacing CivicComments / OfficialComments / ArgumentBoard. Typed
// kind composer, two-axis (agree / valuable) ratings, constituent badge, flag
// menu, bridge/newest/top sort (bridge default), list⇄map view switch (C1 Wave
// B debate map), optional constituent lens, optional stance-grouped (for/against)
// visual mode for initiatives. Pseudonymous display_name only.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { challengedFetch } from "@/lib/challenged-fetch";
import { useConstituentDefaultLens } from "@/lib/use-constituent-default-lens";
import {
  ALLOWED_KINDS,
  DEFAULT_KIND,
  kindLabel,
  MAX_THREAD_DEPTH,
  type EntityCommentType,
} from "@civitics/db";
import { DebateMap } from "./DebateMap";
import { StatementMode } from "./StatementMode";
import { SyntheticMark } from "./integrity/Synthetic";
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
  author_is_synthetic: boolean;
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
  /** FIX-574: the entity's jurisdiction — a verified constituent of it defaults
   *  the comments lens to "constituents" (when that lens has ≥1 comment). */
  constituentJurisdictionId?: string | null;
  /** Initiative-style for/against grouped layout. */
  stanceGrouped?: boolean;
  /** Read-only stages hide the composer. */
  composerEnabled?: boolean;
  heading?: string;
  subheading?: string;
  /** Start collapsed (jurisdiction / institution pages). */
  startCollapsed?: boolean;
  signInNext?: string;
  /** C1 Wave C: mount the agree/disagree/pass statement surface alongside comments. */
  statementsEnabled?: boolean;
  /** C1 Wave C: slow mode — promote statements + de-emphasize the composer during a spike. */
  slowMode?: boolean;
}

// ─── Presentation config (badge colors are presentation → kept in the UI) ─────

// Public Record token map (FIX-566). The constrained semantic palette has no
// categorical hue per kind, so stance-bearing kinds take their semantic token
// (support→green-ink, oppose→accent, concern/tradeoff→amber, question/amendment
// →civic-blue) and the remainder fall to neutral ink. No purple/violet.
const KIND_BADGE: Record<string, string> = {
  discussion: "bg-ink/5 text-ink-soft border-rule",
  support: "bg-green-ink/10 text-green-ink border-green-ink/25",
  oppose: "bg-accent/10 text-accent border-accent/25",
  concern: "bg-amber/25 text-ink border-amber/60",
  amendment: "bg-civic-blue/10 text-civic-blue border-civic-blue/25",
  question: "bg-civic-blue/10 text-civic-blue border-civic-blue/25",
  evidence: "bg-ink/5 text-ink-soft border-rule",
  precedent: "bg-ink/5 text-ink-soft border-rule",
  tradeoff: "bg-amber/20 text-ink border-amber/50",
  stakeholder_impact: "bg-ink/10 text-ink border-rule",
  experience: "bg-ink/5 text-ink-soft border-rule",
  cause: "bg-ink/5 text-ink-soft border-rule",
  solution: "bg-green-ink/10 text-green-ink border-green-ink/25",
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
  return KIND_BADGE[kind] ?? "bg-ink/5 text-ink-soft border-rule";
}

function redirectToSignIn(next: string) {
  window.location.href = `/auth/sign-in?next=${encodeURIComponent(next)}`;
}

// Is the comment anywhere in the loaded tree (roots or nested replies)?
function treeContains(list: Comment[], id: string): boolean {
  for (const c of list) {
    if (c.id === id || treeContains(c.replies, id)) return true;
  }
  return false;
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
          className={`px-1 ${myAgree === 1 ? "bg-green-ink/10 text-green-ink" : "text-ink-soft/60 hover:text-green-ink"}`}
          aria-label="Agree"
        >
          ▲
        </button>
        <span className="tabular-nums text-ink-soft">{agreeNet}</span>
        <button
          type="button"
          onClick={() => toggle("agree", -1)}
          disabled={busy}
          className={`px-1 ${myAgree === -1 ? "bg-accent/10 text-accent" : "text-ink-soft/60 hover:text-accent"}`}
          aria-label="Disagree"
        >
          ▼
        </button>
      </div>
      <button
        type="button"
        onClick={() => toggle("valuable", 1)}
        disabled={busy}
        className={`flex items-center gap-1 px-1.5 py-0.5 ${myValuable === 1 ? "bg-civic-blue/10 text-civic-blue" : "text-ink-soft/60 hover:text-civic-blue"}`}
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

  if (done) return <span className="text-[10px] text-ink-soft/60">Flagged · thanks</span>;

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
        className="text-[10px] text-ink-soft/50 hover:text-accent"
        aria-label="Flag comment"
      >
        ⚑ Flag
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-20 w-60 border border-rule bg-card p-3 shadow-lg">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full border border-rule bg-card px-2 py-1 text-xs text-ink"
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
            className="mt-2 w-full border border-rule bg-card px-2 py-1 text-xs text-ink placeholder:text-ink-soft/50 resize-none"
          />
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
      const res = await challengedFetch(`/api/comments`, {
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
    <form onSubmit={submit} className={compact ? "mt-2" : "border border-rule bg-card p-4"}>
      {kinds.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                kind === k ? "border-ink bg-ink/5 text-ink" : "border-rule bg-card text-ink-soft hover:bg-paper-2"
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
          className="mb-2 block border border-rule bg-card px-2 py-1 text-xs text-ink-soft"
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
        className="block w-full resize-none border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-soft/50 focus:border-ink focus:bg-card focus:outline-none focus:ring-1 focus:ring-ink"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className={`text-xs tabular-nums ${body.length > 1900 ? "text-accent" : "text-ink-soft/60"}`}>{body.length}/2000</span>
        <div className="flex gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel} className="border border-rule px-3 py-1 text-xs text-ink-soft hover:bg-paper-2">
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={saving || body.trim().length < 10}
            className="bg-ink px-3 py-1.5 text-xs font-semibold text-paper hover:bg-accent disabled:opacity-50 transition-colors"
          >
            {saving ? "Posting…" : parentId ? "Reply" : "Post"}
          </button>
        </div>
      </div>
      {error && <p className="mt-1 text-xs text-accent">{error}</p>}
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
      className={`scroll-mt-24 border bg-card p-3 ${
        selected ? "border-accent ring-2 ring-accent/30" : depth > 0 ? "border-rule/60" : "border-rule"
      }`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeClass(comment.kind)}`}>
            {comment.kind_label}
          </span>
          {comment.stance && STANCE_LABEL[comment.stance] && (
            <span className="inline-block rounded-full border border-rule bg-paper-2 px-2 py-0.5 text-[10px] font-medium text-ink-soft">
              {STANCE_LABEL[comment.stance]}
            </span>
          )}
          {comment.is_constituent && (
            <span className="inline-block rounded-full border border-civic-blue/25 bg-civic-blue/10 px-2 py-0.5 text-[10px] font-medium text-civic-blue" title="Verified constituent at post time">
              ✓ Constituent
            </span>
          )}
          {comment.rating_summary.deltas > 0 && (
            <span
              className="inline-block rounded-full border border-ink/40 bg-ink/5 px-2 py-0.5 text-[10px] font-medium text-ink"
              title="Readers changed their position and credited this comment"
            >
              ↺ changed {comment.rating_summary.deltas} {comment.rating_summary.deltas === 1 ? "mind" : "minds"}
            </span>
          )}
          {bridges && (
            <span
              className="inline-block rounded-full border border-civic-blue/25 bg-civic-blue/10 px-2 py-0.5 text-[10px] font-medium text-civic-blue"
              title="Valued by people on both sides of this debate"
            >
              ⇄ bridges divides
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-ink-soft/50">{formatRelTime(comment.created_at)}</span>
      </div>

      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-soft">
        <span>{comment.author_name}</span>
        {comment.author_is_synthetic && <SyntheticMark size="xs" />}
      </div>

      {collapsed ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-ink-soft hover:text-accent">This comment was flagged and is under review — show anyway</summary>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed text-ink">{comment.body}</p>
        </details>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{comment.body}</p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <RatingControls comment={comment} signInNext={signInNext} />
          {depth < MAX_THREAD_DEPTH && (
            <button onClick={() => setShowReply((v) => !v)} className="text-xs text-ink-soft/60 hover:text-ink">
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
        <div className="mt-3 space-y-2 border-l-2 border-rule/60 pl-3">
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
  constituentJurisdictionId = null,
  stanceGrouped = false,
  composerEnabled = true,
  heading = "Community comments",
  subheading,
  startCollapsed = false,
  signInNext,
  statementsEnabled = false,
  slowMode = false,
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
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // FIX-574: open on the constituent lens for a verified constituent — but only
  // if that lens actually has a comment, else stay on "all" (decision 6). The
  // manual toggle below sets lensOverridden so this async default never yanks a
  // user who toggled first (decision 4).
  const lensProbe = useCallback(
    async (signal: AbortSignal) => {
      const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, lens: "constituents", sort: "bridge" });
      const res = await fetch(`/api/comments?${sp.toString()}`, { signal });
      const data = await res.json().catch(() => ({}));
      return res.ok && Array.isArray(data.comments) && data.comments.length >= 1;
    },
    [entityType, entityId],
  );
  const { defaultLens, resolved: lensResolved } = useConstituentDefaultLens(
    lensEnabled ? constituentJurisdictionId : null,
    lensProbe,
  );
  const lensOverridden = useRef(false);
  const toggleLens = useCallback(() => {
    lensOverridden.current = true;
    setLens((l) => (l === "all" ? "constituents" : "all"));
  }, []);
  useEffect(() => {
    if (lensOverridden.current) return;
    if (lensResolved && defaultLens === "constituents") setLens("constituents");
  }, [lensResolved, defaultLens]);
  // FIX-532: threads fetched via focus_id when the target wasn't on a loaded
  // page — rendered pinned above the list with a "jumped to comment" marker.
  const [pinned, setPinned] = useState<Comment[]>([]);

  // The focus handler subscribes once but needs the CURRENT loaded tree to
  // decide whether to fetch — mirror state into refs instead of re-subscribing.
  const commentsRef = useRef<Comment[]>([]);
  commentsRef.current = comments;
  const pinnedRef = useRef<Comment[]>([]);
  pinnedRef.current = pinned;

  // The map / highlights strip ask the list to select + scroll to a comment.
  // Switch to the list view and mark the target selected. FIX-532: if the
  // target isn't on a loaded page, fetch just its thread via focus_id (bounded
  // work no matter how deep it sits), prepend it pinned, then select — the
  // card's own scroll-on-selected effect handles the scroll on mount.
  useEffect(() => {
    function onFocus(e: Event) {
      const id = (e as CustomEvent<FocusCommentDetail>).detail?.id;
      if (!id) return;
      setView("list");
      setOpen(true);
      if (treeContains(commentsRef.current, id) || treeContains(pinnedRef.current, id)) {
        setSelectedId(id);
        return;
      }
      void (async () => {
        try {
          const sp = new URLSearchParams({
            entity_type: entityType,
            entity_id: entityId,
            focus_id: id,
          });
          const res = await fetch(`/api/comments?${sp.toString()}`);
          const data = await res.json();
          if (res.ok && Array.isArray(data.comments) && data.comments.length > 0) {
            const fetched = data.comments as Comment[];
            setPinned((prev) => [
              ...fetched,
              ...prev.filter((p) => !fetched.some((f) => f.id === p.id)),
            ]);
          }
        } catch {
          // Selection still happens; without the thread there's just nothing to scroll to.
        }
        setSelectedId(id);
      })();
    }
    window.addEventListener(FOCUS_COMMENT_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_COMMENT_EVENT, onFocus);
  }, [entityType, entityId]);

  // The cursor is an explicit arg (not state): the previous setCursor-then-load
  // pattern read the stale closure value, so the first Load more re-fetched and
  // appended page one. The id-dedupe on append is belt-and-braces against a
  // just-posted comment shifting page boundaries mid-pagination.
  const load = useCallback(
    async (reset: boolean, cursorArg?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, sort, lens });
        if (!reset && cursorArg) sp.set("cursor", cursorArg);
        const res = await fetch(`/api/comments?${sp.toString()}`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Failed to load comments.");
          return;
        }
        setComments((prev) =>
          reset
            ? data.comments
            : [
                ...prev,
                ...(data.comments as Comment[]).filter((c) => !prev.some((p) => p.id === c.id)),
              ],
        );
        setNextCursor(data.nextCursor ?? null);
      } catch {
        setError("Failed to load comments.");
      } finally {
        setLoading(false);
      }
    },
    [entityType, entityId, sort, lens],
  );

  // Reload from scratch when sort/lens change (a focus-pinned thread is scoped
  // to the view it was jumped into — drop it too).
  useEffect(() => {
    setPinned([]);
    setSelectedId(null);
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

  // The main list skips roots already rendered in the pinned block (a focused
  // thread can also arrive later via Load more).
  const listed = useMemo(
    () => (pinned.length === 0 ? comments : comments.filter((c) => !pinned.some((p) => p.id === c.id))),
    [comments, pinned],
  );

  const grouped = useMemo(() => {
    if (!stanceGrouped) return null;
    // C1 (FIX-526): side is derived PURELY from stance now — 'support'/'oppose'
    // are no longer kinds. Comments without a stance fall into the discussion column.
    const isFor = (c: Comment) => c.stance === "support";
    const isAgainst = (c: Comment) => c.stance === "oppose";
    return {
      support: listed.filter(isFor),
      oppose: listed.filter(isAgainst),
      other: listed.filter((c) => !isFor(c) && !isAgainst(c)),
    };
  }, [listed, stanceGrouped]);

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
          <h2 className="text-base font-bold text-ink">{heading}</h2>
          <span className="rounded-full bg-paper-2 px-2 py-0.5 text-xs font-semibold text-ink-soft tabular-nums">
            {comments.length}
          </span>
          {startCollapsed && <span className="text-xs text-ink-soft/60">{open ? "▲" : "▼"}</span>}
        </button>
        {open && (
          <div className="flex items-center gap-2 text-xs">
            {lensEnabled && (
              <button
                type="button"
                onClick={toggleLens}
                className={`rounded-full border px-2 py-0.5 ${lens === "constituents" ? "border-civic-blue/30 bg-civic-blue/10 text-civic-blue" : "border-rule text-ink-soft"}`}
              >
                {lens === "constituents" ? "Constituents only" : "Everyone"}
              </button>
            )}
            {/* List ⇄ map view switch (list default; map one click away). */}
            <div className="flex rounded-full border border-rule">
              {(["list", "map"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded-full px-2 py-0.5 capitalize ${view === v ? "bg-ink text-paper" : "text-ink-soft"}`}
                  aria-pressed={view === v}
                >
                  {v}
                </button>
              ))}
            </div>
            {view === "list" && (
              <div className="flex rounded-full border border-rule">
                {(["bridge", "newest", "top"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSort(s)}
                    className={`rounded-full px-2 py-0.5 capitalize ${sort === s ? "bg-ink text-paper" : "text-ink-soft"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Slow mode (decision 6): de-emphasize, never censor. A calm banner +
          statement mode promoted above the comments; the composer collapses
          behind an expander below. New comments are never blocked or queued. */}
      {open && statementsEnabled && slowMode && (
        <>
          <div className="mb-4 border border-amber/60 bg-amber/25 px-4 py-3 text-sm text-ink">
            <span className="font-semibold">High activity right now.</span>{" "}
            Weigh in on the key questions below — a quick agree/disagree take helps more than a long thread when a page is moving fast.
          </div>
          <div className="mb-6">
            <StatementMode
              entityType={entityType}
              entityId={entityId}
              signInNext={next}
              lens={lens}
              heading="Where people stand"
              subheading="High-traffic mode — agree, pass, or disagree on the key questions. 30 seconds, no writing."
            />
          </div>
        </>
      )}

      {subheading && open && <p className="mb-3 text-xs text-ink-soft">{subheading}</p>}

      {!open ? null : view === "map" ? (
        <DebateMap entityType={entityType} entityId={entityId} lens={lens} />
      ) : (
        <>
          {composerEnabled && (
            slowMode ? (
              // Composer collapses behind an expander during slow mode (decision 6).
              <details className="mb-5 border border-rule bg-card">
                <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-ink-soft hover:text-ink">
                  Write a full comment
                </summary>
                <div className="px-4 pb-4">
                  <Composer
                    entityType={entityType}
                    entityId={entityId}
                    allowedKinds={kinds}
                    stanceEnabled={stanceEnabled}
                    signInNext={next}
                    onPosted={handlePosted}
                  />
                </div>
              </details>
            ) : (
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
            )
          )}

          {/* FIX-532: focus-fetched threads, pinned above the list. */}
          {pinned.length > 0 && (
            <div className="mb-3 space-y-3">
              {pinned.map((c) => (
                <div key={c.id}>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-ink-soft/60">
                    ↪ Jumped to comment
                  </p>
                  <CommentCard comment={c} {...cardProps} />
                </div>
              ))}
            </div>
          )}

          {loading && comments.length === 0 ? (
            <div className="py-8 text-center text-sm text-ink-soft/60">Loading comments…</div>
          ) : error ? (
            <div className="border border-accent/25 bg-accent/10 px-4 py-3 text-sm text-accent">{error}</div>
          ) : comments.length === 0 && pinned.length === 0 ? (
            <div className="border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-soft/60">
              No comments yet. <span className="text-ink-soft">Be the first.</span>
            </div>
          ) : grouped ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-green-ink">For</h3>
                <div className="space-y-2">
                  {grouped.support.map((c) => <CommentCard key={c.id} comment={c} {...cardProps} />)}
                  {grouped.support.length === 0 && <p className="text-xs text-ink-soft/60">None yet.</p>}
                </div>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent">Against</h3>
                <div className="space-y-2">
                  {grouped.oppose.map((c) => <CommentCard key={c.id} comment={c} {...cardProps} />)}
                  {grouped.oppose.length === 0 && <p className="text-xs text-ink-soft/60">None yet.</p>}
                </div>
              </div>
              {grouped.other.length > 0 && (
                <div className="md:col-span-2">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Discussion</h3>
                  <div className="space-y-2">
                    {grouped.other.map((c) => <CommentCard key={c.id} comment={c} {...cardProps} />)}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {listed.map((c) => <CommentCard key={c.id} comment={c} {...cardProps} />)}
            </div>
          )}

          {/* FIX-540: newest AND bridge keyset-paginate; top never sets a cursor. */}
          {nextCursor && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => void load(false, nextCursor)}
                disabled={loading}
                className="border border-rule px-4 py-1.5 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-50"
              >
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}

      {/* Secondary statement surface when NOT in slow mode: a below-the-fold
          block near the comments (decision 6 — statements stay available, just
          not promoted). In slow mode it's rendered prominently above instead. */}
      {open && statementsEnabled && !slowMode && (
        <div className="mt-8">
          <StatementMode entityType={entityType} entityId={entityId} signInNext={next} lens={lens} />
        </div>
      )}
    </section>
  );
}
