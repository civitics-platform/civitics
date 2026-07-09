"use client";

// Investigations MVP PR2 (FIX-580) — a debounced entity picker. Two modes:
//   * search mode (kinds): text search over /api/search, flattening the allowed
//     result arrays into pickable {target_type,id,name}. Drives the tier-1
//     internal-record citation picker AND the edge from/to endpoint pickers
//     (which pass a narrower `kinds` list).
//   * imported mode: text search over the additive /api/investigations/
//     imported-entities route (financial_entities whose primary_source is
//     littlesis/icij) for the tier-2 imported-entity citation.
// Selecting an entity calls onPick; the parent owns the chosen value.

import { useEffect, useRef, useState } from "react";
import type { PickKind, PickedEntity } from "../_lib/presentation";

type SearchResponse = Record<string, Array<Record<string, unknown>>>;
type ImportedResponse = { results?: Array<{ id: string; name: string; source: string }> };

const SOURCE_LABEL: Record<string, string> = { littlesis: "LittleSis", icij: "ICIJ" };

export function EntitySearchPicker({
  kinds,
  imported,
  placeholder,
  onPick,
}: {
  kinds?: PickKind[];
  imported?: boolean;
  placeholder?: string;
  onPick: (picked: PickedEntity) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickedEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const myReq = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const picks: PickedEntity[] = [];
        if (imported) {
          const res = await fetch(
            `/api/investigations/imported-entities?q=${encodeURIComponent(query)}&limit=8`,
          );
          const data = (await res.json().catch(() => ({}))) as ImportedResponse;
          for (const r of data.results ?? []) {
            picks.push({
              target_type: "financial_entity",
              target_id: r.id,
              name: r.name,
              kindLabel: SOURCE_LABEL[r.source] ?? r.source,
            });
          }
        } else if (kinds) {
          // FIX-769 — cheap typeahead (per-kind entity_search_index trigram),
          // same SearchResults-keyed envelope /api/search returned.
          const res = await fetch(
            `/api/browse/typeahead?q=${encodeURIComponent(query)}`,
          );
          const data = (await res.json().catch(() => ({}))) as SearchResponse;
          for (const kind of kinds) {
            const rows = (data[kind.resultsKey] ?? []) as Array<Record<string, unknown>>;
            for (const row of rows.slice(0, 6)) {
              const name = String(row[kind.nameField] ?? "").trim();
              const id = String(row.id ?? "");
              if (!id || !name) continue;
              picks.push({
                target_type: kind.targetType,
                target_id: id,
                name,
                kindLabel: kind.label,
              });
            }
          }
        }
        if (myReq === reqId.current) setResults(picks.slice(0, 16));
      } finally {
        if (myReq === reqId.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, imported, kinds]);

  return (
    <div>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder ?? "Search records…"}
        className="w-full rounded border border-rule bg-card px-3 py-2 text-sm text-ink focus:border-civic-blue focus:outline-none"
        aria-label={placeholder ?? "Search records"}
      />
      {q.trim().length >= 2 && (
        <div className="mt-1 max-h-56 overflow-y-auto rounded border border-rule bg-card">
          {loading && results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-soft">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-soft">No matching records.</p>
          ) : (
            <ul className="divide-y divide-rule">
              {results.map((r) => (
                <li key={`${r.target_type}:${r.target_id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(r);
                      setQ("");
                      setResults([]);
                    }}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-paper"
                  >
                    <span className="truncate text-ink">{r.name}</span>
                    <span className="shrink-0 text-[11px] text-ink-soft">{r.kindLabel}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
