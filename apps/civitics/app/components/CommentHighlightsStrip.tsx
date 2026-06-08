"use client";

// C1 Wave B (FIX-529): proportional-representation highlights strip (decision 5).
// Pinned above the comments list AND the debate map. Two groups:
//   * common ground — up to 3 comments by bridge_score (valued across stances)
//   * strongest from each side — best comment per stance bucket, regardless of
//     bridge_score (justified representation — every viewpoint's best is visible)
// Hidden entirely when the RPC returns nothing. Clicking a card asks the list to
// select + scroll to that comment (focusComment).

import { useEffect, useState } from "react";
import { focusComment } from "./comment-focus";
import type { EntityCommentType } from "@civitics/db";

type HighlightComment = {
  id: string;
  stance: string | null;
  kind: string;
  snippet: string;
  bridge_score: number | null;
  valuable_net: number;
  author_name: string;
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
}

const STANCE_META: Record<string, { label: string; cls: string }> = {
  support: { label: "Strongest for", cls: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  oppose: { label: "Strongest against", cls: "border-red-200 bg-red-50 text-red-800" },
  conditional: { label: "Strongest condition", cls: "border-amber-200 bg-amber-50 text-amber-800" },
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
      className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50/40"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeCls}`}>
          {badge}
        </span>
        {trailing && <span className="shrink-0 text-[10px] tabular-nums text-gray-400">{trailing}</span>}
      </div>
      <p className="text-xs leading-relaxed text-gray-800">{c.snippet}</p>
      <div className="mt-1 text-[10px] text-gray-400">{c.author_name}</div>
    </button>
  );
}

export function CommentHighlightsStrip({ entityType, entityId, lens = "all" }: CommentHighlightsStripProps) {
  const [data, setData] = useState<Highlights | null>(null);

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
    <section className="mb-5 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Highlights</h3>

      {common.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-[11px] font-medium text-indigo-700">
            Common ground — valued across the divide
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {common.map((c) => (
              <HighlightCard
                key={c.id}
                c={c}
                badge="Bridges divides"
                badgeCls="border-indigo-200 bg-indigo-50 text-indigo-700"
                trailing={c.bridge_score != null ? `bridge ${c.bridge_score.toFixed(2)}` : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {steelEntries.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-gray-600">Strongest from each side</p>
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
