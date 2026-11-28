/**
 * FIX-1468 (cc-342 G2) — plum-book's name match drops sitting members, links
 * one row or none, and never rewrites a member's `is_active`.
 *
 * Runs via:  tsx --test src/pipelines/plum-book/resolve.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSittingMember, plumLinkUpdate, resolvePlumNameMatch, type PlumNameRow } from "./resolve";

const NOW = "2026-11-28T00:00:00.000Z";

const sitting   = (id: string): PlumNameRow => ({ id, tier: "elected",   is_active: true,  source_ids: { congress_gov: `B${id}` } });
const former    = (id: string): PlumNameRow => ({ id, tier: "former",    is_active: false, source_ids: { congress_gov: `B${id}` } });
const stub      = (id: string): PlumNameRow => ({ id, tier: "candidate", is_active: true,  source_ids: { fec_candidate_id: `H${id}` } });
const appointee = (id: string): PlumNameRow => ({ id, tier: "elected",   is_active: true,  source_ids: null });

test("G2: a sitting member is never linked", () => {
  assert.equal(isSittingMember(sitting("a")), true);
  assert.deepEqual(resolvePlumNameMatch([sitting("a")]), { kind: "none", sitting: ["a"] });
  // Beside one other row, the other row is the link — the member is dropped, not the name.
  assert.deepEqual(resolvePlumNameMatch([sitting("a"), stub("b")]), { kind: "link", row: stub("b") });
  // An inactive member with a bioguide is not sitting, so it stays a candidate.
  const inactive: PlumNameRow = { id: "c", tier: "elected", is_active: false, source_ids: { congress_gov: "Bc" } };
  assert.equal(isSittingMember(inactive), false);
  assert.deepEqual(resolvePlumNameMatch([inactive]), { kind: "link", row: inactive });
});

test("G2: a former member alone is linked, and the row's is_active is not written", () => {
  const m = resolvePlumNameMatch([former("f")]);
  assert.deepEqual(m, { kind: "link", row: former("f") });
  const update = plumLinkUpdate(former("f").source_ids, "usplum-1", true, NOW);
  assert.deepEqual(update, { source_ids: { congress_gov: "Bf", plum_id: "usplum-1" }, updated_at: NOW });
  assert.equal("is_active" in update, false);
});

test("G2: a non-member alone is linked, and is_active follows the appointee", () => {
  assert.deepEqual(resolvePlumNameMatch([appointee("p")]), { kind: "link", row: appointee("p") });
  assert.deepEqual(plumLinkUpdate(null, "usplum-2", true, NOW), {
    source_ids: { plum_id: "usplum-2" }, updated_at: NOW, is_active: true,
  });
  assert.deepEqual(plumLinkUpdate(stub("s").source_ids, "usplum-3", false, NOW), {
    source_ids: { fec_candidate_id: "Hs", plum_id: "usplum-3" }, updated_at: NOW, is_active: false,
  });
});

test("G2: two rows left after the members are dropped → none linked, both named", () => {
  assert.deepEqual(
    resolvePlumNameMatch([stub("y"), sitting("m"), former("x")]),
    { kind: "ambiguous", ids: ["x", "y"] },
  );
  assert.deepEqual(resolvePlumNameMatch([]), { kind: "none", sitting: [] });
  // The same row read twice is one row, not a collision.
  assert.deepEqual(resolvePlumNameMatch([stub("y"), stub("y")]), { kind: "link", row: stub("y") });
});

test("G2: the answer does not depend on the order the rows were read", () => {
  const sets: PlumNameRow[][] = [
    [sitting("a"), stub("b")],
    [stub("b"), former("c"), appointee("d")],
    [sitting("a"), sitting("e")],
    [former("c")],
  ];
  for (const rows of sets) {
    const forward = resolvePlumNameMatch(rows);
    assert.deepEqual(resolvePlumNameMatch([...rows].reverse()), forward);
    assert.deepEqual(resolvePlumNameMatch([...rows.slice(1), rows[0]!]), forward);
  }
});
