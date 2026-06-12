/**
 * FIX-472 — single source of truth for which search-result kinds the connection
 * graph can actually render as a focus entity.
 *
 * The /graph handoff whitelist, the search add-to-graph affordances, and any
 * other "seed this into the graph" entry point all gate on this one constant so
 * the UI never offers to graph a kind the graph silently drops.
 *
 * `official` / `agency` / `proposal` / `financial` match `FocusEntity['type']`
 * in @civitics/graph and seed as focus entities. `institution` (FIX-490, FIX-468
 * Wave A C1) is the first non-FocusEntity seedable kind: it does NOT add a focus
 * entity — the /graph handoff converts it to a synthetic gb-backed group
 * (see GraphPage.tsx). The graph still "can do something" with it, so it belongs
 * on this list; the conversion site is responsible for routing it to addGroup
 * rather than addEntity.
 */
export const GRAPH_SEEDABLE_KINDS = [
  "official",
  "agency",
  "proposal",
  "financial",
  "institution",
] as const;

export type GraphSeedableKind = (typeof GRAPH_SEEDABLE_KINDS)[number];

const SEEDABLE_SET: ReadonlySet<string> = new Set(GRAPH_SEEDABLE_KINDS);

/** Type guard: true when `kind` is a kind the graph can render. */
export function isGraphSeedableKind(kind: string): kind is GraphSeedableKind {
  return SEEDABLE_SET.has(kind);
}

/**
 * FIX-490 (FIX-468 Wave A C1) — governing-body expansion eligibility gate.
 *
 * A gb expands to its member cohort in the graph ONLY when its jurisdiction's
 * `type` is on this allowlist. Co-located with GRAPH_SEEDABLE_KINDS so the one
 * greppable site gates both "can this kind be seeded" and "can this gb expand".
 *
 * Excluded on purpose:
 *  - `city` — Legistar parks hundreds of cross-municipality officials on shared
 *    gbs (FIX-471, ingest-side, open), so a city gb's roster is polluted.
 * `federal_district` (DC) was excluded while its council was mis-modeled as a
 * two-chamber pair; included since the FIX-489/FIX-548 unicameral conversion.
 * The seat canary is advisory only (the FIX-496 backfill filled state-chamber
 * seat_count, but the allowlist remains the gate).
 */
export const GB_EXPANDABLE_JURISDICTION_TYPES = [
  "country",
  "state",
  "federal_district",
  "unincorporated_territory",
] as const;

const GB_EXPANDABLE_SET: ReadonlySet<string> = new Set(GB_EXPANDABLE_JURISDICTION_TYPES);

/** True when a gb in a jurisdiction of `jurisdictionType` may expand in the graph. */
export function isGbExpandableJurisdictionType(jurisdictionType: string | null | undefined): boolean {
  return jurisdictionType != null && GB_EXPANDABLE_SET.has(jurisdictionType);
}
