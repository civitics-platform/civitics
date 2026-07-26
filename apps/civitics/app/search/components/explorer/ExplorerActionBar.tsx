"use client";

/**
 * FIX-751 — selection action bar. ADD TO GRAPH keeps the pre-W1 handoff
 * semantics (/graph?addEntityIds=…&addEntityTypes=…). Selection only ever
 * contains graph-seedable kinds — non-seedable rows never get a checkbox
 * (decision 8, FIX-468(a)).
 *
 * FIX-886 — BUNDLE AS GROUP no longer discards the selection. It used to derive
 * a "dominant kind" from the checked rows and hand off
 * /graph?groupType=official&groupName=…, sending zero ids; the route then
 * resolved that bare filter to every active official (27,753 on prod) and
 * answered about the whole platform under the user's group name. The ids now
 * ride along as groupIds, so the dialog's "N items will be sent to the graph as
 * a group" is true. Officials only: the group route aggregates official donor
 * cohorts, institutions already have their own gb-group affordance on the row,
 * and a financial "group" is a different semantic entirely.
 */

import { useState } from "react";
import type { BrowseRow } from "@/lib/browse/types";
import { MAX_GROUP_OFFICIAL_IDS } from "@/lib/graph-cohort";

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
    if (!bundleName.trim() || !bundleable) return;
    // FIX-886 — the selection IS the group. Ids are what makes the cohort; the
    // route validates, dedups and re-caps them server-side.
    const ids = selected.slice(0, MAX_GROUP_OFFICIAL_IDS).map((r) => r.entity_id);
    const params = new URLSearchParams({
      groupType: "official",
      groupName: bundleName.trim(),
      groupIds: ids.join(","),
    });
    window.location.href = `/graph?${params.toString()}`;
  }

  const tooMany = selected.length > MAX_INDIVIDUAL;

  // FIX-886 — a group is an official donor cohort, so every checked row must be
  // an official. Mixed or non-official selections disable the button with the
  // reason rather than silently bundling a "dominant kind".
  const nonOfficial = selected.filter((r) => r.kind !== "official");
  const bundleable  = nonOfficial.length === 0;
  const bundleBlockedReason = bundleable
    ? null
    : selected.length === nonOfficial.length
      ? "Groups aggregate donors to officials — select officials to bundle."
      : `${nonOfficial.length} non-official row${nonOfficial.length === 1 ? "" : "s"} selected. ` +
        "Groups aggregate donors to officials only.";
  const bundleCapped = selected.length > MAX_GROUP_OFFICIAL_IDS;

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

        <div className="group relative">
          <button
            onClick={() => { setBundleDialogOpen(true); setBundleName(""); }}
            disabled={!bundleable}
            title={bundleBlockedReason ?? undefined}
            className="rounded-[2px] border border-term-line px-3 py-1.5 font-mono text-[11px] text-ink-soft transition-colors hover:border-ink-soft/60 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-term-line disabled:hover:text-ink-soft"
          >
            BUNDLE AS GROUP
          </button>
          {bundleBlockedReason && (
            <div className="absolute bottom-full left-0 z-30 mb-1.5 hidden w-64 rounded-[2px] border border-term-line bg-paper-2 px-2.5 py-1.5 font-mono text-[10.5px] text-ink shadow-lg group-hover:block">
              {bundleBlockedReason}
            </div>
          )}
        </div>

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
              {bundleCapped ? (
                <>
                  The first {MAX_GROUP_OFFICIAL_IDS} of {selected.length} selected officials will be
                  sent to the graph as a group.
                </>
              ) : (
                <>
                  {selected.length} official{selected.length !== 1 ? "s" : ""} will be sent to the
                  graph as a group.
                </>
              )}
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
