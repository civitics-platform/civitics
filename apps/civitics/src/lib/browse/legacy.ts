/**
 * FIX-752 — legacy /search URL → BrowseState translation.
 *
 * The pre-W1 /search grammar (?q=…&type=officials&party=democrat&…, the
 * SearchFilters param set) stays resolvable forever: existing links, nav, and
 * GlobalSearch "view all" hit this translator server-side in page.tsx before
 * the explorer mounts. New-grammar URLs (scope= / f_*) bypass it entirely.
 *
 * Translation is lossy by design — params the browse substrate cannot express
 * (date_from/date_to, min_amount/max_amount, official_role other than
 * congress, old offset cursors) drop cleanly and are reported in `dropped`.
 * Facet keys invalid for the compiled kind also drop (a legacy link must
 * never 400 the page).
 *
 * Dependency-free (no next/*) — unit-testable under tsx.
 */

import type { BrowseKind, BrowseState, FacetMap } from "./types";
import { normalizeSort, parseBrowseState } from "./browse-state";
import { compileScope, kindDirectScope } from "./scope-tree";
import { isValidFacetKey, validateFacets } from "./registry";

const FACET_PREFIX = "f_";

/** Legacy ?type= values → scope path. Tree paths where one exists (so the W1
 *  rail highlights); kind-direct paths (FIX-752) for the rest. */
const LEGACY_TYPE_SCOPE: Record<string, string> = {
  officials:     "people/officials",
  proposals:     "legislation/proposals",
  agencies:      "government/agencies",
  financial:     "money",
  initiatives:   "initiatives",
  jurisdictions: kindDirectScope("jurisdiction"),
  institutions:  kindDirectScope("institution"),
  meetings:      kindDirectScope("meeting"),
};

/** Legacy filter params that map 1:1 onto index facet columns. */
const LEGACY_FACET_PARAMS = [
  "party", "state", "chamber", "status", "proposal_type", "agency_type",
  "industry", "financial_type", "initiative_stage", "jurisdiction_level",
] as const;

/** Legacy params with no browse-substrate representation — always dropped. */
const UNTRANSLATABLE = ["date_from", "date_to", "min_amount", "max_amount", "cursor"] as const;

/** True when the params already speak the new grammar (scope= / f_*). */
export function isBrowseGrammar(sp: URLSearchParams): boolean {
  if (sp.has("scope")) return true;
  for (const key of sp.keys()) {
    if (key.startsWith(FACET_PREFIX)) return true;
  }
  return false;
}

export interface LegacyTranslation {
  state: BrowseState;
  /** Legacy param names that could not be represented and were dropped. */
  dropped: string[];
}

/** Translate a legacy /search param set into a valid BrowseState. */
export function translateLegacyParams(sp: URLSearchParams): LegacyTranslation {
  const dropped: string[] = [];

  const type = (sp.get("type") ?? "all").trim();
  let scope = LEGACY_TYPE_SCOPE[type] ?? "";
  if (type && type !== "all" && !(type in LEGACY_TYPE_SCOPE)) dropped.push(`type=${type}`);

  // official_role=congress deepens the officials scope; other roles have no
  // scope-tree node yet and drop.
  const role = sp.get("official_role");
  if (role) {
    if (role === "congress" && (scope === "" || scope === "people/officials")) {
      scope = "people/officials/federal/congress";
    } else {
      dropped.push(`official_role=${role}`);
    }
  }

  let kind: BrowseKind | null = null;
  try {
    kind = compileScope(scope).kind;
  } catch {
    scope = ""; // unreachable given the static map, but fail open to all-kinds
  }

  const facets: FacetMap = {};
  for (const key of LEGACY_FACET_PARAMS) {
    const value = (sp.get(key) ?? "").trim();
    if (!value) continue;
    if (kind ? isValidFacetKey(kind, key) : validateFacets(null, { [key]: value }).ok) {
      facets[key] = value;
    } else {
      dropped.push(`${key}=${value}`);
    }
  }

  // entity_type was the legacy name for the financial-type facet.
  const entityType = (sp.get("entity_type") ?? "").trim();
  if (entityType && !facets["financial_type"]) {
    if (kind === null || isValidFacetKey(kind, "financial_type")) {
      facets["financial_type"] = entityType;
    } else {
      dropped.push(`entity_type=${entityType}`);
    }
  }

  for (const key of UNTRANSLATABLE) {
    if (sp.get(key)) dropped.push(`${key}=${sp.get(key)}`);
  }

  return {
    state: {
      scope,
      facets,
      q: (sp.get("q") ?? "").trim(),
      sort: normalizeSort(sp.get("sort")),
      cursor: null,
    },
    dropped,
  };
}

/**
 * Resolve ANY /search param set into a valid BrowseState: new-grammar params
 * parse directly (with unknown scopes/facet keys sanitized away rather than
 * erroring — a shared link must always render), legacy params translate.
 * Cursor is always reset — the page starts at row one.
 */
export function resolveBrowseParams(sp: URLSearchParams): LegacyTranslation {
  if (!isBrowseGrammar(sp)) return translateLegacyParams(sp);

  const parsed = parseBrowseState(sp);
  if (parsed.errors.length === 0) {
    return { state: { ...parsed.state, cursor: null }, dropped: [] };
  }

  // Sanitize: unknown scope → all-kinds; facet keys invalid for the (re)compiled
  // kind drop with a record.
  const dropped: string[] = [...parsed.errors];
  let scope = parsed.state.scope;
  let kind: BrowseKind | null = null;
  try {
    kind = compileScope(scope).kind;
  } catch {
    scope = "";
  }
  const facets: FacetMap = {};
  for (const [key, value] of Object.entries(parsed.state.facets)) {
    if (kind ? isValidFacetKey(kind, key) : validateFacets(null, { [key]: value }).ok) {
      facets[key] = value;
    }
  }
  return {
    state: { scope, facets, q: parsed.state.q, sort: parsed.state.sort, cursor: null },
    dropped,
  };
}
