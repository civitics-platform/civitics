"use client";

import { useState, useMemo } from "react";
import type { AgencyRow } from "../page";

const TYPE_LABELS: Record<string, string> = {
  federal:       "Federal",
  state:         "State",
  local:         "Local",
  independent:   "Independent",
  international: "International",
  other:         "Other",
};

const TYPE_COLORS: Record<string, string> = {
  federal:       "bg-blue-50 text-blue-700 border-blue-200",
  state:         "bg-purple-50 text-purple-700 border-purple-200",
  local:         "bg-green-50 text-green-700 border-green-200",
  independent:   "bg-amber-50 text-amber-700 border-amber-200",
  international: "bg-indigo-50 text-indigo-700 border-indigo-200",
  other:         "bg-gray-50 text-gray-600 border-gray-200",
};

export function AgenciesList({ agencies }: { agencies: AgencyRow[] }) {
  const [search,     setSearch]     = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [openOnly,   setOpenOnly]   = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return agencies.filter((a) => {
      if (q) {
        const nameMatch    = a.name.toLowerCase().includes(q);
        const acronymMatch = (a.acronym ?? "").toLowerCase().includes(q);
        if (!nameMatch && !acronymMatch) return false;
      }
      if (typeFilter !== "all" && a.agency_type !== typeFilter) return false;
      if (openOnly && a.openProposals === 0) return false;
      return true;
    });
  }, [agencies, search, typeFilter, openOnly]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="border-b border-gray-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm font-medium text-gray-400 hover:text-gray-700 transition-colors">
            ← Civitics
          </a>
          <span className="text-gray-200">/</span>
          <span className="text-sm font-semibold text-gray-900">Agencies</span>
          <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
            {agencies.length.toLocaleString()} total
          </span>
        </div>
      </header>

      {/* Filters */}
      <div className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              placeholder="Search by name or acronym…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-64 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm placeholder-gray-400 focus:border-indigo-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />

            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            >
              <option value="all">All types</option>
              <option value="federal">Federal</option>
              <option value="state">State</option>
              <option value="local">Local</option>
              <option value="independent">Independent</option>
              <option value="international">International</option>
              <option value="other">Other</option>
            </select>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={openOnly}
                onChange={(e) => setOpenOnly(e.target.checked)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              Open comment periods only
            </label>

            {filtered.length !== agencies.length && (
              <span className="text-sm text-gray-400">
                {filtered.length.toLocaleString()} of {agencies.length.toLocaleString()} shown
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Grid */}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-sm text-gray-400">
            <p>No agencies match your filters.</p>
            <button
              onClick={() => { setSearch(""); setTypeFilter("all"); setOpenOnly(false); }}
              className="mt-3 text-xs text-indigo-500 hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((agency) => {
              const typeColor = TYPE_COLORS[agency.agency_type] ?? TYPE_COLORS["other"]!;
              const typeLabel = TYPE_LABELS[agency.agency_type] ?? agency.agency_type;
              const displayAcronym = agency.acronym ?? agency.short_name ?? agency.name.slice(0, 5).toUpperCase();

              return (
                <a
                  key={agency.id}
                  href={`/agencies/${agency.id}`}
                  className="group block rounded-lg border border-gray-200 bg-white p-4 hover:border-indigo-300 hover:shadow-sm transition-all"
                >
                  {/* Card header */}
                  <div className="flex items-start gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-gray-200 bg-gray-50 font-mono text-xs font-bold text-gray-700">
                      {displayAcronym.slice(0, 5)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold ${typeColor}`}>
                        {typeLabel}
                      </span>
                      <p className="mt-0.5 text-sm font-semibold leading-tight text-gray-900 group-hover:text-indigo-700 line-clamp-2">
                        {agency.name}
                      </p>
                    </div>
                  </div>

                  {/* Description */}
                  {agency.description && (
                    <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-gray-500">
                      {agency.description}
                    </p>
                  )}

                  {/* Stats */}
                  <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-gray-100 bg-gray-100">
                    <div className="bg-white px-3 py-2 text-center">
                      <p className="text-sm font-bold text-gray-900">
                        {agency.totalProposals > 0 ? agency.totalProposals : "—"}
                      </p>
                      <p className="text-[10px] text-gray-400">Total rules</p>
                    </div>
                    <div className="bg-white px-3 py-2 text-center">
                      <p className={`text-sm font-bold ${agency.openProposals > 0 ? "text-emerald-600" : "text-gray-400"}`}>
                        {agency.openProposals > 0 ? agency.openProposals : "—"}
                      </p>
                      <p className="text-[10px] text-gray-400">Open now</p>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
