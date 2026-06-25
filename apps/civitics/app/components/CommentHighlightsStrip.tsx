"use client";

// C1 Wave B (FIX-529): proportional-representation highlights strip (decision 5).
// Pinned above the comments list AND the debate map. Two groups:
//   * common ground — up to 3 comments by bridge_score (valued across stances)
//   * strongest from each side — best comment per stance bucket, regardless of
//     bridge_score (justified representation — every viewpoint's best is visible)
// Hidden entirely when the RPC returns nothing. Clicking a card asks the list to
// select + scroll to that comment (focusComment).

import { useCallback, useEffect, useState } from "react";
import { focusComment } from "./comment-focus";
import type { EntityCommentType } from "@civitics/db";
import { useConstituentDefaultLens } from "@/lib/use-constituent-default-lens";
import { SyntheticMark } from "./integrity/Synthetic";

type HighlightComment = {
  id: string;
  stance: string | null;
  kind: string;
  snippet: string;
  bridge_score: number | null;
  valuable_net: number;
  author_name: string;
  author_is_synthetic?: boolean;
};

type Highlights = {
  common_ground: HighlightComment[];
  steelman: {
    support: HighlightComment | null;
    oppose: HighlightComment | null;
    conditional: HighlightComment | null;
  };
};

export interface CommentHighlightsStripProps {
  entityType: EntityCommentType;
  entityId: string;
  lens?: "all" | "constituents";
  /** FIX-574: the entity's jurisdiction — a verified constituent opens this
   *  strip on the constituent lens (when it has ≥1 highlight). The strip has no
   *  toggle of its own; the comments cluster below carries the manual control. */
  constituentJurisdictionId?: string | null;
}

const STANCE_META: Record<string, { label: string; cls: string }> = {
  support: { label: "Strongest for", cls: "border-green-ink/25 bg-green-ink/10 text-green-ink" },
  oppose: { label: "Strongest against", cls: "border-accent/25 bg-accent/10 text-accent" },
  conditional: { label: "Strongest condition", cls: "border-amber/60 bg-amber/25 text-ink" },
};

function HighlightCard({
  c,
  badge,
  badgeCls,
  trailing,
}: {
  c: HighlightComment;
  badge: string;
  badgeCls: string;
  trailing?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => focusComment(c.id)}
      className="block w-full border border-rule bg-card px-3 py-2 text-left transition-colors hover:border-accent hover:bg-paper-2"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeCls}`}>
          {badge}
        </span>
        {trailing && <span className="shrink-0 text-[10px] tabular-nums text-ink-soft/60">{trailing}</span>}
      </div>
      <p className="text-xs leading-relaxed text-ink">{c.snippet}</p>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-soft/60">
        <span>{c.author_name}</span>
        {c.author_is_synthetic && <SyntheticMark size="xs" />}
      </div>
    </button>
  );
}

export function CommentHighlightsStrip({
  entityType,
  entityId,
  lens: lensProp = "all",
  constituentJurisdictionId = null,
}: CommentHighlightsStripProps) {
  const [data, setData] = useState<Highlights | null>(null);
  const [lens, setLens] = useState<"all" | "constituents">(lensProp);

  // FIX-574: open on the constituent lens for a verified constituent — but only
  // if it has ≥1 highlight (decision 6). No manual toggle here, so nothing to
  // override; the constituent view only ever ADDS to what's shown.
  const probe = useCallback(
    async (signal: AbortSignal) => {
      const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, lens: "constituents" });
      const res = await fetch(`/api/comments/highlights?${sp.toString()}`, { signal });
      const json = await res.json().catch(() => ({}));
      const h = json.highlights as Highlights | undefined;
      if (!h) return false;
      const common = h.common_ground ?? [];
      const steel = h.steelman ?? { support: null, oppose: null, conditional: null };
      const steelCount = (["support", "oppose", "conditional"] as const).filter((k) => steel[k]).length;
      return common.length >= 1 || steelCount >= 1;
    },
    [entityType, entityId],
  );
  const { defaultLens, resolved } = useConstituentDefaultLens(constituentJurisdictionId, probe);
  useEffect(() => {
    if (resolved && defaultLens === "constituents") setLens("constituents");
  }, [resolved, defaultLens]);

  useEffect(() => {
    let cancelled = false;
    const sp = new URLSearchParams({ entity_type: entityType, entity_id: entityId, lens });
    fetch(`/api/comments/highlights?${sp.toString()}`)
      .then((r) => r.json())
      .then((res) => {
        if (!cancelled && res.highlights) setData(res.highlights as Highlights);
      })
      .catch(() => {
        /* strip simply stays hidden on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId, lens]);

  if (!data) return null;
  const common = data.common_ground ?? [];
  const steel = data.steelman ?? { support: null, oppose: null, conditional: null };
  const steelEntries = (["support", "oppose", "conditional"] as const)
    .map((k) => steel[k])
    .filter((c): c is HighlightComment => !!c);

  if (common.length === 0 && steelEntries.length === 0) return null;

  return (
    <section className="mb-5 border border-rule bg-paper-2 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Highlights</h3>

      {common.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-[11px] font-medium text-civic-blue">
            Common ground — valued across the divide
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {common.map((c) => (
              <HighlightCard
                key={c.id}
                c={c}
                badge="Bridges divides"
                badgeCls="border-civic-blue/25 bg-civic-blue/10 text-civic-blue"
                trailing={c.bridge_score != null ? `bridge ${c.bridge_score.toFixed(2)}` : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {steelEntries.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-ink-soft">Strongest from each side</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {(["support", "oppose", "conditional"] as const).map((k) => {
              const c = steel[k];
              const meta = STANCE_META[k];
              if (!c || !meta) return null;
              return (
                <HighlightCard
                  key={c.id}
                  c={c}
                  badge={meta.label}
                  badgeCls={meta.cls}
                  trailing={`★ ${c.valuable_net}`}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
