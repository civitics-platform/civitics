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
import type { GraphView, VizType, VizApplicabilityMeta } from '../types';
import { VIZ_REGISTRY, getVizApplicability } from '../visualizations/registry';
import { AiNarrative } from '../AiNarrative';
import { PathFinder } from '../PathFinder';

export interface GraphHeaderProps {
  view: GraphView;
  onVizChange: (vizType: VizType) => void;
  /** Called when the user selects a search result — ADDS to focus, not replaces */
  onEntitySelect: (id: string, name: string) => void;
  onShare: () => void;
  onScreenshot: () => void;
  onFullscreen: () => void;
  /** When false, ✨ Explain is disabled (kill switch via AI_NARRATIVE_ENABLED). Defaults true. */
  aiEnabled?: boolean;
  /** Loaded-data summary used to gate the viz dropdown by applicability (FIX-129). */
  graphMeta?: VizApplicabilityMeta;
}

interface EntityResult {
  id: string;
  label: string;
  type: string;
  subtitle?: string;
  party?: string;
}

const PARTY_DOT: Record<string, string> = {
  democrat:    '#3b82f6',
  republican:  '#ef4444',
  independent: '#a855f7',
};

export function GraphHeader({
  view,
  onVizChange,
  onEntitySelect,
  onShare,
  onScreenshot,
  onFullscreen,
  aiEnabled = true,
  graphMeta,
}: GraphHeaderProps) {
  const activeViz = VIZ_REGISTRY.find(v => v.id === view.style.vizType);

  const [showVizMenu, setShowVizMenu]       = useState(false);
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
    onEntitySelect(r.id, r.label);
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

  function showVizToast(msg: string) {
    setVizToast(msg);
    window.setTimeout(() => setVizToast(prev => (prev === msg ? null : prev)), 2400);
  }

  return (
    <header className="shrink-0 h-12 flex items-center px-3 bg-white/95 backdrop-blur-sm border-b border-gray-200 z-50">

      {/* ── Left cluster: logo + viz dropdown (FIX-133) ─────────────────── */}
      <div className="flex items-center gap-2 shrink-0 pr-3 border-r border-gray-200">

      {/* Civitics mark */}
      <a
        href="/"
        className="text-xs font-bold text-indigo-600 tracking-tight shrink-0 hover:text-indigo-700 transition-colors"
      >
        Civitics
      </a>

      {/* Viz dropdown + entity focus indicator */}
      <div className="flex items-center gap-1.5 shrink-0">
      <div className="relative" ref={vizMenuRef}>
        <button
          onClick={() => setShowVizMenu(v => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-gray-100 transition-colors text-gray-700"
        >
          <span>{activeViz?.label ?? 'Graph'}</span>
          <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showVizMenu && (
          <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
            {/* Available group (FIX-129) */}
            {availableViz.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                  Available
                </p>
                {availableViz.map(({ viz }) => (
                  <button
                    key={viz.id}
                    onClick={() => { onVizChange(viz.id); setShowVizMenu(false); }}
                    className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-gray-50 transition-colors text-gray-700"
                  >
                    <span>{viz.label}</span>
                    {view.style.vizType === viz.id && (
                      <span className="text-indigo-600 font-bold">✓</span>
                    )}
                  </button>
                ))}
              </>
            )}

            {/* Not yet applicable group (FIX-129) — greyed; click surfaces the reason. */}
            {inapplicableViz.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border-t border-b border-gray-100">
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
                      className="w-full flex flex-col items-start px-3 py-2 text-xs text-gray-400 hover:bg-gray-50 transition-colors text-left"
                    >
                      <span>{viz.label}</span>
                      <span className="text-[10px] text-gray-400 truncate w-full">{reason}</span>
                    </button>
                  );
                })}
              </>
            )}

            {/* Coming soon group */}
            {comingSoonViz.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border-t border-b border-gray-100">
                  Coming Soon
                </p>
                {comingSoonViz.map(viz => (
                  <div
                    key={viz.id}
                    className="flex items-center justify-between px-3 py-2 text-xs text-gray-400 cursor-not-allowed"
                  >
                    <span>{viz.label}</span>
                    <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Soon</span>
                  </div>
                ))}
              </>
            )}

            {/* Custom group */}
            <div className="border-t border-gray-100">
              <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50">
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
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-50 transition-colors text-gray-500"
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
        <span className="text-xs text-indigo-400 truncate max-w-[140px]" title={`Focused on ${view.focus.entities[0]!.name}`}>
          · {view.focus.entities[0]!.name}
        </span>
      )}
      </div>
      </div>

      {/* ── Center cluster: search + Path + AI Explain (FIX-133) ─────────── */}
      <div className="flex items-center gap-1.5 flex-1 px-3 border-r border-gray-200 min-w-0">

      {/* Entity search */}
      <div className="relative flex-1 max-w-72" ref={searchRef}>
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"
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
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-md text-gray-700 placeholder-gray-400 focus:outline-none focus:border-indigo-400 focus:bg-white transition-colors"
          />
          {searching && (
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-gray-400 border-t-transparent animate-spin" />
          )}
        </div>

        {searchOpen && results.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto">
            {results.map(r => (
              <button
                key={r.id}
                onMouseDown={e => { e.preventDefault(); selectEntity(r); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-50 transition-colors text-left"
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor: r.party
                      ? (PARTY_DOT[r.party.toLowerCase()] ?? '#94a3b8')
                      : '#d1d5db',
                  }}
                />
                <span className="text-gray-800 font-medium truncate flex-1">{r.label}</span>
                {r.subtitle && (
                  <span className="text-gray-400 text-[10px] truncate max-w-[120px]">{r.subtitle}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* FIX-132: Path button — toggles PathFinder overlay. */}
      <button
        onClick={() => setPathOpen(p => !p)}
        title="Find shortest path between two entities"
        className={`shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${pathOpen ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-gray-100 text-gray-600'}`}
      >
        🔗 Path
      </button>

      <button
        onClick={() => aiEnabled && setNarrativeOpen(true)}
        disabled={!aiEnabled}
        title={aiEnabled
          ? "AI-generated summary of the current graph"
          : "AI summaries are temporarily disabled"}
        className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-gray-100 transition-colors text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        ✨ Explain
      </button>

      </div>

      {/* ── Right cluster: share + screenshot + fullscreen (FIX-133) ────── */}
      <div className="flex items-center gap-1 shrink-0 pl-3">
        <button
          onClick={onShare}
          className="px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-gray-100 transition-colors text-gray-600"
        >
          Share
        </button>

        <button
          onClick={onScreenshot}
          className="px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-gray-100 transition-colors text-gray-600"
        >
          Screenshot
        </button>

        <button
          onClick={handleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 transition-colors text-gray-600"
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
          <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <span className="text-sm">🔗</span>
                <span className="text-xs font-semibold text-gray-200">Path Finder</span>
              </div>
              <button
                onClick={() => setPathOpen(false)}
                className="text-gray-500 hover:text-white transition-colors text-sm leading-none"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="px-4 py-3">
              <PathFinder />
            </div>
            <div className="px-4 py-2 border-t border-gray-800 bg-gray-950/60">
              <p className="text-[10px] text-gray-600">
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
          className="fixed top-14 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-md shadow-lg pointer-events-none z-50"
        >
          {vizToast}
        </div>
      )}
    </header>
  );
}
