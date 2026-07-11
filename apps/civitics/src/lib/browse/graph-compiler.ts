/**
 * FIX-762 / FIX-763 — BrowseState ↔ GroupFilter compilers + saved-view payload.
 *
 * The graph resolves cohorts through /api/graph/group, whose real capability
 * surface (verified against the route, 2026-07-07) is narrower than the
 * GroupFilter type suggests:
 *
 *   official — gb cohort (governingBody slug/uuid; chamber= is a legacy alias
 *              for the senate/house slugs, FIX-495) composed with party/state,
 *              OR the legacy no-gb path (is_active + party + metadata-state).
 *   pac      — industry-tagged PACs → top recipients (industry optional).
 *   proposal — topic-tag bubble (tag REQUIRED — 400 without).
 *   agency   — ALL active agencies; every filter field is ignored.
 *   financial — FIX-772: subtype cohorts (financial_type REQUIRED —
 *              super_pac|party_committee|corporation|union; pac routes to the
 *              dedicated industry-capable mode above). 'individual' stays
 *              refused — the route 422s it (individuals aren't enumerable as
 *              a cohort). The route ignores industry here, so industry + a
 *              non-pac subtype refuses rather than minting a lying group.
 *   initiative — NOT handled: the route 400s ("Invalid entity_type"). The
 *              compiler REFUSES to emit it rather than minting silently-dead
 *              groups.
 *
 * compileBrowseToGroupFilter mirrors exactly that surface and THROWS
 * UncompilableBrowseStateError (with a user-showable reason) on anything
 * outside it — a browse state that can't become a working live group must be
 * a visible refusal, never a no-op bubble.
 *
 * Dependency-free at runtime (type-only import from @civitics/graph) so it is
 * unit-testable under `tsx --test`.
 */

import type { GroupFilter } from "@civitics/graph";
import type { BrowseKind, BrowseSort, BrowseState, FacetMap, FacetValue } from "./types";
import { normalizeSort } from "./browse-state";
import { compileScope, scopeCrumbs, UnknownScopeError } from "./scope-tree";
import { validateFacets } from "./registry";

// ── Industry token map ──────────────────────────────────────────────────────────
//
// The index/entity_tags canonical vocabulary (verified local + prod 2026-07-07):
// lobby finance oil_gas pharma defense labor tech agriculture real_estate retail
// legal transportation. BUILT_IN_GROUPS already matches it 1:1; the mismatch
// lives in v1 saved rows and legacy URLs, which carry CustomGroupForm display
// labels ("Energy", "Healthcare", "Real Estate", "Retail & Food") or the W1
// legacy "energy" token. Unknown tokens throw — a filter that silently matches
// zero rows is the failure mode this map exists to prevent.

export const CANONICAL_INDUSTRY_TOKENS = [
  "lobby", "finance", "oil_gas", "pharma", "defense", "labor", "tech",
  "agriculture", "real_estate", "retail", "legal", "transportation",
] as const;

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_INDUSTRY_TOKENS);

/** Legacy/display tokens (lowercased, trimmed) → canonical entity_tags token. */
const INDUSTRY_ALIASES: Record<string, string> = {
  "energy":           "oil_gas",
  "oil & gas":        "oil_gas",
  "healthcare":       "pharma",
  "pharmaceutical":   "pharma",
  "real estate":      "real_estate",
  "retail & food":    "retail",
  "lobby / advocacy": "lobby",
  "advocacy":         "lobby",
};

export class UnknownIndustryTokenError extends Error {
  constructor(public readonly token: string) {
    super(
      `Unknown industry token "${token}" — not in the entity_tags vocabulary ` +
      `(${CANONICAL_INDUSTRY_TOKENS.join(", ")}) and no alias maps it`,
    );
    this.name = "UnknownIndustryTokenError";
  }
}

/** Normalize an industry token to the canonical entity_tags form, or throw. */
export function normalizeIndustryToken(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (CANONICAL_SET.has(key)) return key;
  const alias = INDUSTRY_ALIASES[key];
  if (alias) return alias;
  throw new UnknownIndustryTokenError(raw);
}

// ── BrowseState → GroupFilter ───────────────────────────────────────────────────

export class UncompilableBrowseStateError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "UncompilableBrowseStateError";
  }
}

/** Sole value of a facet (callers reject multi-value via isMulti first). */
function single(v: FacetValue | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function isMulti(v: FacetValue | undefined): boolean {
  return Array.isArray(v) && v.length > 1;
}

/** Scope facets merged with explicit facets (explicit wins) — mirrors execute.ts. */
function mergedFacets(state: BrowseState): { kind: BrowseKind | null; facets: FacetMap } {
  let compiled;
  try {
    compiled = compileScope(state.scope);
  } catch (e) {
    if (e instanceof UnknownScopeError) {
      throw new UncompilableBrowseStateError(`Unknown scope "${state.scope}"`);
    }
    throw e;
  }
  return { kind: compiled.kind, facets: { ...compiled.facets, ...state.facets } };
}

function requireSingle(facets: FacetMap, key: string, label: string): string | undefined {
  if (isMulti(facets[key])) {
    throw new UncompilableBrowseStateError(
      `Multiple ${label} values can't define one live group — pick a single ${label}`,
    );
  }
  return single(facets[key]);
}

/**
 * Compile a BrowseState into the GroupFilter /api/graph/group can actually
 * resolve. Throws UncompilableBrowseStateError with a user-showable reason for
 * anything outside the route's real surface (see module header).
 */
export function compileBrowseToGroupFilter(state: BrowseState): GroupFilter {
  if (state.q.trim() !== "") {
    throw new UncompilableBrowseStateError(
      "A text search can't define a live group — clear the search or add rows individually",
    );
  }

  const { kind, facets } = mergedFacets(state);

  if (kind === null) {
    throw new UncompilableBrowseStateError(
      "Pick a scope first — an all-records view can't be a live group",
    );
  }

  if (kind === "official") return compileOfficial(facets);
  if (kind === "financial") return compileFinancial(facets);
  if (kind === "agency") return compileAgency(facets);

  // proposal: the route needs a topic tag, which the browse substrate has no
  // facet for; initiative/jurisdiction/institution/meeting: no route mode.
  throw new UncompilableBrowseStateError(
    `${kind} records can't form a live graph group yet`,
  );
}

function compileOfficial(facets: FacetMap): GroupFilter {
  // A multi-chamber cohort (the people/officials/federal/congress node compiles
  // chamber:[senate,house]) has no single-gb representation on the route.
  if (isMulti(facets["chamber"])) {
    throw new UncompilableBrowseStateError(
      "A whole-Congress cohort spans both chambers — pick Senate or House",
    );
  }
  const chamber = requireSingle(facets, "chamber", "chamber");
  const party = requireSingle(facets, "party", "party");
  const state = requireSingle(facets, "state", "state");
  const level = requireSingle(facets, "jurisdiction_level", "level");
  const status = requireSingle(facets, "status", "status");

  if (status !== undefined && status !== "active") {
    throw new UncompilableBrowseStateError(
      `Graph groups only resolve active officials — the "${status}" status filter can't apply`,
    );
  }

  const filter: GroupFilter = { entity_type: "official" };

  if (chamber !== undefined) {
    if (chamber !== "senate" && chamber !== "house") {
      // 'senate'/'house' are the only gb slugs the chamber facet maps onto
      // (people/officials/federal/congress compiles chamber:[senate,house] —
      // a whole-Congress cohort has no single-gb representation).
      throw new UncompilableBrowseStateError(
        `Chamber "${chamber}" has no graph cohort — pick Senate or House`,
      );
    }
    // FIX-495: governingBody slug is the canonical cohort key; chamber= is a
    // legacy alias for the same route branch. Federal level is implied.
    filter.governingBody = chamber;
  } else if (level !== undefined) {
    // Without a chamber the route falls to the legacy no-gb path (is_active +
    // party + metadata-state), which cannot scope by jurisdiction level.
    throw new UncompilableBrowseStateError(
      `A "${level}"-level officials cohort isn't resolvable as a live group — drill into Senate or House, or filter by state/party only`,
    );
  }

  if (party !== undefined) filter.party = party;
  if (state !== undefined) filter.state = state;
  return filter;
}

// FIX-772 — subtypes the route's entity_type=financial branch resolves (top-1000
// cohort by entity_search_index.amount_cents + donation/contract edge
// aggregation). 'pac' compiles to the dedicated industry-capable mode instead;
// 'individual' is refused (the route 422s — not enumerable as a cohort).
const GROUPABLE_FINANCIAL_TYPES: ReadonlySet<string> = new Set([
  "super_pac", "party_committee", "corporation", "union",
]);

function compileFinancial(facets: FacetMap): GroupFilter {
  const financialType = requireSingle(facets, "financial_type", "entity type");
  const industryRaw = requireSingle(facets, "industry", "industry");

  if (financialType === undefined) {
    throw new UncompilableBrowseStateError(
      "Money records only form live groups per entity type — drill into PACs, Super PACs, Party committees, or Corporations first",
    );
  }

  // PAC cohorts keep the dedicated route mode, which is the only one that
  // understands the industry filter.
  if (financialType === "pac") {
    const filter: GroupFilter = { entity_type: "pac" };
    if (industryRaw !== undefined) {
      try {
        filter.industry = normalizeIndustryToken(industryRaw);
      } catch (e) {
        if (e instanceof UnknownIndustryTokenError) {
          throw new UncompilableBrowseStateError(e.message);
        }
        throw e;
      }
    }
    return filter;
  }

  if (!GROUPABLE_FINANCIAL_TYPES.has(financialType)) {
    throw new UncompilableBrowseStateError(
      financialType === "individual"
        ? "Individual donors can't form a live group — they aren't enumerable as a cohort"
        : `"${financialType}" money entities can't form a live group yet`,
    );
  }

  // The route ignores industry for non-pac financial cohorts — emitting the
  // filter anyway would mint a group whose name lies about its members (the
  // same rule the agency branch applies to its ignored facets).
  if (industryRaw !== undefined) {
    throw new UncompilableBrowseStateError(
      "Industry filters only apply to PAC cohorts — clear the industry filter or drill into PACs",
    );
  }

  return {
    entity_type: "financial",
    financial_type: financialType as NonNullable<GroupFilter["financial_type"]>,
  };
}

function compileAgency(facets: FacetMap): GroupFilter {
  // The route ignores every agency filter field and returns ALL active
  // agencies — emitting a filter for a narrowed agency scope would mint a
  // group whose name lies about its members.
  const keys = Object.keys(facets);
  if (keys.length > 0) {
    throw new UncompilableBrowseStateError(
      "Agency groups can't be filtered yet — the graph resolves all active agencies only",
    );
  }
  return { entity_type: "agency" };
}

/** Non-throwing wrapper for UI gating (button enable/disable + reason line). */
export function tryCompileBrowseToGroupFilter(
  state: BrowseState,
): { ok: true; filter: GroupFilter } | { ok: false; reason: string } {
  try {
    return { ok: true, filter: compileBrowseToGroupFilter(state) };
  } catch (e) {
    if (e instanceof UncompilableBrowseStateError) return { ok: false, reason: e.reason };
    throw e;
  }
}

// ── GroupFilter (v1) → BrowseState up-compile ───────────────────────────────────
//
// v1 user_custom_groups rows are bounded by the route's parseFilter:
// { entity_type: official|pac|agency, chamber?, party?, state?, industry? }.
// (gb/committee/tag groups were never persisted.) industry carries v1 display
// labels — normalize through the token map; unknown tokens throw so the rail
// renders the row as unloadable instead of silently matching zero rows.

export interface V1GroupFilter {
  entity_type: "official" | "pac" | "agency";
  chamber?: "senate" | "house";
  party?: string;
  state?: string;
  industry?: string;
}

export function compileGroupFilterToBrowse(filter: V1GroupFilter): BrowseState {
  const base: BrowseState = { scope: "", facets: {}, q: "", sort: "connections_desc", cursor: null };

  if (filter.entity_type === "official") {
    const facets: FacetMap = {};
    if (filter.party) facets["party"] = filter.party;
    if (filter.state) facets["state"] = filter.state;
    const scope = filter.chamber
      ? `people/officials/federal/congress/${filter.chamber}`
      : "officials";
    return { ...base, scope, facets };
  }

  if (filter.entity_type === "pac") {
    const facets: FacetMap = {};
    if (filter.industry) facets["industry"] = normalizeIndustryToken(filter.industry);
    // money/pacs contributes financial_type:'pac' as a scope facet, so the
    // round-trip back through compileBrowseToGroupFilter lands on the pac mode.
    return { ...base, scope: "money/pacs", facets };
  }

  if (filter.entity_type === "agency") {
    return { ...base, scope: "government/agencies" };
  }

  throw new UncompilableBrowseStateError(
    `v1 group filter entity_type "${(filter as { entity_type: string }).entity_type}" has no browse scope`,
  );
}

// ── Saved-view payload (user_custom_groups.filter, FIX-763) ────────────────────

export interface SavedViewPayloadV2 {
  v: 2;
  scope: string;
  facets: FacetMap;
  q: string;
  sort: BrowseSort;
}

export function buildSavedViewPayload(state: BrowseState): SavedViewPayloadV2 {
  return { v: 2, scope: state.scope, facets: state.facets, q: state.q, sort: state.sort };
}

export class InvalidSavedViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSavedViewError";
  }
}

export interface ParsedSavedView {
  version: 1 | 2;
  state: BrowseState;
}

function parseFacetMap(input: unknown): FacetMap {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidSavedViewError("facets must be an object");
  }
  const out: FacetMap = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
    else throw new InvalidSavedViewError(`facet "${k}" must be a string or string[]`);
  }
  return out;
}

/**
 * Parse a user_custom_groups.filter JSONB payload into a BrowseState —
 * detecting shape: `v:2` rows are BrowseState-native; rows with `entity_type`
 * are v1 GroupFilters and up-compile. Read-only — no row is ever rewritten.
 * Throws InvalidSavedViewError / UnknownIndustryTokenError on malformed or
 * unmappable payloads (callers surface the row as unloadable).
 */
export function parseSavedViewFilter(input: unknown): ParsedSavedView {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidSavedViewError("filter must be an object");
  }
  const f = input as Record<string, unknown>;

  if (f["v"] === 2) {
    const scope = typeof f["scope"] === "string" ? f["scope"] : "";
    let kind: BrowseKind | null;
    try {
      kind = compileScope(scope).kind;
    } catch {
      throw new InvalidSavedViewError(`unknown scope "${scope}"`);
    }
    const facets = parseFacetMap(f["facets"]);
    const check = validateFacets(kind, facets);
    if (!check.ok) {
      throw new InvalidSavedViewError(`unknown facet key(s): ${check.unknownKeys.join(", ")}`);
    }
    return {
      version: 2,
      state: {
        scope,
        facets,
        q: typeof f["q"] === "string" ? f["q"] : "",
        sort: normalizeSort(typeof f["sort"] === "string" ? f["sort"] : null),
        cursor: null,
      },
    };
  }

  if (typeof f["entity_type"] === "string") {
    if (!["official", "pac", "agency"].includes(f["entity_type"])) {
      throw new InvalidSavedViewError(`v1 entity_type "${f["entity_type"]}" is not loadable`);
    }
    const v1: V1GroupFilter = { entity_type: f["entity_type"] as V1GroupFilter["entity_type"] };
    if (typeof f["chamber"] === "string" && (f["chamber"] === "senate" || f["chamber"] === "house")) {
      v1.chamber = f["chamber"];
    }
    if (typeof f["party"] === "string" && f["party"]) v1.party = f["party"];
    if (typeof f["state"] === "string" && f["state"]) v1.state = f["state"];
    if (typeof f["industry"] === "string" && f["industry"]) v1.industry = f["industry"];
    return { version: 1, state: compileGroupFilterToBrowse(v1) };
  }

  throw new InvalidSavedViewError("filter is neither a v2 saved view nor a v1 group filter");
}

// ── Display-name suggestion ─────────────────────────────────────────────────────

function titleize(value: string): string {
  const s = value.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Human name for a browse state ("Senate · Democrat · TX"), for group/view saves. */
export function suggestedViewName(state: BrowseState): string {
  const parts: string[] = [];
  try {
    const crumbs = scopeCrumbs(state.scope);
    const last = crumbs[crumbs.length - 1];
    if (last) parts.push(last.label);
  } catch {
    // unknown scope — facets alone will have to carry the name
  }
  for (const value of Object.values(state.facets)) {
    const vals = Array.isArray(value) ? value : [value];
    for (const v of vals) parts.push(v.length <= 3 ? v.toUpperCase() : titleize(v));
  }
  if (state.q) parts.push(`“${state.q}”`);
  return parts.join(" · ") || "All records";
}

// ── GroupFilter field coverage manifest ─────────────────────────────────────────
//
// One entry per GroupFilter field, stating which BrowseState part produces it
// (or why none can). The unit test asserts this manifest stays exhaustive over
// keyof GroupFilter, so a new GroupFilter field forces a conscious decision
// here instead of silently falling outside the compiler.

export const GROUP_FILTER_FIELD_COVERAGE: Record<keyof GroupFilter, string> = {
  entity_type:      "kind official → 'official'; kind financial + f_financial_type=pac → 'pac'; kind financial + f_financial_type super_pac|party_committee|corporation|union → 'financial' (FIX-772); kind agency → 'agency'. 'initiative' is never emitted (route 400s); 'proposal' unreachable (needs tag).",
  governingBody:    "f_chamber senate|house → gb slug (FIX-495 canonical cohort key)",
  chamber:          "never emitted — chamber compiles to governingBody; the route aliases chamber= to the same gb branch",
  party:            "f_party (single value)",
  state:            "f_state (single value, index carries abbreviations)",
  industry:         "f_industry (single value, normalized through the token map; pac cohorts only — refused with a non-pac financial subtype, which the route ignores)",
  tag:              "unreachable — the browse registry has no topic-tag facet (proposal scopes refuse to compile)",
  committeeId:      "unreachable — no committee facet in the browse registry",
  official_role:    "unreachable — no role facet; the route also ignores it today",
  financial_type:   "f_financial_type: pac is consumed to select the pac mode; super_pac|party_committee|corporation|union are emitted on the filter (FIX-772); individual is refused (route 422s — not enumerable)",
  proposal_type:    "unreachable — proposal scopes refuse to compile (route needs tag)",
  agency_type:      "never emitted — the route ignores it, so a narrowed agency filter would lie about its members",
  initiative_stage: "unreachable — initiative scopes refuse to compile (no route mode)",
};
