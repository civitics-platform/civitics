"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import type { OfficialRow } from "../page";
import { OfficialCard } from "./OfficialCard";
import { OfficialGraph } from "./OfficialGraph";
import { compareEngagement, EMPTY_ENGAGEMENT } from "../../lib/engagement";

type SortMode = "default" | "engaged";

// Issue area filter pills
const ISSUE_PILLS = [
  { tag: "healthcare", label: "Healthcare",  icon: "🏥" },
  { tag: "climate",    label: "Climate",     icon: "🌊" },
  { tag: "finance",    label: "Finance",     icon: "📈" },
  { tag: "defense",    label: "Defense",     icon: "🛡" },
  { tag: "technology", label: "Tech",        icon: "💻" },
  { tag: "labor",      label: "Labor",       icon: "👷" },
  { tag: "agriculture",label: "Agriculture", icon: "🌾" },
];

// Donor pattern filter pills
const PATTERN_PILLS = [
  { tag: "grassroots", label: "Grassroots",  icon: "🌱" },
  { tag: "pac_heavy",  label: "PAC-Heavy",   icon: "💰" },
  { tag: "bipartisan", label: "Bipartisan",  icon: "🤝" },
  { tag: "partisan",   label: "Partisan",    icon: null },
];

// Party reads as red/blue ink, never a wash; independents stay ink-outline
// (no purple token exists by design — FIX-552 precedent).
const PARTY_STYLES: Record<string, { border: string; badge: string; dot: string }> = {
  democrat:    { border: "border-l-civic-blue", badge: "bg-civic-blue/10 text-civic-blue", dot: "bg-civic-blue" },
  republican:  { border: "border-l-accent",     badge: "bg-accent/10 text-accent",         dot: "bg-accent" },
  independent: { border: "border-l-ink",        badge: "border border-ink/40 text-ink",    dot: "bg-ink" },
};
const DEFAULT_PARTY = { border: "border-l-rule", badge: "bg-ink/5 text-ink-soft", dot: "bg-rule" };

function partyStyle(party: string | null) {
  return PARTY_STYLES[party ?? ""] ?? DEFAULT_PARTY;
}

function partyLabel(party: string | null) {
  if (party === "democrat") return "D";
  if (party === "republican") return "R";
  if (party === "independent") return "I";
  return "?";
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

export function OfficialsList({
  officials,
  defaultSelectedId,
  includeFormer = false,
}: {
  officials: OfficialRow[];
  defaultSelectedId?: string;
  includeFormer?: boolean;
}) {
  const [search, setSearch]         = useState("");
  const [chamberFilter, setChamber] = useState<"all" | "Senate" | "House">("all");
  const [partyFilter, setParty]     = useState<"all" | "democrat" | "republican" | "independent">("all");
  const [stateFilter, setState]     = useState("all");
  const [issueFilter, setIssue]     = useState<string | null>(null);
  const [patternFilter, setPattern] = useState<string | null>(null);
  const [sortMode, setSortMode]     = useState<SortMode>("default");
  const [selectedId, setSelectedId] = useState<string | null>(defaultSelectedId ?? null);
  const listRef = useRef<HTMLDivElement>(null);

  // When arriving with a pre-selected official, scroll it into view
  useEffect(() => {
    if (!defaultSelectedId) return;
    const el = listRef.current?.querySelector(`[data-official-id="${defaultSelectedId}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [defaultSelectedId]);

  // Derive sorted unique states
  const states = useMemo(() => {
    const s = new Set(officials.map((o) => o.state_name).filter(Boolean) as string[]);
    return ["all", ...Array.from(s).sort()];
  }, [officials]);

  const PARTY_ORDER: Record<string, number> = { democrat: 1, republican: 2 };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return officials
      .filter((o) => {
        if (q && !o.full_name.toLowerCase().includes(q)) return false;
        if (chamberFilter !== "all" && o.chamber !== chamberFilter) return false;
        if (partyFilter !== "all" && o.party !== partyFilter) return false;
        if (stateFilter !== "all" && o.state_name !== stateFilter) return false;
        if (issueFilter && !(o.tags ?? []).some((t) => t.tag === issueFilter && t.tag_category === "topic")) return false;
        if (patternFilter && !(o.tags ?? []).some((t) => t.tag === patternFilter)) return false;
        return true;
      })
      .sort((a, b) => {
        // FIX-618: "Most engaged" orders by the display-only engagement rollup
        // (responsiveness → community → recency); falls back to party→name on
        // ties so the list is stable when engagement is sparse/absent.
        if (sortMode === "engaged") {
          const cmp = compareEngagement(
            a.engagement ?? EMPTY_ENGAGEMENT,
            b.engagement ?? EMPTY_ENGAGEMENT,
          );
          if (cmp !== 0) return cmp;
        }
        const pa = PARTY_ORDER[a.party ?? ""] ?? 3;
        const pb = PARTY_ORDER[b.party ?? ""] ?? 3;
        if (pa !== pb) return pa - pb;
        return a.full_name.localeCompare(b.full_name);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officials, search, chamberFilter, partyFilter, stateFilter, issueFilter, patternFilter, sortMode]);

  const selected = useMemo(
    () => officials.find((o) => o.id === selectedId) ?? null,
    [officials, selectedId]
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      {/* Top bar */}
      <header className="shrink-0 border-b border-rule bg-card px-5 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm font-medium text-ink-soft hover:text-accent transition-colors">
            ← Civitics
          </a>
          <span className="text-rule">/</span>
          <span className="font-serif text-sm font-semibold text-ink">Officials</span>
          <span className="ml-1 rounded-full bg-ink/5 px-2 py-0.5 font-mono text-xs font-medium tabular-nums text-ink-soft">
            {officials.length.toLocaleString()} members
          </span>
        </div>
      </header>

      {/* Two-panel body */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT PANEL ─────────────────────────────────────────────────── */}
        <div className="flex w-full flex-col border-r border-rule bg-card lg:w-2/5">

          {/* Search + filters */}
          <div className="shrink-0 border-b border-rule px-4 py-3 space-y-2">
            <input
              type="search"
              aria-label="Search officials by name"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full border border-rule bg-paper px-3 py-2 text-sm placeholder:text-ink-soft/60 focus:border-accent focus:bg-card focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {/* Active / former toggle (FIX-457) — server round-trip via ?status */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft/70">Status</span>
              <Link
                href="/officials"
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  !includeFormer ? "bg-ink text-paper" : "bg-ink/5 text-ink-soft hover:bg-ink/10"
                }`}
              >
                Active
              </Link>
              <Link
                href="/officials?status=all"
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  includeFormer ? "bg-ink text-paper" : "bg-ink/5 text-ink-soft hover:bg-ink/10"
                }`}
              >
                Include former
              </Link>
            </div>
            <div className="flex flex-wrap gap-2">
              {/* Chamber */}
              <select
                aria-label="Filter by chamber"
                value={chamberFilter}
                onChange={(e) => setChamber(e.target.value as typeof chamberFilter)}
                className="border border-rule bg-card px-2 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="all">All chambers</option>
                <option value="Senate">Senate</option>
                <option value="House">House</option>
              </select>

              {/* Party */}
              <select
                aria-label="Filter by party"
                value={partyFilter}
                onChange={(e) => setParty(e.target.value as typeof partyFilter)}
                className="border border-rule bg-card px-2 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="all">All parties</option>
                <option value="democrat">Democrat</option>
                <option value="republican">Republican</option>
                <option value="independent">Independent</option>
              </select>

              {/* State */}
              <select
                aria-label="Filter by state"
                value={stateFilter}
                onChange={(e) => setState(e.target.value)}
                className="border border-rule bg-card px-2 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {states.map((s) => (
                  <option key={s} value={s}>{s === "all" ? "All states" : s}</option>
                ))}
              </select>

              {/* Sort (FIX-618) */}
              <select
                aria-label="Sort officials"
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="border border-rule bg-card px-2 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="default">Party &amp; name</option>
                <option value="engaged">Most engaged</option>
              </select>
            </div>
            {/* Issue area pills */}
            <div role="group" aria-label="Filter by issue area" className="flex flex-wrap gap-1 pt-1">
              {ISSUE_PILLS.map((pill) => (
                <button
                  key={pill.tag}
                  type="button"
                  aria-pressed={issueFilter === pill.tag}
                  onClick={() => setIssue(issueFilter === pill.tag ? null : pill.tag)}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
                    issueFilter === pill.tag
                      ? "bg-ink text-paper"
                      : "bg-ink/5 text-ink-soft hover:bg-ink/10 hover:text-ink"
                  }`}
                >
                  {pill.icon} {pill.label}
                </button>
              ))}
            </div>

            {/* Donor pattern pills */}
            <div role="group" aria-label="Filter by donor pattern" className="flex flex-wrap gap-1">
              {PATTERN_PILLS.map((pill) => (
                <button
                  key={pill.tag}
                  type="button"
                  aria-pressed={patternFilter === pill.tag}
                  onClick={() => setPattern(patternFilter === pill.tag ? null : pill.tag)}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${
                    patternFilter === pill.tag
                      ? "bg-ink text-paper"
                      : "bg-ink/5 text-ink-soft hover:bg-ink/10 hover:text-ink"
                  }`}
                >
                  {pill.icon && <span aria-hidden="true">{pill.icon}</span>} {pill.label}
                </button>
              ))}
            </div>

            {filtered.length !== officials.length && (
              <p className="font-mono text-xs tabular-nums text-ink-soft">
                {filtered.length.toLocaleString()} of {officials.length.toLocaleString()} shown
              </p>
            )}
          </div>

          {/* Scrollable list */}
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="border border-dashed border-rule bg-card px-8 py-16 text-center mx-4 my-8">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-paper-2">
                  <svg aria-hidden="true" className="h-6 w-6 text-ink-soft/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-ink">No officials match your filters.</p>
                <p className="mt-1 text-sm text-ink-soft">Try adjusting your search, party, chamber, or state filter.</p>
                <button
                  onClick={() => { setSearch(""); setChamber("all"); setParty("all"); setState("all"); setIssue(null); setPattern(null); }}
                  className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
                >
                  Clear all filters
                </button>
              </div>
            ) : (
              filtered.map((official) => {
                const ps = partyStyle(official.party);
                const isSelected = official.id === selectedId;
                return (
                  <button
                    key={official.id}
                    type="button"
                    data-official-id={official.id}
                    aria-pressed={isSelected}
                    aria-label={`${official.full_name}, ${official.role_title}${official.state_name ? `, ${official.state_name}` : ""}`}
                    onClick={() => setSelectedId(isSelected ? null : official.id)}
                    className={`w-full border-b border-rule/60 border-l-4 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${ps.border} ${
                      isSelected
                        ? "bg-accent/5 hover:bg-accent/5"
                        : "bg-card hover:bg-paper-2"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 font-serif text-xs font-semibold ${
                          isSelected ? "border-accent/50 bg-accent/10 text-accent" : "border-rule bg-paper-2 text-ink-soft"
                        }`}
                      >
                        {initials(official.full_name)}
                      </div>

                      {/* Name + role */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${ps.badge}`}>
                            {partyLabel(official.party)}
                          </span>
                          <p className={`truncate text-sm font-medium ${isSelected ? "text-accent" : "text-ink"}`}>
                            {official.full_name}
                          </p>
                          {official.is_active === false && (
                            <span className="shrink-0 rounded-full bg-ink/5 px-1.5 py-0.5 text-[10px] font-semibold text-ink-soft">
                              Former
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-ink-soft">
                          {official.role_title}
                          {official.state_name ? ` · ${official.state_name}` : ""}
                          {official.district_name ? ` · ${official.district_name}` : ""}
                        </p>
                      </div>

                      {/* Chamber badge */}
                      {official.chamber && (
                        <span className="shrink-0 border border-rule bg-paper-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
                          {official.chamber === "Senate" ? "SEN" : "REP"}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── RIGHT PANEL ────────────────────────────────────────────────── */}
        <div className="hidden flex-col lg:flex lg:w-3/5 overflow-y-auto">
          {selected ? (
            <div className="flex flex-col gap-0">
              <OfficialCard official={selected} />
              <OfficialGraph
                officialId={selected.id}
                officialName={selected.full_name}
                officialParty={selected.party}
              />
            </div>
          ) : (
            <EmptyRight />
          )}
        </div>
      </div>

      {/* Mobile: show selected below list (full-width overlay) */}
      {selected && (
        <div className="lg:hidden border-t border-rule bg-card">
          <div className="flex items-center justify-between px-4 py-2 border-b border-rule">
            <span className="font-serif text-sm font-semibold text-ink">{selected.full_name}</span>
            <button onClick={() => setSelectedId(null)} className="text-xs text-ink-soft/70 hover:text-ink-soft">
              ✕ Close
            </button>
          </div>
          <OfficialCard official={selected} />
          <OfficialGraph
            officialId={selected.id}
            officialName={selected.full_name}
            officialParty={selected.party}
          />
        </div>
      )}
    </div>
  );
}

function EmptyRight() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-rule">
        <svg className="h-7 w-7 text-rule" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-ink-soft">Select an official</p>
        <p className="mt-1 text-xs text-ink-soft/70">Profile, vote record, and connection graph will appear here</p>
      </div>
    </div>
  );
}
