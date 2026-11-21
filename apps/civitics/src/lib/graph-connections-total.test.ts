/**
 * FIX-1434 — /api/graph/connections' default view reads an estimated total.
 *
 * The default view (no `entityId`) ran an exact count HEAD over
 * entity_connections (~6.9M rows) on every uncached request; cold, it outran
 * withDbTimeout's 5 s and the route returned 500 (cc-295 contradiction 7 (a)).
 * Pinned on the route's source: the default-view branch asks PostgREST for an
 * `estimated` count, no exact count remains anywhere in the route, a failed
 * count is logged rather than thrown, and the estimate does not decide that
 * the graph is empty.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(join(__dirname, "..", "..", "app", "api", "graph", "connections", "route.ts"), "utf8");

// The default-view branch: from its banner to the top-10 read.
const start = ROUTE.indexOf("// ── Default view");
const end = ROUTE.indexOf("get_top_connected_officials", start);
const DEFAULT_VIEW = ROUTE.slice(start, end);

test("FIX-1434: the default-view branch is where the scan says it is", () => {
  assert.ok(start !== -1 && end > start, "default-view banner and top-10 read found");
});

test("FIX-1434: the default view's total over entity_connections is an estimated count", () => {
  assert.match(
    DEFAULT_VIEW,
    /\.from\("entity_connections"\)\s*\.select\("\*",\s*\{\s*count:\s*"estimated",\s*head:\s*true\s*\}\)/,
  );
});

test("FIX-1434: no exact count remains in the route", () => {
  assert.doesNotMatch(ROUTE, /count:\s*"exact"/);
});

test("FIX-1434: a failed count does not fail the view", () => {
  assert.doesNotMatch(DEFAULT_VIEW, /throw\s+countErr/);
  assert.match(DEFAULT_VIEW, /if \(countErr\) \{[^}]*console\.warn\([^}]*totalCount = undefined;/);
});

test("FIX-1434: the estimate does not decide emptiness", () => {
  assert.doesNotMatch(ROUTE, /totalCount === 0/);
  assert.match(ROUTE, /if \(top10Ids\.length === 0\) \{/);
});
