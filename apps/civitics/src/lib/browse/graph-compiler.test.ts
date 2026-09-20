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
  isSessionScopedGroup,
  sessionScopedSaveNotice,
  SESSION_ONLY_LABEL,
  SESSION_ONLY_TITLE,
  type SessionScopedGroupLike,
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
    state({ scope: "money/pacs", facets: { industry: "health" } }),
  );
  assert.deepEqual(f, { entity_type: "pac", industry: "health" });
});

test("financial subtype scopes compile to the financial cohort mode (FIX-772)", () => {
  assert.deepEqual(
    compileBrowseToGroupFilter(state({ scope: "money/super-pacs" })),
    { entity_type: "financial", financial_type: "super_pac" },
  );
  assert.deepEqual(
    compileBrowseToGroupFilter(state({ scope: "money/party-committees" })),
    { entity_type: "financial", financial_type: "party_committee" },
  );
  assert.deepEqual(
    compileBrowseToGroupFilter(state({ scope: "money/corporations" })),
    { entity_type: "financial", financial_type: "corporation" },
  );
  assert.deepEqual(
    compileBrowseToGroupFilter(state({ scope: "money/unions" })),
    { entity_type: "financial", financial_type: "union" },
  );
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

test("financial without a subtype fails loudly (whole-Money cohort has no route mode)", () => {
  assertUncompilable(state({ scope: "money" }), /entity type/i);
  assertUncompilable(state({ scope: "money", facets: { industry: "health" } }), /entity type/i);
});

test("individual donors and unknown financial subtypes fail loudly (FIX-772)", () => {
  assertUncompilable(
    state({ scope: "money", facets: { financial_type: "individual" } }),
    /individual donors/i,
  );
  assertUncompilable(
    state({ scope: "money", facets: { financial_type: "nonprofit" } }),
    /can't form a live group yet/i,
  );
});

test("industry with a non-pac financial subtype fails loudly (route ignores it)", () => {
  assertUncompilable(
    state({ scope: "money/super-pacs", facets: { industry: "health" } }),
    /pac cohorts/i,
  );
});

test("multi-value financial_type fails loudly", () => {
  assertUncompilable(
    state({ scope: "money", facets: { financial_type: ["super_pac", "corporation"] } }),
    /single entity type/i,
  );
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
  assert.equal(normalizeIndustryToken("Healthcare"), "health");
  assert.equal(normalizeIndustryToken("Real Estate"), "real_estate");
  assert.equal(normalizeIndustryToken("Retail & Food"), "retail");
  assert.equal(normalizeIndustryToken("Finance"), "finance");
  assert.equal(normalizeIndustryToken("Tech"), "tech");
});

// FIX-908 — `pharma` was the canonical token until the blanket rename to
// `health`. Old URLs and any v1 saved row still carry it, and normalizeIndustryToken
// THROWS on an unknown token, so without the alias a bookmarked /search or graph
// link would hard-fail rather than resolve.
test("the retired `pharma` token still resolves to `health` (FIX-908 back-compat)", () => {
  assert.equal(normalizeIndustryToken("pharma"), "health");
  assert.equal(normalizeIndustryToken("Pharma"), "health");
  assert.equal(normalizeIndustryToken("pharmaceutical"), "health");
  assert.equal(normalizeIndustryToken("Health Care"), "health");
});

// The four buckets FIX-908 added are empty in entity_tags until the curated
// override list lands, but the compiler must accept them NOW — otherwise the
// first donor moved into `utilities` produces a filter that throws.
test("the four new FIX-908 industry keys are accepted as canonical", () => {
  for (const k of ["utilities", "manufacturing", "mining", "media"]) {
    assert.equal(normalizeIndustryToken(k), k);
  }
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
  assert.deepEqual(parsed.state.facets, { industry: "health" });
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
    // FIX-886 — handoff-only; the compiler must never emit it (asserted below).
    "officialIds",
  ].sort();
  assert.deepEqual(Object.keys(GROUP_FILTER_FIELD_COVERAGE).sort(), expected);
  for (const [field, note] of Object.entries(GROUP_FILTER_FIELD_COVERAGE)) {
    assert.ok(note.length > 10, `coverage note for ${field} is empty`);
  }
});

test("the compiler never emits officialIds (FIX-886 — handoff-only field)", () => {
  // BrowseState is a predicate; it cannot express a hand-picked id list. If a
  // future browse facet ever compiles to one, this must become a deliberate
  // decision (and the saved-view round-trip needs designing) rather than a
  // surprise — a saved view carrying stale ids would silently drift.
  const states = [
    state({ scope: "people/officials/federal/congress/senate" }),
    state({ scope: "officials", facets: { state: "WA" } }),
    state({ scope: "people/officials/federal/congress/house/democrat", facets: { state: "CA" } }),
  ];
  for (const s of states) {
    assert.equal(compileBrowseToGroupFilter(s).officialIds, undefined);
  }
});

// ── FIX-888 — session-scoped groups, and the save that must not drop them silently ──
//
// Decision (b), taken 2026-09-19: persist nothing, say so. The two declined
// options are recorded in graph-compiler.ts — (a) snapshotting the ids into the
// saved view drifts as officials leave office or merge; (c) a real membership
// table is a feature, not a fix.
//
// The test that carries the weight is the NEGATIVE one: a predicate group must
// NOT trigger the notice, or the warning appears on every save, becomes noise,
// and stops being read — which is the same outcome as the silent drop.

function group(partial: Partial<SessionScopedGroupLike> = {}): SessionScopedGroupLike {
  return { name: "Climate advocates", ...partial };
}

test("FIX-888: an ids-group is session-scoped (BUNDLE AS GROUP → groupIds)", () => {
  assert.equal(isSessionScopedGroup(group({ filter: { officialIds: ["a", "b"] } })), true);
});

test("FIX-888: a selection group is session-scoped (FIX-826 memberIds)", () => {
  assert.equal(isSessionScopedGroup(group({ memberIds: ["a"] })), true);
  // An EMPTY memberIds array is still a selection group — FIX-826's own
  // isSelectionGroup keys on the array's presence, and a group that has been
  // emptied is still one a saved view cannot reproduce.
  assert.equal(isSessionScopedGroup(group({ memberIds: [] })), true);
});

test("FIX-888: a predicate group is NOT session-scoped — the notice must stay rare", () => {
  assert.equal(isSessionScopedGroup(group({ filter: {} })), false);
  assert.equal(isSessionScopedGroup(group()), false);
  // officialIds present but empty is what the GraphPage decode leaves when the
  // handoff carried no ids — it is the bare predicate, not a hand-picked group.
  assert.equal(isSessionScopedGroup(group({ filter: { officialIds: [] } })), false);
});

test("FIX-888: no notice when nothing in focus is hand-picked", () => {
  assert.equal(sessionScopedSaveNotice([]), null);
  assert.equal(sessionScopedSaveNotice([group(), group({ name: "WA Senate" })]), null);
});

test("FIX-888: the notice names the group and its size, not just 'something is lost'", () => {
  const notice = sessionScopedSaveNotice([
    group({ name: "Climate advocates", filter: { officialIds: ["a", "b", "c"] } }),
  ]);
  assert.ok(notice, "a hand-picked group in focus must produce a notice");
  assert.ok(notice!.includes("Climate advocates"), notice!);
  assert.ok(notice!.includes("3 members"), notice!);
  // It must say what IS saved, not only what isn't — "this won't be saved"
  // invites the reader to assume the graph is what gets saved.
  assert.ok(/saves the filters/i.test(notice!), notice!);
  assert.ok(/only in this session/i.test(notice!), notice!);
});

test("FIX-888: one member is not pluralised", () => {
  const notice = sessionScopedSaveNotice([group({ filter: { officialIds: ["a"] } })]);
  assert.ok(notice!.includes("1 member"), notice!);
  assert.ok(!notice!.includes("1 members"), notice!);
});

test("FIX-888: several hand-picked groups are summed, and the predicate ones ignored", () => {
  const notice = sessionScopedSaveNotice([
    group({ name: "Climate advocates", filter: { officialIds: ["a", "b"] } }),
    group({ name: "WA Senate" }),                       // predicate — not counted
    group({ name: "Shift-picked", memberIds: ["c", "d", "e"] }),
  ]);
  assert.ok(notice!.includes("2 hand-picked groups"), notice!);
  assert.ok(notice!.includes("5 members"), notice!);
  assert.ok(!notice!.includes("WA Senate"), "a predicate group must not be named as lost");
});

test("FIX-888: the focus-list affordance says the same thing as the save notice", () => {
  // Two surfaces, one fact. If they drift, one of them is lying.
  assert.ok(SESSION_ONLY_LABEL.length > 0);
  assert.ok(/only in this session/i.test(SESSION_ONLY_TITLE), SESSION_ONLY_TITLE);
  assert.ok(/filters, not these members/i.test(SESSION_ONLY_TITLE), SESSION_ONLY_TITLE);
});

test("FIX-888: decision (b) means NO schema change — the saved-view payload is unchanged", () => {
  // If (b) ever grew a persistence side, buildSavedViewPayload would have to
  // carry the members. It must not: that is option (a), which was declined.
  const payload = buildSavedViewPayload(
    state({ scope: "people/officials/federal/congress/senate" }),
  ) as unknown as Record<string, unknown>;
  assert.ok(!("officialIds" in payload), "a saved view must not carry hand-picked ids");
  assert.ok(!("memberIds" in payload), "a saved view must not carry selection members");
  assert.ok(!JSON.stringify(payload).includes("officialIds"));
});
