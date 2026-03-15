"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import type { OfficialRow } from "../page";
import { OfficialCard } from "./OfficialCard";
import { OfficialGraph } from "./OfficialGraph";

const PARTY_STYLES: Record<string, { border: string; badge: string; dot: string }> = {
  democrat:    { border: "border-l-blue-500",   badge: "bg-blue-50 text-blue-700",   dot: "bg-blue-500" },
  republican:  { border: "border-l-red-500",    badge: "bg-red-50 text-red-700",     dot: "bg-red-500" },
  independent: { border: "border-l-purple-500", badge: "bg-purple-50 text-purple-700", dot: "bg-purple-500" },
};
const DEFAULT_PARTY = { border: "border-l-gray-300", badge: "bg-gray-50 text-gray-600", dot: "bg-gray-400" };

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
}: {
  officials: OfficialRow[];
  defaultSelectedId?: string;
}) {
  const [search, setSearch]         = useState("");
  const [chamberFilter, setChamber] = useState<"all" | "Senate" | "House">("all");
  const [partyFilter, setParty]     = useState<"all" | "democrat" | "republican" | "independent">("all");
  const [stateFilter, setState]     = useState("all");
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
        return true;
      })
      .sort((a, b) => {
        const pa = PARTY_ORDER[a.party ?? ""] ?? 3;
        const pb = PARTY_ORDER[b.party ?? ""] ?? 3;
        if (pa !== pb) return pa - pb;
        return a.full_name.localeCompare(b.full_name);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [officials, search, chamberFilter, partyFilter, stateFilter]);

  const selected = useMemo(
    () => officials.find((o) => o.id === selectedId) ?? null,
    [officials, selectedId]
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50">
      {/* Top bar */}
      <header className="shrink-0 border-b border-gray-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors">
            ← Civitics
          </a>
          <span className="text-gray-200">/</span>
          <span className="text-sm font-semibold text-gray-900">Officials</span>
          <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
            {officials.length.toLocaleString()} members
          </span>
        </div>
      </header>

      {/* Two-panel body */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── LEFT PANEL ─────────────────────────────────────────────────── */}
        <div className="flex w-full flex-col border-r border-gray-200 bg-white lg:w-2/5">

          {/* Search + filters */}
          <div className="shrink-0 border-b border-gray-100 px-4 py-3 space-y-2">
            <input
              type="search"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm placeholder-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            <div className="flex flex-wrap gap-2">
              {/* Chamber */}
              <select
                value={chamberFilter}
                onChange={(e) => setChamber(e.target.value as typeof chamberFilter)}
                className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              >
                <option value="all">All chambers</option>
                <option value="Senate">Senate</option>
                <option value="House">House</option>
              </select>

              {/* Party */}
              <select
                value={partyFilter}
                onChange={(e) => setParty(e.target.value as typeof partyFilter)}
                className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              >
                <option value="all">All parties</option>
                <option value="democrat">Democrat</option>
                <option value="republican">Republican</option>
                <option value="independent">Independent</option>
              </select>

              {/* State */}
              <select
                value={stateFilter}
                onChange={(e) => setState(e.target.value)}
                className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              >
                {states.map((s) => (
                  <option key={s} value={s}>{s === "all" ? "All states" : s}</option>
                ))}
              </select>
            </div>
            {filtered.length !== officials.length && (
              <p className="text-xs text-gray-400">
                {filtered.length.toLocaleString()} of {officials.length.toLocaleString()} shown
              </p>
            )}
          </div>

          {/* Scrollable list */}
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-sm text-gray-400">
                <p>No officials match your filters.</p>
                <button
                  onClick={() => { setSearch(""); setChamber("all"); setParty("all"); setState("all"); }}
                  className="mt-3 text-xs text-indigo-500 hover:underline"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              filtered.map((official) => {
                const ps = partyStyle(official.party);
                const isSelected = official.id === selectedId;
                return (
                  <button
                    key={official.id}
                    data-official-id={official.id}
                    onClick={() => setSelectedId(isSelected ? null : official.id)}
                    className={`w-full border-b border-gray-100 border-l-4 px-4 py-3 text-left transition-colors ${ps.border} ${
                      isSelected
                        ? "bg-indigo-50 hover:bg-indigo-50"
                        : "bg-white hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold ${
                          isSelected ? "border-indigo-400 bg-indigo-100 text-indigo-700" : "border-gray-200 bg-gray-100 text-gray-600"
                        }`}
                      >
                        {initials(official.full_name)}
                      </div>

                      {/* Name + role */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${ps.badge}`}>
                            {partyLabel(official.party)}
                          </span>
                          <p className={`truncate text-sm font-medium ${isSelected ? "text-indigo-800" : "text-gray-900"}`}>
                            {official.full_name}
                          </p>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-gray-500">
                          {official.role_title}
                          {official.state_name ? ` · ${official.state_name}` : ""}
                          {official.district_name ? ` · ${official.district_name}` : ""}
                        </p>
                      </div>

                      {/* Chamber badge */}
                      {official.chamber && (
                        <span className="shrink-0 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
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
        <div className="lg:hidden border-t border-gray-200 bg-white">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-900">{selected.full_name}</span>
            <button onClick={() => setSelectedId(null)} className="text-xs text-gray-400 hover:text-gray-600">
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
      <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-gray-200">
        <svg className="h-7 w-7 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-gray-500">Select an official</p>
        <p className="mt-1 text-xs text-gray-400">Profile, vote record, and connection graph will appear here</p>
      </div>
    </div>
  );
}
