/**
 * FIX-1196 — the promotion's bound-identity guard.
 *
 * Runs via:  tsx --test src/pipelines/congress/promote-candidates.test.ts
 *
 * Pins `selectPromotionPairs` without a database. The load-bearing assertion is
 * the pair of cases in the first two tests: ONE elected row, ONE same-key
 * candidate, and the ONLY difference between "promoted" and "refused" is
 * whether the elected row already holds `source_ids.fec_candidate_id`.
 *
 * That is the exact shape a shared-CAND_ID merge manufactures. The merge
 * retires the stubs around a sitting member, dropping their same-key candidate
 * count to one, which UNBLOCKS the FIX-248 ambiguity guard — and the FIX-248
 * promotion then deletes the merge's own survivor. It deleted three of set 1's
 * survivors on prod on 2026-09-17 (Harris, Marshall, Menendez).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectPromotionPairs,
  type ElectedInput,
  type CandidateInput,
} from "./promote-candidates";

function elected(over: Partial<ElectedInput> = {}): ElectedInput {
  return {
    id:               "elected-1",
    full_name:        "Roger Marshall",
    role_title:       "Senator",
    state_short:      "KS",
    fec_candidate_id: null,
    ...over,
  };
}

function candidate(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    id:         "cand-1",
    full_name:  "Roger Marshall",
    role_title: "Candidate for Senator",
    state:      "KS",
    ...over,
  };
}

test("unbound elected row with exactly one same-key candidate IS paired", () => {
  const sel = selectPromotionPairs([elected()], [candidate()]);
  assert.equal(sel.pairs.length, 1);
  assert.equal(sel.pairs[0]!.electedId, "elected-1");
  assert.equal(sel.pairs[0]!.candidateId, "cand-1");
  assert.equal(sel.skippedBound, 0);
});

test("FIX-1196: the SAME row holding fec_candidate_id is NOT paired", () => {
  // Identical inputs to the test above but for the one key. The lone same-key
  // candidate is still there — the ambiguity guard would pass — and the row is
  // refused anyway, because it is already FEC-bound.
  const sel = selectPromotionPairs(
    [elected({ fec_candidate_id: "H6KS01179" })],
    [candidate()],
  );
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.skippedBound, 1);
});

test("FIX-1196: the guard runs BEFORE indexing — a bound row with NO candidate still counts", () => {
  const sel = selectPromotionPairs([elected({ fec_candidate_id: "S0KS00315" })], []);
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.skippedBound, 1);
});

test("FIX-1196: an empty-string fec_candidate_id is not a binding", () => {
  // `source_ids->>'fec_candidate_id'` can only be absent or a value; a row that
  // somehow carries "" is unbound, and must stay promotable rather than be
  // silently parked forever.
  const sel = selectPromotionPairs([elected({ fec_candidate_id: "" })], [candidate()]);
  assert.equal(sel.pairs.length, 1);
  assert.equal(sel.skippedBound, 0);
});

test("the FIX-248 ambiguity guard still refuses two same-key candidates", () => {
  const sel = selectPromotionPairs(
    [elected()],
    [candidate({ id: "cand-1" }), candidate({ id: "cand-2" })],
  );
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.skippedBound, 0); // refused by ambiguity, not by the binding
});

test("the guard is per-row: a bound row is skipped, an unbound sibling still promotes", () => {
  const sel = selectPromotionPairs(
    [
      elected({ id: "bound",   full_name: "Roger Marshall", fec_candidate_id: "H6KS01179" }),
      elected({ id: "unbound", full_name: "Mark Harris", role_title: "Representative", state_short: "NC" }),
    ],
    [
      candidate({ id: "cand-marshall" }),
      candidate({ id: "cand-harris", full_name: "Mark Harris", role_title: "Candidate for Representative", state: "NC" }),
    ],
  );
  assert.equal(sel.skippedBound, 1);
  assert.equal(sel.pairs.length, 1);
  assert.equal(sel.pairs[0]!.electedId, "unbound");
  assert.equal(sel.pairs[0]!.candidateId, "cand-harris");
});

test("state and role family still gate the match", () => {
  // Same name, wrong state → no pair. Same name, wrong family → no pair.
  assert.deepEqual(
    selectPromotionPairs([elected()], [candidate({ state: "MO" })]).pairs,
    [],
  );
  assert.deepEqual(
    selectPromotionPairs(
      [elected()],
      [candidate({ role_title: "Candidate for Representative" })],
    ).pairs,
    [],
  );
});
