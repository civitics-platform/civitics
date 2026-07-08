"use client";

/**
 * FIX-762 — the explorer's state + fetch orchestration, extracted verbatim from
 * ExplorerPage (FIX-751/752) so the graph's sidebar mount runs the SAME
 * semantics: scope change clears explicit facets (and fixes up an invalid
 * sort); pivots replace facets and clear q; q debounced 300ms; facet/scope/sort
 * changes coalesced ~250ms; in-flight fetches aborted on supersession; rows and
 * facet counts fetched as separate requests on the same settle.
 *
 * ExplorerPage keeps what is page-shaped (URL sync, history, view toggle,
 * selection, detail rail); the sidebar mount keeps what is panel-shaped. Both
 * consume this hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowseCountsMode, BrowseResponse, BrowseRow, BrowseSort, BrowseState, FacetMap,
} from "@/lib/browse/types";
import { serializeBrowseState } from "@/lib/browse/browse-state";
import { compileScope, scopeCrumbs, type ScopeCrumb } from "@/lib/browse/scope-tree";
import { sortsFor } from "@/lib/browse/registry";

const FACET_COALESCE_MS = 250;
const Q_DEBOUNCE_MS = 300;

export interface UseBrowseExplorerOptions {
  initialState: BrowseState;
  /** SSR first fetch (rows + facets in one pass); null/undefined → fetch on mount. */
  initialData?: BrowseResponse | null;
  /** Rows per page (48 on /search, smaller in the sidebar mount). */
  pageLimit?: number;
  /** Skip the secondary facet-counts request (`only=rows` everywhere). */
  fetchFacets?: boolean;
}

export function useBrowseExplorer({
  initialState,
  initialData = null,
  pageLimit = 48,
  fetchFacets = true,
}: UseBrowseExplorerOptions) {
  // ── The one state object ────────────────────────────────────────────────────
  const [scope, setScopeRaw] = useState(initialState.scope);
  const [facets, setFacets] = useState<FacetMap>(initialState.facets);
  const [qInput, setQInput] = useState(initialState.q);
  const [q, setQ] = useState(initialState.q);
  const [sort, setSort] = useState<BrowseSort>(initialState.sort);

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

  // ── Derived ─────────────────────────────────────────────────────────────────
  const compiled = useMemo(() => {
    try { return compileScope(scope); } catch { return { kind: null, facets: {} as FacetMap }; }
  }, [scope]);
  const kind = compiled.kind;

  const crumbs = useMemo((): ScopeCrumb[] => {
    try { return scopeCrumbs(scope); } catch { return []; }
  }, [scope]);
  const scopeLabel = crumbs.length > 0 ? (crumbs[crumbs.length - 1]?.label ?? null) : null;

  const stateKey = useMemo(() => JSON.stringify([scope, facets, q, sort]), [scope, facets, q, sort]);
  const selectionScopeKey = useMemo(() => JSON.stringify([scope, facets, q]), [scope, facets, q]);

  /** The current BrowseState (cursor always null — page one of the active set). */
  const currentState = useMemo(
    (): BrowseState => ({ scope, facets, q, sort, cursor: null }),
    [scope, facets, q, sort],
  );

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
    rowsSp.set("limit", String(pageLimit));
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
    if (k && fetchFacets) {
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
  }, [rememberUniverse, pageLimit, fetchFacets]);

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

  // ── Infinite scroll ─────────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || loading) return;
    setLoadingMore(true);
    const seq = fetchSeqRef.current;
    const sp = serializeBrowseState({ scope, facets, q, sort, cursor });
    sp.set("only", "rows");
    sp.set("limit", String(pageLimit));
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
  }, [cursor, loadingMore, loading, scope, facets, q, sort, pageLimit]);

  // ── Handlers (settled W1 semantics) ─────────────────────────────────────────

  /** Scope change clears explicit facets and fixes up an invalid sort. */
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

  /** Pivot: replace facets with one, clear q. */
  const handlePivot = useCallback((key: string, value: string) => {
    setFacets({ [key]: value });
    setQ("");
    setQInput("");
  }, []);

  const handleRetry = useCallback(() => {
    lastFetchedKeyRef.current = null;
    doFetch(stateKey, { scope, facets, q, sort, cursor: null }, kind);
  }, [doFetch, stateKey, scope, facets, q, sort, kind]);

  const searchEverywhere = useCallback(() => {
    setScopeRaw("");
    setFacets({});
  }, []);

  /** Replace the whole state (history pop, saved-view apply). Bypasses the q debounce. */
  const applyState = useCallback((next: BrowseState) => {
    setScopeRaw(next.scope);
    setFacets(next.facets);
    setQ(next.q);
    setQInput(next.q);
    setSort(next.sort);
  }, []);

  return {
    // state
    scope, facets, qInput, q, sort, kind, compiled, crumbs, scopeLabel,
    currentState, stateKey, selectionScopeKey,
    // results
    rows, cursor, facetCounts, totals, countsMode, refreshedAt,
    loading, loadingMore, error,
    universe: kind ? (universeRef.current[kind] ?? {}) : {},
    // setters + handlers
    setQInput, setQ, setSort, setFacets,
    handleScope, handleToggleFacet, handlePivot, handleRetry,
    searchEverywhere, applyState, loadMore,
  };
}

export type UseBrowseExplorerReturn = ReturnType<typeof useBrowseExplorer>;
