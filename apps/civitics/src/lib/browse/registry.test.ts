/**
 * FIX-749 — entity-kind registry: facet-key validation, sort menus, graph-
 * seedability, and back-compat with the absorbed graph-seedable-kinds data.
 * Runs via:  pnpm --filter @civitics/app-civitics test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSE_REGISTRY, isBrowseKind, isValidFacetKey, facetKeysFor, sortsFor,
  ledgerColumnsFor, validateFacets, GRAPH_SEEDABLE_KINDS, isGraphSeedableKind,
  GB_EXPANDABLE_JURISDICTION_TYPES, isGbExpandableJurisdictionType,
} from "./registry";
import { BROWSE_KINDS } from "./types";

// The facet columns physically present on entity_search_index (FIX-748). Every
// registry facet key MUST be one of these (key === index column, decision 5).
const INDEX_FACET_COLUMNS = new Set([
  "jurisdiction_level", "state", "party", "chamber", "status", "proposal_type",
  "agency_type", "financial_type", "industry", "initiative_stage", "institution_type",
]);

test("every kind has a registry entry with facets + sorts + ledger", () => {
  for (const k of BROWSE_KINDS) {
    const def = BROWSE_REGISTRY[k];
    assert.ok(def, `missing registry entry for ${k}`);
    assert.equal(def.kind, k);
    assert.ok(sortsFor(k).length > 0, `${k} has no sorts`);
    assert.ok(ledgerColumnsFor(k).length >= 4, `${k} ledger too small`);
  }
});

test("every registry facet key maps to a real index column", () => {
  for (const k of BROWSE_KINDS) {
    for (const key of facetKeysFor(k)) {
      assert.ok(INDEX_FACET_COLUMNS.has(key), `${k}.${key} is not an index column`);
    }
  }
});

test("isValidFacetKey + isBrowseKind", () => {
  assert.equal(isBrowseKind("official"), true);
  assert.equal(isBrowseKind("nope"), false);
  assert.equal(isValidFacetKey("official", "party"), true);
  assert.equal(isValidFacetKey("official", "industry"), false); // financial-only
  assert.equal(isValidFacetKey("financial", "industry"), true);
});

test("validateFacets flags unknown keys for a kind, accepts any-kind keys when kind is null", () => {
  assert.deepEqual(validateFacets("official", { party: "democrat" }), { ok: true, unknownKeys: [] });
  const bad = validateFacets("official", { industry: "tech" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknownKeys, ["industry"]);
  // null kind (all-kinds scope): a key valid for SOME kind passes.
  assert.equal(validateFacets(null, { industry: "tech", party: "democrat" }).ok, true);
  assert.deepEqual(validateFacets(null, { not_a_facet: "x" }).unknownKeys, ["not_a_facet"]);
});

test("graphSeedable mirrors GRAPH_SEEDABLE_KINDS", () => {
  for (const k of BROWSE_KINDS) {
    assert.equal(BROWSE_REGISTRY[k].graphSeedable, isGraphSeedableKind(k), `graphSeedable mismatch for ${k}`);
  }
  assert.deepEqual([...GRAPH_SEEDABLE_KINDS], ["official", "agency", "proposal", "financial", "institution"]);
});

test("back-compat gb-expansion guard preserved", () => {
  assert.deepEqual(
    [...GB_EXPANDABLE_JURISDICTION_TYPES],
    ["country", "state", "federal_district", "unincorporated_territory"],
  );
  assert.equal(isGbExpandableJurisdictionType("state"), true);
  assert.equal(isGbExpandableJurisdictionType("city"), false); // roster pollution — excluded
  assert.equal(isGbExpandableJurisdictionType(null), false);
});
