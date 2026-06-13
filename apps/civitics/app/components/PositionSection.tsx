"use client";

// Position spine UI (C1 / FIX-525) over the entity_positions substrate (FIX-523).
// Three surfaces composed into one section, mounted on proposal + initiative
// detail pages near the comments:
//   * PositionRollupStrip   — 7-bucket distribution + median + n + constituent lens
//   * PositionCard          — 7-stop intensity selector (-3..+3) + conditions +
//                             optional delta-attribution picker on a stance change
//   * TermsOfConsensusPanel — top conditional/amendment comments + pct_with_conditions
//
// Public reads are aggregates only; the card writes through /api/positions, which
// calls set_entity_position() as the caller (every anti-collusion guard server-side).

import { useState, useEffect, useCallback, useMemo } from "react";
import type { EntityCommentType } from "@civitics/db";
import { challengedFetch } from "@/lib/challenged-fetch";

// ─── Types ────────────────────────────────────────────────────────────────────

type OwnPosition = {
  entity_type: string;
  entity_id: string;
  stance: number;
  conditions_md: string | null;
  constituent_jurisdiction_id: string | null;
  updated_at: string;
} | null;

type Rollup = {
  n: number;
  median: number | null;
  pct_with_conditions: number | null;
  buckets: Record<string, number> | null;
};

type CommentLite = {
  id: string;
  body: string;
  author_name: string;
  kind: string;
  kind_label: string;
  stance: string | null;
  rating_summary: { valuable_up: number; valuable_down: number; legacy_upvotes: number };
  replies: CommentLite[];
};

export interface PositionSectionProps {
  entityType: EntityCommentType;
  entityId: string;
  heading?: string;
  signInNext?: string;
  /** Show the constituent lens toggle on the rollup strip. */
  lensEnabled?: boolean;
}

// ─── Stance vocabulary (presentation) ─────────────────────────────────────────

const STOPS = [-3, -2, -1, 0, 1, 2, 3] as const;
const STOP_LABEL: Record<number, string> = {
  [-3]: "Strongly oppose",
  [-2]: "Oppose",
  [-1]: "Lean oppose",
  [0]: "Neutral",
  [1]: "Lean support",
  [2]: "Support",
  [3]: "Strongly support",
};
function stopColor(s: number): string {
  if (s < 0) return "bg-red-500";
  if (s > 0) return "bg-emerald-500";
  return "bg-gray-400";
}
function stopTextColor(s: number): string {
  if (s < 0) return "text-red-700";
  if (s > 0) return "text-emerald-700";
  return "text-gray-600";
}

function redirectToSignIn(next: string) {
  window.location.href = `/auth/sign-in?next=${encodeURIComponent(next)}`;
}

function flatten(list: CommentLite[]): CommentLite[] {
  return list.flatMap((c) => [c, ...flatten(c.replies ?? [])]);
}
function valuableScore(c: CommentLite): number {
  const s = c.rating_summary ?? { valuable_up: 0, valuable_down: 0, legacy_upvotes: 0 };
  return (s.valuable_up ?? 0) - (s.valuable_down ?? 0) + (s.legacy_upvotes ?? 0);
}

// ─── Rollup strip ─────────────────────────────────────────────────────────────

function PositionRollupStrip({
  rollup,
  lens,
  lensEnabled,
  onLens,
}: {
  rollup: Rollup | null;
  lens: "all" | "constituents";
  lensEnabled: boolean;
  onLens: (l: "all" | "constituents") => void;
}) {
  const belowMin = !rollup || rollup.median === null;
  const maxCount = useMemo(() => {
    if (!rollup?.buckets) return 0;
    return Math.max(1, ...STOPS.map((s) => rollup.buckets?.[String(s)] ?? 0));
  }, [rollup]);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Where people stand</h3>
        {lensEnabled && (
          <button
            type="button"
            onClick={() => onLens(lens === "all" ? "constituents" : "all")}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              lens === "constituents" ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500"
            }`}
          >
            {lens === "constituents" ? "Verified constituents" : "Everyone"}
          </button>
        )}
      </div>

      {belowMin ? (
        <div className="rounded-lg border border-dashed border-gray-200 px-3 py-5 text-center text-xs text-gray-400">
          Not enough positions yet — be one of the first.
          {rollup && rollup.n > 0 && (
            <span className="ml-1 text-gray-400">({rollup.n} so far)</span>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-end gap-1.5" aria-hidden>
            {STOPS.map((s) => {
              const c = rollup?.buckets?.[String(s)] ?? 0;
              const h = Math.round((c / maxCount) * 48) + 2;
              return (
                <div key={s} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] tabular-nums text-gray-400">{c}</span>
                  <div className={`w-full rounded-sm ${stopColor(s)}`} style={{ height: `${h}px` }} />
                  <span className="text-[10px] tabular-nums text-gray-400">{s > 0 ? `+${s}` : s}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
            <span>
              Median{" "}
              <span className="font-semibold tabular-nums text-gray-800">
                {rollup!.median!.toFixed(1)}
              </span>
            </span>
            <span className="tabular-nums">{rollup!.n} positions</span>
            {rollup!.pct_with_conditions != null && (
              <span className="tabular-nums">
                {Math.round(rollup!.pct_with_conditions * 100)}% conditional
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Attribution picker (optional, skippable) ─────────────────────────────────

function AttributionPicker({
  comments,
  onPick,
  onSkip,
  saving,
}: {
  comments: CommentLite[];
  onPick: (commentId: string) => void;
  onSkip: () => void;
  saving: boolean;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const ranked = [...comments].sort((a, b) => valuableScore(b) - valuableScore(a));
    return needle ? ranked.filter((c) => c.body.toLowerCase().includes(needle)) : ranked;
  }, [comments, q]);

  return (
    <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-violet-800">Did a comment change your mind?</p>
        <button
          type="button"
          onClick={onSkip}
          disabled={saving}
          className="rounded-md border border-violet-200 bg-white px-2.5 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Skip"}
        </button>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search comments…"
        className="mb-2 w-full rounded-md border border-violet-200 bg-white px-2 py-1 text-xs"
      />
      <div className="max-h-48 space-y-1.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-gray-400">No comments to credit.</p>
        ) : (
          filtered.slice(0, 30).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c.id)}
              disabled={saving}
              className="block w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-left text-[11px] text-gray-700 hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50"
            >
              <span className="font-medium text-gray-500">{c.author_name}: </span>
              {c.body.length > 120 ? `${c.body.slice(0, 120)}…` : c.body}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Position card ────────────────────────────────────────────────────────────

function PositionCard({
  entityType,
  entityId,
  own,
  comments,
  signInNext,
  onSaved,
}: {
  entityType: EntityCommentType;
  entityId: string;
  own: OwnPosition;
  comments: CommentLite[];
  signInNext: string;
  onSaved: (p: OwnPosition) => void;
}) {
  const [stance, setStance] = useState<number | null>(own ? own.stance : null);
  const [conditions, setConditions] = useState<string>(own?.conditions_md ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Sync when the loaded position arrives/changes.
  useEffect(() => {
    setStance(own ? own.stance : null);
    setConditions(own?.conditions_md ?? "");
  }, [own?.stance, own?.conditions_md]); // eslint-disable-line react-hooks/exhaustive-deps

  const hadPrior = !!own;
  const stanceChanged = own ? own.stance !== stance : stance !== null;
  const conditionsChanged = (own?.conditions_md ?? "") !== conditions;
  const dirty = stanceChanged || conditionsChanged;

  const doSave = useCallback(
    async (attributedCommentId: string | null) => {
      if (stance === null) return;
      setSaving(true);
      setError(null);
      setNote(null);
      try {
        const attempt = async (withAttribution: boolean) =>
          challengedFetch("/api/positions", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entity_type: entityType,
              entity_id: entityId,
              stance,
              conditions_md: conditions.trim() ? conditions.trim() : null,
              attributed_comment_id: withAttribution ? attributedCommentId : null,
            }),
          });

        let res = await attempt(attributedCommentId !== null);
        if (res.status === 401) {
          redirectToSignIn(signInNext);
          return;
        }
        // Attribution is optional — if a guard (age / cap / etc.) rejects it,
        // still record the position itself without the credit.
        let data = await res.json().catch(() => ({}));
        if (!res.ok && attributedCommentId !== null && (res.status === 400 || res.status === 429)) {
          res = await attempt(false);
          data = await res.json().catch(() => ({}));
          if (res.ok) setNote("Position saved (the credit couldn’t be applied).");
        }
        if (!res.ok) {
          setError(data.error ?? "Couldn’t save your position.");
          return;
        }
        setPickerOpen(false);
        onSaved((data.position as OwnPosition) ?? null);
      } catch {
        setError("Network error. Try again.");
      } finally {
        setSaving(false);
      }
    },
    [entityType, entityId, stance, conditions, signInNext, onSaved],
  );

  function handleSaveClick() {
    if (stance === null) return;
    // Offer the (optional) attribution picker only on a genuine stance change
    // from an existing position, and only when there are comments to credit.
    if (hadPrior && stanceChanged && comments.length > 0) {
      setPickerOpen(true);
      return;
    }
    void doSave(null);
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="mb-1 text-sm font-bold text-gray-900">Your position</h3>
      <p className="mb-3 text-xs text-gray-500">
        Set once per item. Softening counts — moving from strong to mild opposition is most persuasion.
      </p>

      <div className="flex items-stretch gap-1" role="radiogroup" aria-label="Your position">
        {STOPS.map((s) => {
          const active = stance === s;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={STOP_LABEL[s]}
              title={STOP_LABEL[s]}
              onClick={() => setStance(s)}
              className={`flex-1 rounded-md border py-2 text-center text-xs font-semibold transition-colors ${
                active
                  ? `${stopColor(s)} border-transparent text-white`
                  : `border-gray-200 bg-white ${stopTextColor(s)} hover:bg-gray-50`
              } ${s === 0 ? "mx-0.5" : ""}`}
            >
              {s > 0 ? `+${s}` : s}
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-gray-400">
        <span>Strong oppose</span>
        <span>Neutral</span>
        <span>Strong support</span>
      </div>

      <label className="mt-3 block">
        <span className="text-xs font-medium text-gray-600">What would change your mind? (optional)</span>
        <textarea
          rows={2}
          value={conditions}
          onChange={(e) => setConditions(e.target.value)}
          maxLength={1000}
          placeholder="e.g. I'd support this if it included a sunset clause."
          className="mt-1 block w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
      </label>

      {pickerOpen && (
        <AttributionPicker
          comments={comments}
          saving={saving}
          onPick={(id) => void doSave(id)}
          onSkip={() => void doSave(null)}
        />
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-gray-400">
          {own ? `You: ${STOP_LABEL[own.stance]}` : "No position set"}
        </span>
        {!pickerOpen && (
          <button
            type="button"
            onClick={handleSaveClick}
            disabled={saving || stance === null || !dirty}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : own ? "Update position" : "Set position"}
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
    </div>
  );
}

// ─── Terms-of-consensus panel ─────────────────────────────────────────────────

function TermsOfConsensusPanel({
  comments,
  rollup,
}: {
  comments: CommentLite[];
  rollup: Rollup | null;
}) {
  const [open, setOpen] = useState(false);
  const top = useMemo(() => {
    return comments
      .filter((c) => c.stance === "conditional" || c.kind === "amendment")
      .sort((a, b) => valuableScore(b) - valuableScore(a))
      .slice(0, 5);
  }, [comments]);

  const pct = rollup?.pct_with_conditions ?? null;
  const hasContent = top.length > 0 || (pct != null && pct > 0);
  if (!hasContent) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Terms of consensus
        </span>
        <span className="text-xs text-gray-400">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-gray-100 px-4 py-3">
          {pct != null && rollup && (
            <p className="mb-2 text-xs text-gray-500">
              {Math.round(pct * 100)}% of {rollup.n} positions name a condition that would move them.
            </p>
          )}
          <div className="space-y-2">
            {top.map((c) => (
              <div key={c.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-gray-400">
                  <span className="font-semibold uppercase tracking-wide">
                    {c.stance === "conditional" ? "Conditional" : c.kind_label}
                  </span>
                  <span>· {c.author_name}</span>
                </div>
                <p className="text-sm text-gray-800">{c.body}</p>
              </div>
            ))}
            {top.length === 0 && (
              <p className="text-xs text-gray-400">No specific terms proposed yet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

export function PositionSection({
  entityType,
  entityId,
  heading = "Positions",
  signInNext,
  lensEnabled = false,
}: PositionSectionProps) {
  const next = signInNext ?? (typeof window !== "undefined" ? window.location.pathname : "/");
  const [own, setOwn] = useState<OwnPosition>(null);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [comments, setComments] = useState<CommentLite[]>([]);
  const [lens, setLens] = useState<"all" | "constituents">("all");

  const loadRollup = useCallback(async () => {
    try {
      const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, lens });
      const res = await fetch(`/api/positions/rollup?${sp.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setRollup(data.rollup ?? null);
    } catch {
      /* keep last rollup */
    }
  }, [entityType, entityId, lens]);

  const loadOwn = useCallback(async () => {
    try {
      const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId });
      const res = await fetch(`/api/positions?${sp.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setOwn((data.position as OwnPosition) ?? null);
    } catch {
      /* leave own as-is */
    }
  }, [entityType, entityId]);

  const loadComments = useCallback(async () => {
    try {
      const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, sort: "top", limit: "50" });
      const res = await fetch(`/api/comments?${sp.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setComments(flatten((data.comments ?? []) as CommentLite[]));
    } catch {
      /* no comments → picker/terms simply empty */
    }
  }, [entityType, entityId]);

  useEffect(() => {
    void loadOwn();
    void loadComments();
  }, [loadOwn, loadComments]);
  useEffect(() => {
    void loadRollup();
  }, [loadRollup]);

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-base font-bold text-gray-900">{heading}</h2>
      <div className="space-y-3">
        <PositionRollupStrip rollup={rollup} lens={lens} lensEnabled={lensEnabled} onLens={setLens} />
        <PositionCard
          entityType={entityType}
          entityId={entityId}
          own={own}
          comments={comments}
          signInNext={next}
          onSaved={(p) => {
            setOwn(p);
            void loadRollup();
          }}
        />
        <TermsOfConsensusPanel comments={comments} rollup={rollup} />
      </div>
    </section>
  );
}
