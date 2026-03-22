"use client";

import React, { useState, useEffect, useCallback } from "react";
import type { EntitySearchResult } from "./index";

async function defaultSearchFn(q: string): Promise<EntitySearchResult[]> {
  const res = await fetch(`/api/graph/search?q=${encodeURIComponent(q)}&limit=10`);
  if (!res.ok) return [];
  const data = await res.json() as EntitySearchResult[];
  return Array.isArray(data) ? data : [];
}

export interface PathFinderProps {
  searchFn?: (q: string) => Promise<EntitySearchResult[]>;
  onPathFound?: (path: PathResult) => void;
}

interface PathResult {
  entityIds: string[];
  entityLabels: string[];
  connectionTypes: string[];
  hops: number;
}

interface ApiPathSegment {
  entity_id: string;
  entity_label?: string;
  connection_type?: string;
}

interface MiniSearchProps {
  placeholder: string;
  selected: { id: string; label: string } | null;
  onSelect: (e: { id: string; label: string }) => void;
  onClear: () => void;
  searchFn: (q: string) => Promise<EntitySearchResult[]>;
}

function MiniEntitySearch({ placeholder, selected, onSelect, onClear, searchFn }: MiniSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntitySearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setResults([]); setOpen(false); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await searchFn(query);
        setResults(r);
        setOpen(r.length > 0);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, searchFn]);

  function handleSelect(r: EntitySearchResult) {
    onSelect({ id: r.id, label: r.label });
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="relative">
      {selected && !query ? (
        <div className="flex items-center gap-1.5 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs">
          <span className="text-indigo-400 truncate flex-1">{selected.label}</span>
          <button
            onClick={onClear}
            className="text-gray-600 hover:text-gray-400 shrink-0"
            title="Clear"
          >
            ✕
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder={placeholder}
            className="w-full px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
          />
          {loading && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border border-gray-500 border-t-transparent animate-spin" />
          )}
        </div>
      )}

      {open && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 bg-gray-900 border border-gray-700 rounded-b shadow-xl max-h-40 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.id}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs hover:bg-gray-800 transition-colors text-left"
            >
              <span className="text-gray-300 truncate flex-1">{r.label}</span>
              {r.subtitle && <span className="text-gray-600 truncate text-[10px]">{r.subtitle}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PathFinder({ searchFn = defaultSearchFn, onPathFound }: PathFinderProps) {
  const [fromEntity, setFromEntity] = useState<{ id: string; label: string } | null>(null);
  const [toEntity, setToEntity] = useState<{ id: string; label: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<PathResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const findPath = useCallback(async () => {
    if (!fromEntity || !toEntity) return;
    setSearching(true);
    setResult(null);
    setNotFound(false);
    setError(null);

    try {
      const res = await fetch("/api/graph/pathfinder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_id: fromEntity.id, to_id: toEntity.id, max_hops: 4 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { path: ApiPathSegment[] | null; message?: string };

      if (!data.path || data.path.length === 0) {
        setNotFound(true);
        return;
      }

      const path: PathResult = {
        entityIds: data.path.map((s) => s.entity_id),
        entityLabels: data.path.map((s) => s.entity_label ?? s.entity_id),
        connectionTypes: data.path.slice(1).map((s) => s.connection_type ?? "→"),
        hops: data.path.length - 1,
      };

      setResult(path);
      onPathFound?.(path);
    } catch (e) {
      const err = e instanceof Error ? e.message : "Unknown error";
      setError(err);
    } finally {
      setSearching(false);
    }
  }, [fromEntity, toEntity, onPathFound]);

  return (
    <div className="space-y-2">
      <div>
        <p className="text-[10px] text-gray-600 mb-1">From</p>
        <MiniEntitySearch
          placeholder="Search start entity…"
          selected={fromEntity}
          onSelect={setFromEntity}
          onClear={() => { setFromEntity(null); setResult(null); setNotFound(false); }}
          searchFn={searchFn}
        />
      </div>

      <div>
        <p className="text-[10px] text-gray-600 mb-1">To</p>
        <MiniEntitySearch
          placeholder="Search end entity…"
          selected={toEntity}
          onSelect={setToEntity}
          onClear={() => { setToEntity(null); setResult(null); setNotFound(false); }}
          searchFn={searchFn}
        />
      </div>

      <button
        onClick={findPath}
        disabled={!fromEntity || !toEntity || searching}
        className="w-full py-1.5 text-xs font-medium rounded bg-indigo-700 hover:bg-indigo-600 disabled:bg-gray-800 disabled:text-gray-600 text-white transition-colors"
      >
        {searching ? (
          <span className="flex items-center justify-center gap-1.5">
            <span className="w-3 h-3 rounded-full border border-white border-t-transparent animate-spin" />
            Searching…
          </span>
        ) : "Find shortest path"}
      </button>

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      {notFound && (
        <div className="text-xs text-gray-500 bg-gray-900 border border-gray-800 rounded px-2.5 py-2">
          No connection found within 4 hops.
        </div>
      )}

      {result && (
        <div className="bg-gray-900 border border-gray-800 rounded px-2.5 py-2">
          <p className="text-[10px] text-gray-500 mb-1.5 uppercase tracking-wider">
            {result.hops} hop{result.hops !== 1 ? "s" : ""}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            {result.entityLabels.map((label, i) => (
              <React.Fragment key={i}>
                <span className="text-[11px] text-indigo-400 font-medium">{label}</span>
                {i < result.connectionTypes.length && (
                  <span className="text-[10px] text-gray-600">
                    {" "}{result.connectionTypes[i]}{" "}
                  </span>
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
