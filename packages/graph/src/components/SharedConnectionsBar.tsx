"use client";

/**
 * packages/graph/src/components/SharedConnectionsBar.tsx
 *
 * Floating pill bar that lists nodes connected to ≥2 currently-focused
 * entities. The headline civic insight: "PACs that gave to BOTH Warren AND
 * Cruz" — those nodes are quietly the most analytically interesting.
 * Per FIX-149 / GRAPH_PLAN §6.1.
 *
 * Hidden when fewer than 2 entities are in focus; the parent should also
 * gate by viz type (only meaningful in force).
 */

import { useMemo } from "react";
import type { GraphNode, GraphEdge, FocusItem } from "../types";
import { isFocusEntity } from "../types";
import { extractUuid } from "../nodeId";

// ── Helper ────────────────────────────────────────────────────────────────────

export interface SharedConnection {
  /** Node id of the third party */
  id: string;
  name: string;
  type: GraphNode["type"];
  /** How many focused entities are connected to this node. */
  focusCount: number;
}

/**
 * Find nodes connected to ≥2 of the focused entity ids. Returns them sorted by
 * focusCount desc, then name asc — most-shared first.
 *
 * `focusIds` is a set of RAW focus uuids; edge endpoints are canonical
 * `type:{uuid}` (FIX-850). The old `focusIds.has(e.fromId)` compared the two
 * directly and never matched, so this bar was permanently empty.
 */
export function findSharedConnections(
  focusIds: ReadonlySet<string>,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): SharedConnection[] {
  if (focusIds.size < 2) return [];

  // Resolve an edge endpoint id to the focus uuid it represents, or null.
  const focusUuidOf = (id: string): string | null => {
    if (focusIds.has(id)) return id;
    const u = extractUuid(id);
    return u != null && focusIds.has(u) ? u : null;
  };

  // Build neighbour map: node id → set of DISTINCT focus uuids it's connected to.
  const neighbourFocus = new Map<string, Set<string>>();
  for (const e of edges) {
    const fromFocus = focusUuidOf(e.fromId);
    const toFocus = focusUuidOf(e.toId);
    if (fromFocus && !toFocus) {
      const set = neighbourFocus.get(e.toId) ?? new Set<string>();
      set.add(fromFocus);
      neighbourFocus.set(e.toId, set);
    }
    if (toFocus && !fromFocus) {
      const set = neighbourFocus.get(e.fromId) ?? new Set<string>();
      set.add(toFocus);
      neighbourFocus.set(e.fromId, set);
    }
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const out: SharedConnection[] = [];
  for (const [nodeId, focusSet] of neighbourFocus) {
    if (focusSet.size < 2) continue;
    const node = nodeById.get(nodeId);
    if (!node) continue;
    out.push({
      id: nodeId,
      name: node.name,
      type: node.type,
      focusCount: focusSet.size,
    });
  }

  out.sort((a, b) => b.focusCount - a.focusCount || a.name.localeCompare(b.name));
  return out;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface SharedConnectionsBarProps {
  /** Currently focused items. Only entities (not groups) participate in shared analysis. */
  focusItems: FocusItem[];
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** Currently highlighted shared node, drives pill active state. */
  highlightedNodeId?: string | null;
  /** Click a pill — pass null to clear. */
  onHighlight?: (nodeId: string | null) => void;
  /** Optional cap on the number of pills rendered before "+N more". Default 8. */
  maxPills?: number;
  className?: string;
}

const TYPE_DOT_COLORS: Record<string, string> = {
  official: "rgb(var(--c-blue))",
  agency: "rgb(var(--c-viz-7))",
  proposal: "rgb(var(--c-amber))",
  financial: "rgb(var(--c-green-ink))",
  pac: "rgb(var(--c-viz-6))",
  corporation: "rgb(var(--c-green-ink))",
  organization: "rgb(var(--c-blue))",
  individual: "rgb(var(--c-blue))",
  user: "rgb(var(--c-viz-7))",
  group: "rgb(var(--c-ink-soft))",
};

export function SharedConnectionsBar({
  focusItems,
  nodes,
  edges,
  highlightedNodeId,
  onHighlight,
  maxPills = 8,
  className = "",
}: SharedConnectionsBarProps) {
  // Only consider focused entities (not groups) for the headline pair label.
  const focusEntities = useMemo(
    () => focusItems.filter(isFocusEntity),
    [focusItems],
  );

  const focusIds = useMemo(
    () => new Set(focusEntities.map((e) => e.id)),
    [focusEntities],
  );

  const shared = useMemo(
    () => findSharedConnections(focusIds, nodes, edges),
    [focusIds, nodes, edges],
  );

  if (focusEntities.length < 2 || shared.length === 0) return null;

  const visible = shared.slice(0, maxPills);
  const hidden = shared.length - visible.length;

  // Build the headline: "between Warren and Cruz" / "between 3 entities"
  let headline: string;
  if (focusEntities.length === 2) {
    const a = focusEntities[0]?.name ?? "";
    const b = focusEntities[1]?.name ?? "";
    headline = `between ${a} and ${b}`;
  } else {
    headline = `across ${focusEntities.length} focused entities`;
  }

  return (
    <div
      className={`flex items-center gap-2 max-w-full overflow-x-auto pointer-events-auto ${className}`}
      role="region"
      aria-label="Shared connections"
    >
      <div className="shrink-0 text-[11px] text-ink-soft bg-card backdrop-blur-sm border border-rule rounded-full px-3 py-1">
        <span className="font-semibold text-green-ink">{shared.length}</span>{" "}
        shared {headline}
      </div>

      {visible.map((s) => {
        const dot = TYPE_DOT_COLORS[s.type] ?? "rgb(var(--c-ink-soft))";
        const active = s.id === highlightedNodeId;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onHighlight?.(active ? null : s.id)}
            className={[
              "shrink-0 inline-flex items-center gap-1.5 text-[11px] rounded-full px-2.5 py-1 transition-colors",
              active
                ? "bg-green-ink text-paper border border-green-ink"
                : "bg-card text-ink border border-rule hover:bg-ink/10",
            ].join(" ")}
            title={`${s.name} — connected to ${s.focusCount} focused entities`}
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: dot }}
            />
            <span className="truncate max-w-[160px]">{s.name}</span>
            {s.focusCount > 2 && (
              <span className="text-[10px] opacity-70 tabular-nums">×{s.focusCount}</span>
            )}
          </button>
        );
      })}

      {hidden > 0 && (
        <span className="shrink-0 text-[11px] text-ink-soft/60">+{hidden} more</span>
      )}
    </div>
  );
}
