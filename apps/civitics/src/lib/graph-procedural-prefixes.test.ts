/**
 * FIX-1409 (D8) — /api/graph/connections' procedural filter, anchored by source.
 *
 * The filter drops a vote edge whose every roll's question starts with one of
 * PROCEDURAL_PREFIXES. Its predicate is a closure inside a non-exported
 * function of a route file (a route may export only its handlers), so the LIST
 * is what is pinned, against passage-questions.json: no question of the
 * vote-edge rule's `final` tier (house, senate, nomination, veto_override) may
 * read as procedural under the route's own rule, `q.toLowerCase().startsWith(p)`.
 * Before FIX-1409 three Senate passage questions sat in the list. The filter
 * itself stays until prod runs the new rule (a later prompt removes it).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..", "..");
const ROUTE = readFileSync(join(__dirname, "..", "..", "app", "api", "graph", "connections", "route.ts"), "utf8");
const PQ = JSON.parse(
  readFileSync(join(REPO, "packages", "data", "src", "pipelines", "congress", "passage-questions.json"), "utf8"),
) as Record<"house" | "senate" | "nomination" | "veto_override" | "advance", string[]>;

function prefixes(): string[] {
  const m = ROUTE.match(/const PROCEDURAL_PREFIXES = \[([\s\S]*?)\];/);
  assert.ok(m, "PROCEDURAL_PREFIXES not found");
  return [...(m[1] as string).matchAll(/^\s*"([^"]+)",/gm)].map((x) => x[1] as string);
}

/** The route's predicate, as it reads: lowercased, then startsWith. */
const procedural = (q: string) => prefixes().some((p) => q.toLowerCase().startsWith(p));

test("FIX-1409 D8: no final-tier question of passage-questions.json reads as procedural", () => {
  const finals = [...PQ.house, ...PQ.senate, ...PQ.nomination, ...PQ.veto_override];
  assert.ok(finals.length > 25);
  for (const q of finals) assert.equal(procedural(q), false, q);
  // The census's casing (cc-283 read 4).
  for (const q of ["On the Conference Report", "On the Joint Resolution", "On the Resolution", "On the Concurrent Resolution"]) {
    assert.equal(procedural(q), false, q);
  }
});

test("FIX-1409 D8: the three passage strings left; the rest of the list is as it was", () => {
  assert.deepEqual(prefixes(), [
    "on the cloture motion",
    "on the motion to proceed",
    "on the motion to table",
    "on the motion to recommit",
    "on ordering the previous question",
    "on agreeing to the amendment",
    "on the amendment",
    "on the motion",
  ]);
  for (const q of ["On the Cloture Motion", "On the Motion to Proceed", "On Agreeing to the Amendment", "On the Amendment", "On the Motion"]) {
    assert.equal(procedural(q), true, q);
  }
  assert.match(ROUTE, /\/\/ FIX-1409: packages\/data\/src\/pipelines\/congress\/passage-questions\.json is the list of passage questions/);
});
