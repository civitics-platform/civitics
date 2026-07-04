"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FocusEntity, FocusGroup } from "@civitics/graph";
import type { SearchResults } from "../../api/search/route";
import { SearchResultCard, resultId, resultEntityId, resultEntityType } from "./SearchResultCard";
import type { AnySearchResult } from "./SearchResultCard";
import { SearchFiltersPanel } from "./SearchFiltersPanel";
import type { SearchFilters } from "./SearchFiltersPanel";
import { SearchFilterBar } from "./SearchFilterBar";
import { SearchDetailPanel } from "./SearchDetailPanel";
import { SearchActionBar } from "./SearchActionBar";
import { isGraphSeedableKind } from "@/lib/graph-seedable-kinds";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AdvancedSearchPageProps {
  initialData?: SearchResults;
  initialParams?: Record<string, string>;
  mode?: "page" | "sidebar";
  onAddEntity?: (entity: FocusEntity) => void;
  onAddGroup?: (group: FocusGroup) => void;
  activeEntityIds?: string[];
  activeGroupIds?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_TABS = [
  { key: "all",           label: "All" },
  { key: "officials",     label: "Officials" },
  { key: "proposals",     label: "Legislation" },
  { key: "jurisdictions", label: "Jurisdictions" },
  { key: "institutions",  label: "Institutions" },
  { key: "agencies",      label: "Agencies" },
  { key: "financial",     label: "Money" },
  { key: "initiatives",   label: "Initiatives" },
  { key: "meetings",      label: "Meetings" },
] as const;

function filtersToParams(q: string, filters: SearchFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (q)                          p.set("q",              q);
  if (filters.type && filters.type !== "all") p.set("type", filters.type);
  if (filters.party)              p.set("party",          filters.party);
  if (filters.state)              p.set("state",          filters.state);
  if (filters.chamber)            p.set("chamber",        filters.chamber);
  if (filters.status)             p.set("status",         filters.status);
  if (filters.proposal_type)      p.set("proposal_type",  filters.proposal_type);
  if (filters.date_from)          p.set("date_from",      filters.date_from);
  if (filters.date_to)            p.set("date_to",        filters.date_to);
  if (filters.agency_type)        p.set("agency_type",    filters.agency_type);
  if (filters.entity_type)        p.set("entity_type",    filters.entity_type);
  if (filters.industry)           p.set("industry",       filters.industry);
  if (filters.min_amount)         p.set("min_amount",     filters.min_amount);
  if (filters.max_amount)         p.set("max_amount",     filters.max_amount);
  if (filters.official_role)      p.set("official_role",      filters.official_role);
  if (filters.financial_type)     p.set("financial_type",     filters.financial_type);
  if (filters.initiative_stage)   p.set("initiative_stage",   filters.initiative_stage);
  if (filters.jurisdiction_level) p.set("jurisdiction_level", filters.jurisdiction_level);
  return p;
}

function flattenResults(pages: SearchResults[]): AnySearchResult[] {
  const out: AnySearchResult[] = [];
  for (const page of pages) {
    for (const o of page.officials)              out.push({ kind: "official",     data: o });
    for (const p of page.proposals)              out.push({ kind: "proposal",     data: p });
    for (const j of (page.jurisdictions ?? []))  out.push({ kind: "jurisdiction", data: j });
    for (const g of (page.institutions ?? []))   out.push({ kind: "institution",  data: g });
    for (const a of page.agencies)               out.push({ kind: "agency",       data: a });
    for (const f of page.financial_entities)     out.push({ kind: "financial",    data: f });
    for (const i of (page.initiatives ?? []))    out.push({ kind: "initiative",   data: i });
    for (const m of (page.meetings ?? []))       out.push({ kind: "meeting",      data: m });
  }
  return out;
}

function getName(r: AnySearchResult): string {
  if (r.kind === "official")   return r.data.full_name;
  if (r.kind === "proposal")   return r.data.title;
  if (r.kind === "agency")       return r.data.name;
  if (r.kind === "financial")    return r.data.name;
  if (r.kind === "initiative")   return (r.data as { title: string }).title;
  if (r.kind === "jurisdiction") return r.data.name;
  if (r.kind === "institution")  return r.data.name;
  if (r.kind === "meeting")      return r.data.title;
  return "";
}

function sortResults(results: AnySearchResult[], type: string, sort: string): AnySearchResult[] {
  const base = type !== "all" ? results : [...results].sort((a, b) => b.data.relevance_score - a.data.relevance_score);
  if (sort === "name_asc")         return [...base].sort((a, b) => getName(a).localeCompare(getName(b)));
  if (sort === "name_desc")        return [...base].sort((a, b) => getName(b).localeCompare(getName(a)));
  if (sort === "connections_desc") return [...base].sort((a, b) => b.data.connection_count - a.data.connection_count);
  if (sort === "amount_desc")      return [...base].sort((a, b) => {
    const aAmt = "total_amount_cents" in a.data ? (a.data.total_amount_cents ?? 0) : 0;
    const bAmt = "total_amount_cents" in b.data ? (b.data.total_amount_cents ?? 0) : 0;
    return bAmt - aAmt;
  });
  return base; // relevance (default)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdvancedSearchPage({
  initialData,
  initialParams,
  mode = "page",
  onAddEntity,
  activeEntityIds = [],
  activeGroupIds = [],
}: AdvancedSearchPageProps) {
  const [query, setQuery] = useState(initialParams?.q ?? "");
  const [debouncedQuery, setDebouncedQuery] = useState(initialParams?.q ?? "");
  const [filters, setFilters] = useState<SearchFilters>({
    type:            initialParams?.type           ?? "all",
    party:           initialParams?.party,
    state:           initialParams?.state,
    chamber:         initialParams?.chamber,
    status:          initialParams?.status,
    proposal_type:   initialParams?.proposal_type,
    date_from:       initialParams?.date_from,
    date_to:         initialParams?.date_to,
    agency_type:     initialParams?.agency_type,
    entity_type:     initialParams?.entity_type,
    industry:        initialParams?.industry,
    min_amount:      initialParams?.min_amount,
    max_amount:      initialParams?.max_amount,
    official_role:      initialParams?.official_role,
    financial_type:     initialParams?.financial_type,
    initiative_stage:   initialParams?.initiative_stage,
    jurisdiction_level: initialParams?.jurisdiction_level,
  });
  const [sort, setSort] = useState(initialParams?.sort ?? "relevance");

  const [pages, setPages] = useState<SearchResults[]>(initialData ? [initialData] : []);
  const [cursor, setCursor] = useState<string | null>(initialData?.next_cursor ?? null);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailResult, setDetailResult] = useState<AnySearchResult | null>(null);

  const sentinelRef    = useRef<HTMLDivElement>(null);
  const debounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchingRef    = useRef(false);

  // ── Debounce text query ────────────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // ── Fetch on filter/query change ───────────────────────────────────────────
  const fetchPage = useCallback(async (
    q: string,
    f: SearchFilters,
    cursorParam: string | null,
    append: boolean,
  ) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);

    try {
      const params = filtersToParams(q, f);
      if (cursorParam) params.set("cursor", cursorParam);

      const res = await fetch(`/api/search?${params.toString()}`);
      if (!res.ok) return;
      const data: SearchResults = await res.json();

      setPages((prev) => append ? [...prev, data] : [data]);
      setCursor(data.next_cursor);
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, []);

  // Reset and re-fetch when query or filters change
  useEffect(() => {
    setPages([]);
    setSelectedIds(new Set());
    setDetailResult(null);
    setCursor(null);
    fetchPage(debouncedQuery, filters, null, false);

    if (mode === "page") {
      const params = filtersToParams(debouncedQuery, filters);
      if (sort !== "relevance") params.set("sort", sort);
      const url = `/search${params.toString() ? `?${params.toString()}` : ""}`;
      window.history.pushState(null, "", url);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, filters, mode]);

  // ── Infinite scroll sentinel ───────────────────────────────────────────────
  useEffect(() => {
    if (!sentinelRef.current || !cursor || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && cursor && !fetchingRef.current) {
          fetchPage(debouncedQuery, filters, cursor, true);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [cursor, loading, fetchPage, debouncedQuery, filters]);

  // ── Selection helpers ──────────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allResults = sortResults(flattenResults(pages), filters.type, sort);
  const selectedResults = allResults.filter((r) => selectedIds.has(resultId(r)));
  const totals = pages[0]?.totals;
  const grandTotal = totals
    ? (totals.officials + totals.proposals + totals.jurisdictions + totals.institutions + totals.agencies + totals.financial_entities + totals.initiatives + totals.meetings)
    : (pages[0]?.total ?? 0);

  // FIX-472 — only seed kinds the graph can render; the detail panel disables the
  // button for un-graphable kinds, and the header button gates on this count.
  const seedableSelected = selectedResults.filter((r) => isGraphSeedableKind(r.kind));

  // ── Graph seed (single entity from detail panel) ───────────────────────────
  function handleSeedToGraph(result: AnySearchResult) {
    if (!isGraphSeedableKind(result.kind)) return;
    if (mode === "sidebar" && onAddEntity) {
      onAddEntity({
        id:   resultEntityId(result),
        name: result.data.id,
        type: resultEntityType(result) as FocusEntity["type"],
      });
      return;
    }
    const params = new URLSearchParams({
      addEntityIds:   result.data.id,
      addEntityTypes: result.kind,
    });
    window.location.href = `/graph?${params.toString()}`;
  }

  // ── Filter change helper ───────────────────────────────────────────────────
  function applyFilters(partial: Partial<SearchFilters>) {
    setFilters((prev) => ({ ...prev, ...partial }));
  }

  // ── Graph action from top header ──────────────────────────────────────────
  function handleAddToGraph() {
    if (seedableSelected.length === 0) return;
    const toAdd = seedableSelected.slice(0, 5);
    const ids   = toAdd.map((r) => r.data.id).join(",");
    const types = toAdd.map((r) => r.kind).join(",");
    window.location.href = `/graph?addEntityIds=${encodeURIComponent(ids)}&addEntityTypes=${encodeURIComponent(types)}`;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isPage = mode === "page";

  return (
    // Terminal Wave 2 (FIX-723): everything below the site masthead is a dark
    // live instrument, mirroring the dashboard scope (FIX-720). text-ink must
    // be restated alongside bg-paper — the inherited body color does not
    // re-resolve inside the scope. Sidebar mode stays unscoped; the graph
    // terminal wave owns that surface.
    <div
      data-theme={isPage ? "terminal" : undefined}
      className={`flex flex-col ${isPage ? "h-screen" : "h-full"} bg-paper text-ink overflow-hidden`}
    >

      {/* ── Top bar ── */}
      <div className={`shrink-0 bg-card border-b border-rule ${isPage ? "px-4" : "px-3"}`}>

        {/* Live-instrument kicker (page mode only) — the site masthead brands
            the page, so no in-page logo/wordmark here. */}
        {isPage && (
          <p className="flex items-center gap-2 pt-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.22em] text-amber">
            <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-amber motion-reduce:animate-none" />
            Advanced search — Full index
          </p>
        )}

        {/* Search bar */}
        <div className={`flex items-center gap-3 ${isPage ? "py-3" : "py-2"}`}>
          <div className="relative flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
              <svg className="h-4 w-4 text-ink-soft" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search officials, proposals, agencies, donors…"
              className="w-full rounded-md border border-term-line bg-paper pl-9 pr-4 py-2 text-sm text-ink placeholder:font-mono placeholder:text-[13px] placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              autoFocus={!query}
            />
          </div>
        </div>

        {/* Type tabs */}
        <div className="flex gap-0.5 overflow-x-auto scrollbar-hide">
          {TYPE_TABS.map((tab) => {
            const active = filters.type === tab.key;
            const count =
              tab.key === "all"           ? grandTotal
              : tab.key === "officials"   ? (totals?.officials ?? 0)
              : tab.key === "proposals"   ? (totals?.proposals ?? 0)
              : tab.key === "jurisdictions" ? (totals?.jurisdictions ?? 0)
              : tab.key === "institutions"  ? (totals?.institutions ?? 0)
              : tab.key === "agencies"    ? (totals?.agencies ?? 0)
              : tab.key === "financial"   ? (totals?.financial_entities ?? 0)
              : tab.key === "meetings"    ? (totals?.meetings ?? 0)
              : (totals?.initiatives ?? 0);
            return (
              <button
                key={tab.key}
                onClick={() => applyFilters({ type: tab.key })}
                className={`flex items-center gap-1 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap
                  ${active
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-soft hover:text-ink"}`}
              >
                {tab.label}
                {count > 0 && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums
                    ${active ? "bg-accent/15 text-accent" : "bg-ink/10 text-ink-soft"}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Filter bar (under tabs, above content) ── */}
      {isPage && (
        <SearchFilterBar
          filters={filters}
          onFiltersChange={applyFilters}
          sort={sort}
          onSortChange={setSort}
        />
      )}

      {/* ── Three-panel body ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* LEFT — taxonomy browser (page mode only) */}
        {isPage && (
          <div className="w-[260px] shrink-0 overflow-hidden">
            <SearchFiltersPanel filters={filters} onFiltersChange={applyFilters} />
          </div>
        )}

        {/* MIDDLE — results */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">

          {/* Pinned results header */}
          <div className="shrink-0 border-b border-rule bg-card px-4 py-2 flex items-center gap-3">
            {/* Add to Graph button */}
            <div className="relative">
              <button
                onClick={handleAddToGraph}
                disabled={seedableSelected.length === 0}
                title={
                  seedableSelected.length < selectedResults.length
                    ? `${seedableSelected.length} of ${selectedResults.length} selected can be graphed`
                    : undefined
                }
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors
                  ${seedableSelected.length > 0
                    ? "border-accent/60 bg-accent/15 text-accent hover:bg-accent/25"
                    : "border-term-line bg-card text-ink-soft/60 cursor-not-allowed"}`}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                Add to graph
                {seedableSelected.length > 0 && (
                  <span className="ml-0.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-paper tabular-nums">
                    {seedableSelected.length}
                  </span>
                )}
              </button>
            </div>

            {/* Result count */}
            <span className="text-xs text-ink-soft">
              {loading && pages.length === 0
                ? "Loading…"
                : grandTotal > 0
                  ? <><span className="font-semibold tabular-nums text-ink">{allResults.length.toLocaleString()}</span> of <span className="font-semibold tabular-nums text-ink">{grandTotal.toLocaleString()}</span> results{debouncedQuery ? ` for "${debouncedQuery}"` : ""}</>
                  : pages.length > 0
                    ? "No results"
                    : ""}
            </span>

            {/* Clear selection */}
            {selectedResults.length > 0 && (
              <button
                onClick={() => setSelectedIds(new Set())}
                className="ml-auto text-xs text-ink-soft hover:text-ink transition-colors"
              >
                Clear selection
              </button>
            )}
          </div>

          {/* Infinite scroll area */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 pb-20">

            {/* Results */}
            {allResults.map((result) => (
              <SearchResultCard
                key={resultId(result)}
                result={result}
                isSelected={selectedIds.has(resultId(result))}
                onToggleSelect={toggleSelect}
                onClickDetail={setDetailResult}
                showCheckbox={isPage}
                badge={filters.type === "all"}
                isInGraph={activeEntityIds.includes(resultEntityId(result))}
              />
            ))}

            {/* Empty state */}
            {!loading && pages.length > 0 && allResults.length === 0 && (
              <div className="py-16 text-center">
                <p className="text-sm text-ink-soft">
                  No results match these filters
                </p>
              </div>
            )}

            {/* Loading skeleton (initial load) */}
            {loading && pages.length === 0 && (
              <div className="space-y-2">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="h-14 rounded-lg bg-rule/50 animate-pulse" />
                ))}
              </div>
            )}

            {/* Infinite scroll sentinel */}
            <div ref={sentinelRef} className="h-4" />

            {/* Bottom loader */}
            {loading && pages.length > 0 && (
              <div className="py-4 text-center">
                <span className="text-xs text-ink-soft">Loading more…</span>
              </div>
            )}
          </div>

          {/* Multi-select action bar (bundle-as-group dialog) */}
          {isPage && (
            <SearchActionBar
              selected={selectedResults}
              onClear={() => setSelectedIds(new Set())}
            />
          )}
        </div>

        {/* RIGHT — detail panel (page mode only) */}
        {isPage && (
          <div className="w-[280px] shrink-0 overflow-hidden">
            <SearchDetailPanel
              result={detailResult}
              onSeedToGraph={handleSeedToGraph}
            />
          </div>
        )}
      </div>
    </div>
  );
}
