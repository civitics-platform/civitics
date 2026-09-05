/**
 * FIX-956 — the retired-claim marker is multi-valued, and readers accept both
 * shapes.
 *
 * WHY. FIX-933 neutralises a same-person duplicate by retiring the stub's
 * `fec_candidate_id`. The original marker was a SCALAR, so it could hold
 * exactly one retired id — which is wrong for anyone who has run for two
 * different federal seats. Jim Banks, Ted Budd and Tom Cotton each retired a
 * SENATE id and later had a HOUSE id stolen; retiring the second one overwrote
 * the first, un-retiring it, and the pipeline re-bound it on the next pass.
 * That trio is the shape this test pins.
 *
 * The transition is deliberately backward-compatible: writers emit
 * `merged_fec_candidate_ids` (array), readers accept that OR the legacy
 * `merged_fec_candidate_id` (scalar), and both may coexist on one row while
 * prod's 86 legacy rows wait for their data pass.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/retired-claim.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retiredClaims,
  hasRetiredClaim,
  hasAnyRetiredClaim,
  type OfficialRecord,
} from "./index";

function official(sourceIds: Record<string, unknown>): OfficialRecord {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    full_name: "Test Person",
    last_name: "Person",
    first_name: "Test",
    role_title: "Representative",
    state: "IN",
    tier: "candidate",
    source_ids: sourceIds as Record<string, string>,
  } as unknown as OfficialRecord;
}

test("FIX-955 shape: a stub carrying only the legacy SCALAR is still refused", () => {
  const o = official({ merged_fec_candidate_id: "S4IN00196" });
  assert.deepEqual(retiredClaims(o), ["S4IN00196"]);
  assert.equal(hasRetiredClaim(o, "S4IN00196"), true);
  assert.equal(hasRetiredClaim(o, "H8IN03159"), false);
  assert.equal(hasAnyRetiredClaim(o), true);
});

test("FIX-956 shape: a stub carrying the ARRAY is refused the same way", () => {
  const o = official({ merged_fec_candidate_ids: ["S4IN00196"] });
  assert.deepEqual(retiredClaims(o), ["S4IN00196"]);
  assert.equal(hasRetiredClaim(o, "S4IN00196"), true);
  assert.equal(hasRetiredClaim(o, "H8IN03159"), false);
  assert.equal(hasAnyRetiredClaim(o), true);
});

test("FIX-956 transition: BOTH keys on one row, neither claim is lost", () => {
  const o = official({
    merged_fec_candidate_ids: ["H8IN03159"],
    merged_fec_candidate_id:  "S4IN00196",
  });
  assert.deepEqual(retiredClaims(o).sort(), ["H8IN03159", "S4IN00196"]);
  assert.equal(hasRetiredClaim(o, "H8IN03159"), true);
  assert.equal(hasRetiredClaim(o, "S4IN00196"), true);
  assert.equal(hasAnyRetiredClaim(o), true);
});

test("FIX-956: the Banks shape — TWO retired ids, which the scalar cannot express", () => {
  const o = official({ merged_fec_candidate_ids: ["S4IN00196", "H8IN03159"] });
  assert.deepEqual(retiredClaims(o), ["S4IN00196", "H8IN03159"]);
  // Both are refused. Under the scalar marker the second write clobbered the
  // first and the pipeline re-bound whichever id lost.
  assert.equal(hasRetiredClaim(o, "S4IN00196"), true);
  assert.equal(hasRetiredClaim(o, "H8IN03159"), true);
});

test("FIX-956: the scalar is not duplicated when it also appears in the array", () => {
  const o = official({
    merged_fec_candidate_ids: ["S4IN00196"],
    merged_fec_candidate_id:  "S4IN00196",
  });
  assert.deepEqual(retiredClaims(o), ["S4IN00196"]);
});

test("FIX-956: a row with no marker retires nothing", () => {
  const o = official({ fec_candidate_id: "H8IN03159" });
  assert.deepEqual(retiredClaims(o), []);
  assert.equal(hasAnyRetiredClaim(o), false);
  assert.equal(hasRetiredClaim(o, "H8IN03159"), false);
});

test("FIX-956: malformed marker values are ignored, never crash", () => {
  for (const bad of [null, 42, {}, "", [], [null, 7, ""], { a: 1 }]) {
    const o = official({ merged_fec_candidate_ids: bad });
    assert.deepEqual(retiredClaims(o), [], JSON.stringify(bad));
    assert.equal(hasAnyRetiredClaim(o), false);
  }
  // A non-string scalar is likewise not a claim.
  assert.deepEqual(retiredClaims(official({ merged_fec_candidate_id: 42 })), []);
});
