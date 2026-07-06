/**
 * FIX-749 — BrowseState ↔ URLSearchParams (de)serialization + validation.
 *
 * URL shape (all optional):
 *   scope   = people/officials/federal/congress/senate
 *   q       = <text>
 *   sort    = connections_desc | name_asc | name_desc | amount_desc | recent
 *             (relevance is accepted as an alias → the default sort)
 *   cursor  = <opaque keyset cursor>
 *   f_<key> = <facet value>   (repeat the param for a multi-value IN facet)
 *
 * Facet keys are validated against the scope's compiled kind via the registry —
 * unknown keys surface as errors (the route rejects them). Kept dependency-free
 * (no next/*) so it is unit-testable under tsx.
 */

import type { BrowseKind, BrowseSort, BrowseState, FacetMap, FacetValue } from "./types";
import { DEFAULT_SORT } from "./types";
import { compileScope, UnknownScopeError } from "./scope-tree";
import { BROWSE_REGISTRY, validateFacets } from "./registry";

const FACET_PREFIX = "f_";

const ALL_SORTS: readonly BrowseSort[] = [
  "name_asc", "name_desc", "connections_desc", "amount_desc", "recent",
];
const SORT_SET: ReadonlySet<string> = new Set(ALL_SORTS);

/** Normalize a raw sort param. `relevance` (and empty/unknown) → the default. */
export function normalizeSort(raw: string | null | undefined): BrowseSort {
  if (!raw || raw === "relevance") return DEFAULT_SORT;
  return SORT_SET.has(raw) ? (raw as BrowseSort) : DEFAULT_SORT;
}

export interface ParsedBrowseState {
  state: BrowseState;
  /** Compiled scope kind (null = all kinds). */
  kind: BrowseKind | null;
  /** Non-fatal + fatal issues; the route rejects when non-empty. */
  errors: string[];
}

/** Collapse a single-element array facet to a scalar (cosmetic; = vs IN is decided downstream). */
function collapse(v: string[]): FacetValue {
  return v.length === 1 ? (v[0] as string) : v;
}

/** Parse + validate a BrowseState from URLSearchParams. */
export function parseBrowseState(sp: URLSearchParams): ParsedBrowseState {
  const errors: string[] = [];
  const scope = (sp.get("scope") ?? "").trim();
  const q = (sp.get("q") ?? "").trim();
  const sort = normalizeSort(sp.get("sort"));
  const cursor = sp.get("cursor");

  // Compile scope → kind (drives facet validation).
  let kind: BrowseKind | null = null;
  try {
    kind = compileScope(scope).kind;
  } catch (e) {
    if (e instanceof UnknownScopeError) errors.push(e.message);
    else throw e;
  }

  // Collect f_<key> facet params (repeat = multi-value).
  const raw: Record<string, string[]> = {};
  for (const [k, v] of sp.entries()) {
    if (!k.startsWith(FACET_PREFIX)) continue;
    const key = k.slice(FACET_PREFIX.length);
    if (!v) continue;
    (raw[key] ??= []).push(v);
  }
  const facets: FacetMap = {};
  for (const [k, vals] of Object.entries(raw)) facets[k] = collapse(vals);

  // Validate facet keys against the scope's kind.
  const v = validateFacets(kind, facets);
  if (!v.ok) {
    const valid = kind ? BROWSE_REGISTRY[kind].facets.map((f) => f.key).join(", ") : "(any kind's facets)";
    errors.push(`Unknown facet key(s) for kind ${kind ?? "all"}: ${v.unknownKeys.join(", ")}. Valid: ${valid}`);
  }

  return { state: { scope, facets, q, sort, cursor: cursor || null }, kind, errors };
}

/** Serialize a BrowseState back to URLSearchParams (round-trips parseBrowseState). */
export function serializeBrowseState(state: BrowseState): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.scope) sp.set("scope", state.scope);
  if (state.q) sp.set("q", state.q);
  if (state.sort && state.sort !== DEFAULT_SORT) sp.set("sort", state.sort);
  if (state.cursor) sp.set("cursor", state.cursor);
  for (const [key, value] of Object.entries(state.facets)) {
    const vals = Array.isArray(value) ? value : [value];
    for (const val of vals) sp.append(`${FACET_PREFIX}${key}`, val);
  }
  return sp;
}
