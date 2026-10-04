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
import type { Listing } from "./legislator-ids";

function elected(over: Partial<ElectedInput> = {}): ElectedInput {
  return {
    id:               "elected-1",
    full_name:        "Roger Marshall",
    role_title:       "Senator",
    state_short:      "KS",
    fec_candidate_id: null,
    bioguide:         null,
    ...over,
  };
}

function candidate(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    id:         "cand-1",
    full_name:  "Roger Marshall",
    role_title: "Candidate for Senator",
    state:      "KS",
    fec_candidate_id: null,
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

// ───────────────────────────────────────────────────────────────────────────
// FIX-1189 — pass 2, the congress-legislators dataset key.
//
// One fixture per shape of cc-186 §7 Table E1, with the real names and ids.
// Each shape is asserted three ways: the name key alone misses it (the
// defect); the dataset key pairs it; and its wrong-but-green twin (rule 105) —
// the same rows with the stub holding an id the dataset does NOT list for the
// member — pairs nothing, which is what proves the key is the id, not the name.
// ───────────────────────────────────────────────────────────────────────────

function listingOf(...ls: Listing[]): Map<string, Listing> {
  return new Map(ls.map((l) => [l.bioguide, l]));
}

function repListing(bioguide: string, name: string, fec: string[], state: string, district: number): Listing {
  return { bioguide, name, fec, currentType: "rep", state, district };
}

interface Shape {
  label:    string;
  elected:  ElectedInput;
  stub:     CandidateInput;
  listing:  Listing;
  /** An id this member's listing does not carry, for the twin. */
  unlisted: string;
}

const SHAPES: Shape[] = [
  {
    label: "accent (Barragán)",
    elected: elected({ id: "e-barragan", full_name: "Nanette Diaz Barragán", role_title: "Representative", state_short: "CA", bioguide: "B001300" }),
    stub: candidate({ id: "s-barragan", full_name: "Nanette Barragan", role_title: "Candidate for Representative", state: "CA", fec_candidate_id: "H6CA44103" }),
    listing: repListing("B001300", "Nanette Diaz Barragán", ["H6CA44103"], "CA", 44),
    unlisted: "H6CA44999",
  },
  {
    label: "middle name + accent (Luján, Senate)",
    elected: elected({ id: "e-lujan", full_name: "Ben Ray Luján", role_title: "Senator", state_short: "NM", bioguide: "L000570" }),
    stub: candidate({ id: "s-lujan-s", full_name: "Ben Lujan", role_title: "Candidate for Senator", state: "NM", fec_candidate_id: "S0NM00058" }),
    listing: { bioguide: "L000570", name: "Ben Ray Luján", fec: ["H8NM03196", "S0NM00058"], currentType: "sen", state: "NM", district: null },
    unlisted: "S0NM00999",
  },
  {
    label: "compound surname (McClain Delaney)",
    elected: elected({ id: "e-mcclain", full_name: "April McClain Delaney", role_title: "Representative", state_short: "MD", bioguide: "M001232" }),
    stub: candidate({ id: "s-mcclain", full_name: "April Delaney", role_title: "Candidate for Representative", state: "MD", fec_candidate_id: "H4MD06340" }),
    listing: repListing("M001232", "April McClain Delaney", ["H4MD06340"], "MD", 6),
    unlisted: "H4MD06999",
  },
  {
    label: "a different surname string (Hinson / Arenholz)",
    elected: elected({ id: "e-hinson", full_name: "Ashley Hinson", role_title: "Representative", state_short: "IA", bioguide: "H001091" }),
    stub: candidate({ id: "s-hinson", full_name: "Ashley Arenholz", role_title: "Candidate for Representative", state: "IA", fec_candidate_id: "H0IA01174" }),
    listing: repListing("H001091", "Ashley Hinson", ["H0IA01174"], "IA", 2),
    unlisted: "H0IA02999",
  },
  {
    label: "legal first name (Austin / James Scott)",
    elected: elected({ id: "e-scott", full_name: "Austin Scott", role_title: "Representative", state_short: "GA", bioguide: "S001189" }),
    stub: candidate({ id: "s-scott", full_name: "James Scott", role_title: "Candidate for Representative", state: "GA", fec_candidate_id: "H0GA08099" }),
    listing: repListing("S001189", "Austin Scott", ["H0GA08099"], "GA", 8),
    unlisted: "H0GA08999",
  },
  {
    label: "a different-seat id on the stub (Velázquez: H2NY00010 encodes NY-00, she sits for NY-7)",
    elected: elected({ id: "e-velazquez", full_name: "Nydia M. Velázquez", role_title: "Representative", state_short: "NY", bioguide: "V000081" }),
    stub: candidate({ id: "s-velazquez", full_name: "Nydia Velazquez", role_title: "Candidate for Representative", state: "NY", fec_candidate_id: "H2NY00010" }),
    listing: repListing("V000081", "Nydia M. Velázquez", ["H2NY00010"], "NY", 7),
    unlisted: "H2NY07999",
  },
];

for (const s of SHAPES) {
  test(`FIX-1189 ${s.label}: the name key alone misses it`, () => {
    assert.deepEqual(selectPromotionPairs([s.elected], [s.stub]).pairs, []);
  });

  test(`FIX-1189 ${s.label}: the dataset key pairs it`, () => {
    const sel = selectPromotionPairs([s.elected], [s.stub], listingOf(s.listing));
    assert.equal(sel.pairs.length, 1);
    assert.equal(sel.pairs[0]!.electedId, s.elected.id);
    assert.equal(sel.pairs[0]!.candidateId, s.stub.id);
    assert.equal(sel.pairs[0]!.reason, "dataset_key");
    assert.equal(sel.by_dataset_key, 1);
    assert.equal(sel.by_name, 0);
    assert.equal(sel.conflict, 0);
  });

  test(`FIX-1189 ${s.label}: twin — the stub holds an id the dataset does not list → no pair`, () => {
    const sel = selectPromotionPairs([s.elected], [{ ...s.stub, fec_candidate_id: s.unlisted }], listingOf(s.listing));
    assert.deepEqual(sel.pairs, []);
    assert.equal(sel.dataset_no_stub, 1);
  });
}

const LUJAN = SHAPES[1]!;
const LUJAN_H_STUB = candidate({
  id: "s-lujan-h", full_name: "Ben Lujan", role_title: "Candidate for Representative", state: "NM", fec_candidate_id: "H8NM03196",
});

test("FIX-1189 two stubs: Luján's Senate stub (current) is paired, his House stub (prior office) is counted, never paired", () => {
  const sel = selectPromotionPairs([LUJAN.elected], [LUJAN.stub, LUJAN_H_STUB], listingOf(LUJAN.listing));
  assert.equal(sel.pairs.length, 1);
  assert.equal(sel.pairs[0]!.candidateId, "s-lujan-s");
  assert.equal(sel.prior_office_stub, 1);
});

test("FIX-1189 two stubs, twin: with ONLY the prior-office stub there is no pair", () => {
  const sel = selectPromotionPairs([LUJAN.elected], [LUJAN_H_STUB], listingOf(LUJAN.listing));
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.prior_office_stub, 1);
  assert.equal(sel.dataset_no_stub, 1);
});

const CISNEROS_LISTING = repListing("C001123", "Gilbert Ray Cisneros", ["H4CA31170", "H8CA39174"], "CA", 31);
const CISNEROS_STUB = candidate({
  id: "s-cisneros", full_name: "Gilbert Cisneros", role_title: "Candidate for Representative", state: "CA", fec_candidate_id: "H4CA31170",
});
const CISNEROS = elected({
  id: "e-cisneros", full_name: "Gilbert Ray Cisneros", role_title: "Representative", state_short: "CA", bioguide: "C001123",
});

test("FIX-1189 Cisneros: an elected row holding a DIFFERENT live id is never an input, though its current id sits on a stub", () => {
  const sel = selectPromotionPairs([{ ...CISNEROS, fec_candidate_id: "H8CA39174" }], [CISNEROS_STUB], listingOf(CISNEROS_LISTING));
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.skippedBound, 1);
  assert.equal(sel.by_dataset_key, 0);
  assert.equal(sel.dataset_no_stub, 0, "a bound row is not looked at by pass 2 at all");
});

test("FIX-1189 Cisneros, twin: the SAME row unbound IS paired — the FIX-1196 guard is what refuses it", () => {
  const sel = selectPromotionPairs([CISNEROS], [CISNEROS_STUB], listingOf(CISNEROS_LISTING));
  assert.equal(sel.pairs.length, 1);
  assert.equal(sel.skippedBound, 0);
});

const HINSON = SHAPES[3]!;

test("FIX-1189 ambiguous: two stubs hold the member's current id → dataset_ambiguous, no pair", () => {
  const sel = selectPromotionPairs([HINSON.elected], [HINSON.stub, { ...HINSON.stub, id: "s-hinson-2" }], listingOf(HINSON.listing));
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.dataset_ambiguous, 1);
});

const SELF_ELECTED = elected({ id: "e-self", full_name: "Keith Self", role_title: "Representative", state_short: "TX", bioguide: "S001224" });
const SELF_LISTING = repListing("S001224", "Keith Self", ["H2TX03290", "H2TX00064"], "TX", 3);
const SELF_NAME_STUB = candidate({ id: "s-self-name", full_name: "Keith Self", role_title: "Candidate for Representative", state: "TX", fec_candidate_id: "H2TX99999" });
const SELF_ID_STUB = candidate({ id: "s-self-id", full_name: "K Self", role_title: "Candidate for Representative", state: "TX", fec_candidate_id: "H2TX03290" });

test("FIX-1189 conflict: the name key and the dataset key name DIFFERENT stubs → no pair at all", () => {
  const sel = selectPromotionPairs([SELF_ELECTED], [SELF_NAME_STUB, SELF_ID_STUB], listingOf(SELF_LISTING));
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.conflict, 1);
});

test("FIX-1189 conflict, twin: without the listing the name-key pair exists — it is what the conflict dropped", () => {
  const sel = selectPromotionPairs([SELF_ELECTED], [SELF_NAME_STUB, SELF_ID_STUB]);
  assert.equal(sel.pairs.length, 1);
  assert.equal(sel.pairs[0]!.candidateId, "s-self-name");
  assert.equal(sel.pairs[0]!.reason, "name_key");
});

test("FIX-1189 conflict: a name-key stub the dataset calls a PRIOR office is not paired", () => {
  const priorStub = { ...SELF_NAME_STUB, fec_candidate_id: "H2TX00064" };
  const sel = selectPromotionPairs([SELF_ELECTED], [priorStub], listingOf(SELF_LISTING));
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.conflict, 1);
  assert.equal(sel.prior_office_stub, 1);
  // twin: pass 1 alone would have promoted the prior-office stub into the member's row
  assert.equal(selectPromotionPairs([SELF_ELECTED], [priorStub]).pairs.length, 1);
});

test("FIX-1189 one stub claimed for two members (dataset key for one, name key for the other) → neither is paired", () => {
  const other = elected({ id: "e-other", full_name: "K Self", role_title: "Representative", state_short: "TX", bioguide: "X000001" });
  const sel = selectPromotionPairs([SELF_ELECTED, other], [SELF_ID_STUB], listingOf(SELF_LISTING));
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.conflict, 2);
  // twin: without the listing the other row's name-key pair stands
  const p1 = selectPromotionPairs([SELF_ELECTED, other], [SELF_ID_STUB]);
  assert.equal(p1.pairs.length, 1);
  assert.equal(p1.pairs[0]!.electedId, "e-other");
});

test("FIX-1189 agreement: a row both keys pair with the SAME stub is one name_key pair, counted once", () => {
  const sel = selectPromotionPairs(
    [elected({ bioguide: "M001198" })],
    [candidate({ fec_candidate_id: "S0KS00315" })],
    listingOf({ bioguide: "M001198", name: "Roger Marshall", fec: ["S0KS00315"], currentType: "sen", state: "KS", district: null }),
  );
  assert.equal(sel.pairs.length, 1);
  assert.equal(sel.pairs[0]!.reason, "name_key");
  assert.equal(sel.by_name, 1);
  assert.equal(sel.by_dataset_key, 0);
});

test("FIX-1189 family mismatch: the stub's office is not the elected row's → no pair (twin: the shape test above)", () => {
  const sel = selectPromotionPairs([{ ...LUJAN.elected, role_title: "Representative" }], [LUJAN.stub], listingOf(LUJAN.listing));
  assert.deepEqual(sel.pairs, []);
  assert.equal(sel.family_mismatch, 1);
});

test("FIX-1189 a CORRECT row produces no pair: bound to its current id (guard), or unbound with no stub (dataset_no_stub)", () => {
  const bound = selectPromotionPairs([{ ...HINSON.elected, fec_candidate_id: "H0IA01174" }], [], listingOf(HINSON.listing));
  assert.deepEqual(bound.pairs, []);
  assert.equal(bound.skippedBound, 1);
  const unbound = selectPromotionPairs([HINSON.elected], [], listingOf(HINSON.listing));
  assert.deepEqual(unbound.pairs, []);
  assert.equal(unbound.dataset_no_stub, 1);
});

test("FIX-1189 listing absent → pass 1 exactly: the name-key pair only, every dataset counter 0", () => {
  const sel = selectPromotionPairs(
    [...SHAPES.map((s) => s.elected), elected()],
    [...SHAPES.map((s) => s.stub), candidate()],
  );
  assert.equal(sel.pairs.length, 1);
  assert.equal(sel.pairs[0]!.electedId, "elected-1");
  assert.equal(sel.pairs[0]!.reason, "name_key");
  assert.equal(sel.by_name, 1);
  for (const k of ["by_dataset_key", "dataset_no_stub", "dataset_ambiguous", "prior_office_stub", "family_mismatch", "conflict"] as const) {
    assert.equal(sel[k], 0, k);
  }
});

test("FIX-1189 the shapes together: every one pairs in one run, in elected-row order", () => {
  const sel = selectPromotionPairs(
    SHAPES.map((s) => s.elected),
    [...SHAPES.map((s) => s.stub), LUJAN_H_STUB],
    listingOf(...SHAPES.map((s) => s.listing)),
  );
  assert.deepEqual(sel.pairs.map((p) => p.candidateId), SHAPES.map((s) => s.stub.id));
  assert.equal(sel.by_dataset_key, SHAPES.length);
  assert.equal(sel.prior_office_stub, 1);
});
