"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { EntitySearchResult } from "./index";

export interface EntitySelectorProps {
  selectedEntity?: { id: string; type: string; label: string } | null;
  onSelect: (entity: { id: string; type: string; label: string }) => void;
  searchFn: (query: string) => Promise<EntitySearchResult[]>;
}

export function EntitySelector({ selectedEntity, onSelect, searchFn }: EntitySelectorProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntitySearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!q.trim()) {
        setResults([]);
        setOpen(false);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        setLoading(true);
        try {
          const res = await searchFn(q);
          setResults(res);
          setOpen(res.length > 0);
        } finally {
          setLoading(false);
        }
      }, 300);
    },
    [searchFn]
  );

  useEffect(() => {
    runSearch(query);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  const officials = results.filter((r) => r.type === "official");
  const agencies = results.filter((r) => r.type === "agency");
  const proposals = results.filter((r) => r.type === "proposal");

  function handleSelect(result: EntitySearchResult) {
    onSelect({ id: result.id, type: result.type, label: result.label });
    setQuery("");
    setOpen(false);
  }

  const partyColor: Record<string, string> = {
    democrat: "#3b82f6",
    republican: "#ef4444",
    independent: "#a855f7",
  };

  return (
    <div className="relative w-full">
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={
            selectedEntity
              ? `Centered on: ${selectedEntity.label}`
              : "Search officials, agencies, proposals…"
          }
          className="w-full pl-9 pr-10 py-3 text-sm bg-gray-900 border-b border-gray-700 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:bg-gray-800 transition-colors"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border border-gray-500 border-t-transparent animate-spin" />
        )}
        {selectedEntity && !query && (
          <button
            onClick={() => onSelect({ id: "", type: "", label: "" })}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 text-xs"
            title="Clear selection"
          >
            ✕
          </button>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 bg-gray-900 border border-gray-700 border-t-0 rounded-b-lg shadow-2xl overflow-hidden">
          {officials.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-800/50">
                Officials
              </div>
              {officials.map((r) => (
                <button
                  key={r.id}
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-800 transition-colors text-left"
                >
                  {r.party && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: partyColor[r.party.toLowerCase()] ?? "#94a3b8" }}
                    />
                  )}
                  <span className="font-medium text-gray-200">{r.label}</span>
                  {r.subtitle && (
                    <span className="text-gray-500 text-xs">{r.subtitle}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {agencies.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-800/50">
                Agencies
              </div>
              {agencies.map((r) => (
                <button
                  key={r.id}
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-800 transition-colors text-left"
                >
                  {r.subtitle && (
                    <span className="text-xs font-mono font-bold text-gray-400">{r.subtitle}</span>
                  )}
                  <span className="text-gray-300">{r.label}</span>
                </button>
              ))}
            </div>
          )}
          {proposals.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider bg-gray-800/50">
                Proposals
              </div>
              {proposals.map((r) => (
                <button
                  key={r.id}
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-800 transition-colors text-left"
                >
                  <span className="text-gray-300 truncate flex-1">{r.label}</span>
                  {r.subtitle && (
                    <span className="text-xs text-amber-500 shrink-0">{r.subtitle}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
