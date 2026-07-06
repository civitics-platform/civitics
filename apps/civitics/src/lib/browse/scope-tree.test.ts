/**
 * FIX-749 — scope-tree compiler: path → { kind, facets }, override semantics,
 * full-tree round-trip, and unknown-segment rejection.
 * Runs via:  pnpm --filter @civitics/app-civitics test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileScope, allScopePaths, scopeSegments, UnknownScopeError,
} from "./scope-tree";

test("empty / all scope compiles to all-kinds", () => {
  assert.deepEqual(compileScope(""), { kind: null, facets: {} });
  assert.deepEqual(compileScope("all"), { kind: null, facets: {} });
  assert.deepEqual(scopeSegments("/people/officials/"), ["people", "officials"]);
});

test("root scopes resolve to a single kind", () => {
  assert.equal(compileScope("people").kind, "official");
  assert.equal(compileScope("money").kind, "financial");
  assert.equal(compileScope("government").kind, "agency");
  assert.equal(compileScope("legislation").kind, "proposal");
  assert.equal(compileScope("initiatives").kind, "initiative");
});

test("facets accumulate down the path; deeper overrides shallower", () => {
  const congress = compileScope("people/officials/federal/congress");
  assert.equal(congress.kind, "official");
  assert.equal(congress.facets.jurisdiction_level, "federal");
  assert.deepEqual(congress.facets.chamber, ["senate", "house"]); // congress = both chambers

  const senate = compileScope("people/officials/federal/congress/senate");
  assert.equal(senate.facets.chamber, "senate"); // overrides the [senate,house] contribution

  const senateDems = compileScope("people/officials/federal/congress/senate/democrat");
  assert.equal(senateDems.facets.chamber, "senate");
  assert.equal(senateDems.facets.party, "democrat");
  assert.equal(senateDems.facets.jurisdiction_level, "federal");
});

test("money / government / legislation / initiatives leaf facets", () => {
  assert.equal(compileScope("money/super-pacs").facets.financial_type, "super_pac");
  assert.equal(compileScope("government/agencies/independent").facets.agency_type, "independent");
  assert.equal(compileScope("legislation/proposals/regulations").facets.proposal_type, "regulation");
  assert.equal(compileScope("legislation/proposals/open-comment").facets.status, "open_comment");
  assert.deepEqual(compileScope("initiatives/active").facets.initiative_stage, ["deliberate", "mobilise", "draft"]);
});

test("every enumerated tree path compiles without throwing (round-trip)", () => {
  const paths = allScopePaths();
  assert.ok(paths.length > 10, "expected a non-trivial tree");
  for (const p of paths) {
    const compiled = compileScope(p);
    assert.ok(compiled.kind !== null, `path ${p} should resolve to a kind`);
  }
});

test("unknown segment throws UnknownScopeError", () => {
  assert.throws(() => compileScope("people/officials/martians"), UnknownScopeError);
  assert.throws(() => compileScope("banana"), UnknownScopeError);
});
