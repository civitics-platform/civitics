"use client";

/**
 * packages/graph/src/components/GraphHeader.tsx
 *
 * Fixed bar at the top of the graph. Always visible. Never scrolls.
 *
 * Layout (left → right):
 *   [Civitics mark] | [Viz dropdown ▾] [Entity search ____] [spacer] [Share] [Screenshot] [⛶]
 *
 * Screenshot delegates to the calling page via onScreenshot — actual
 * VIZ_REGISTRY-based capture is wired in Prompt 3.
 */

import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { GraphView, VizType, VizApplicabilityMeta } from '../types';
import { VIZ_REGISTRY, getVizApplicability } from '../visualizations/registry';
import { AiNarrative } from '../AiNarrative';
import { PathFinder } from '../PathFinder';
import { Icon } from '../icons';

export interface GraphHeaderProps {
  view: GraphView;
  onVizChange: (vizType: VizType) => void;
  /**
   * Called when the user selects a search result — ADDS to focus, not replaces.
   * `entityType` is the search row's type (official / agency / proposal /
   * financial_entity); threaded through (FIX-861) so the caller sets the right
   * FocusEntity type instead of defaulting every add to "official" — which had
   * killed header-search agency scoping for Sankey/Hierarchy/Gantt (FIX-857).
   */
  onEntitySelect: (id: string, name: string, entityType?: string) => void;
  onShare: () => void;
  onScreenshot: () => void;
  onFullscreen: () => void;
  /** FIX-829 — combined CSV export (Export ▾ menu). 'selection' scopes to the multi-select. */
  onExportCsv?: (scope: "selection" | "all") => void;
  /** FIX-829 — current multi-selection size; the "CSV (selection)" entry is disabled below 2. */
  selectionCount?: number;
  /** When false, ✨ Explain is disabled (kill switch via AI_NARRATIVE_ENABLED). Defaults true. */
  aiEnabled?: boolean;
  /** Loaded-data summary used to gate the viz dropdown by applicability (FIX-129). */
  graphMeta?: VizApplicabilityMeta;
  /**
   * Brand mark slot (FIX-728). /graph has no site masthead, so the header
   * carries the brand — the app passes PorticoMark + wordmark here (the mark
   * lives app-side; this package can't import it). Falls back to a plain
   * wordmark link.
   */
  brand?: ReactNode;
  /**
   * FIX-814 — drawer toggles for narrow viewports. When provided, the header
   * renders "Focus" / "View" buttons (visible below lg) that open the
   * off-canvas panel drawers.
   */
  drawerControls?: {
    onToggleFocus: () => void;
    onToggleView: () => void;
    focusOpen: boolean;
    viewOpen: boolean;
  };
}

interface EntityResult {
  id: string;
  label: string;
  type: string;
  subtitle?: string;
  party?: string;
}

// rgb(var(--c-x)) strings re-bind per scope — wine (viz-7) stands in for
// independents; the token system has no purple.
const PARTY_DOT: Record<string, string> = {
  democrat:    'rgb(var(--c-blue))',
  republican:  'rgb(var(--c-accent))',
  independent: 'rgb(var(--c-viz-7))',
};

export function GraphHeader({
  view,
  onVizChange,
  onEntitySelect,
  onShare,
  onScreenshot,
  onFullscreen,
  onExportCsv,
  selectionCount = 0,
  aiEnabled = true,
  graphMeta,
  brand,
  drawerControls,
}: GraphHeaderProps) {
  const activeViz = VIZ_REGISTRY.find(v => v.id === view.style.vizType);

  const [showVizMenu, setShowVizMenu]       = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [query, setQuery]                   = useState('');
  const [results, setResults]               = useState<EntityResult[]>([]);
  const [searchOpen, setSearchOpen]         = useState(false);
  const [searching, setSearching]           = useState(false);
  const [isFullscreen, setIsFullscreen]     = useState(false);
  const [narrativeOpen, setNarrativeOpen]   = useState(false);
  // FIX-129: transient toast shown when the user clicks a non-applicable viz.
  const [vizToast, setVizToast]             = useState<string | null>(null);
  // FIX-132: PathFinder floats as an overlay (same pattern as AiNarrative).
  const [pathOpen, setPathOpen]             = useState(false);

  const vizMenuRef = useRef<HTMLDivElement>(null);
  const searchRef  = useRef<HTMLDivElement>(null);

  // Track fullscreen state
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Close menus on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (vizMenuRef.current && !vizMenuRef.current.contains(e.target as Node)) {
        setShowVizMenu(false);
      }
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSearchOpen(false);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/graph/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) { setResults([]); return; }
        const data = await res.json() as EntityResult[];
        setResults(data);
        setSearchOpen(data.length > 0);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  function selectEntity(r: EntityResult) {
    onEntitySelect(r.id, r.label, r.type);
    setQuery('');
    setSearchOpen(false);
  }

  function handleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
    onFullscreen();
  }

  const standardViz    = VIZ_REGISTRY.filter(v => v.group === 'standard');
  const comingSoonViz  = VIZ_REGISTRY.filter(v => v.group === 'coming_soon');

  // FIX-129: split standard viz entries into Available vs Not-yet-applicable
  // based on each entry's isApplicable() against the current focus + graph data.
  const standardApplicability = standardViz.map(viz => ({
    viz,
    result: getVizApplicability(viz, view.focus, view.connections, graphMeta),
  }));
  const availableViz   = standardApplicability.filter(s =>  s.result.applicable);
  const inapplicableViz = standardApplicability.filter(s => !s.result.applicable);
  // FIX-856 — within the applicable set, split by scope so the user sees which
  // views respond to focus (focus/hybrid) and which are always platform-wide.
  const availableFocusViz    = availableViz.filter(s => s.viz.scope !== 'platform');
  const availablePlatformViz = availableViz.filter(s => s.viz.scope === 'platform');

  function showVizToast(msg: string) {
    setVizToast(msg);
    window.setTimeout(() => setVizToast(prev => (prev === msg ? null : prev)), 2400);
  }

  return (
    <header className="shrink-0 h-12 flex items-center px-3 bg-card/95 backdrop-blur-sm border-b border-rule z-50">

      {/* ── Left cluster: brand + kicker + viz dropdown (FIX-133 / FIX-728) ── */}
      <div className="flex items-center gap-2.5 shrink-0 pr-3 border-r border-rule">

      {/* Brand — no site masthead on /graph, so the header carries it */}
      {brand ?? (
        <a
          href="/"
          className="shrink-0 font-mono text-[11px] font-bold tracking-[0.18em] text-ink hover:text-accent transition-colors"
        >
          CIVITICS
        </a>
      )}

      {/* Live-instrument kicker — dashboard/search idiom */}
      <span className="hidden lg:flex items-center gap-1.5 shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-amber">
        <span className="h-[6px] w-[6px] animate-pulse rounded-full bg-amber motion-reduce:animate-none" />
        Connection graph
      </span>

      {/* Viz dropdown + entity focus indicator */}
      <div className="flex items-center gap-1.5 shrink-0">
      <div className="relative" ref={vizMenuRef}>
        <button
          onClick={() => setShowVizMenu(v => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-ink/10 transition-colors text-ink"
        >
          <span>{activeViz?.label ?? 'Graph'}</span>
          <svg className="w-3 h-3 text-ink-soft" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showVizMenu && (
          <div className="absolute top-full left-0 mt-1 w-56 bg-card border border-rule rounded-lg shadow-lg z-50 overflow-hidden">
            {/* Available group, split Focus vs Platform (FIX-129 / FIX-856) */}
            {availableFocusViz.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wider bg-paper-2 border-b border-rule/60">
                  Focus views
                </p>
                {availableFocusViz.map(({ viz }) => (
                  <button
                    key={viz.id}
                    onClick={() => { onVizChange(viz.id); setShowVizMenu(false); }}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-ink/5 transition-colors text-ink"
                  >
                    <span>{viz.label}</span>
                    {view.style.vizType === viz.id && (
                      <span className="text-accent font-bold">✓</span>
                    )}
                  </button>
                ))}
              </>
            )}
            {availablePlatformViz.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wider bg-paper-2 border-t border-b border-rule/60">
                  Platform views
                </p>
                {availablePlatformViz.map(({ viz }) => (
                  <button
                    key={viz.id}
                    onClick={() => { onVizChange(viz.id); setShowVizMenu(false); }}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-ink/5 transition-colors text-ink"
                  >
                    <span>{viz.label}</span>
                    {view.style.vizType === viz.id && (
                      <span className="text-accent font-bold">✓</span>
                    )}
                  </button>
                ))}
              </>
            )}

            {/* Not yet applicable group (FIX-129) — greyed; click surfaces the reason. */}
            {inapplicableViz.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wider bg-paper-2 border-t border-b border-rule/60">
                  Not yet applicable
                </p>
                {inapplicableViz.map(({ viz, result }) => {
                  const reason = result.applicable ? '' : result.reason;
                  return (
                    <button
                      key={viz.id}
                      onClick={() => {
                        showVizToast(reason);
                        setShowVizMenu(false);
                      }}
                      title={reason}
                      className="w-full flex flex-col items-start px-3 py-2 text-xs text-ink-soft/60 hover:bg-ink/5 transition-colors text-left"
                    >
                      <span>{viz.label}</span>
                      <span className="text-[10px] text-ink-soft/60 truncate w-full">{reason}</span>
                    </button>
                  );
                })}
              </>
            )}

            {/* Coming soon group */}
            {comingSoonViz.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wider bg-paper-2 border-t border-b border-rule/60">
                  Coming Soon
                </p>
                {comingSoonViz.map(viz => (
                  <div
                    key={viz.id}
                    className="flex items-center justify-between px-3 py-2 text-xs text-ink-soft/60 cursor-not-allowed"
                  >
                    <span>{viz.label}</span>
                    <span className="text-[10px] bg-ink/10 text-ink-soft px-1.5 py-0.5 rounded">Soon</span>
                  </div>
                ))}
              </>
            )}

            {/* Custom group */}
            <div className="border-t border-rule/60">
              <p className="px-3 py-1.5 text-[10px] font-semibold text-ink-soft/70 uppercase tracking-wider bg-paper-2">
                Custom
              </p>
              <button
                onClick={() => {
                  setShowVizMenu(false);
                  // Stage 2: real custom view creation. For now: toast placeholder.
                  if (typeof window !== 'undefined') {
                    alert('Create custom view — coming in a future update');
                  }
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-ink/5 transition-colors text-ink-soft"
              >
                <span>+</span>
                <span>Create new view</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Entity focus indicator — shown next to viz selector for entity-aware viz types */}
      {view.focus.entities.length > 0 &&
       ['chord', 'treemap', 'sunburst'].includes(view.style.vizType) && (
        <span className="text-xs text-ink-soft truncate max-w-[140px]" title={`Focused on ${view.focus.entities[0]!.name}`}>
          · {view.focus.entities[0]!.name}
        </span>
      )}
      </div>
      </div>

      {/* ── Center cluster: search + Path + AI Explain (FIX-133) ─────────── */}
      <div className="flex items-center gap-1.5 flex-1 px-3 border-r border-rule min-w-0">

      {/* Entity search — FIX-811: min-width so the input can't collapse to a
          sliver on narrow viewports; the results dropdown carries its own
          min-width so rows stay readable even when the anchor is tight. */}
      <div className="relative flex-1 min-w-[150px] max-w-72" ref={searchRef}>
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-soft pointer-events-none"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setSearchOpen(true)}
            placeholder="Add to graph…"
            aria-label="Search entities to add to the graph"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-paper border border-rule rounded-md text-ink placeholder:text-ink-soft focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
          />
          {searching && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-ink-soft border-t-transparent animate-spin" />
          )}
        </div>

        {searchOpen && results.length > 0 && (
          <div className="absolute top-full left-0 mt-1 w-full min-w-[260px] max-w-[80vw] bg-card border border-rule rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto">
            {results.map(r => (
              <button
                key={r.id}
                onMouseDown={e => { e.preventDefault(); selectEntity(r); }}
                aria-label={`Add ${r.label} to graph`}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-ink/5 transition-colors text-left"
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor: r.party
                      ? (PARTY_DOT[r.party.toLowerCase()] ?? 'rgb(var(--c-ink-soft))')
                      : 'rgb(var(--c-rule))',
                  }}
                />
                <span className="text-ink font-medium truncate flex-1">{r.label}</span>
                {r.subtitle && (
                  <span className="text-ink-soft/70 text-[10px] truncate max-w-[120px]">{r.subtitle}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* FIX-132: Path button — toggles PathFinder overlay. FIX-811 — icon-only
          below md so the search input keeps room on narrow viewports. */}
      <button
        onClick={() => setPathOpen(p => !p)}
        title="Find shortest path between two entities"
        aria-label="Find shortest path between two entities"
        className={`shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${pathOpen ? 'bg-accent/10 text-accent' : 'hover:bg-ink/10 text-ink-soft'}`}
      >
        <span className="inline-flex items-center gap-1">
          <Icon name="link" className="w-4 h-4" />
          <span className="hidden md:inline">Path</span>
        </span>
      </button>

      <button
        onClick={() => aiEnabled && setNarrativeOpen(true)}
        disabled={!aiEnabled}
        title={aiEnabled
          ? "AI-generated summary of the current graph"
          : "AI summaries are temporarily disabled"}
        aria-label="AI-generated summary of the current graph"
        className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-ink/10 transition-colors text-ink-soft disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <span className="inline-flex items-center gap-1">
          <Icon name="ai" className="w-4 h-4" />
          <span className="hidden md:inline">Explain</span>
        </span>
      </button>

      </div>

      {/* ── Right cluster: drawers (narrow) + share + screenshot + fullscreen ── */}
      <div className="flex items-center gap-1 shrink-0 pl-3">
        {/* FIX-814 — drawer toggles, only relevant below lg where the inline
            panels are replaced by off-canvas drawers. */}
        {drawerControls && (
          <>
            <button
              onClick={drawerControls.onToggleFocus}
              aria-expanded={drawerControls.focusOpen}
              aria-label="Toggle focus panel"
              className={`lg:hidden px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${drawerControls.focusOpen ? 'bg-accent/10 text-accent' : 'hover:bg-ink/10 text-ink-soft'}`}
            >
              Focus
            </button>
            <button
              onClick={drawerControls.onToggleView}
              aria-expanded={drawerControls.viewOpen}
              aria-label="Toggle view panel"
              className={`lg:hidden px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${drawerControls.viewOpen ? 'bg-accent/10 text-accent' : 'hover:bg-ink/10 text-ink-soft'}`}
            >
              View
            </button>
          </>
        )}

        <button
          onClick={onShare}
          aria-label="Share this graph"
          className="px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-ink/10 transition-colors text-ink-soft"
        >
          Share
        </button>

        {/* FIX-829 — Export ▾ (combined CSV). The Screenshot button/panel is untouched. */}
        {onExportCsv && (
          <div className="relative" ref={exportMenuRef}>
            <button
              onClick={() => setShowExportMenu(o => !o)}
              title="Export graph data as CSV"
              aria-label="Export graph data as CSV"
              aria-expanded={showExportMenu}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-ink/10 transition-colors text-ink-soft"
            >
              <Icon name="download" className="w-3.5 h-3.5 md:hidden" aria-hidden="true" />
              <span className="hidden md:inline">Export</span>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showExportMenu && (
              <div className="absolute top-full right-0 mt-1 w-48 bg-card border border-rule rounded-lg shadow-lg z-50 overflow-hidden py-1">
                <button
                  onClick={() => { onExportCsv("selection"); setShowExportMenu(false); }}
                  disabled={selectionCount < 2}
                  className="w-full text-left px-3 py-2 text-xs text-ink hover:bg-ink/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  CSV — selection{selectionCount >= 2 ? ` (${selectionCount})` : ""}
                </button>
                <button
                  onClick={() => { onExportCsv("all"); setShowExportMenu(false); }}
                  className="w-full text-left px-3 py-2 text-xs text-ink hover:bg-ink/5 transition-colors"
                >
                  CSV — all
                </button>
              </div>
            )}
          </div>
        )}

        <button
          onClick={onScreenshot}
          title="Screenshot"
          aria-label="Screenshot the graph"
          className="px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-ink/10 transition-colors text-ink-soft"
        >
          <Icon name="camera" className="w-3.5 h-3.5 md:hidden" aria-hidden="true" />
          <span className="hidden md:inline">Screenshot</span>
        </button>

        <button
          onClick={handleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-ink/10 transition-colors text-ink-soft"
        >
          {isFullscreen ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M15 9h4.5M15 9V4.5M15 15v4.5M15 15h4.5M9 15H4.5M9 15v4.5" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          )}
        </button>
      </div>
      {narrativeOpen && aiEnabled && (
        <AiNarrative
          vizType={view.style.vizType}
          entityNames={view.focus.entities.map(e => e.name)}
          activeFilters={Object.keys(view.connections).filter(t => view.connections[t]?.enabled)}
          isVisible={narrativeOpen}
          onClose={() => setNarrativeOpen(false)}
        />
      )}

      {/* FIX-132: PathFinder overlay — same floating pattern as AiNarrative.
          Positions relative to viewport (no positioned ancestor in this header
          — the overlay needs to escape the 48px-tall header). */}
      {pathOpen && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 w-full max-w-md px-4">
          <div className="bg-card border border-rule rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-rule/60">
              <div className="flex items-center gap-2">
                <Icon name="link" className="w-4 h-4 text-ink" />
                <span className="text-xs font-semibold text-ink">Path Finder</span>
              </div>
              <button
                onClick={() => setPathOpen(false)}
                className="text-ink-soft hover:text-ink transition-colors text-sm leading-none"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="px-4 py-3">
              <PathFinder />
            </div>
            <div className="px-4 py-2 border-t border-rule/60 bg-paper/60">
              <p className="text-[10px] text-ink-soft/70">
                Path edges highlight on the Force graph.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* FIX-129: transient toast surfaced when the user clicks a non-applicable
          viz. Fixed-positioned so it floats relative to the viewport (the header
          itself isn't a positioned ancestor — that would clip floating overlays
          like AiNarrative which expect to escape the header). */}
      {vizToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-14 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-card border border-rule text-ink text-xs rounded-md shadow-lg pointer-events-none z-50"
        >
          {vizToast}
        </div>
      )}
    </header>
  );
}
