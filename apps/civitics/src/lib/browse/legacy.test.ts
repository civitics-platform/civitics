/**
 * FIX-752 — legacy /search URL translation + kind-direct scopes.
 * Runs via:  pnpm --filter @civitics/app-civitics test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateLegacyParams, isBrowseGrammar } from "./legacy";
import { compileScope, scopeCrumbs, KIND_DIRECT_SCOPES } from "./scope-tree";
import { parseBrowseState } from "./browse-state";
import { BROWSE_KINDS } from "./types";

function translate(qs: string) {
  return translateLegacyParams(new URLSearchParams(qs));
}

test("kind-direct scope exists and compiles for every indexed kind", () => {
  const covered = new Set(Object.values(KIND_DIRECT_SCOPES));
  for (const kind of BROWSE_KINDS) assert.ok(covered.has(kind), `no direct scope for ${kind}`);
  for (const [path, kind] of Object.entries(KIND_DIRECT_SCOPES)) {
    assert.deepEqual(compileScope(path), { kind, facets: {} });
    assert.equal(scopeCrumbs(path).length, 1);
  }
});

test("bare q translates to all-kinds browse with the query", () => {
  const { state, dropped } = translate("q=smith");
  assert.equal(state.scope, "");
  assert.equal(state.q, "smith");
  assert.deepEqual(state.facets, {});
  assert.deepEqual(dropped, []);
});

test("type=proposals&status=open_comment → legislation scope + status facet", () => {
  const { state, dropped } = translate("type=proposals&status=open_comment");
  assert.equal(state.scope, "legislation/proposals");
  assert.deepEqual(state.facets, { status: "open_comment" });
  assert.deepEqual(dropped, []);
});

test("type=financial&entity_type=pac&industry=energy → money scope + mapped facets", () => {
  const { state, dropped } = translate("type=financial&entity_type=pac&industry=energy");
  assert.equal(state.scope, "money");
  assert.deepEqual(state.facets, { financial_type: "pac", industry: "energy" });
  assert.deepEqual(dropped, []);
});

test("type=jurisdictions resolves via the kind-direct scope", () => {
  const { state } = translate("type=jurisdictions&jurisdiction_level=state");
  assert.equal(state.scope, "jurisdictions");
  assert.deepEqual(state.facets, { jurisdiction_level: "state" });
  assert.equal(compileScope(state.scope).kind, "jurisdiction");
});

test("officials + congress role deepens scope; facets valid for the kind survive", () => {
  const { state } = translate("type=officials&official_role=congress&party=democrat&chamber=senate&state=WA");
  assert.equal(state.scope, "people/officials/federal/congress");
  assert.deepEqual(state.facets, { party: "democrat", chamber: "senate", state: "WA" });
});

test("unrepresentable params drop and are reported", () => {
  const { state, dropped } = translate(
    "type=officials&official_role=judiciary&industry=energy&date_from=2024-01-01&min_amount=100",
  );
  assert.equal(state.scope, "people/officials");
  assert.deepEqual(state.facets, {});
  assert.equal(dropped.length, 4);
});

test("sort=relevance normalizes to the default; real sorts pass through", () => {
  assert.equal(translate("q=x&sort=relevance").state.sort, "connections_desc");
  assert.equal(translate("q=x&sort=name_asc").state.sort, "name_asc");
});

test("translated state round-trips through parseBrowseState without errors", () => {
  for (const qs of [
    "q=smith",
    "type=proposals&status=open_comment",
    "type=financial&entity_type=pac&industry=energy",
    "type=officials&party=independent&state=VT",
    "type=meetings",
    "type=institutions&jurisdiction_level=state",
  ]) {
    const { state } = translate(qs);
    const sp = new URLSearchParams();
    if (state.scope) sp.set("scope", state.scope);
    if (state.q) sp.set("q", state.q);
    for (const [k, v] of Object.entries(state.facets)) sp.set(`f_${k}`, String(v));
    const parsed = parseBrowseState(sp);
    assert.deepEqual(parsed.errors, [], `errors for ${qs}: ${parsed.errors.join("; ")}`);
  }
});

test("grammar detection: scope/f_* params are new-grammar, legacy set is not", () => {
  assert.ok(isBrowseGrammar(new URLSearchParams("scope=money")));
  assert.ok(isBrowseGrammar(new URLSearchParams("f_party=democrat")));
  assert.ok(!isBrowseGrammar(new URLSearchParams("q=smith&type=officials&party=democrat")));
});
