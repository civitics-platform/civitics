"use client";

/**
 * FIX-751 — selection action bar. ADD TO GRAPH and BUNDLE AS GROUP keep the
 * exact pre-W1 handoff semantics (/graph?addEntityIds=…&addEntityTypes=… and
 * /graph?groupType=…&groupName=…). Selection only ever contains graph-seedable
 * kinds — non-seedable rows never get a checkbox (decision 8, FIX-468(a)).
 */

import { useState } from "react";
import type { BrowseRow } from "@/lib/browse/types";

const MAX_INDIVIDUAL = 5;

export function ExplorerActionBar({ selected, onClear }: { selected: BrowseRow[]; onClear: () => void }) {
  const [bundleDialogOpen, setBundleDialogOpen] = useState(false);
  const [bundleName, setBundleName] = useState("");

  if (selected.length === 0) return null;

  function handleAddIndividually() {
    const toAdd = selected.slice(0, MAX_INDIVIDUAL);
    const ids   = toAdd.map((r) => r.entity_id).join(",");
    const types = toAdd.map((r) => r.kind).join(",");
    window.location.href = `/graph?addEntityIds=${encodeURIComponent(ids)}&addEntityTypes=${encodeURIComponent(types)}`;
  }

  function handleBundleConfirm() {
    if (!bundleName.trim()) return;
    // Best-effort GroupFilter derivation from the dominant kind (pre-W1 behavior).
    const typeCounts: Record<string, number> = {};
    for (const r of selected) typeCounts[r.kind] = (typeCounts[r.kind] ?? 0) + 1;
    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "official";
    const entityType = dominantType === "financial" ? "pac" : dominantType;
    const params = new URLSearchParams({ groupType: entityType, groupName: bundleName.trim() });
    window.location.href = `/graph?${params.toString()}`;
  }

  const tooMany = selected.length > MAX_INDIVIDUAL;

  return (
    <>
      <div className="flex items-center gap-3 border-t border-green-ink/40 bg-green-ink/5 px-4 py-2">
        <span className="font-mono text-[12px] font-medium tabular-nums text-green-ink">
          {selected.length} selected
        </span>

        <div className="group relative">
          <button
            onClick={handleAddIndividually}
            className="rounded-[2px] border border-green-ink/50 px-3 py-1.5 font-mono text-[11px] font-medium text-green-ink transition-colors hover:bg-green-ink/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-ink"
          >
            ADD TO GRAPH
          </button>
          {tooMany && (
            <div className="absolute bottom-full left-0 z-30 mb-1.5 hidden w-56 rounded-[2px] border border-term-line bg-paper-2 px-2.5 py-1.5 font-mono text-[10.5px] text-ink shadow-lg group-hover:block">
              Limited to {MAX_INDIVIDUAL} entities. First {MAX_INDIVIDUAL} will be added.
            </div>
          )}
        </div>

        <button
          onClick={() => { setBundleDialogOpen(true); setBundleName(""); }}
          className="rounded-[2px] border border-term-line px-3 py-1.5 font-mono text-[11px] text-ink-soft transition-colors hover:border-ink-soft/60 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          BUNDLE AS GROUP
        </button>

        <button
          onClick={onClear}
          className="font-mono text-[11px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-none focus-visible:text-accent"
        >
          Clear
        </button>

        <span className="ml-auto font-mono text-[10.5px] text-ink-soft/60">esc to clear</span>
      </div>

      {bundleDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[3px] border border-term-line bg-card p-5 shadow-xl">
            <h3 className="mb-1 text-sm font-semibold text-ink">Name your group</h3>
            <p className="mb-3 text-xs text-ink-soft">
              {selected.length} item{selected.length !== 1 ? "s" : ""} will be sent to the graph as a group.
            </p>
            <input
              type="text"
              autoFocus
              value={bundleName}
              onChange={(e) => setBundleName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleBundleConfirm(); if (e.key === "Escape") setBundleDialogOpen(false); }}
              placeholder="e.g. Climate advocates"
              className="mb-4 w-full rounded-[2px] border border-term-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBundleDialogOpen(false)}
                className="rounded-[2px] px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={handleBundleConfirm}
                disabled={!bundleName.trim()}
                className="rounded-[2px] bg-accent px-4 py-1.5 text-sm font-medium text-paper transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
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
