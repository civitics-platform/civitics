"use client";

/**
 * GlobalSearch
 *
 * Universal search dropdown used in the nav bar and hero section.
 * - 300ms debounce on input
 * - Cmd/Ctrl+K global shortcut (nav variant only)
 * - Arrow key navigation + Enter to select + Esc to close
 * - Click outside to close
 * - Groups results by: Officials, Proposals, Agencies
 * - "View all results" navigates to /search?q=...
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchResults, SearchOfficial, SearchProposal, SearchAgency } from "../api/search/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-blue-100 text-blue-800",
  republican:  "bg-red-100 text-red-800",
  independent: "bg-purple-100 text-purple-800",
};

const STATUS_DOT: Record<string, string> = {
  open_comment: "bg-amber-400",
  introduced:   "bg-blue-400",
  in_committee: "bg-blue-400",
  enacted:      "bg-green-400",
  signed:       "bg-green-400",
  failed:       "bg-red-400",
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FlatResult =
  | { kind: "official"; data: SearchOfficial }
  | { kind: "proposal"; data: SearchProposal }
  | { kind: "agency";   data: SearchAgency };

function flattenResults(results: SearchResults): FlatResult[] {
  const flat: FlatResult[] = [];
  for (const o of results.officials.slice(0, 3)) flat.push({ kind: "official", data: o });
  for (const p of results.proposals.slice(0, 3)) flat.push({ kind: "proposal", data: p });
  for (const a of results.agencies.slice(0, 2))  flat.push({ kind: "agency",   data: a });
  return flat;
}

function hrefFor(r: FlatResult): string {
  if (r.kind === "official") return `/officials/${r.data.id}`;
  if (r.kind === "proposal") return `/proposals/${r.data.id}`;
  return `/agencies/${r.data.id}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OfficialResult({ o, selected }: { o: SearchOfficial; selected: boolean }) {
  const badge = PARTY_BADGE[o.party ?? ""] ?? "bg-gray-100 text-gray-700";
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-indigo-50" : "hover:bg-gray-50"}`}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600">
        {o.photo_url
          ? <img src={o.photo_url} alt={o.full_name} className="h-8 w-8 rounded-full object-cover" />
          : initials(o.full_name)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{o.full_name}</p>
        <p className="truncate text-xs text-gray-500">
          {o.role_title}{o.state ? ` · ${o.state}` : ""}
        </p>
      </div>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge}`}>
        {o.party?.[0]?.toUpperCase() ?? "?"}
      </span>
    </div>
  );
}

function ProposalResult({ p, selected }: { p: SearchProposal; selected: boolean }) {
  const dot = STATUS_DOT[p.status] ?? "bg-gray-300";
  const isOpen = p.status === "open_comment" && p.comment_period_end && new Date(p.comment_period_end) > new Date();
  return (
    <div className={`flex items-start gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-indigo-50" : "hover:bg-gray-50"}`}>
      <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium text-gray-900 leading-snug">{p.title}</p>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-400">
          {p.agency_acronym && <span className="font-mono">{p.agency_acronym}</span>}
          {p.agency_acronym && <span>·</span>}
          {isOpen
            ? <span className="text-amber-600 font-medium">⏰ Open for Comment</span>
            : <span>{p.status.replace(/_/g, " ")}</span>}
        </div>
      </div>
    </div>
  );
}

function AgencyResult({ a, selected }: { a: SearchAgency; selected: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-indigo-50" : "hover:bg-gray-50"}`}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 font-mono text-[10px] font-bold text-gray-600">
        {(a.acronym ?? a.name).slice(0, 4)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-900">{a.name}</p>
        {a.acronym && <p className="text-xs text-gray-400">{a.acronym}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type Props = {
  variant?: "nav" | "hero";
  placeholder?: string;
};

export function GlobalSearch({
  variant = "nav",
  placeholder = "Search officials, proposals, agencies…",
}: Props) {
  const [query, setQuery]           = useState("");
  const [results, setResults]       = useState<SearchResults | null>(null);
  const [loading, setLoading]       = useState(false);
  const [open, setOpen]             = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);

  const inputRef    = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flat result list for keyboard nav
  const flatResults = results ? flattenResults(results) : [];

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchResults = useCallback(async (q: string) => {
    if (q.length < 2) { setResults(null); setOpen(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data: SearchResults = await res.json();
      setResults(data);
      setOpen(data.total > 0);
      setSelectedIdx(-1);
    } catch {
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Debounce ───────────────────────────────────────────────────────────────
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.length < 2) { setResults(null); setOpen(false); return; }
    debounceRef.current = setTimeout(() => fetchResults(q), 300);
  };

  // ── Keyboard navigation ────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); return; }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, flatResults.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIdx >= 0 && flatResults[selectedIdx]) {
        window.location.href = hrefFor(flatResults[selectedIdx]);
      } else if (query.length >= 2) {
        window.location.href = `/search?q=${encodeURIComponent(query)}`;
      }
    }
  };

  // ── Cmd/Ctrl+K global shortcut ─────────────────────────────────────────────
  useEffect(() => {
    if (variant !== "nav") return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [variant]);

  // ── Click outside to close ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Styles by variant ──────────────────────────────────────────────────────
  const isHero = variant === "hero";
  const inputClass = isHero
    ? "w-full rounded-lg border border-gray-300 bg-white px-5 py-3.5 text-base text-gray-900 placeholder-gray-400 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
    : "w-full rounded-full border border-gray-300 bg-white pl-8 pr-3 py-1.5 text-sm text-gray-500 placeholder-gray-400 shadow-sm hover:border-gray-400 hover:shadow focus:border-indigo-400 focus:text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-400/20 cursor-text transition-shadow";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className={`relative ${isHero ? "w-full max-w-xl" : "w-48 lg:w-64"}`}>
      <div className="relative">
        <span className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 ${isHero ? "text-base" : "text-sm"}`}>
          {loading ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-500" />
          ) : (
            <svg className={isHero ? "h-5 w-5" : "h-4 w-4"} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results && results.total > 0) setOpen(true); }}
          placeholder={placeholder}
          className={`${inputClass} ${isHero ? "pl-12" : "pl-9 pr-14"}`}
          autoComplete="off"
          spellCheck={false}
        />
        {!isHero && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500 lg:block">
            ⌘K
          </span>
        )}
      </div>

      {/* Dropdown */}
      {open && results && results.total > 0 && (
        <div className={`absolute left-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg ${isHero ? "w-full" : "w-80"}`}>

          {/* Officials */}
          {results.officials.length > 0 && (
            <div>
              <p className="border-b border-gray-100 bg-gray-50 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                Officials
              </p>
              {results.officials.slice(0, 3).map((o, i) => {
                const flatIdx = i;
                return (
                  <a key={o.id} href={`/officials/${o.id}`} onClick={() => setOpen(false)}>
                    <OfficialResult o={o} selected={selectedIdx === flatIdx} />
                  </a>
                );
              })}
            </div>
          )}

          {/* Proposals */}
          {results.proposals.length > 0 && (
            <div className={results.officials.length > 0 ? "border-t border-gray-100" : ""}>
              <p className="border-b border-gray-100 bg-gray-50 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                Proposals
              </p>
              {results.proposals.slice(0, 3).map((p, i) => {
                const flatIdx = results.officials.length + i;
                return (
                  <a key={p.id} href={`/proposals/${p.id}`} onClick={() => setOpen(false)}>
                    <ProposalResult p={p} selected={selectedIdx === flatIdx} />
                  </a>
                );
              })}
            </div>
          )}

          {/* Agencies */}
          {results.agencies.length > 0 && (
            <div className={(results.officials.length > 0 || results.proposals.length > 0) ? "border-t border-gray-100" : ""}>
              <p className="border-b border-gray-100 bg-gray-50 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
                Agencies
              </p>
              {results.agencies.slice(0, 2).map((a, i) => {
                const flatIdx = results.officials.length + results.proposals.length + i;
                return (
                  <a key={a.id} href={`/agencies/${a.id}`} onClick={() => setOpen(false)}>
                    <AgencyResult a={a} selected={selectedIdx === flatIdx} />
                  </a>
                );
              })}
            </div>
          )}

          {/* View all */}
          <div className="border-t border-gray-100 px-4 py-2">
            <a
              href={`/search?q=${encodeURIComponent(query)}`}
              className="block text-center text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors py-1"
              onClick={() => setOpen(false)}
            >
              View all results for &ldquo;{query}&rdquo; →
            </a>
          </div>
        </div>
      )}

      {/* No results */}
      {open && results && results.total === 0 && query.length >= 2 && (
        <div className={`absolute left-0 top-full z-50 mt-1 rounded-lg border border-gray-200 bg-white shadow-lg ${isHero ? "w-full" : "w-80"}`}>
          <div className="px-4 py-6 text-center">
            <p className="text-sm font-medium text-gray-500">No results for &ldquo;{query}&rdquo;</p>
            <p className="mt-1 text-xs text-gray-400">
              Try an official&apos;s name, agency acronym, or topic
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
