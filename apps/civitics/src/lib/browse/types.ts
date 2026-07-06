/**
 * FIX-749 — Browse Program Wave 0 shared types.
 *
 * The canonical, URL-serializable filter object for the browse/search explorer.
 * `BrowseState` is the shape that later waves use to replace BOTH `SearchFilters`
 * (apps/civitics/app/search) and `GroupFilter` (@civitics/graph). Kept dependency-
 * free (no next/*, no @civitics/db) so the scope compiler, cursor codec, and
 * registry validators are unit-testable under `tsx --test`.
 */

/** Every kind carried by entity_search_index (FIX-748). */
export type BrowseKind =
  | "official"
  | "proposal"
  | "initiative"
  | "agency"
  | "financial"
  | "jurisdiction"
  | "institution"
  | "meeting";

export const BROWSE_KINDS: readonly BrowseKind[] = [
  "official", "proposal", "initiative", "agency",
  "financial", "jurisdiction", "institution", "meeting",
] as const;

/** A facet constraint value — a single value (=) or a set (IN / = ANY). */
export type FacetValue = string | string[];

/** key → value map of facet constraints (key === index column name). */
export type FacetMap = Record<string, FacetValue>;

/**
 * Keyset-capable sort modes. Each maps 1:1 to an entity_search_index column with
 * a (kind, <col>, entity_id) btree behind it (FIX-748), so paging is O(1) not
 * O(offset). `relevance` is accepted as an alias (see BROWSE_SORTS) — the browse
 * substrate has no per-row relevance column, so it resolves to the civic default
 * (most-connected first) while the text query does the narrowing.
 */
export type BrowseSort =
  | "name_asc"
  | "name_desc"
  | "connections_desc"
  | "amount_desc"
  | "recent";

export const DEFAULT_SORT: BrowseSort = "connections_desc";

/** The canonical, versioned browse filter. Round-trips through URLSearchParams. */
export interface BrowseState {
  /** Tree path in the By-Branch scope tree, e.g. "people/officials/federal/congress/senate". "" = all kinds. */
  scope: string;
  /** Per-kind facet refinements applied on top of the scope's own predicates. */
  facets: FacetMap;
  /** Free-text query (trigram/tsv). "" = browse mode (no text filter). */
  q: string;
  /** Keyset sort mode. */
  sort: BrowseSort;
  /** Opaque keyset cursor (base64 [sortValue, entityId]) or null for page 1. */
  cursor: string | null;
}

/** Result of compiling a scope path against the tree. `kind: null` = all kinds. */
export interface CompiledScope {
  kind: BrowseKind | null;
  facets: FacetMap;
}

/** How the facet counts in a response were derived (decision 3). */
export type BrowseCountsMode = "exact" | "estimated" | "omitted";

/** One row in a /api/browse response. Per-kind extra facet fields ride in `facets`. */
export interface BrowseRow {
  kind: BrowseKind;
  entity_id: string;
  display_name: string;
  secondary_label: string | null;
  photo_url: string | null;
  is_synthetic: boolean;
  amount_cents: number | null;
  amount_label: string | null;
  connection_count: number;
  activity_at: string | null;
  primary_source: string | null;
  /** The kind's facet column values (party/state/industry/…), non-null only. */
  facets: Record<string, string>;
}

/** The /api/browse response envelope. */
export interface BrowseResponse {
  rows: BrowseRow[];
  /** facet_key → (facet_value → count) for the active scope. */
  facets: Record<string, Record<string, number>>;
  /** total rows matching scope (+facets+q where cheap), per counts_mode. */
  totals: { count: number | null };
  counts_mode: BrowseCountsMode;
  /** Next-page keyset cursor, or null when exhausted. */
  cursor: string | null;
  /** When the underlying index/rollup was last rebuilt (ISO), or null. */
  refreshed_at: string | null;
  /** Echo of the resolved query for debugging. */
  query: { scope: string; kind: BrowseKind | null; q: string; sort: BrowseSort };
}
