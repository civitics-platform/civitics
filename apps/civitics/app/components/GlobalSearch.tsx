"use client";

/**
 * GlobalSearch
 *
 * Universal search dropdown used in the nav bar and hero section.
 * - 300ms debounce on input
 * - Cmd/Ctrl+K global shortcut (nav variant only)
 * - Arrow key navigation + Enter to select + Esc to close
 * - Click outside to close
 * - Groups results by: Officials, Proposals, Agencies, Donors & PACs
 * - "View all results" navigates to /search?q=...
 *
 * FIX-769 — the data source is the cheap /api/browse/typeahead (a per-kind
 * entity_search_index trigram match), NOT the /api/search 8-searcher fan-out.
 * It returns the same SearchResults envelope, so the dropdown UI, keyboard nav,
 * and result mapping below are unchanged (FIX-555) — only the fetch URL moved.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SearchResults,
  SearchOfficial,
  SearchProposal,
  SearchAgency,
  SearchFinancialEntity,
  SearchJurisdiction,
  SearchInstitution,
} from "../api/search/route";
import { FormerBadge } from "./FormerBadge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-civic-blue text-paper",
  republican:  "bg-accent text-paper",
  independent: "border border-ink text-ink",
};

const STATUS_DOT: Record<string, string> = {
  open_comment: "bg-amber",
  introduced:   "bg-civic-blue",
  in_committee: "bg-civic-blue",
  enacted:      "bg-term-green",
  signed:       "bg-term-green",
  failed:       "bg-accent",
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

function formatDollarsShort(cents: number | null): string {
  if (cents == null) return "";
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toFixed(0)}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FlatResult =
  | { kind: "official";     data: SearchOfficial }
  | { kind: "proposal";     data: SearchProposal }
  | { kind: "jurisdiction"; data: SearchJurisdiction }
  | { kind: "institution";  data: SearchInstitution }
  | { kind: "agency";       data: SearchAgency }
  | { kind: "financial";    data: SearchFinancialEntity };

// Section order must match the rendered dropdown order below (keyboard-nav
// offsets are derived from the same slices). Meetings are deliberately excluded
// from the dropdown to preserve space — they appear on /search only (FIX-442).
function flattenResults(results: SearchResults): FlatResult[] {
  const flat: FlatResult[] = [];
  for (const o of results.officials.slice(0, 3))                  flat.push({ kind: "official",     data: o });
  for (const p of results.proposals.slice(0, 3))                  flat.push({ kind: "proposal",     data: p });
  for (const j of (results.jurisdictions ?? []).slice(0, 2))      flat.push({ kind: "jurisdiction", data: j });
  for (const g of (results.institutions ?? []).slice(0, 2))       flat.push({ kind: "institution",  data: g });
  for (const a of results.agencies.slice(0, 2))                   flat.push({ kind: "agency",       data: a });
  for (const f of results.financial_entities.slice(0, 2))         flat.push({ kind: "financial",    data: f });
  return flat;
}

function hrefFor(r: FlatResult): string {
  if (r.kind === "official")     return `/officials/${r.data.id}`;
  if (r.kind === "proposal")     return `/proposals/${r.data.id}`;
  if (r.kind === "jurisdiction") return `/jurisdictions/${r.data.id}`;
  if (r.kind === "institution")  return `/institutions/${r.data.id}`;
  if (r.kind === "financial")    return `/donors/${r.data.id}`;
  return `/agencies/${r.data.id}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OfficialResult({ o, selected }: { o: SearchOfficial; selected: boolean }) {
  const badge = PARTY_BADGE[o.party ?? ""] ?? "border border-rule bg-paper-2 text-ink-soft";
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-paper-2" : "hover:bg-paper-2"}`}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-rule bg-paper-2 text-xs font-semibold text-ink-soft">
        {o.photo_url
          ? <img src={o.photo_url} alt={o.full_name} width={32} height={32} loading="lazy" decoding="async" className="h-8 w-8 rounded-full object-cover" />
          : initials(o.full_name)}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-medium ${selected ? "text-accent" : "text-ink"}`}>{o.full_name}</p>
        <p className="truncate text-xs text-ink-soft">
          {o.role_title}{o.state ? ` · ${o.state}` : ""}
        </p>
      </div>
      <span className={`shrink-0 px-1.5 py-0.5 font-mono text-[10px] font-semibold ${badge}`}>
        {o.party?.[0]?.toUpperCase() ?? "?"}
      </span>
    </div>
  );
}

function ProposalResult({ p, selected }: { p: SearchProposal; selected: boolean }) {
  const dot = STATUS_DOT[p.status] ?? "bg-rule";
  const isOpen = p.status === "open_comment" && p.comment_period_end && new Date(p.comment_period_end) > new Date();
  return (
    <div className={`flex items-start gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-paper-2" : "hover:bg-paper-2"}`}>
      <div className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0 flex-1">
        <p className={`line-clamp-2 text-sm font-medium leading-snug ${selected ? "text-accent" : "text-ink"}`}>{p.title}</p>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-soft">
          {p.agency_acronym && <span className="font-mono">{p.agency_acronym}</span>}
          {p.agency_acronym && <span>·</span>}
          {isOpen
            ? <span className="font-semibold text-accent">⏰ Open for Comment</span>
            : <span>{p.status.replace(/_/g, " ")}</span>}
        </div>
      </div>
    </div>
  );
}

function AgencyResult({ a, selected }: { a: SearchAgency; selected: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-paper-2" : "hover:bg-paper-2"}`}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-rule bg-paper-2 font-mono text-[10px] font-bold text-ink-soft">
        {(a.acronym ?? a.name).slice(0, 4)}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-medium ${selected ? "text-accent" : "text-ink"}`}>{a.name}</p>
        {a.acronym && <p className="font-mono text-xs text-ink-soft">{a.acronym}</p>}
      </div>
    </div>
  );
}

function JurisdictionResult({ j, selected }: { j: SearchJurisdiction; selected: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-paper-2" : "hover:bg-paper-2"}`}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-rule bg-paper-2 text-ink-soft">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-medium ${selected ? "text-accent" : "text-ink"}`}>{j.name}</p>
        <p className="truncate text-xs text-ink-soft capitalize">
          {j.jurisdiction_type}{j.short_name ? ` · ${j.short_name}` : ""}
        </p>
      </div>
    </div>
  );
}

function InstitutionResult({ g, selected }: { g: SearchInstitution; selected: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-paper-2" : "hover:bg-paper-2"}`}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-rule bg-paper-2 text-ink-soft">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-medium ${selected ? "text-accent" : "text-ink"}`}>{g.name}</p>
        <p className="truncate text-xs text-ink-soft capitalize">
          {g.institution_type.replace(/_/g, " ")}{g.short_name ? ` · ${g.short_name}` : ""}
        </p>
      </div>
      <FormerBadge isActive={g.is_active} />
    </div>
  );
}

function FinancialEntityResult({ f, selected }: { f: SearchFinancialEntity; selected: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${selected ? "bg-paper-2" : "hover:bg-paper-2"}`}>
      {/* Dollar-sign icon instead of photo/acronym */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-rule bg-paper-2 text-ink-soft">
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-medium ${selected ? "text-accent" : "text-ink"}`}>{f.name}</p>
        <p className="truncate text-xs text-ink-soft">
          {f.entity_type.replace(/_/g, " ")}
          {f.industry ? ` · ${f.industry}` : ""}
        </p>
      </div>
      {f.total_amount_cents != null && (
        <span className="shrink-0 border border-rule bg-paper-2 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-ink">
          {formatDollarsShort(f.total_amount_cents)}
        </span>
      )}
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
  const [query, setQuery]             = useState("");
  const [results, setResults]         = useState<SearchResults | null>(null);
  const [loading, setLoading]         = useState(false);
  const [open, setOpen]               = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);

  const inputRef     = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flat result list for keyboard nav
  const flatResults = results ? flattenResults(results) : [];

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchResults = useCallback(async (q: string) => {
    if (q.length < 2) { setResults(null); setOpen(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/browse/typeahead?q=${encodeURIComponent(q)}`);
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
  // Public Record × Terminal (FIX-555): squared corners, ink borders, card
  // surfaces. Hero gets the bordered-wrapper + attached solid-ink button
  // pattern from the mockup; nav is the compact 1.5px-ink masthead field.
  const isHero = variant === "hero";
  const inputClass = isHero
    ? "w-full min-w-0 flex-1 border-0 bg-transparent py-3.5 pr-3 text-[15px] text-ink placeholder:font-mono placeholder:text-[13px] placeholder:text-ink-soft focus:outline-none"
    : "w-full border-[1.5px] border-ink bg-card py-1.5 text-sm text-ink placeholder:font-mono placeholder:text-[12px] placeholder:text-ink-soft transition-colors hover:border-accent focus:border-accent focus:outline-none cursor-text";

  // Offset indexes for keyboard nav per section — must track flattenResults order:
  // officials(3) → proposals(3) → jurisdictions(2) → institutions(2) → agencies(2) → financial(2)
  const offProposal     = results?.officials.slice(0, 3).length ?? 0;
  const offJurisdiction = offProposal     + (results?.proposals.slice(0, 3).length ?? 0);
  const offInstitution  = offJurisdiction + ((results?.jurisdictions ?? []).slice(0, 2).length);
  const offAgency       = offInstitution  + ((results?.institutions ?? []).slice(0, 2).length);
  const offFinancial    = offAgency       + (results?.agencies.slice(0, 2).length ?? 0);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className={`relative ${isHero ? "w-full max-w-xl" : "w-48 lg:w-64"}`}>
      <div className={isHero ? "relative flex border-2 border-ink bg-card transition-colors focus-within:border-accent" : "relative"}>
        <span className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft ${isHero ? "text-base" : "text-sm"}`}>
          {loading ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-rule border-t-accent" />
          ) : (
            <svg className={isHero ? "h-5 w-5" : "h-4 w-4"} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          )}
        </span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={placeholder}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls="search-results-listbox"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results && results.total > 0) setOpen(true); }}
          placeholder={placeholder}
          className={`${inputClass} ${isHero ? "pl-12" : "pl-9 pr-14"}`}
          autoComplete="off"
          spellCheck={false}
        />
        {/* Screen-reader live region — announces search status */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {loading
            ? "Searching…"
            : results && open
              ? results.total > 0
                ? `${results.total} result${results.total === 1 ? "" : "s"} found`
                : "No results found"
              : ""}
        </div>
        {!isHero && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 hidden border border-rule bg-paper-2 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-soft lg:block">
            ⌘K
          </span>
        )}
        {isHero && (
          <button
            type="button"
            onClick={() => {
              // Mirrors the Enter-with-no-selection path exactly.
              if (query.length >= 2) window.location.href = `/search?q=${encodeURIComponent(query)}`;
            }}
            className="shrink-0 bg-ink px-6 text-[13px] font-semibold uppercase tracking-[0.06em] text-paper transition-colors hover:bg-accent focus-visible:outline-none focus-visible:bg-accent"
          >
            Search
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && results && results.total > 0 && (
        <div
          id="search-results-listbox"
          role="listbox"
          aria-label="Search results"
          className={`absolute left-0 top-full z-50 mt-1 overflow-hidden border border-ink bg-card shadow-[0_14px_30px_rgba(28,26,22,0.18)] ${isHero ? "w-full" : "w-80"}`}
        >

          {/* Officials */}
          {results.officials.length > 0 && (
            <div>
              <p className="border-b border-rule bg-paper-2 px-4 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-accent">
                Officials
              </p>
              {results.officials.slice(0, 3).map((o, i) => (
                <a key={o.id} role="option" aria-selected={selectedIdx === i} href={`/officials/${o.id}`} onClick={() => setOpen(false)}>
                  <OfficialResult o={o} selected={selectedIdx === i} />
                </a>
              ))}
            </div>
          )}

          {/* Proposals */}
          {results.proposals.length > 0 && (
            <div className={results.officials.length > 0 ? "border-t border-rule" : ""}>
              <p className="border-b border-rule bg-paper-2 px-4 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-accent">
                Proposals
              </p>
              {results.proposals.slice(0, 3).map((p, i) => (
                <a key={p.id} role="option" aria-selected={selectedIdx === offProposal + i} href={`/proposals/${p.id}`} onClick={() => setOpen(false)}>
                  <ProposalResult p={p} selected={selectedIdx === offProposal + i} />
                </a>
              ))}
            </div>
          )}

          {/* Jurisdictions */}
          {(results.jurisdictions ?? []).length > 0 && (
            <div className={(results.officials.length > 0 || results.proposals.length > 0) ? "border-t border-rule" : ""}>
              <p className="border-b border-rule bg-paper-2 px-4 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-accent">
                Jurisdictions
              </p>
              {(results.jurisdictions ?? []).slice(0, 2).map((j, i) => (
                <a key={j.id} role="option" aria-selected={selectedIdx === offJurisdiction + i} href={`/jurisdictions/${j.id}`} onClick={() => setOpen(false)}>
                  <JurisdictionResult j={j} selected={selectedIdx === offJurisdiction + i} />
                </a>
              ))}
            </div>
          )}

          {/* Institutions */}
          {(results.institutions ?? []).length > 0 && (
            <div className={(results.officials.length > 0 || results.proposals.length > 0 || (results.jurisdictions ?? []).length > 0) ? "border-t border-rule" : ""}>
              <p className="border-b border-rule bg-paper-2 px-4 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-accent">
                Institutions
              </p>
              {(results.institutions ?? []).slice(0, 2).map((g, i) => (
                <a key={g.id} role="option" aria-selected={selectedIdx === offInstitution + i} href={`/institutions/${g.id}`} onClick={() => setOpen(false)}>
                  <InstitutionResult g={g} selected={selectedIdx === offInstitution + i} />
                </a>
              ))}
            </div>
          )}

          {/* Agencies */}
          {results.agencies.length > 0 && (
            <div className={(results.officials.length > 0 || results.proposals.length > 0 || (results.jurisdictions ?? []).length > 0 || (results.institutions ?? []).length > 0) ? "border-t border-rule" : ""}>
              <p className="border-b border-rule bg-paper-2 px-4 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-accent">
                Agencies
              </p>
              {results.agencies.slice(0, 2).map((a, i) => (
                <a key={a.id} role="option" aria-selected={selectedIdx === offAgency + i} href={`/agencies/${a.id}`} onClick={() => setOpen(false)}>
                  <AgencyResult a={a} selected={selectedIdx === offAgency + i} />
                </a>
              ))}
            </div>
          )}

          {/* Donors & PACs */}
          {results.financial_entities.length > 0 && (
            <div className="border-t border-rule">
              <p className="border-b border-rule bg-paper-2 px-4 py-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-accent">
                Donors & PACs
              </p>
              {results.financial_entities.slice(0, 2).map((f, i) => (
                <a key={f.id} role="option" aria-selected={selectedIdx === offFinancial + i} href={`/donors/${f.id}`} onClick={() => setOpen(false)}>
                  <FinancialEntityResult f={f} selected={selectedIdx === offFinancial + i} />
                </a>
              ))}
            </div>
          )}

          {/* View all */}
          <div className="border-t border-rule px-4 py-2">
            <a
              href={`/search?q=${encodeURIComponent(query)}`}
              className="block py-1 text-center font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-accent transition-colors hover:underline"
              onClick={() => setOpen(false)}
            >
              View all results for &ldquo;{query}&rdquo; →
            </a>
          </div>
        </div>
      )}

      {/* No results */}
      {open && results && results.total === 0 && query.length >= 2 && (
        <div className={`absolute left-0 top-full z-50 mt-1 border border-ink bg-card shadow-[0_14px_30px_rgba(28,26,22,0.18)] ${isHero ? "w-full" : "w-80"}`}>
          <div className="px-4 py-6 text-center">
            <p className="text-sm font-medium text-ink">No results for &ldquo;{query}&rdquo;</p>
            <p className="mt-1 text-xs text-ink-soft">
              Try an official&apos;s name, agency acronym, or topic
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
