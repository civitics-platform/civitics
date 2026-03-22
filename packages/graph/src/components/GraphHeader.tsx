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
import type { GraphView, VizType } from '../types';
import { VIZ_REGISTRY } from '../visualizations/registry';

export interface GraphHeaderProps {
  view: GraphView;
  onVizChange: (vizType: VizType) => void;
  /** Called when the user selects a search result. (id, name) */
  onEntitySelect: (id: string, name: string) => void;
  onShare: () => void;
  onScreenshot: () => void;
  onFullscreen: () => void;
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
}: GraphHeaderProps) {
  const activeViz = VIZ_REGISTRY.find(v => v.id === view.style.vizType);

  const [showVizMenu, setShowVizMenu]   = useState(false);
  const [query, setQuery]               = useState('');
  const [results, setResults]           = useState<EntityResult[]>([]);
  const [searchOpen, setSearchOpen]     = useState(false);
  const [searching, setSearching]       = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

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

  return (
    <header className="shrink-0 h-12 flex items-center gap-2 px-3 bg-white/95 backdrop-blur-sm border-b border-gray-200 z-50">

      {/* Civitics mark */}
      <a
        href="/"
        className="text-xs font-bold text-indigo-600 tracking-tight shrink-0 hover:text-indigo-700 transition-colors"
      >
        Civitics
      </a>

      <span className="text-gray-300">|</span>

      {/* Viz dropdown */}
      <div className="relative shrink-0" ref={vizMenuRef}>
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
          <div className="absolute top-full left-0 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
            {/* Standard group */}
            {standardViz.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">
                  Standard
                </p>
                {standardViz.map(viz => (
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
            placeholder={view.focus.entityName ?? 'Search entity…'}
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

      {/* Spacer */}
      <div className="flex-1" />

      {/* Action buttons */}
      <div className="flex items-center gap-1 shrink-0">
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
    </header>
  );
}
