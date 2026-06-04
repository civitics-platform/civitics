/**
 * FIX-472 — single source of truth for which search-result kinds the connection
 * graph can actually render as a focus entity.
 *
 * The /graph handoff whitelist, the search add-to-graph affordances, and any
 * other "seed this into the graph" entry point all gate on this one constant so
 * the UI never offers to graph a kind the graph silently drops.
 *
 * These four match `FocusEntity['type']` in @civitics/graph — the only node
 * kinds the graph renders today. FIX-468's later phases (group expansion,
 * institution / meeting / jurisdiction nodes) widen this list in exactly one
 * place: here.
 */
export const GRAPH_SEEDABLE_KINDS = [
  "official",
  "agency",
  "proposal",
  "financial",
] as const;

export type GraphSeedableKind = (typeof GRAPH_SEEDABLE_KINDS)[number];

const SEEDABLE_SET: ReadonlySet<string> = new Set(GRAPH_SEEDABLE_KINDS);

/** Type guard: true when `kind` is a kind the graph can render. */
export function isGraphSeedableKind(kind: string): kind is GraphSeedableKind {
  return SEEDABLE_SET.has(kind);
}
