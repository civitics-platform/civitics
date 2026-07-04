"use client";

import { useState } from "react";
import type { AnySearchResult } from "./SearchResultCard";
import { isGraphSeedableKind } from "@/lib/graph-seedable-kinds";

const MAX_INDIVIDUAL = 5;

interface SearchActionBarProps {
  selected: AnySearchResult[];
  onClear: () => void;
}

export function SearchActionBar({ selected, onClear }: SearchActionBarProps) {
  const [bundleDialogOpen, setBundleDialogOpen] = useState(false);
  const [bundleName, setBundleName] = useState("");

  if (selected.length === 0) return null;

  // FIX-472 — only kinds the graph can render are eligible to be seeded; the
  // rest (institutions, jurisdictions, meetings, initiatives) used to be added
  // to the handoff URL and then silently dropped at /graph.
  const seedable = selected.filter((r) => isGraphSeedableKind(r.kind));

  // ── Path A: add as individual entities ────────────────────────────────────
  function handleAddIndividually() {
    if (seedable.length === 0) return;
    const toAdd = seedable.slice(0, MAX_INDIVIDUAL);
    const ids   = toAdd.map((r) => r.data.id).join(",");
    const types = toAdd.map((r) => r.kind).join(",");
    window.location.href = `/graph?addEntityIds=${encodeURIComponent(ids)}&addEntityTypes=${encodeURIComponent(types)}`;
  }

  // ── Path B: bundle as group ────────────────────────────────────────────────
  function handleBundleConfirm() {
    if (!bundleName.trim()) return;

    // Derive a GroupFilter from the selection (best-effort: use the dominant type)
    const typeCounts: Record<string, number> = {};
    for (const r of selected) typeCounts[r.kind] = (typeCounts[r.kind] ?? 0) + 1;
    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "official";

    // Map to entity_type that the GroupFilter understands
    const entityType = dominantType === "financial" ? "pac" : dominantType;

    const params = new URLSearchParams({
      groupType: entityType,
      groupName: bundleName.trim(),
    });
    window.location.href = `/graph?${params.toString()}`;
  }

  const tooMany = seedable.length > MAX_INDIVIDUAL;
  const someUnseedable = seedable.length < selected.length;
  const noneSeedable = seedable.length === 0;

  return (
    <>
      <div className="sticky bottom-0 left-0 right-0 border-t border-rule bg-card/95 backdrop-blur-sm px-4 py-3 flex items-center gap-3 z-20 shadow-[0_-1px_4px_rgba(0,0,0,0.35)]">
        <span className="text-sm font-medium text-ink shrink-0">
          {selected.length} selected
        </span>

        <button
          onClick={onClear}
          className="text-xs text-ink-soft hover:text-ink transition-colors shrink-0"
        >
          Clear
        </button>

        <div className="flex-1" />

        {/* FIX-472 — graphable hint when the selection mixes seedable + un-graphable kinds */}
        {someUnseedable && (
          <span className="text-[11px] text-ink-soft shrink-0">
            {seedable.length} of {selected.length} can be graphed
          </span>
        )}

        {/* Add individually */}
        <div className="relative group">
          <button
            onClick={handleAddIndividually}
            disabled={noneSeedable}
            className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              noneSeedable
                ? "border-term-line text-ink-soft/50 cursor-not-allowed"
                : "border-term-line text-ink hover:border-accent/60 hover:text-accent"
            }`}
          >
            Add to graph individually
          </button>
          {(tooMany || noneSeedable) && (
            <div className="absolute bottom-full mb-1.5 right-0 hidden group-hover:block z-30 w-56 rounded-md border border-term-line bg-paper-2 px-2.5 py-1.5 text-[11px] text-ink shadow-lg">
              {noneSeedable
                ? "None of the selected items can be shown on the graph yet."
                : `Limited to ${MAX_INDIVIDUAL} graphable entities. First ${MAX_INDIVIDUAL} will be added.`}
            </div>
          )}
        </div>

        {/* Bundle as group */}
        <button
          onClick={() => { setBundleDialogOpen(true); setBundleName(""); }}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-paper hover:bg-accent/90 transition-colors"
        >
          Bundle as group
        </button>
      </div>

      {/* Bundle dialog */}
      {bundleDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-term-line bg-card shadow-xl p-5">
            <h3 className="text-sm font-semibold text-ink mb-1">Name your group</h3>
            <p className="text-xs text-ink-soft mb-3">
              {selected.length} item{selected.length !== 1 ? "s" : ""} will be sent to the graph as a group.
            </p>
            <input
              type="text"
              autoFocus
              value={bundleName}
              onChange={(e) => setBundleName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleBundleConfirm(); if (e.key === "Escape") setBundleDialogOpen(false); }}
              placeholder="e.g. Climate advocates"
              className="w-full rounded-md border border-term-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setBundleDialogOpen(false)}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBundleConfirm}
                disabled={!bundleName.trim()}
                className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-paper hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Open in graph
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
