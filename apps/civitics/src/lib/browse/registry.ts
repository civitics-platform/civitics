/**
 * FIX-749 — the single entity-kind registry for the browse/search explorer.
 *
 * One source of truth, importable by /search page code, /graph page code, and
 * /api routes. Defines per kind: label, facet definitions (key → index column +
 * facet flavour), sortable columns, the ledger column set (consumed in W1), and
 * `graphSeedable`. Registry-driven — routes validate params against this, never
 * hardcode a per-kind facet allowlist.
 *
 * Absorbs the former apps/civitics/src/lib/graph-seedable-kinds.ts data
 * (GRAPH_SEEDABLE_KINDS / GB_EXPANDABLE_JURISDICTION_TYPES + guards); that module
 * now re-exports these for back-compat (do not delete it — FIX-749 standing rule).
 *
 * Dependency-free (no next/*, no @civitics/db) so it is unit-testable under tsx.
 */

import type { BrowseKind, BrowseSort, FacetMap } from "./types";
import { BROWSE_KINDS } from "./types";

// ── Graph-seedability (absorbed from graph-seedable-kinds.ts, FIX-472/490) ─────
// `official`/`agency`/`proposal`/`financial` match FocusEntity['type'] in
// @civitics/graph and seed as focus entities. `institution` (FIX-490) is the
// first non-FocusEntity seedable kind: the /graph handoff converts it to a
// synthetic gb-backed group rather than a focus entity.
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

// A gb expands to its member cohort in the graph ONLY when its jurisdiction's
// `type` is on this allowlist (FIX-490; city excluded for roster pollution).
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

// ── Facet + kind definitions ───────────────────────────────────────────────────

/**
 * Facet flavour drives how a facet is rendered/filtered downstream (W1+):
 *  - enum      : bounded value set (party, chamber, agency_type, …) — checkbox list
 *  - typeahead : open-ended, high-cardinality (state, industry) — search box
 *  - bracket   : range bucket (reserved for amount ranges in a later wave)
 */
export type FacetFlavour = "enum" | "typeahead" | "bracket";

export interface FacetDef {
  /** URL/param key AND the entity_search_index column it filters (1:1). */
  key: string;
  label: string;
  flavour: FacetFlavour;
}

export interface KindDef {
  kind: BrowseKind;
  label: string;
  /** Facets this kind exposes (key === index column). */
  facets: FacetDef[];
  /** Sort modes valid for this kind (subset of BrowseSort). */
  sorts: BrowseSort[];
  /**
   * Columns surfaced on a browse/ledger row for this kind (W1 consumes this to
   * shape the ledger table). Always includes the core display fields.
   */
  ledger: string[];
  /** Whether the graph can seed this kind (mirrors GRAPH_SEEDABLE_KINDS). */
  graphSeedable: boolean;
}

// Shared sort menus.
const NAME_CONN_SORTS: BrowseSort[] = ["connections_desc", "name_asc", "name_desc"];
const MONEY_SORTS: BrowseSort[] = ["amount_desc", "connections_desc", "name_asc", "name_desc"];
const TIME_SORTS: BrowseSort[] = ["recent", "connections_desc", "name_asc", "name_desc"];

const CORE_LEDGER = ["display_name", "secondary_label", "connection_count", "is_synthetic"];

function def(
  kind: BrowseKind,
  label: string,
  facets: FacetDef[],
  sorts: BrowseSort[],
  extraLedger: string[] = [],
): KindDef {
  return {
    kind,
    label,
    facets,
    sorts,
    ledger: [...CORE_LEDGER, ...extraLedger],
    graphSeedable: isGraphSeedableKind(kind),
  };
}

const F = (key: string, label: string, flavour: FacetFlavour): FacetDef => ({ key, label, flavour });

export const BROWSE_REGISTRY: Record<BrowseKind, KindDef> = {
  official: def("official", "Officials",
    [
      F("jurisdiction_level", "Level", "enum"),
      F("state", "State", "typeahead"),
      F("party", "Party", "enum"),
      F("chamber", "Chamber", "enum"),
      F("status", "Status", "enum"),
    ],
    NAME_CONN_SORTS,
    ["photo_url", "party", "state", "chamber", "jurisdiction_level", "primary_source"],
  ),
  proposal: def("proposal", "Proposals",
    [
      F("proposal_type", "Type", "enum"),
      F("status", "Status", "enum"),
    ],
    TIME_SORTS,
    ["proposal_type", "status", "activity_at", "primary_source"],
  ),
  initiative: def("initiative", "Initiatives",
    [
      F("initiative_stage", "Stage", "enum"),
      F("status", "Status", "enum"),
    ],
    TIME_SORTS,
    ["initiative_stage", "status", "activity_at"],
  ),
  agency: def("agency", "Agencies",
    [
      F("agency_type", "Type", "enum"),
      F("jurisdiction_level", "Level", "enum"),
    ],
    NAME_CONN_SORTS,
    ["agency_type", "secondary_label"],
  ),
  financial: def("financial", "Money",
    [
      F("financial_type", "Entity type", "enum"),
      F("industry", "Industry", "typeahead"),
    ],
    MONEY_SORTS,
    ["financial_type", "industry", "amount_cents", "amount_label", "primary_source"],
  ),
  jurisdiction: def("jurisdiction", "Jurisdictions",
    [F("jurisdiction_level", "Level", "enum")],
    NAME_CONN_SORTS,
    ["jurisdiction_level"],
  ),
  institution: def("institution", "Institutions",
    [
      F("jurisdiction_level", "Level", "enum"),
      F("institution_type", "Type", "enum"),
    ],
    NAME_CONN_SORTS,
    ["institution_type", "jurisdiction_level"],
  ),
  meeting: def("meeting", "Meetings",
    [F("status", "Status", "enum")],
    TIME_SORTS,
    ["status", "activity_at"],
  ),
};

// ── Validation helpers ─────────────────────────────────────────────────────────

export function isBrowseKind(k: string): k is BrowseKind {
  return (BROWSE_KINDS as readonly string[]).includes(k);
}

/** Facet keys valid for a kind. */
export function facetKeysFor(kind: BrowseKind): string[] {
  return BROWSE_REGISTRY[kind].facets.map((f) => f.key);
}

/** True when `key` is a facet the kind exposes. */
export function isValidFacetKey(kind: BrowseKind, key: string): boolean {
  return facetKeysFor(kind).includes(key);
}

/** Sort modes valid for a kind. */
export function sortsFor(kind: BrowseKind): BrowseSort[] {
  return BROWSE_REGISTRY[kind].sorts;
}

/** The ledger/display column set for a kind (W1). */
export function ledgerColumnsFor(kind: BrowseKind): string[] {
  return BROWSE_REGISTRY[kind].ledger;
}

export interface FacetValidation {
  ok: boolean;
  /** facet keys that are not valid for the kind. */
  unknownKeys: string[];
}

/**
 * Validate a facet map against a kind's registry entry. When `kind` is null
 * (all-kinds scope), any key valid for ANY kind is accepted (the endpoint applies
 * it only where the column exists). Returns the set of keys valid for no kind.
 */
export function validateFacets(kind: BrowseKind | null, facets: FacetMap): FacetValidation {
  const keys = Object.keys(facets);
  const allowed = kind
    ? new Set(facetKeysFor(kind))
    : new Set(BROWSE_KINDS.flatMap((k) => facetKeysFor(k)));
  const unknownKeys = keys.filter((k) => !allowed.has(k));
  return { ok: unknownKeys.length === 0, unknownKeys };
}
