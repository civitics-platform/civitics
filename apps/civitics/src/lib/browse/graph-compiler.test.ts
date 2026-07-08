/**
 * FIX-762 / FIX-763 — compiler tests: BrowseState → GroupFilter, v1 → BrowseState
 * up-compile, saved-view payload parsing, industry token map, and the
 * GroupFilter field-coverage manifest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { BrowseState } from "./types";
import {
  compileBrowseToGroupFilter,
  tryCompileBrowseToGroupFilter,
  compileGroupFilterToBrowse,
  parseSavedViewFilter,
  buildSavedViewPayload,
  normalizeIndustryToken,
  suggestedViewName,
  UncompilableBrowseStateError,
  UnknownIndustryTokenError,
  InvalidSavedViewError,
  GROUP_FILTER_FIELD_COVERAGE,
  CANONICAL_INDUSTRY_TOKENS,
} from "./graph-compiler";

function state(partial: Partial<BrowseState>): BrowseState {
  return { scope: "", facets: {}, q: "", sort: "connections_desc", cursor: null, ...partial };
}

// ── BrowseState → GroupFilter: the resolvable surface ──────────────────────────

test("senate scope compiles to a gb cohort", () => {
  const f = compileBrowseToGroupFilter(state({ scope: "people/officials/federal/congress/senate" }));
  assert.deepEqual(f, { entity_type: "official", governingBody: "senate" });
});

test("senate democrats (scope facets) compose party onto the gb cohort", () => {
  const f = compileBrowseToGroupFilter(
    state({ scope: "people/officials/federal/congress/senate/democrat" }),
  );
  assert.deepEqual(f, { entity_type: "official", governingBody: "senate", party: "democrat" });
});

test("explicit chamber/party/state facets compose; explicit overrides scope", () => {
  const f = compileBrowseToGroupFilter(
    state({
      scope: "people/officials/federal/congress/senate",
      facets: { party: "republican", state: "TX", chamber: "house" },
    }),
  );
  // explicit chamber=house overrides the scope's senate (mirrors execute.ts merge)
  assert.deepEqual(f, {
    entity_type: "official",
    governingBody: "house",
    party: "republican",
    state: "TX",
  });
});

test("officials kind-direct scope with state only → legacy no-gb delegation filter", () => {
  const f = compileBrowseToGroupFilter(state({ scope: "officials", facets: { state: "WA" } }));
  assert.deepEqual(f, { entity_type: "official", state: "WA" });
});

test("status=active is consumed (route is always active-only)", () => {
  const f = compileBrowseToGroupFilter(
    state({ scope: "officials", facets: { status: "active", party: "independent" } }),
  );
  assert.deepEqual(f, { entity_type: "official", party: "independent" });
});

test("pac scope + industry compiles to the industry-tagged pac mode", () => {
  const f = compileBrowseToGroupFilter(
    state({ scope: "money/pacs", facets: { industry: "pharma" } }),
  );
  assert.deepEqual(f, { entity_type: "pac", industry: "pharma" });
});

test("legacy industry token normalizes through the map (energy → oil_gas)", () => {
  const f = compileBrowseToGroupFilter(
    state({ scope: "money/pacs", facets: { industry: "energy" } }),
  );
  assert.deepEqual(f, { entity_type: "pac", industry: "oil_gas" });
});

test("bare agencies scope compiles to the all-agencies group", () => {
  assert.deepEqual(
    compileBrowseToGroupFilter(state({ scope: "government/agencies" })),
    { entity_type: "agency" },
  );
  assert.deepEqual(
    compileBrowseToGroupFilter(state({ scope: "agencies" })),
    { entity_type: "agency" },
  );
});

// ── BrowseState → GroupFilter: loud failures ────────────────────────────────────

function assertUncompilable(s: BrowseState, reasonPattern: RegExp) {
  assert.throws(() => compileBrowseToGroupFilter(s), UncompilableBrowseStateError);
  const r = tryCompileBrowseToGroupFilter(s);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, reasonPattern);
}

test("all-kinds scope fails loudly", () => {
  assertUncompilable(state({ scope: "" }), /pick a scope/i);
});

test("text query fails loudly", () => {
  assertUncompilable(
    state({ scope: "people/officials/federal/congress/senate", q: "warren" }),
    /text search/i,
  );
});

test("whole-Congress scope (multi-chamber) fails loudly", () => {
  assertUncompilable(state({ scope: "people/officials/federal/congress" }), /senate or house/i);
});

test("jurisdiction level without a chamber fails loudly (federal and state)", () => {
  assertUncompilable(state({ scope: "people/officials/federal" }), /level/i);
  assertUncompilable(state({ scope: "people/officials/state" }), /level/i);
});

test("multi-value party fails loudly", () => {
  assertUncompilable(
    state({ scope: "officials", facets: { party: ["democrat", "republican"] } }),
    /single party/i,
  );
});

test("non-active status fails loudly", () => {
  assertUncompilable(state({ scope: "officials", facets: { status: "former" } }), /active/i);
});

test("financial without financial_type=pac fails loudly (route has no financial mode)", () => {
  assertUncompilable(state({ scope: "money" }), /pac/i);
  assertUncompilable(state({ scope: "money/super-pacs" }), /super_pac/);
  assertUncompilable(state({ scope: "money", facets: { industry: "pharma" } }), /pac/i);
});

test("unknown industry token fails loudly with the vocabulary in the message", () => {
  assertUncompilable(
    state({ scope: "money/pacs", facets: { industry: "Construction" } }),
    /unknown industry token/i,
  );
});

test("narrowed agency scope fails loudly (route ignores agency filters)", () => {
  assertUncompilable(state({ scope: "government/agencies/independent" }), /agency groups/i);
});

test("proposal / initiative / non-route kinds fail loudly", () => {
  assertUncompilable(state({ scope: "legislation/proposals" }), /proposal/i);
  assertUncompilable(state({ scope: "initiatives" }), /initiative/i);
  assertUncompilable(state({ scope: "jurisdictions" }), /jurisdiction/i);
  assertUncompilable(state({ scope: "meetings" }), /meeting/i);
});

test("unknown scope fails loudly", () => {
  assertUncompilable(state({ scope: "people/aliens" }), /unknown scope/i);
});

// ── Industry token map ──────────────────────────────────────────────────────────

test("canonical tokens pass through unchanged", () => {
  for (const t of CANONICAL_INDUSTRY_TOKENS) assert.equal(normalizeIndustryToken(t), t);
});

test("v1 display labels map to canonical tokens", () => {
  assert.equal(normalizeIndustryToken("Energy"), "oil_gas");
  assert.equal(normalizeIndustryToken("Healthcare"), "pharma");
  assert.equal(normalizeIndustryToken("Real Estate"), "real_estate");
  assert.equal(normalizeIndustryToken("Retail & Food"), "retail");
  assert.equal(normalizeIndustryToken("Finance"), "finance");
  assert.equal(normalizeIndustryToken("Tech"), "tech");
});

test("unknown tokens throw (never silently match zero rows)", () => {
  assert.throws(() => normalizeIndustryToken("Construction"), UnknownIndustryTokenError);
  assert.throws(() => normalizeIndustryToken("Education"), UnknownIndustryTokenError);
});

// ── v1 → BrowseState up-compile ─────────────────────────────────────────────────

test("v1 official chamber+party+state up-compiles to the congress scope", () => {
  const s = compileGroupFilterToBrowse({
    entity_type: "official", chamber: "senate", party: "democrat", state: "CA",
  });
  assert.equal(s.scope, "people/officials/federal/congress/senate");
  assert.deepEqual(s.facets, { party: "democrat", state: "CA" });
});

test("v1 official up-compile round-trips through the forward compiler", () => {
  const v1 = { entity_type: "official" as const, chamber: "house" as const, party: "republican" };
  const forward = compileBrowseToGroupFilter(compileGroupFilterToBrowse(v1));
  // chamber re-expresses as the governingBody slug (FIX-495) — same cohort.
  assert.deepEqual(forward, { entity_type: "official", governingBody: "house", party: "republican" });
});

test("v1 state delegation up-compiles to the kind-direct officials scope", () => {
  const s = compileGroupFilterToBrowse({ entity_type: "official", state: "TX" });
  assert.equal(s.scope, "officials");
  assert.deepEqual(s.facets, { state: "TX" });
  assert.deepEqual(compileBrowseToGroupFilter(s), { entity_type: "official", state: "TX" });
});

test("v1 pac with a display-label industry up-compiles + normalizes + round-trips", () => {
  const s = compileGroupFilterToBrowse({ entity_type: "pac", industry: "Energy" });
  assert.equal(s.scope, "money/pacs");
  assert.deepEqual(s.facets, { industry: "oil_gas" });
  assert.deepEqual(compileBrowseToGroupFilter(s), { entity_type: "pac", industry: "oil_gas" });
});

test("v1 agency up-compiles to the agencies scope and round-trips", () => {
  const s = compileGroupFilterToBrowse({ entity_type: "agency" });
  assert.equal(s.scope, "government/agencies");
  assert.deepEqual(compileBrowseToGroupFilter(s), { entity_type: "agency" });
});

test("v1 unknown industry throws (row surfaces as unloadable)", () => {
  assert.throws(
    () => compileGroupFilterToBrowse({ entity_type: "pac", industry: "Construction" }),
    UnknownIndustryTokenError,
  );
});

// ── Saved-view payload parsing ──────────────────────────────────────────────────

test("v2 payload round-trips through build + parse", () => {
  const original = state({
    scope: "people/officials/federal/congress/senate",
    facets: { party: "democrat", state: ["WA", "OR"] },
    q: "budget",
    sort: "name_asc",
  });
  const parsed = parseSavedViewFilter(buildSavedViewPayload(original));
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.state, { ...original, cursor: null });
});

test("v2 payload with an unknown scope or facet key is rejected", () => {
  assert.throws(
    () => parseSavedViewFilter({ v: 2, scope: "people/aliens", facets: {} }),
    InvalidSavedViewError,
  );
  assert.throws(
    () => parseSavedViewFilter({ v: 2, scope: "officials", facets: { nope: "x" } }),
    InvalidSavedViewError,
  );
});

test("v1 row shape is detected and up-compiled on parse", () => {
  const parsed = parseSavedViewFilter({ entity_type: "pac", industry: "Healthcare" });
  assert.equal(parsed.version, 1);
  assert.equal(parsed.state.scope, "money/pacs");
  assert.deepEqual(parsed.state.facets, { industry: "pharma" });
});

test("garbage payloads are rejected, not guessed at", () => {
  assert.throws(() => parseSavedViewFilter(null), InvalidSavedViewError);
  assert.throws(() => parseSavedViewFilter("x"), InvalidSavedViewError);
  assert.throws(() => parseSavedViewFilter({ hello: "world" }), InvalidSavedViewError);
  assert.throws(() => parseSavedViewFilter({ entity_type: "financial" }), InvalidSavedViewError);
});

// ── Name suggestion ─────────────────────────────────────────────────────────────

test("suggestedViewName composes crumb + facets", () => {
  const name = suggestedViewName(
    state({ scope: "people/officials/federal/congress/senate", facets: { party: "democrat", state: "TX" } }),
  );
  assert.equal(name, "Senate · Democrat · TX");
  assert.equal(suggestedViewName(state({})), "All records");
});

// ── Coverage manifest ───────────────────────────────────────────────────────────

test("GROUP_FILTER_FIELD_COVERAGE names every GroupFilter field", () => {
  // Keep in sync with packages/graph/src/types.ts GroupFilter. The Record's
  // keyof constraint catches removals at compile time; this literal list
  // catches additions (a new field must be consciously classified).
  const expected = [
    "entity_type", "chamber", "party", "state", "industry", "tag",
    "committeeId", "governingBody", "official_role", "financial_type",
    "proposal_type", "agency_type", "initiative_stage",
  ].sort();
  assert.deepEqual(Object.keys(GROUP_FILTER_FIELD_COVERAGE).sort(), expected);
  for (const [field, note] of Object.entries(GROUP_FILTER_FIELD_COVERAGE)) {
    assert.ok(note.length > 10, `coverage note for ${field} is empty`);
  }
});
