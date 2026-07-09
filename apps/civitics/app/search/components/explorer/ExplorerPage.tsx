"use client";

/**
 * FIX-751 / FIX-752 — the W1 Explorer (Screen 2 of the agreed concepts). One
 * BrowseState { scope, facets, q, sort } drives every surface; it serializes
 * to the URL on every change (shareable/bookmarkable) and both rails are pure
 * views over it.
 *
 * FIX-762 — the state + fetch orchestration now lives in useBrowseExplorer
 * (shared with the graph's sidebar mount) so the settled interaction semantics
 * stay identical across surfaces; this component keeps only what is
 * page-shaped: URL/history sync, view toggle, selection, and the detail rail.
 * FIX-763 — the ScopeRail's Saved section renders the live SavedViewsRail
 * (replacing the W1 disabled stub).
 *
 * Terminal Wave 2 scope (FIX-723) is preserved: everything below the site
 * masthead is a dark live instrument (data-theme=terminal, text-ink restated).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowseResponse, BrowseRow, BrowseState } from "@/lib/browse/types";
import type { DiscoveryRootKey } from "@/lib/browse/discovery";
import { serializeBrowseState } from "@/lib/browse/browse-state";
import { resolveBrowseParams } from "@/lib/browse/legacy";
import { useBrowseExplorer } from "./useBrowseExplorer";
import { ScopeRail } from "./ScopeRail";
import { SavedViewsRail } from "./SavedViewsRail";
import { CrumbBar } from "./CrumbBar";
import { ToolRow, type BrowseView } from "./ToolRow";
import { LedgerTable } from "./LedgerTable";
import { CardsGrid } from "./CardsGrid";
import { DetailRail } from "./DetailRail";
import { ExplorerActionBar } from "./ExplorerActionBar";
import { formatCountCompact, rowKey } from "./format";

const PAGE_LIMIT = 48;
const VIEW_STORAGE_KEY = "civitics:browse:view";

export interface ExplorerPageProps {
  initialState: BrowseState;
  /** View from the URL (?view=cards) — null lets localStorage decide. */
  initialView: BrowseView | null;
  /** SSR first fetch (rows + facets in one pass); null → client fetches on mount. */
  initialData: BrowseResponse | null;
  /** Discovery-path root from the URL (?root=place|topic) — FIX-768. */
  initialRoot?: string | null;
}

function normalizeRoot(raw: string | null | undefined): DiscoveryRootKey {
  return raw === "place" || raw === "topic" ? raw : "branch";
}

export function ExplorerPage({ initialState, initialView, initialData, initialRoot }: ExplorerPageProps) {
  // ── Shared explorer state + fetch orchestration (FIX-762) ───────────────────
  const ex = useBrowseExplorer({ initialState, initialData, pageLimit: PAGE_LIMIT });
  const {
    scope, facets, qInput, q, sort, kind, compiled, scopeLabel,
    rows, cursor, facetCounts, totals, countsMode, refreshedAt,
    loading, loadingMore, error,
  } = ex;

  // ── Page-shaped state ───────────────────────────────────────────────────────
  const [view, setView] = useState<BrowseView>(initialView ?? "table");
  const [root, setRoot] = useState<DiscoveryRootKey>(() => normalizeRoot(initialRoot));
  const [selection, setSelection] = useState<Map<string, BrowseRow>>(new Map());
  const [detailRow, setDetailRow] = useState<BrowseRow | null>(null);

  // Selection + detail reset when the result set changes (sort excluded — the
  // set is the same rows reordered).
  const selectionInitRef = useRef(true);
  useEffect(() => {
    if (selectionInitRef.current) { selectionInitRef.current = false; return; }
    setSelection(new Map());
    setDetailRow(null);
  }, [ex.selectionScopeKey]);

  // ── URL sync (decision 4) + history navigation ──────────────────────────────
  const popRestoreRef = useRef(false);
  const lastSyncedScopeRef = useRef(initialState.scope);
  const firstSyncRef = useRef(true);
  useEffect(() => {
    const sp = serializeBrowseState({ scope, facets, q, sort, cursor: null });
    if (view === "cards") sp.set("view", "cards");
    if (root !== "branch") sp.set("root", root); // keep the discovery root shareable (FIX-768)
    const qs = sp.toString();
    const url = qs ? `/search?${qs}` : "/search";
    const current = window.location.search.replace(/^\?/, "");
    if (popRestoreRef.current) {
      popRestoreRef.current = false;
      lastSyncedScopeRef.current = scope;
      return;
    }
    if (current === qs) { firstSyncRef.current = false; return; }
    // Scope drills push (back pops the drill); everything else replaces so
    // typing/facet toggles don't spam history. First sync normalizes legacy
    // URLs in place.
    const scopeChanged = lastSyncedScopeRef.current !== scope;
    if (firstSyncRef.current || !scopeChanged) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    firstSyncRef.current = false;
    lastSyncedScopeRef.current = scope;
  }, [scope, facets, q, sort, view, root]);

  const applyState = ex.applyState;
  useEffect(() => {
    function onPop() {
      const sp = new URLSearchParams(window.location.search);
      const { state } = resolveBrowseParams(sp);
      popRestoreRef.current = true;
      applyState(state);
      setView(sp.get("view") === "cards" ? "cards" : "table");
      setRoot(normalizeRoot(sp.get("root")));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyState]);

  // View persistence: URL param wins on load; otherwise localStorage restores.
  useEffect(() => {
    if (initialView != null) return;
    try {
      if (window.localStorage.getItem(VIEW_STORAGE_KEY) === "cards") setView("cards");
    } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleViewChange = useCallback((v: BrowseView) => {
    setView(v);
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, v); } catch { /* storage unavailable */ }
  }, []);

  const handleToggleSelect = useCallback((row: BrowseRow) => {
    setSelection((prev) => {
      const next = new Map(prev);
      const key = rowKey(row);
      if (next.has(key)) next.delete(key);
      else next.set(key, row);
      return next;
    });
  }, []);

  const handleSeedToGraph = useCallback((row: BrowseRow) => {
    const params = new URLSearchParams({ addEntityIds: row.entity_id, addEntityTypes: row.kind });
    window.location.href = `/graph?${params.toString()}`;
  }, []);

  const handleRemoveFacet = ex.handleToggleFacet; // removing = toggling off an active value

  // ── Render pieces ───────────────────────────────────────────────────────────
  const detailKey = detailRow ? rowKey(detailRow) : null;
  const selectedRows = useMemo(() => [...selection.values()], [selection]);
  const facetChipCount = Object.values(facets).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);

  const showEscapeHatch = Boolean(q) && Boolean(scope) && !loading && !error && rows.length < PAGE_LIMIT;

  const escapeHatch = showEscapeHatch ? (
    <div className="border-t border-rule/60 px-4 py-3">
      <button
        onClick={ex.searchEverywhere}
        className="w-full rounded-[2px] border border-dashed border-term-line px-3 py-2 text-center font-mono text-[11.5px] text-ink-soft transition-colors hover:border-amber/50 hover:text-amber focus-visible:outline-none focus-visible:border-accent focus-visible:text-accent"
      >
        SEARCH EVERYWHERE FOR “{q}” →
      </button>
    </div>
  ) : null;

  const trailer = (
    <>
      {loadingMore && (
        <p className="py-3 text-center font-mono text-[11px] text-ink-soft" role="status">loading more…</p>
      )}
      {escapeHatch}
    </>
  );

  const empty = error ? (
    <div className="px-6 py-16 text-center">
      <p className="font-mono text-[12px] text-accent">{error}</p>
      <button
        onClick={ex.handleRetry}
        className="mt-3 rounded-[2px] border border-term-line px-3 py-1.5 font-mono text-[11px] text-ink transition-colors hover:border-accent/60 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        RETRY
      </button>
    </div>
  ) : (
    <div className="px-6 py-16 text-center">
      <p className="font-mono text-[12px] text-ink-soft">
        {q
          ? `No matches for “${q}”${scopeLabel ? ` in ${scopeLabel}` : ""}`
          : `Nothing here${scopeLabel ? ` in ${scopeLabel}` : ""} with these filters`}
      </p>
      {facetChipCount > 0 && (
        <button
          onClick={() => ex.setFacets({})}
          className="mt-3 font-mono text-[11px] text-ink-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-amber focus-visible:outline-none focus-visible:text-accent"
        >
          clear filters
        </button>
      )}
      {q && scope && (
        <div className="mx-auto mt-4 max-w-sm">
          <button
            onClick={ex.searchEverywhere}
            className="w-full rounded-[2px] border border-dashed border-term-line px-3 py-2 font-mono text-[11.5px] text-ink-soft transition-colors hover:border-amber/50 hover:text-amber focus-visible:outline-none focus-visible:text-accent"
          >
            SEARCH EVERYWHERE FOR “{q}” →
          </button>
        </div>
      )}
    </div>
  );

  const viewProps = {
    rows, kind, selection, detailKey,
    onToggleSelect: handleToggleSelect,
    onDetail: setDetailRow,
    hasMore: cursor != null,
    loadingMore,
    onLoadMore: ex.loadMore,
    loading,
    empty,
    trailer,
  };

  // refreshed_at renders as a fixed UTC stamp (deterministic from the ISO
  // string — hydration-safe, unlike a relative age).
  const refreshedLabel = refreshedAt ? `${refreshedAt.slice(11, 16)} UTC` : null;

  return (
    <div data-theme="terminal" className="flex h-screen flex-col overflow-hidden bg-paper text-ink">
      {/* Live-instrument kicker (FIX-723 idiom) */}
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule bg-card px-4 py-2.5">
        <p className="flex items-center gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-amber">
          <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-amber motion-reduce:animate-none" />
          Search &amp; Browse — Live index
        </p>
        <span className="font-mono text-[10.5px] tracking-[0.04em] text-ink-soft/70">
          {scopeLabel ? `scope: ${scopeLabel.toLowerCase()}` : "all records"}
          {` · ${facetChipCount} facet${facetChipCount === 1 ? "" : "s"}`}
          {totals.count != null && ` · ${formatCountCompact(totals.count)} matches`}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[264px_minmax(0,1fr)] xl:grid-cols-[264px_minmax(0,1fr)_292px]">
        {/* LEFT — scope tree + saved views + facets */}
        <div className="hidden min-h-0 md:block">
          <ScopeRail
            scope={scope}
            kind={kind}
            scopeFacets={compiled.facets}
            facets={facets}
            facetCounts={facetCounts}
            universe={ex.universe}
            totalsCount={countsMode === "exact" ? totals.count : null}
            scopeLabel={scopeLabel ?? "all"}
            onScope={ex.handleScope}
            onToggleFacet={ex.handleToggleFacet}
            root={root}
            onRootChange={setRoot}
            savedViewsSlot={
              <SavedViewsRail
                currentState={ex.currentState}
                onApply={(state) => ex.applyState(state)}
              />
            }
          />
        </div>

        {/* CENTER — crumbs, toolrow, results */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <CrumbBar
            scope={scope}
            kind={kind}
            facets={facets}
            onScope={ex.handleScope}
            onRemoveFacet={handleRemoveFacet}
            onClearFacets={() => ex.setFacets({})}
          />
          <ToolRow
            q={qInput}
            onQChange={ex.setQInput}
            scopeLabel={scopeLabel}
            view={view}
            onViewChange={handleViewChange}
            kind={kind}
            sort={sort}
            onSortChange={ex.setSort}
          />

          {view === "table" ? (
            <LedgerTable
              {...viewProps}
              sort={sort}
              onSortChange={ex.setSort}
              resetKey={ex.stateKey}
              onEscape={() => setSelection(new Map())}
            />
          ) : (
            <CardsGrid {...viewProps} />
          )}

          <ExplorerActionBar selected={selectedRows} onClear={() => setSelection(new Map())} />

          {/* Footer strip */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule px-4 py-1.5 font-mono text-[10.5px] text-ink-soft/60">
            <span className="tabular-nums">
              {totals.count != null ? `${totals.count.toLocaleString()} matches · ` : ""}{rows.length.toLocaleString()} loaded
            </span>
            <span>keyset cursor · infinite scroll</span>
            <span className="ml-auto">
              counts: {countsMode}{refreshedLabel ? ` · entity_search_index ${refreshedLabel}` : ""}
            </span>
          </div>
        </div>

        {/* RIGHT — detail rail */}
        <div className="hidden min-h-0 xl:block">
          <DetailRail
            row={detailRow}
            onPivot={ex.handlePivot}
            onSeedToGraph={handleSeedToGraph}
            onAddToSelection={handleToggleSelect}
            isSelected={detailKey != null && selection.has(detailKey)}
          />
        </div>
      </div>
    </div>
  );
}
