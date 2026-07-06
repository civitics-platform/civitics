/**
 * FIX-472 — single source of truth for which search-result kinds the connection
 * graph can render as a focus entity.
 *
 * FIX-749: the canonical definitions were absorbed into the browse entity-kind
 * registry (`./browse/registry`) so /search, /graph, and /api routes share ONE
 * registry. This module is retained as a back-compat re-export — the /graph
 * handoff whitelist, search add-to-graph affordances, and the gb-expansion gate
 * import from here unchanged. Do not delete (FIX-749 standing rule); prefer
 * importing from `./browse/registry` in new code.
 *
 * `official` / `agency` / `proposal` / `financial` match `FocusEntity['type']`
 * in @civitics/graph and seed as focus entities. `institution` (FIX-490) is the
 * first non-FocusEntity seedable kind: the /graph handoff converts it to a
 * synthetic gb-backed group rather than a focus entity.
 */
export {
  GRAPH_SEEDABLE_KINDS,
  type GraphSeedableKind,
  isGraphSeedableKind,
  GB_EXPANDABLE_JURISDICTION_TYPES,
  isGbExpandableJurisdictionType,
} from "./browse/registry";
