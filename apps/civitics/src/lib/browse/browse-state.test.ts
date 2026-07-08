/**
 * FIX-749 — BrowseState URL (de)serialization: round-trip, facet multi-value,
 * sort normalization, and unknown-facet rejection.
 * Runs via:  pnpm --filter @civitics/app-civitics test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrowseState, serializeBrowseState, normalizeSort } from "./browse-state";
import type { BrowseState } from "./types";

function parse(qs: string) {
  return parseBrowseState(new URLSearchParams(qs));
}

test("parses a full BrowseState and resolves the scope kind", () => {
  const { state, kind, errors } = parse(
    "scope=people/officials/federal/congress/senate&q=warren&sort=name_asc&f_party=democrat",
  );
  assert.deepEqual(errors, []);
  assert.equal(kind, "official");
  assert.equal(state.q, "warren");
  assert.equal(state.sort, "name_asc");
  assert.deepEqual(state.facets, { party: "democrat" });
});

test("multi-value facet params collapse to an array", () => {
  const { state } = parse("scope=money&f_financial_type=pac&f_financial_type=super_pac");
  assert.deepEqual(state.facets, { financial_type: ["pac", "super_pac"] });
});

test("sort normalization: relevance + unknown → default (connections_desc)", () => {
  assert.equal(normalizeSort("relevance"), "connections_desc");
  assert.equal(normalizeSort("wat"), "connections_desc");
  assert.equal(normalizeSort(null), "connections_desc");
  assert.equal(normalizeSort("amount_desc"), "amount_desc");
});

test("unknown facet key for the scope kind → error", () => {
  const { errors } = parse("scope=people&f_industry=tech"); // industry is financial-only
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /Unknown facet key/);
});

test("unknown scope segment → error", () => {
  const { errors } = parse("scope=people/officials/martians");
  assert.equal(errors.length >= 1, true);
  assert.match(errors[0] ?? "", /Unknown scope segment/);
});

test("serialize → parse round-trips (default sort omitted)", () => {
  const state: BrowseState = {
    scope: "money/super-pacs",
    facets: { financial_type: "super_pac", industry: ["oil_gas", "defense"] },
    q: "leadership",
    sort: "amount_desc",
    cursor: "abc123",
  };
  const sp = serializeBrowseState(state);
  const back = parseBrowseState(sp).state;
  assert.deepEqual(back, state);

  // default sort is not serialized (clean URLs) but re-parses to the default.
  const dflt: BrowseState = { scope: "money", facets: {}, q: "", sort: "connections_desc", cursor: null };
  assert.equal(serializeBrowseState(dflt).has("sort"), false);
  assert.deepEqual(parseBrowseState(serializeBrowseState(dflt)).state, dflt);
});
