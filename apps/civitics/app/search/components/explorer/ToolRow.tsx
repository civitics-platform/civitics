"use client";

/**
 * FIX-751 — toolrow: search-within-scope input, table/cards view toggle, and
 * the keyset sort select. Sort labels are honest — the substrate has no
 * relevance column, so the default is labelled CONNECTIONS, never RELEVANCE
 * (W0 ship-report rider).
 */

import type { BrowseKind, BrowseSort } from "@/lib/browse/types";
import { sortsFor } from "@/lib/browse/registry";

export type BrowseView = "table" | "cards";

const SORT_LABEL: Record<BrowseSort, string> = {
  connections_desc: "SORT: CONNECTIONS ↓",
  name_asc:         "SORT: NAME A–Z",
  name_desc:        "SORT: NAME Z–A",
  amount_desc:      "SORT: AMOUNT ↓",
  recent:           "SORT: RECENT ↓",
};

export function ToolRow({
  q, onQChange, scopeLabel, view, onViewChange, kind, sort, onSortChange,
}: {
  q: string;
  onQChange: (q: string) => void;
  scopeLabel: string | null;
  view: BrowseView;
  onViewChange: (view: BrowseView) => void;
  kind: BrowseKind | null;
  sort: BrowseSort;
  onSortChange: (sort: BrowseSort) => void;
}) {
  const sorts: BrowseSort[] = kind ? sortsFor(kind) : ["connections_desc", "name_asc", "name_desc"];

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2">
      <div className="relative min-w-[200px] flex-1">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[12px] text-green-ink">&gt;</span>
        <input
          type="text"
          value={q}
          onChange={(e) => onQChange(e.target.value)}
          placeholder={scopeLabel ? `search within ${scopeLabel}…` : "search the full index…"}
          aria-label={scopeLabel ? `Search within ${scopeLabel}` : "Search the full index"}
          className="w-full rounded-[2px] border border-term-line bg-paper py-1.5 pl-7 pr-3 font-mono text-[12.5px] text-ink placeholder:text-ink-soft/60 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <div className="flex overflow-hidden rounded-[2px] border border-term-line" role="group" aria-label="Result view">
        {(["table", "cards"] as const).map((v) => (
          <button
            key={v}
            onClick={() => onViewChange(v)}
            aria-pressed={view === v}
            className={`px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] transition-colors focus-visible:outline-none focus-visible:text-accent
              ${view === v ? "bg-amber/10 text-amber" : "text-ink-soft/70 hover:text-ink"}`}
          >
            {v === "table" ? "▤ Table" : "▦ Cards"}
          </button>
        ))}
      </div>

      <select
        value={sort}
        onChange={(e) => onSortChange(e.target.value as BrowseSort)}
        aria-label="Sort results"
        className="rounded-[2px] border border-term-line bg-card px-2 py-1.5 font-mono text-[10.5px] text-ink-soft focus:border-accent focus:outline-none"
      >
        {sorts.map((s) => (
          <option key={s} value={s}>{SORT_LABEL[s]}</option>
        ))}
      </select>
    </div>
  );
}
