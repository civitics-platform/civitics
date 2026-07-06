"use client";

/**
 * FIX-751 — the default ledger view (decision 2/3). Registry column sets,
 * sticky sortable header (server keyset sort — never a client re-sort), and
 * keyset infinite scroll behind a hand-rolled fixed-row-height render window
 * (top/bottom spacer rows) so the DOM stays bounded with thousands of loaded
 * rows. No virtualization dependency — decision 3 forbids new npm deps.
 *
 * Keyboard: container is focusable; ↑/↓ move the active row, Enter opens the
 * detail rail, Space toggles selection (seedable kinds only), Escape clears
 * the selection.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BrowseKind, BrowseRow, BrowseSort } from "@/lib/browse/types";
import { BROWSE_REGISTRY } from "@/lib/browse/registry";
import { ledgerColumnDefs } from "./ledger-columns";
import { rowKey } from "./format";

const ROW_H_FALLBACK = 33;
const OVERSCAN = 16;
const LOAD_MORE_PX = 800;

export function LedgerTable({
  rows, kind, sort, onSortChange, selection, onToggleSelect, detailKey, onDetail,
  hasMore, loadingMore, onLoadMore, loading, resetKey, onEscape, trailer, empty,
}: {
  rows: BrowseRow[];
  kind: BrowseKind | null;
  sort: BrowseSort;
  onSortChange: (sort: BrowseSort) => void;
  selection: ReadonlyMap<string, BrowseRow>;
  onToggleSelect: (row: BrowseRow) => void;
  detailKey: string | null;
  onDetail: (row: BrowseRow) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  loading: boolean;
  /** Changes when the filter state changes — scrolls back to the top. */
  resetKey: string;
  onEscape: () => void;
  /** Rendered after the table inside the scroll area (loaders, escape hatch). */
  trailer?: ReactNode;
  /** Rendered instead of the table when there are no rows and not loading. */
  empty?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(ROW_H_FALLBACK);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const [activeIndex, setActiveIndex] = useState(-1);
  const rafRef = useRef<number | null>(null);

  const columns = ledgerColumnDefs(kind);

  // ── Scroll → window range (rAF-throttled) ───────────────────────────────────
  const syncViewport = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    if (hasMore && !loadingMore && !loading && el.scrollHeight - (el.scrollTop + el.clientHeight) < LOAD_MORE_PX) {
      onLoadMore();
    }
  }, [hasMore, loadingMore, loading, onLoadMore]);

  function handleScroll() {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      syncViewport();
    });
  }

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  // Filter state changed → back to the top, keyboard position reset.
  useEffect(() => {
    setActiveIndex(-1);
    const el = containerRef.current;
    if (el) el.scrollTop = 0;
    setViewport((v) => ({ ...v, top: 0 }));
  }, [resetKey]);

  // Short result sets never scroll — top up until the viewport is full.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || rows.length === 0) return;
    if (hasMore && !loadingMore && !loading && el.scrollHeight <= el.clientHeight) onLoadMore();
  }, [rows.length, hasMore, loadingMore, loading, onLoadMore]);

  // Measure the real row height once rows exist (fallback estimate until then).
  const measureRow = useCallback((el: HTMLTableRowElement | null) => {
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0 && Math.abs(h - rowH) > 0.5) setRowH(h);
  }, [rowH]);

  const start = Math.max(0, Math.floor(viewport.top / rowH) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / rowH) + OVERSCAN);
  const topPad = start * rowH;
  const bottomPad = (rows.length - end) * rowH;

  // ── Keyboard ────────────────────────────────────────────────────────────────
  function scrollRowIntoView(index: number) {
    const el = containerRef.current;
    if (!el) return;
    const headH = 30; // sticky header approximation — overscan absorbs drift
    const rowTop = index * rowH + headH;
    if (rowTop < el.scrollTop + headH) el.scrollTop = rowTop - headH;
    else if (rowTop + rowH > el.scrollTop + el.clientHeight) el.scrollTop = rowTop + rowH - el.clientHeight;
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (rows.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown"
        ? Math.min(rows.length - 1, activeIndex + 1)
        : Math.max(0, activeIndex - 1);
      setActiveIndex(next);
      scrollRowIntoView(next);
      return;
    }
    const active = rows[activeIndex];
    if (!active) {
      if (e.key === "Escape") onEscape();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onDetail(active);
    } else if (e.key === " ") {
      e.preventDefault();
      if (BROWSE_REGISTRY[active.kind].graphSeedable) onToggleSelect(active);
    } else if (e.key === "Escape") {
      onEscape();
    }
  }

  function headerClick(col: { sort?: BrowseSort; sortAlt?: BrowseSort }) {
    if (!col.sort) return;
    // name toggles asc⇄desc; single-direction sorts just apply.
    if (col.sortAlt && sort === col.sort) onSortChange(col.sortAlt);
    else onSortChange(col.sort);
  }

  const colCount = columns.length + 1;

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="grid"
      aria-rowcount={rows.length}
      aria-busy={loading}
      className="relative flex-1 overflow-y-auto overflow-x-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
    >
      {loading && rows.length > 0 && (
        <div className="pointer-events-none sticky top-0 z-20 h-[2px] w-full animate-pulse bg-amber/70 motion-reduce:animate-none" />
      )}

      {loading && rows.length === 0 ? (
        <div className="space-y-1.5 px-4 py-3" aria-hidden>
          {[...Array(10)].map((_, i) => (
            <div key={i} className="h-[26px] animate-pulse rounded-[2px] bg-rule/40 motion-reduce:animate-none" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        empty
      ) : (
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 w-[36px] border-b border-rule bg-card px-3 py-2" aria-label="Select" />
              {columns.map((col) => {
                const isSorted = col.sort === sort || col.sortAlt === sort;
                return (
                  <th
                    key={col.id}
                    onClick={() => headerClick(col)}
                    aria-sort={isSorted ? (sort.endsWith("asc") ? "ascending" : "descending") : undefined}
                    className={`sticky top-0 z-10 border-b border-rule bg-card px-3 py-2 text-[10px] font-normal uppercase tracking-[0.12em] whitespace-nowrap
                      ${col.align === "right" ? "text-right" : "text-left"}
                      ${isSorted ? "text-amber" : "text-ink-soft/70"}
                      ${col.sort ? "cursor-pointer hover:text-ink" : ""}
                      ${col.width ?? ""}`}
                  >
                    {col.header}
                    {isSorted && <span className="ml-1">{sort.endsWith("asc") ? "▲" : "▼"}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 && (
              <tr aria-hidden style={{ height: `${topPad}px` }}>
                <td colSpan={colCount} className="p-0" />
              </tr>
            )}
            {rows.slice(start, end).map((row, i) => {
              const index = start + i;
              const key = rowKey(row);
              const picked = selection.has(key);
              const isDetail = detailKey === key;
              const isActive = activeIndex === index;
              const seedable = BROWSE_REGISTRY[row.kind].graphSeedable;
              return (
                <tr
                  key={key}
                  ref={index === start ? measureRow : undefined}
                  onClick={() => { setActiveIndex(index); onDetail(row); }}
                  aria-selected={picked}
                  className={`cursor-pointer border-b border-rule/40 transition-colors
                    ${isDetail ? "bg-amber/10" : isActive ? "bg-ink/10" : picked ? "bg-green-ink/5" : "hover:bg-ink/5"}`}
                >
                  <td className="px-3 py-[6px]" onClick={(e) => e.stopPropagation()}>
                    {seedable && (
                      <input
                        type="checkbox"
                        checked={picked}
                        onChange={() => onToggleSelect(row)}
                        aria-label={`Select ${row.display_name}`}
                        className="h-3 w-3 cursor-pointer rounded-[2px] border-rule bg-paper text-green-ink focus:ring-green-ink"
                      />
                    )}
                  </td>
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={`max-w-[300px] overflow-hidden px-3 py-[6px] align-middle whitespace-nowrap ${col.align === "right" ? "text-right" : ""}`}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {bottomPad > 0 && (
              <tr aria-hidden style={{ height: `${bottomPad}px` }}>
                <td colSpan={colCount} className="p-0" />
              </tr>
            )}
          </tbody>
        </table>
      )}

      {trailer}
    </div>
  );
}
