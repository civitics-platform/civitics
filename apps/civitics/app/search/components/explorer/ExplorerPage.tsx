"use client";

/**
 * FIX-751 / FIX-752 — the W1 Explorer (Screen 2 of the agreed concepts). One
 * BrowseState { scope, facets, q, sort } drives every surface; it serializes
 * to the URL on every change (shareable/bookmarkable) and both rails are pure
 * views over it.
 *
 * Fetch hygiene (FIX-752): q debounced 300ms; facet/scope/sort changes
 * coalesced ~250ms; in-flight fetches aborted on supersession; rows and facet
 * counts fetched as SEPARATE requests on the same settle so the slow narrowed
 * facet path never blocks rows (facet failure → counts_mode omitted).
 *
 * Terminal Wave 2 scope (FIX-723) is preserved: everything below the site
 * masthead is a dark live instrument (data-theme=terminal, text-ink restated).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowseCountsMode, BrowseResponse, BrowseRow, BrowseSort, BrowseState, FacetMap } from "@/lib/browse/types";
import { serializeBrowseState } from "@/lib/browse/browse-state";
import { resolveBrowseParams } from "@/lib/browse/legacy";
import { compileScope, scopeCrumbs } from "@/lib/browse/scope-tree";
import { sortsFor } from "@/lib/browse/registry";
import { ScopeRail } from "./ScopeRail";
import { CrumbBar } from "./CrumbBar";
import { ToolRow, type BrowseView } from "./ToolRow";
import { LedgerTable } from "./LedgerTable";
import { CardsGrid } from "./CardsGrid";
import { DetailRail } from "./DetailRail";
import { ExplorerActionBar } from "./ExplorerActionBar";
import { formatCountCompact, rowKey } from "./format";

const PAGE_LIMIT = 48;
const FACET_COALESCE_MS = 250;
const Q_DEBOUNCE_MS = 300;
const VIEW_STORAGE_KEY = "civitics:browse:view";

export interface ExplorerPageProps {
  initialState: BrowseState;
  /** View from the URL (?view=cards) — null lets localStorage decide. */
  initialView: BrowseView | null;
  /** SSR first fetch (rows + facets in one pass); null → client fetches on mount. */
  initialData: BrowseResponse | null;
}

export function ExplorerPage({ initialState, initialView, initialData }: ExplorerPageProps) {
  // ── The one state object ────────────────────────────────────────────────────
  const [scope, setScopeRaw] = useState(initialState.scope);
  const [facets, setFacets] = useState<FacetMap>(initialState.facets);
  const [qInput, setQInput] = useState(initialState.q);
  const [q, setQ] = useState(initialState.q);
  const [sort, setSort] = useState<BrowseSort>(initialState.sort);
  const [view, setView] = useState<BrowseView>(initialView ?? "table");

  // ── Result state ────────────────────────────────────────────────────────────
  const [rows, setRows] = useState<BrowseRow[]>(initialData?.rows ?? []);
  const [cursor, setCursor] = useState<string | null>(initialData?.cursor ?? null);
  const [facetCounts, setFacetCounts] = useState<Record<string, Record<string, number>>>(initialData?.facets ?? {});
  const [totals, setTotals] = useState<{ count: number | null }>(initialData?.totals ?? { count: null });
  const [countsMode, setCountsMode] = useState<BrowseCountsMode>(initialData?.counts_mode ?? "omitted");
  const [refreshedAt, setRefreshedAt] = useState<string | null>(initialData?.refreshed_at ?? null);
  const [loading, setLoading] = useState(initialData == null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Map<string, BrowseRow>>(new Map());
  const [detailRow, setDetailRow] = useState<BrowseRow | null>(null);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const compiled = useMemo(() => {
    try { return compileScope(scope); } catch { return { kind: null, facets: {} as FacetMap }; }
  }, [scope]);
  const kind = compiled.kind;

  const crumbs = useMemo(() => {
    try { return scopeCrumbs(scope); } catch { return []; }
  }, [scope]);
  const scopeLabel = crumbs.length > 0 ? (crumbs[crumbs.length - 1]?.label ?? null) : null;

  const stateKey = useMemo(() => JSON.stringify([scope, facets, q, sort]), [scope, facets, q, sort]);
  const selectionScopeKey = useMemo(() => JSON.stringify([scope, facets, q]), [scope, facets, q]);

  // Per-kind facet value universe — first exact counts seen per kind, so blocks
  // keep their value rows when the live counts are narrowed/omitted.
  const universeRef = useRef<Record<string, Record<string, string[]>>>({});
  const rememberUniverse = useCallback((k: string | null, counts: Record<string, Record<string, number>>, mode: BrowseCountsMode) => {
    if (!k || mode !== "exact") return;
    const perKind = (universeRef.current[k] ??= {});
    for (const [key, values] of Object.entries(counts)) {
      const existing = new Set(perKind[key] ?? []);
      for (const v of Object.keys(values)) existing.add(v);
      perKind[key] = [...existing];
    }
  }, []);
  const universeInitRef = useRef(false);
  if (!universeInitRef.current) {
    universeInitRef.current = true;
    if (initialData) rememberUniverse(initialData.query.kind, initialData.facets, initialData.counts_mode);
  }

  // ── q debounce (300ms) ──────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), Q_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [qInput]);

  // ── Fetch orchestration ─────────────────────────────────────────────────────
  const lastFetchedKeyRef = useRef<string | null>(initialData ? stateKey : null);
  const lastQRef = useRef(q);
  const fetchSeqRef = useRef(0);
  const rowsAbortRef = useRef<AbortController | null>(null);
  const facetsAbortRef = useRef<AbortController | null>(null);

  const doFetch = useCallback((key: string, state: BrowseState, k: string | null) => {
    lastFetchedKeyRef.current = key;
    const seq = ++fetchSeqRef.current;
    rowsAbortRef.current?.abort();
    facetsAbortRef.current?.abort();
    const rowsCtl = new AbortController();
    const facetsCtl = new AbortController();
    rowsAbortRef.current = rowsCtl;
    facetsAbortRef.current = facetsCtl;

    setLoading(true);
    setError(null);

    // Rows first — never blocked on facet counting (FIX-752).
    const rowsSp = serializeBrowseState(state);
    rowsSp.set("only", "rows");
    rowsSp.set("limit", String(PAGE_LIMIT));
    fetch(`/api/browse?${rowsSp.toString()}`, { signal: rowsCtl.signal })
      .then(async (res) => {
        if (seq !== fetchSeqRef.current) return;
        if (!res.ok) {
          setRows([]); setCursor(null); setLoading(false);
          setError(`Browse request failed (${res.status})`);
          return;
        }
        const data: BrowseResponse = await res.json();
        if (seq !== fetchSeqRef.current) return;
        setRows(data.rows);
        setCursor(data.cursor);
        setRefreshedAt(data.refreshed_at);
        setLoading(false);
      })
      .catch((e) => {
        if (rowsCtl.signal.aborted || seq !== fetchSeqRef.current) return;
        setRows([]); setCursor(null); setLoading(false);
        setError(e instanceof Error ? e.message : "Browse request failed");
      });

    // Facet counts as the secondary request on the same settle.
    if (k) {
      const facetsSp = serializeBrowseState(state);
      facetsSp.set("only", "facets");
      fetch(`/api/browse?${facetsSp.toString()}`, { signal: facetsCtl.signal })
        .then(async (res) => {
          if (seq !== fetchSeqRef.current) return;
          if (!res.ok) { setFacetCounts({}); setTotals({ count: null }); setCountsMode("omitted"); return; }
          const data: BrowseResponse = await res.json();
          if (seq !== fetchSeqRef.current) return;
          setFacetCounts(data.facets);
          setTotals(data.totals);
          setCountsMode(data.counts_mode);
          rememberUniverse(k, data.facets, data.counts_mode);
        })
        .catch(() => {
          if (facetsCtl.signal.aborted || seq !== fetchSeqRef.current) return;
          setFacetCounts({}); setTotals({ count: null }); setCountsMode("omitted");
        });
    } else {
      setFacetCounts({}); setTotals({ count: null }); setCountsMode("omitted");
    }
  }, [rememberUniverse]);

  useEffect(() => {
    if (lastFetchedKeyRef.current === stateKey) return;
    const qChanged = lastQRef.current !== q;
    lastQRef.current = q;
    // q is pre-debounced; everything else coalesces so a burst of facet clicks
    // fires ONE fetch. First-ever fetch (no SSR data) goes immediately.
    const delay = qChanged || lastFetchedKeyRef.current === null ? 0 : FACET_COALESCE_MS;
    const state: BrowseState = { scope, facets, q, sort, cursor: null };
    const t = setTimeout(() => doFetch(stateKey, state, kind), delay);
    return () => clearTimeout(t);
  }, [stateKey, scope, facets, q, sort, kind, doFetch]);

  // Abort in-flight work on unmount.
  useEffect(() => () => {
    rowsAbortRef.current?.abort();
    facetsAbortRef.current?.abort();
  }, []);

  // Selection + detail reset when the result set changes (sort excluded — the
  // set is the same rows reordered).
  const selectionInitRef = useRef(true);
  useEffect(() => {
    if (selectionInitRef.current) { selectionInitRef.current = false; return; }
    setSelection(new Map());
    setDetailRow(null);
  }, [selectionScopeKey]);

  // ── Infinite scroll ─────────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || loading) return;
    setLoadingMore(true);
    const seq = fetchSeqRef.current;
    const sp = serializeBrowseState({ scope, facets, q, sort, cursor });
    sp.set("only", "rows");
    sp.set("limit", String(PAGE_LIMIT));
    const ctl = new AbortController();
    rowsAbortRef.current = ctl;
    fetch(`/api/browse?${sp.toString()}`, { signal: ctl.signal })
      .then(async (res) => {
        if (seq !== fetchSeqRef.current) return; // filters changed mid-flight
        if (!res.ok) { setLoadingMore(false); return; }
        const data: BrowseResponse = await res.json();
        if (seq !== fetchSeqRef.current) return;
        setRows((prev) => [...prev, ...data.rows]);
        setCursor(data.cursor);
        setLoadingMore(false);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setLoadingMore(false);
      });
  }, [cursor, loadingMore, loading, scope, facets, q, sort]);

  // ── URL sync (decision 4) + history navigation ──────────────────────────────
  const popRestoreRef = useRef(false);
  const lastSyncedScopeRef = useRef(initialState.scope);
  const firstSyncRef = useRef(true);
  useEffect(() => {
    const sp = serializeBrowseState({ scope, facets, q, sort, cursor: null });
    if (view === "cards") sp.set("view", "cards");
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
  }, [scope, facets, q, sort, view]);

  useEffect(() => {
    function onPop() {
      const sp = new URLSearchParams(window.location.search);
      const { state } = resolveBrowseParams(sp);
      popRestoreRef.current = true;
      setScopeRaw(state.scope);
      setFacets(state.facets);
      setQ(state.q);
      setQInput(state.q);
      setSort(state.sort);
      setView(sp.get("view") === "cards" ? "cards" : "table");
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // View persistence: URL param wins on load; otherwise localStorage restores.
  useEffect(() => {
    if (initialView != null) return;
    try {
      if (window.localStorage.getItem(VIEW_STORAGE_KEY) === "cards") setView("cards");
    } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleScope = useCallback((path: string) => {
    setScopeRaw(path);
    setFacets({});
    setSort((prev) => {
      let nextKind = null;
      try { nextKind = compileScope(path).kind; } catch { /* stays all-kinds */ }
      const valid = nextKind ? sortsFor(nextKind) : (["connections_desc", "name_asc", "name_desc"] as BrowseSort[]);
      return valid.includes(prev) ? prev : "connections_desc";
    });
  }, []);

  const handleToggleFacet = useCallback((key: string, value: string) => {
    setFacets((prev) => {
      const next: FacetMap = { ...prev };
      const current = prev[key];
      const values = current == null ? [] : Array.isArray(current) ? [...current] : [current];
      const at = values.indexOf(value);
      if (at >= 0) values.splice(at, 1);
      else values.push(value);
      if (values.length === 0) delete next[key];
      else next[key] = values.length === 1 ? (values[0] as string) : values;
      return next;
    });
  }, []);

  const handleRemoveFacet = handleToggleFacet; // removing = toggling off an active value

  const handlePivot = useCallback((key: string, value: string) => {
    setFacets({ [key]: value });
    setQ("");
    setQInput("");
  }, []);

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

  const handleRetry = useCallback(() => {
    lastFetchedKeyRef.current = null;
    doFetch(stateKey, { scope, facets, q, sort, cursor: null }, kind);
  }, [doFetch, stateKey, scope, facets, q, sort, kind]);

  const searchEverywhere = useCallback(() => {
    setScopeRaw("");
    setFacets({});
  }, []);

  // ── Render pieces ───────────────────────────────────────────────────────────
  const detailKey = detailRow ? rowKey(detailRow) : null;
  const selectedRows = useMemo(() => [...selection.values()], [selection]);
  const facetChipCount = Object.values(facets).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);

  const showEscapeHatch = Boolean(q) && Boolean(scope) && !loading && !error && rows.length < PAGE_LIMIT;

  const escapeHatch = showEscapeHatch ? (
    <div className="border-t border-rule/60 px-4 py-3">
      <button
        onClick={searchEverywhere}
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
        onClick={handleRetry}
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
          onClick={() => setFacets({})}
          className="mt-3 font-mono text-[11px] text-ink-soft underline decoration-dotted underline-offset-2 transition-colors hover:text-amber focus-visible:outline-none focus-visible:text-accent"
        >
          clear filters
        </button>
      )}
      {q && scope && (
        <div className="mx-auto mt-4 max-w-sm">
          <button
            onClick={searchEverywhere}
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
    onLoadMore: loadMore,
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
        {/* LEFT — scope tree + facets */}
        <div className="hidden min-h-0 md:block">
          <ScopeRail
            scope={scope}
            kind={kind}
            scopeFacets={compiled.facets}
            facets={facets}
            facetCounts={facetCounts}
            universe={kind ? (universeRef.current[kind] ?? {}) : {}}
            totalsCount={countsMode === "exact" ? totals.count : null}
            scopeLabel={scopeLabel ?? "all"}
            onScope={handleScope}
            onToggleFacet={handleToggleFacet}
          />
        </div>

        {/* CENTER — crumbs, toolrow, results */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <CrumbBar
            scope={scope}
            kind={kind}
            facets={facets}
            onScope={handleScope}
            onRemoveFacet={handleRemoveFacet}
            onClearFacets={() => setFacets({})}
          />
          <ToolRow
            q={qInput}
            onQChange={setQInput}
            scopeLabel={scopeLabel}
            view={view}
            onViewChange={handleViewChange}
            kind={kind}
            sort={sort}
            onSortChange={setSort}
          />

          {view === "table" ? (
            <LedgerTable
              {...viewProps}
              sort={sort}
              onSortChange={setSort}
              resetKey={stateKey}
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
            onPivot={handlePivot}
            onSeedToGraph={handleSeedToGraph}
            onAddToSelection={handleToggleSelect}
            isSelected={detailKey != null && selection.has(detailKey)}
          />
        </div>
      </div>
    </div>
  );
}
