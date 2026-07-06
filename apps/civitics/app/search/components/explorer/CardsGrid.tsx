"use client";

/**
 * FIX-751 — the cards toggle view (decision 2): simplified generic card shapes
 * fed by BrowseRow, kind-agnostic. Infinite scroll via a sentinel, with a hard
 * render cap (decision 3) — the grid layout makes spacer-window math unstable,
 * so past the cap we stop rendering and say so instead of growing the DOM.
 */

import { useEffect, useRef } from "react";
import type { BrowseKind, BrowseRow } from "@/lib/browse/types";
import { BROWSE_REGISTRY } from "@/lib/browse/registry";
import { SyntheticMark } from "../../../components/integrity/Synthetic";
import { Chip, chipVariantFor } from "./Chip";
import { formatDollarsCompact, initials, rowKey, titleizeValue } from "./format";

const CARD_RENDER_CAP = 300;

export function CardsGrid({
  rows, kind, selection, onToggleSelect, detailKey, onDetail,
  hasMore, loadingMore, onLoadMore, loading, empty, trailer,
}: {
  rows: BrowseRow[];
  kind: BrowseKind | null;
  selection: ReadonlyMap<string, BrowseRow>;
  onToggleSelect: (row: BrowseRow) => void;
  detailKey: string | null;
  onDetail: (row: BrowseRow) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  loading: boolean;
  empty?: React.ReactNode;
  trailer?: React.ReactNode;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const capped = rows.length >= CARD_RENDER_CAP;
  const visible = capped ? rows.slice(0, CARD_RENDER_CAP) : rows;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loadingMore || loading || capped) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) onLoadMore(); },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loading, capped, onLoadMore]);

  if (loading && rows.length === 0) {
    return (
      <div className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5 overflow-y-auto px-4 py-3" aria-hidden>
        {[...Array(9)].map((_, i) => (
          <div key={i} className="h-[92px] animate-pulse rounded-[3px] bg-rule/40 motion-reduce:animate-none" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <div className="flex-1 overflow-y-auto">{empty}</div>;
  }

  return (
    <div className="relative flex-1 overflow-y-auto px-4 py-3" aria-busy={loading}>
      {loading && (
        <div className="pointer-events-none sticky top-0 z-20 -mt-3 mb-3 h-[2px] w-full animate-pulse bg-amber/70 motion-reduce:animate-none" />
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2.5">
        {visible.map((row) => {
          const key = rowKey(row);
          const picked = selection.has(key);
          const isDetail = detailKey === key;
          const seedable = BROWSE_REGISTRY[row.kind].graphSeedable;
          return (
            <div
              key={key}
              onClick={() => onDetail(row)}
              className={`cursor-pointer rounded-[3px] border bg-card p-3 transition-colors
                ${isDetail ? "border-amber/60" : picked ? "border-green-ink/50" : "border-rule hover:border-ink-soft/50"}`}
            >
              <div className="flex items-start gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[2px] border border-term-line bg-paper-2 font-mono text-[10px] font-semibold text-ink-soft">
                  {row.photo_url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={row.photo_url} alt="" width={32} height={32} loading="lazy" decoding="async" className="h-8 w-8 object-cover" />
                    : initials(row.display_name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-ink">
                    {row.display_name}
                    {row.is_synthetic && <SyntheticMark size="xs" className="ml-1.5" />}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-ink-soft">
                    {row.secondary_label ?? BROWSE_REGISTRY[row.kind].label}
                  </p>
                </div>
                {seedable && (
                  <input
                    type="checkbox"
                    checked={picked}
                    onChange={() => onToggleSelect(row)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${row.display_name}`}
                    className="h-3 w-3 shrink-0 cursor-pointer rounded-[2px] border-rule bg-paper text-green-ink focus:ring-green-ink"
                  />
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {!kind && <Chip>{BROWSE_REGISTRY[row.kind].label.toUpperCase()}</Chip>}
                {row.facets.party && (
                  <Chip variant={chipVariantFor("party", row.facets.party)}>{row.facets.party.slice(0, 3).toUpperCase()}</Chip>
                )}
                {row.facets.status && (
                  <Chip variant={chipVariantFor("status", row.facets.status)}>{titleizeValue(row.facets.status)}</Chip>
                )}
                {row.facets.state && <Chip>{row.facets.state.toUpperCase()}</Chip>}
                {row.amount_cents != null && row.amount_cents > 0 && (
                  <Chip><span className="tabular-nums">{formatDollarsCompact(row.amount_cents)}</span></Chip>
                )}
                {row.connection_count > 0 && (
                  <Chip><span className="tabular-nums">{row.connection_count.toLocaleString()} conn</span></Chip>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {capped && (
        <p className="py-4 text-center font-mono text-[11px] text-ink-soft">
          {CARD_RENDER_CAP} cards shown — refine filters, or switch to the table view to keep scrolling.
        </p>
      )}
      <div ref={sentinelRef} className="h-4" />
      {trailer}
    </div>
  );
}
