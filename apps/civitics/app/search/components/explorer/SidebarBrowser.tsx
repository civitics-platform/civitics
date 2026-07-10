"use client";

/**
 * FIX-762 — the browser's SIDEBAR MOUNT (Screen 3): the same explorer that
 * powers /search, compacted into the graph's left panel as its entity
 * selector. Replaces the GroupBrowser / EntityBrowse / EntitySearchInput /
 * CustomGroupForm stack as mounted in FocusTree (old components stay on disk —
 * FIX-765). State + fetch semantics come from useBrowseExplorer; the tree and
 * refine blocks are the /search ScopeRail's own exports, so drill/facet
 * behavior is identical across mounts.
 *
 * Per-row [+] is gated by the registry's graphSeedable (FIX-764): seedable
 * kinds add as focus entities, institutions convert to gb-backed groups
 * (mirrors the /graph handoff decode), non-seedable kinds render a visible
 * "no graph" mark instead of a silent no-op. ADD ALL AS LIVE GROUP compiles
 * the current BrowseState → GroupFilter (FIX-762 compiler) — the group stays
 * live as data updates — and persists it as a saved view (FIX-763) best-effort,
 * mirroring the pre-W2 custom-group anon fallback.
 */

import { useMemo, useState } from "react";
import type { FocusEntity, FocusGroup } from "@civitics/graph";
import { createCustomGroup } from "@civitics/graph";
import type { BrowseRow } from "@/lib/browse/types";
import { serializeBrowseState } from "@/lib/browse/browse-state";
import {
  suggestedViewName,
  tryCompileBrowseToGroupFilter,
} from "@/lib/browse/graph-compiler";
import { isGraphSeedableKind } from "@/lib/graph-seedable-kinds";
import { useBrowseExplorer } from "./useBrowseExplorer";
import { ScopeTree, FacetBlocks } from "./ScopeRail";
import { SavedViewsRail, saveViewToServer, type SavedViewItem } from "./SavedViewsRail";
import { Chip, chipVariantFor } from "./Chip";
import { formatCountCompact, rowKey, titleizeValue } from "./format";

const SIDEBAR_PAGE_LIMIT = 20;
const EMPTY_STATE = { scope: "", facets: {}, q: "", sort: "connections_desc" as const, cursor: null };

export interface SidebarBrowserProps {
  onAddEntity: (entity: FocusEntity) => void;
  onAddGroup: (group: FocusGroup) => void;
  /** Focus ids so added rows/groups render as ✓. */
  activeEntityIds: string[];
  activeGroupIds: string[];
  atMaxFocus: boolean;
}

export function SidebarBrowser({
  onAddEntity,
  onAddGroup,
  activeEntityIds,
  activeGroupIds,
  atMaxFocus,
}: SidebarBrowserProps) {
  const ex = useBrowseExplorer({ initialState: EMPTY_STATE, pageLimit: SIDEBAR_PAGE_LIMIT });
  const [notice, setNotice] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const [refineOpen, setRefineOpen] = useState(false);

  const compileResult = useMemo(() => tryCompileBrowseToGroupFilter(ex.currentState), [ex.currentState]);
  const groupCount = ex.totals.count ?? (ex.cursor ? null : ex.rows.length);

  const searchHref = useMemo(() => {
    const qs = serializeBrowseState(ex.currentState).toString();
    return qs ? `/search?${qs}` : "/search";
  }, [ex.currentState]);

  const facetChips = useMemo(() => {
    const out: Array<{ key: string; value: string }> = [];
    for (const [key, value] of Object.entries(ex.facets)) {
      for (const v of Array.isArray(value) ? value : [value]) out.push({ key, value: v });
    }
    return out;
  }, [ex.facets]);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice((n) => (n === message ? null : n)), 4000);
  }

  function handleAddRow(row: BrowseRow) {
    if (row.kind === "institution") {
      // Institutions become gb-backed groups, mirroring the /graph handoff
      // decode (FIX-490) — the row gives us the real name up front.
      onAddGroup({
        id: `group-gb-${row.entity_id}`,
        name: row.display_name,
        type: "group",
        icon: "🏛",
        color: "rgb(var(--c-viz-5))",
        filter: { entity_type: "official", governingBody: row.entity_id },
        isPremade: false,
      });
      return;
    }
    onAddEntity({
      id: row.entity_id,
      name: row.display_name,
      type: row.kind as FocusEntity["type"],
      ...(row.facets["party"] ? { party: row.facets["party"] } : {}),
      ...(row.photo_url ? { photoUrl: row.photo_url } : {}),
    });
  }

  async function handleAddAllAsGroup() {
    if (!compileResult.ok || atMaxFocus) return;
    const name = suggestedViewName(ex.currentState);
    // Decision 5: the live group persists the FILTER as a saved view (the
    // browse state IS the group definition) — best-effort, anon falls back to
    // an in-session group exactly like the pre-W2 custom-group save flow.
    const { persisted, row } = await saveViewToServer(name, ex.currentState);
    const group: FocusGroup = {
      ...createCustomGroup(compileResult.filter, name),
      ...(persisted && row ? { id: `group-view-${row.id}` } : {}),
      ...(groupCount != null ? { count: groupCount } : {}),
    };
    onAddGroup(group);
    // FIX-784: no savedNonce bump — saveViewToServer already broadcast the row
    // onto the rail via the saved-views bus. Re-fetching here would fire the
    // post-write GET that races the auth-cookie rotation on prod (empty-200 →
    // the just-saved view disappears from the graph list).
    flash(persisted ? "Added to graph + saved to your views" : "Added to graph (sign in to save views)");
  }

  async function handleSaveView() {
    const name = suggestedViewName(ex.currentState);
    const { persisted } = await saveViewToServer(name, ex.currentState);
    // FIX-784: the bus broadcast from saveViewToServer lists the row on the rail;
    // no savedNonce refetch (that post-write GET is the one that races on prod).
    if (persisted) {
      flash(`Saved “${name}” — usable in /search too`);
    } else {
      flash("Not signed in — views can't be saved");
    }
  }

  function handleAddSavedView(item: SavedViewItem) {
    if (!item.state || atMaxFocus) return;
    const compiled = tryCompileBrowseToGroupFilter(item.state);
    if (!compiled.ok) return; // rail disables [+] with the reason already
    onAddGroup({
      ...createCustomGroup(compiled.filter, item.name),
      ...(item.sessionOnly ? {} : { id: `group-view-${item.id}` }),
    });
  }

  const railProps = {
    scope: ex.scope,
    kind: ex.kind,
    scopeFacets: ex.compiled.facets,
    facets: ex.facets,
    facetCounts: ex.facetCounts,
    universe: ex.universe,
    totalsCount: ex.countsMode === "exact" ? ex.totals.count : null,
    scopeLabel: ex.scopeLabel ?? "all",
    onScope: ex.handleScope,
    onToggleFacet: ex.handleToggleFacet,
  };

  return (
    <div className="px-1 pb-2">
      {/* Header: open-in-/search round-trip */}
      <div className="flex items-center justify-between px-2 pb-1.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-soft/60">
          Browser
        </span>
        <a
          href={searchHref}
          className="font-mono text-[10px] text-ink-soft transition-colors hover:text-amber focus-visible:outline-none focus-visible:text-accent"
          title="Open this view in the full /search explorer"
        >
          ⧉ open in /search
        </a>
      </div>

      {/* Search within scope */}
      <div className="px-2 pb-1.5">
        <input
          type="text"
          value={ex.qInput}
          onChange={(e) => ex.setQInput(e.target.value)}
          placeholder={ex.scopeLabel ? `search within ${ex.scopeLabel.toLowerCase()}…` : "search all records…"}
          className="w-full rounded-[2px] border border-term-line bg-paper px-2 py-1 font-mono text-[11px] text-ink placeholder:text-ink-soft/60 focus:border-accent focus:outline-none"
        />
      </div>

      {/* Mini crumb + facet chips */}
      {(ex.crumbs.length > 0 || facetChips.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-2 pb-1.5 font-mono text-[10.5px] text-ink-soft">
          <button
            onClick={() => ex.handleScope("")}
            className="hover:text-amber focus-visible:outline-none focus-visible:text-accent"
          >
            All
          </button>
          {ex.crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-1">
              <span className="text-ink-soft/40">›</span>
              {i === ex.crumbs.length - 1 ? (
                <b className="text-ink">{c.label}</b>
              ) : (
                <button
                  onClick={() => ex.handleScope(c.path)}
                  className="hover:text-amber focus-visible:outline-none focus-visible:text-accent"
                >
                  {c.label}
                </button>
              )}
            </span>
          ))}
          {facetChips.map(({ key, value }) => (
            <Chip
              key={`${key}:${value}`}
              variant={chipVariantFor(key, value)}
              onDismiss={() => ex.handleToggleFacet(key, value)}
            >
              {titleizeValue(value)}
            </Chip>
          ))}
        </div>
      )}

      {/* Scope tree (collapsible) */}
      <button
        onClick={() => setTreeOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft/70 hover:text-ink focus-visible:outline-none focus-visible:text-accent"
      >
        <span className="text-[9px]">{treeOpen ? "▾" : "▸"}</span> Scope
      </button>
      {treeOpen && <ScopeTree {...railProps} />}

      {/* Refine blocks (collapsible, kind-scoped) */}
      {ex.kind && (
        <>
          <button
            onClick={() => setRefineOpen((o) => !o)}
            className="flex w-full items-center gap-1 px-2 py-1 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft/70 hover:text-ink focus-visible:outline-none focus-visible:text-accent"
          >
            <span className="text-[9px]">{refineOpen ? "▾" : "▸"}</span> Refine
          </button>
          {refineOpen && (
            <div className="[&>div]:mt-0 [&>div]:border-t-0 [&>div]:pt-0 [&_h5]:hidden">
              <FacetBlocks {...railProps} />
            </div>
          )}
        </>
      )}

      {/* Results */}
      <div className="mt-1 border-t border-rule/60 pt-1">
        <div className="flex items-baseline justify-between px-2 pb-0.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft/60">
            Results
          </span>
          <span className="font-mono text-[10px] tabular-nums text-ink-soft/60">
            {ex.totals.count != null ? formatCountCompact(ex.totals.count) : ex.loading ? "…" : ex.rows.length}
          </span>
        </div>

        {ex.error && (
          <div className="px-2 py-2">
            <p className="font-mono text-[10.5px] text-accent">{ex.error}</p>
            <button
              onClick={ex.handleRetry}
              className="mt-1 font-mono text-[10.5px] text-ink underline decoration-dotted hover:text-amber focus-visible:outline-none focus-visible:text-accent"
            >
              retry
            </button>
          </div>
        )}

        {!ex.error && ex.loading && (
          <p className="px-2 py-2 font-mono text-[10.5px] text-ink-soft/60" role="status">loading…</p>
        )}

        {!ex.error && !ex.loading && ex.rows.length === 0 && (
          <p className="px-2 py-2 font-mono text-[10.5px] text-ink-soft/60">
            {ex.q ? `no matches for “${ex.q}”` : "nothing here with these filters"}
          </p>
        )}

        {!ex.error && ex.rows.map((row) => {
          const seedable = isGraphSeedableKind(row.kind);
          const isActive = row.kind === "institution"
            ? activeGroupIds.includes(`group-gb-${row.entity_id}`)
            : activeEntityIds.includes(row.entity_id);
          const secondary = row.facets["state"] ?? row.secondary_label;
          return (
            <div
              key={rowKey(row)}
              className="flex items-center gap-2 border-b border-rule/40 px-2 py-[5px] hover:bg-ink/5"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink" title={row.display_name}>
                {row.display_name}
                {secondary && <span className="text-ink-soft/60"> · {secondary}</span>}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-soft/50">
                {formatCountCompact(row.connection_count)}
              </span>
              {seedable ? (
                <button
                  onClick={() => { if (!isActive && !atMaxFocus) handleAddRow(row); }}
                  disabled={isActive || atMaxFocus}
                  title={
                    isActive ? "Already on the graph"
                      : atMaxFocus ? "Maximum focus entities reached"
                      : `Add ${row.display_name} to the graph`
                  }
                  className={`shrink-0 rounded-[2px] border px-1 font-mono text-[10.5px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent
                    ${isActive
                      ? "cursor-default border-green-ink/40 text-green-ink"
                      : atMaxFocus
                        ? "cursor-not-allowed border-term-line text-ink-soft/40"
                        : "border-green-ink/40 text-green-ink hover:bg-green-ink/15"}`}
                >
                  {isActive ? "✓" : "+"}
                </button>
              ) : (
                // FIX-764 — non-seedable kinds show a visible mark, never a silent no-op.
                <span
                  className="shrink-0 cursor-help font-mono text-[9.5px] text-ink-soft/40"
                  title={`The graph can't render ${row.kind} records yet`}
                >
                  no graph
                </span>
              )}
            </div>
          );
        })}

        {ex.cursor && !ex.loading && (
          <button
            onClick={ex.loadMore}
            disabled={ex.loadingMore}
            className="w-full px-2 py-1.5 text-center font-mono text-[10.5px] text-ink-soft transition-colors hover:text-amber disabled:opacity-50 focus-visible:outline-none focus-visible:text-accent"
          >
            {ex.loadingMore ? "loading…" : "more…"}
          </button>
        )}
      </div>

      {/* Add-all + save view */}
      <div className="mt-2 flex flex-col gap-1.5 px-2">
        <button
          onClick={() => void handleAddAllAsGroup()}
          disabled={!compileResult.ok || atMaxFocus}
          title={
            atMaxFocus ? "Maximum focus entities reached"
              : compileResult.ok ? "Add every matching record as one live group — it stays current as data updates"
              : compileResult.reason
          }
          className={`w-full rounded-[2px] border px-2 py-1.5 text-center font-mono text-[10.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent
            ${compileResult.ok && !atMaxFocus
              ? "border-amber/60 bg-amber/10 text-amber hover:bg-amber/20"
              : "cursor-not-allowed border-term-line text-ink-soft/40"}`}
        >
          ＋ ADD ALL{groupCount != null ? ` ${formatCountCompact(groupCount)}` : ""} AS LIVE GROUP
        </button>
        {!compileResult.ok && (
          <p className="font-mono text-[9.5px] leading-snug text-ink-soft/50">{compileResult.reason}</p>
        )}
        <button
          onClick={() => void handleSaveView()}
          className="w-full rounded-[2px] border border-term-line px-2 py-1.5 text-center font-mono text-[10.5px] text-ink-soft transition-colors hover:border-ink-soft/60 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          ★ SAVE VIEW (usable in /search too)
        </button>
        {notice && <p className="font-mono text-[9.5px] text-amber">{notice}</p>}
      </div>

      {/* Saved views */}
      <div className="mt-3 border-t border-rule/60 pt-1.5">
        <h5 className="px-2 pb-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft/60">
          Saved views
        </h5>
        <SavedViewsRail
          currentState={ex.currentState}
          onApply={(state) => ex.applyState(state)}
          onAddGroup={handleAddSavedView}
          activeGroupIds={activeGroupIds}
          showSaveRow={false}
        />
      </div>
    </div>
  );
}
