/**
 * FIX-1189 O2 — the congress-legislators id.fec[] conflict table.
 *
 * Runs via:  tsx --test src/pipelines/congress/legislator-ids.test.ts
 *
 * One fixture per class of design §4, plus the classes the tree added
 * (prior_incomplete, dataset_lag, ambiguous_current), plus rule 105's
 * wrong-but-green shapes: a row that is already CORRECT classifies `noop`, and
 * a row whose only difference is the ORDER of `prior_fec_candidate_ids`
 * classifies `noop`. The partition test is rule 116: the classes cover the
 * population exactly once and every dataset member is matched or unmatched,
 * never both, never neither.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BINDING_ACTIONS,
  buildClaimsMap,
  buildReport,
  bindingRowFromSourceIds,
  classifyBinding,
  currentFecId,
  parseLegislators,
  planBinding,
  planBindings,
  reconcileReport,
  REPORT_LIST_CAP,
  type BindingRow,
  type BindingWrite,
  type ClaimsMap,
  type Listing,
  type PopulationRow,
} from "./legislator-ids";

// A House→Senate member (the FIX-1187 set-2 shape): H id from the House years,
// S id for the seat held now. The ids are the design note's §2 EXAMPLE, not
// Moran's real ones (the dataset lists H6KS01096 / S0KS00091 for him).
const MORAN: Listing = {
  bioguide: "M000934",
  name: "Jerry Moran",
  fec: ["H6KS01179", "S0KS00315"],
  currentType: "sen",
  state: "KS",
  district: null,
};

// A single-id Representative.
const REP: Listing = {
  bioguide: "R000001",
  name: "Rep One",
  fec: ["H0CA12345"],
  currentType: "rep",
  state: "CA",
  district: 12,
};

// Redistricted: two FL-11 ids, now sits for FL-14. No id agrees with the term.
const CASTOR: Listing = {
  bioguide: "C001066",
  name: "Kathy Castor",
  fec: ["H6FL11126", "H6FL11134"],
  currentType: "rep",
  state: "FL",
  district: 14,
};

function row(over: Partial<BindingRow> & { official_id?: string }): BindingRow {
  return {
    official_id: over.official_id ?? "00000000-0000-0000-0000-000000000001",
    bioguide: "bioguide" in over ? (over.bioguide ?? null) : MORAN.bioguide,
    live: over.live ?? null,
    prior: over.prior ?? [],
    merged: over.merged ?? [],
  };
}

const NO_CLAIMS: ClaimsMap = new Map();

// ── currentFecId ────────────────────────────────────────────────────────────

test("currentFecId: the one id whose prefix matches terms[last].type", () => {
  assert.deepEqual(currentFecId(MORAN), { kind: "ok", id: "S0KS00315" });
  assert.deepEqual(currentFecId(REP), { kind: "ok", id: "H0CA12345" });
});

test("currentFecId: two same-chamber ids resolve by state + district", () => {
  // Bill Foster, 2026-09-28: IL-14 id from 2008, IL-11 id since, sits for IL-11.
  const foster: Listing = { ...REP, fec: ["H8IL14067", "H2IL11124"], state: "IL", district: 11 };
  assert.deepEqual(currentFecId(foster), { kind: "ok", id: "H2IL11124" });
  // Two Senate ids, one per state — state alone decides.
  const moved: Listing = { ...MORAN, fec: ["S0KS00315", "S2MO00111"], state: "MO" };
  assert.deepEqual(currentFecId(moved), { kind: "ok", id: "S2MO00111" });
});

test("currentFecId: none or several agreeing → ambiguous; no id of the chamber → none", () => {
  assert.deepEqual(currentFecId(CASTOR), { kind: "ambiguous", candidates: ["H6FL11126", "H6FL11134"] });
  // Amodei's shape: both ids NV-02 — both agree, still ambiguous, both candidates.
  const both: Listing = { ...REP, fec: ["H2NV02395", "H1NV02017"], state: "NV", district: 2 };
  assert.deepEqual(currentFecId(both), { kind: "ambiguous", candidates: ["H1NV02017", "H2NV02395"] });
  assert.deepEqual(currentFecId({ ...MORAN, fec: ["H6KS01179"] }), { kind: "none" });
});

// ── design §4, one fixture per row ─────────────────────────────────────────

test("§4 (a) unlisted_live_id: the row holds an id the dataset does not list — reported, never demoted", () => {
  const c = classifyBinding(row({ live: "S0XX99999" }), MORAN, NO_CLAIMS);
  assert.equal(c.action, "unlisted_live_id");
  assert.equal(c.live, undefined, "a report class proposes no write");
  assert.match(c.reason, /live S0XX99999 not listed/);
  // An unlisted PRIOR id is the same class — design §4 says "an id".
  const p = classifyBinding(row({ live: "S0KS00315", prior: ["H6KS01179", "H9ZZ00001"] }), MORAN, NO_CLAIMS);
  assert.equal(p.action, "unlisted_live_id");
  assert.match(p.reason, /prior H9ZZ00001 not listed/);
});

test("§4 (b) bindable: the row holds nothing, the dataset lists ids — live = current, rest → prior", () => {
  const c = classifyBinding(row({}), MORAN, NO_CLAIMS);
  assert.equal(c.action, "bindable");
  assert.equal(c.live, "S0KS00315");
  assert.deepEqual(c.prior, ["H6KS01179"]);
});

test("§4 (c) prior_office_live: a House id live on a now-Senator", () => {
  const c = classifyBinding(row({ live: "H6KS01179" }), MORAN, NO_CLAIMS);
  assert.equal(c.action, "prior_office_live");
  assert.equal(c.live, "S0KS00315");
  assert.deepEqual(c.prior, ["H6KS01179"]);
  assert.equal(c.current_id, "S0KS00315");
});

test("§4 (d) double_claim: a stub (no bioguide) claims one of this member's ids", () => {
  const stub = row({ official_id: "stub", bioguide: null, live: "S0KS00315" });
  const claims = buildClaimsMap([stub]);
  const c = classifyBinding(row({ live: "H6KS01179" }), MORAN, claims);
  assert.equal(c.action, "double_claim");
  assert.deepEqual(c.contested, ["S0KS00315"]);
  assert.match(c.reason, /S0KS00315 also claimed by stub \(no bioguide\)/);
});

test("§4 (e) cross_bioguide_claim: a listed id is held by a DIFFERENT bioguide's row", () => {
  const other = row({ official_id: "other", bioguide: "X000001", live: "H6KS01179" });
  const claims = buildClaimsMap([other]);
  const c = classifyBinding(row({ live: "S0KS00315" }), MORAN, claims);
  assert.equal(c.action, "cross_bioguide_claim");
  assert.match(c.reason, /H6KS01179 held by other \(bioguide X000001\)/);
});

test("noop: live = the current-office id and prior ⊇ the rest", () => {
  const c = classifyBinding(row({ live: "S0KS00315", prior: ["H6KS01179"] }), MORAN, NO_CLAIMS);
  assert.equal(c.action, "noop");
  assert.equal(c.live, undefined, "noop proposes no write");
});

test("no_bioguide: an elected federal row with no congress_gov key", () => {
  assert.equal(classifyBinding(row({ bioguide: null, live: "S0KS00315" }), null, NO_CLAIMS).action, "no_bioguide");
});

// ── the classes the tree added ─────────────────────────────────────────────

test("prior_incomplete: live is right, the prior-office id is missing from prior", () => {
  const c = classifyBinding(row({ live: "S0KS00315" }), MORAN, NO_CLAIMS);
  assert.equal(c.action, "prior_incomplete");
  assert.equal(c.live, "S0KS00315");
  assert.deepEqual(c.prior, ["H6KS01179"]);
});

test("dataset_lag: the dataset lists no id for this member, or not the member at all", () => {
  assert.equal(classifyBinding(row({ live: "S0KS00315" }), { ...MORAN, fec: [] }, NO_CLAIMS).action, "dataset_lag");
  assert.equal(classifyBinding(row({}), null, NO_CLAIMS).action, "dataset_lag");
});

test("ambiguous_current: the row needs the current id and the dataset cannot name it", () => {
  const castor = (over: Partial<BindingRow>) => row({ bioguide: CASTOR.bioguide, ...over });
  assert.equal(classifyBinding(castor({}), CASTOR, NO_CLAIMS).action, "ambiguous_current");
  // A live id among the candidates is the row's choice and stands.
  assert.equal(classifyBinding(castor({ live: "H6FL11126", prior: ["H6FL11134"] }), CASTOR, NO_CLAIMS).action, "noop");
  assert.equal(classifyBinding(castor({ live: "H6FL11134" }), CASTOR, NO_CLAIMS).action, "prior_incomplete");
  // A listed live id that is NOT a candidate (an old Senate run) cannot be promoted.
  const withS: Listing = { ...CASTOR, fec: [...CASTOR.fec, "S4FL00001"] };
  assert.equal(classifyBinding(castor({ live: "S4FL00001" }), withS, NO_CLAIMS).action, "ambiguous_current");
  // No id of the last term's chamber at all.
  const noH: Listing = { ...CASTOR, fec: ["S4FL00001"] };
  assert.equal(classifyBinding(castor({}), noH, NO_CLAIMS).action, "ambiguous_current");
});

// ── rule 105: the wrong-but-green shapes ───────────────────────────────────

test("rule 105: a row that is already CORRECT classifies noop (single-id and multi-id)", () => {
  assert.equal(classifyBinding(row({ bioguide: REP.bioguide, live: "H0CA12345" }), REP, NO_CLAIMS).action, "noop");
  assert.equal(classifyBinding(row({ live: "S0KS00315", prior: ["H6KS01179"] }), MORAN, NO_CLAIMS).action, "noop");
});

test("rule 105: a difference only in the ORDER of prior_fec_candidate_ids is noop", () => {
  const three: Listing = { ...MORAN, fec: ["H6KS01179", "H8KS01002", "S0KS00315"] };
  const a = classifyBinding(row({ live: "S0KS00315", prior: ["H6KS01179", "H8KS01002"] }), three, NO_CLAIMS);
  const b = classifyBinding(row({ live: "S0KS00315", prior: ["H8KS01002", "H6KS01179"] }), three, NO_CLAIMS);
  assert.equal(a.action, "noop");
  assert.equal(b.action, "noop");
});

test("the row's own claim in the claims map is not a double claim", () => {
  const me = row({ live: "S0KS00315", prior: ["H6KS01179"] });
  assert.equal(classifyBinding(me, MORAN, buildClaimsMap([me])).action, "noop");
});

// ── rule 139: retired ids are not claims, through authoritativeClaims() ────

test("rule 139: a merged (retired) id is not a claim — on the row or on another row", () => {
  // The row retired its own live id: it claims nothing, so it is bindable.
  const retired = classifyBinding(row({ live: "S0KS00315", merged: ["S0KS00315"] }), MORAN, NO_CLAIMS);
  assert.equal(retired.action, "bindable");
  // A merge stub that retired a listed id does not double-claim it.
  const stub = bindingRowFromSourceIds("stub", { fec_candidate_id: "S0KS00315", merged_fec_candidate_id: "S0KS00315" });
  const c = classifyBinding(row({ live: "S0KS00315", prior: ["H6KS01179"] }), MORAN, buildClaimsMap([stub]));
  assert.equal(c.action, "noop");
});

test("bindingRowFromSourceIds reads the scalar and array retired shapes and the prior array", () => {
  const r = bindingRowFromSourceIds("id", {
    congress_gov: "M000934",
    fec_candidate_id: "S0KS00315",
    prior_fec_candidate_ids: ["H6KS01179"],
    merged_fec_candidate_ids: ["H0XX00001"],
    merged_fec_candidate_id: "H0XX00002",
  });
  assert.deepEqual(r, {
    official_id: "id",
    bioguide: "M000934",
    live: "S0KS00315",
    prior: ["H6KS01179"],
    merged: ["H0XX00001", "H0XX00002"],
  });
});

// ── parsing ────────────────────────────────────────────────────────────────

test("parseLegislators reads bioguide, fec[], and the LAST term", () => {
  const raw = [
    {
      id: { bioguide: "M000934", fec: ["H6KS01179", "S0KS00315"] },
      name: { first: "Jerry", last: "Moran", official_full: "Jerry Moran" },
      terms: [
        { type: "rep", state: "KS", district: 1 },
        { type: "sen", state: "KS" },
      ],
    },
    { id: { bioguide: "A000383" }, name: { first: "Alan", last: "Armstrong" }, terms: [{ type: "sen", state: "OK" }] },
    { id: {}, terms: [{ type: "rep", state: "CA", district: 1 }] },
  ];
  assert.deepEqual(parseLegislators(raw), [
    { bioguide: "M000934", name: "Jerry Moran", fec: ["H6KS01179", "S0KS00315"], currentType: "sen", state: "KS", district: null },
    { bioguide: "A000383", name: "Alan Armstrong", fec: [], currentType: "sen", state: "OK", district: null },
  ]);
  assert.throws(() => parseLegislators({ not: "an array" }), /not an array/);
});

// ── rule 116: the partition ────────────────────────────────────────────────

test("rule 116: every class present, the classes partition the population, members matched or unmatched once", () => {
  let n = 0;
  const pr = (bioguide: string | null, over: Partial<BindingRow> = {}): PopulationRow => ({
    ...row({ official_id: `row-${String(++n).padStart(3, "0")}`, bioguide, ...over }),
    name: `Row ${n}`,
  });
  const current: Listing[] = [
    MORAN,
    REP,
    CASTOR,
    { ...MORAN, bioguide: "B1", fec: ["S1AA00001", "H1AA01001"] },
    { ...MORAN, bioguide: "B2", fec: ["S2BB00002"] },
    { ...MORAN, bioguide: "B3", fec: ["S3CC00003"] },
    { ...MORAN, bioguide: "B4", fec: [] },
    { ...REP, bioguide: "B5", fec: ["H5DD05005"], state: "DD", district: 5 },
    { ...MORAN, bioguide: "B6", fec: ["S6FF00006", "H6FF01006"] },
    { ...REP, bioguide: "UNMATCHED", name: "Nobody Here", fec: ["H9ZZ09009"] },
  ];
  const historical: Listing[] = [{ ...REP, bioguide: "H_ONLY", fec: ["H7EE07007"], state: "EE", district: 7 }];

  const stub = row({ official_id: "stub-x", bioguide: null, live: "S3CC00003" });
  const stranger = row({ official_id: "stranger", bioguide: "ZZZ", live: "S2BB00002" });
  const rows: PopulationRow[] = [
    pr("M000934", { live: "S0KS00315", prior: ["H6KS01179"] }), // noop
    pr(REP.bioguide), //                                           bindable
    pr("B1", { live: "H1AA01001" }), //                            prior_office_live
    pr("B1"), //    double_claim: a 2nd row on B1, and the 1st row claims B1's id (§4 (d))
    pr("B6", { live: "S6FF00006" }), //                            prior_incomplete
    pr(CASTOR.bioguide), //                                        ambiguous_current
    pr("B5", { live: "H5DD05999" }), //                            unlisted_live_id
    pr("B3", { live: "S3CC00003" }), //                            double_claim (the stub)
    pr("B2", {}), //                                               cross_bioguide_claim (the stranger)
    pr("B4", { live: "S4XX00004" }), //                            dataset_lag (empty fec)
    pr("NOT_ANYWHERE"), //                                         dataset_lag (no listing)
    pr("H_ONLY", { live: "H7EE07007" }), //                        noop via the historical file
    pr(null, { live: "H0QQ00000" }), //                            no_bioguide
  ];
  const report = buildReport(rows, current, historical, buildClaimsMap([...rows, stub, stranger]));

  for (const a of BINDING_ACTIONS) assert.ok(report.counts[a] > 0, `fixture set lacks a ${a} row`);
  const sum = Object.values(report.counts).reduce((x, y) => x + y, 0);
  assert.equal(sum, rows.length);
  assert.deepEqual(reconcileReport(report, current.length), []);
  assert.equal(report.counts.noop, 2);
  assert.equal(report.counts.dataset_lag, 2);
  assert.equal(report.counts.double_claim, 2);
  // B3's stub holds B3's CURRENT id; B1's 1st row holds B1's PRIOR-office id.
  assert.deepEqual(report.double_claim_split, { current_id: 1, other_id: 1 });
  // The claimless 2nd B1 row does not turn the 1st into a double claim: a row
  // that claims nothing is not a claimant.
  assert.equal(report.counts.prior_office_live, 1);
  assert.equal(report.matched_via_historical, 1);
  assert.equal(report.matched_dataset_members, 9, "B1's two rows are ONE matched member");
  assert.equal(report.members_with_multiple_rows, 1);
  assert.deepEqual(report.unmatched_dataset_members, { count: 1, first_20: [{ bioguide: "UNMATCHED", name: "Nobody Here" }] });
  assert.equal(report.dataset_ambiguous_current, 1);
  assert.equal(report.top_20.noop, undefined, "noop rows are counted, never listed");
});

test("rule 116: the partition holds across a combinatorial sweep, and prior order never changes a class", () => {
  const lives = [null, "S0KS00315", "H6KS01179", "S0XX99999"];
  const priors = [[], ["H6KS01179"], ["S0KS00315"], ["H6KS01179", "H9ZZ00001"], ["H9ZZ00001", "H6KS01179"]];
  const claimVariants: ClaimsMap[] = [
    NO_CLAIMS,
    buildClaimsMap([row({ official_id: "stub", bioguide: null, live: "S0KS00315" })]),
    buildClaimsMap([row({ official_id: "x", bioguide: "OTHER", live: "H6KS01179" })]),
  ];
  const rows: PopulationRow[] = [];
  let i = 0;
  for (const live of lives) {
    for (const prior of priors) {
      for (const merged of [[], ["S0KS00315"]]) {
        rows.push({ ...row({ official_id: `r${i++}`, live, prior, merged }), name: `r${i}` });
      }
    }
  }
  for (const claims of claimVariants) {
    const report = buildReport(rows, [MORAN], [], claims);
    assert.deepEqual(reconcileReport(report, 1), [], "reconciliation must hold for every claims variant");
    for (const r of rows) {
      const a = classifyBinding(r, MORAN, claims).action;
      const b = classifyBinding({ ...r, prior: [...r.prior].reverse() }, MORAN, claims).action;
      assert.equal(a, b, `prior order changed the class of ${JSON.stringify(r)}`);
    }
  }
});

test("reconcileReport names a broken partition rather than passing it", () => {
  const report = buildReport([{ ...row({}), name: "x" }], [MORAN], [], NO_CLAIMS);
  assert.deepEqual(reconcileReport(report, 1), []);
  const broken = { ...report, counts: { ...report.counts, noop: report.counts.noop + 1 } };
  assert.match(reconcileReport(broken, 1).join(), /classes sum to 2, population is 1/);
  assert.match(reconcileReport(report, 2).join(), /≠ 2 current members/);
  const badSplit = { ...report, double_claim_split: { current_id: 1, other_id: 0 } };
  assert.match(reconcileReport(badSplit, 1).join(), /double_claim split sums to 1, class is 0/);
});

// ── The stamp's lists (cc-193, D5) ──────────────────────────────────────────

/** prod's 10-03 shape: 13 current-id double claims + 46 prior/other-office ones. */
function doubleClaimPopulation(nCurrent: number, nOther: number) {
  const rows: PopulationRow[] = [];
  const listings: Listing[] = [];
  const stubs: BindingRow[] = [];
  for (let i = 0; i < nCurrent; i++) {
    const b = `C${String(i).padStart(3, "0")}`;
    const id = `H0AA${String(i).padStart(2, "0")}${String(i).padStart(3, "0")}`;
    listings.push({ bioguide: b, name: `Cur ${i}`, fec: [id], currentType: "rep", state: "AA", district: i });
    // Named so they sort LAST — the cut must still keep them.
    rows.push({ ...row({ official_id: `cur-${i}`, bioguide: b }), name: `Zz Current ${String(i).padStart(2, "0")}` });
    stubs.push(row({ official_id: `stub-c${i}`, bioguide: null, live: id }));
  }
  for (let i = 0; i < nOther; i++) {
    const b = `O${String(i).padStart(3, "0")}`;
    const h = `H1BB${String(i).padStart(2, "0")}${String(i).padStart(3, "0")}`;
    const s = `S1BB${String(i).padStart(5, "0")}`;
    listings.push({ bioguide: b, name: `Oth ${i}`, fec: [h, s], currentType: "sen", state: "BB", district: null });
    rows.push({ ...row({ official_id: `oth-${i}`, bioguide: b, live: s }), name: `Aa Other ${String(i).padStart(2, "0")}` });
    stubs.push(row({ official_id: `stub-o${i}`, bioguide: null, live: h }));
  }
  return { rows, listings, claims: buildClaimsMap([...rows, ...stubs]) };
}

test("D5: a class over 50 lists 50 and says it was cut — and every current-id double claim is among them", () => {
  const { rows, listings, claims } = doubleClaimPopulation(13, 46);
  const r = buildReport(rows, listings, [], claims);
  assert.equal(r.counts.double_claim, 59);
  assert.deepEqual(r.double_claim_split, { current_id: 13, other_id: 46 });
  const listed = r.top_20.double_claim!;
  assert.equal(listed.length, REPORT_LIST_CAP);
  assert.equal(r.top_20_truncated.double_claim, true);
  const cur = listed.filter((e) => e.double_claim_split === "current_id");
  assert.equal(cur.length, 13, "all 13, though their names sort after every other-office row");
  assert.ok(listed.slice(0, 13).every((e) => e.double_claim_split === "current_id"), "current-id rows first");
  assert.deepEqual(reconcileReport(r, listings.length), []);
});

test("D5 twin: a class of ≤ 50 is listed IN FULL and not flagged", () => {
  const { rows, listings, claims } = doubleClaimPopulation(13, 33);
  const r = buildReport(rows, listings, [], claims);
  assert.equal(r.top_20.double_claim!.length, 46);
  assert.equal(r.top_20_truncated.double_claim, undefined);
});

// ── O1 — planBinding / planBindings (FIX-1189, cc-193) ──────────────────────
//
// One fixture per class O1 acts on, each with its wrong-but-green twin (rule
// 105): the same class where a write would be WRONG, which must plan null. The
// idempotence test applies a plan in memory and re-plans: zero.

const plan = (r: BindingRow, claims: ClaimsMap = NO_CLAIMS) => planBinding(r, classifyBinding(r, MORAN, claims), claims);

test("O1 bindable → bind: live ← the current id, the listed prior ids appended in the same write", () => {
  assert.deepEqual(plan(row({})), {
    official_id: "00000000-0000-0000-0000-000000000001",
    kind: "bind",
    expect_live: null,
    set_live: "S0KS00315",
    add_prior: ["H6KS01179"],
  });
});

test("O1 bindable, twin: the current id is RETIRED on the row → null (writing it would change nothing, forever)", () => {
  const r = row({ merged: ["S0KS00315"] });
  assert.equal(classifyBinding(r, MORAN, NO_CLAIMS).action, "bindable", "the classifier still says bindable");
  assert.equal(plan(r), null);
});

test("O1 prior_office_live → promote: live ← current, the old live id → prior", () => {
  assert.deepEqual(plan(row({ live: "H6KS01179" })), {
    official_id: "00000000-0000-0000-0000-000000000001",
    kind: "promote",
    expect_live: "H6KS01179",
    set_live: "S0KS00315",
    add_prior: ["H6KS01179"],
  });
});

test("O1 prior_office_live, twin: another row (a stub) holds the current id → null", () => {
  const r = row({ live: "H6KS01179" });
  const stubClaims = buildClaimsMap([row({ official_id: "stub", bioguide: null, live: "S0KS00315" })]);
  // Through the classifier the stub makes this a double_claim, which plans null …
  assert.equal(classifyBinding(r, MORAN, stubClaims).action, "double_claim");
  assert.equal(plan(r, stubClaims), null);
  // … and the plan refuses on its own, without leaning on the classifier's order.
  const forced = { action: "prior_office_live" as const, live: "S0KS00315", prior: ["H6KS01179"], current_id: "S0KS00315", reason: "" };
  assert.equal(planBinding(r, forced, stubClaims), null);
  assert.notEqual(planBinding(r, forced, NO_CLAIMS), null, "the same classification with no stub does plan");
});

test("O1 prior_incomplete → prior_append: the missing listed ids, live untouched", () => {
  assert.deepEqual(plan(row({ live: "S0KS00315" })), {
    official_id: "00000000-0000-0000-0000-000000000001",
    kind: "prior_append",
    expect_live: "S0KS00315",
    set_live: null,
    add_prior: ["H6KS01179"],
  });
});

test("O1 prior_incomplete, twin: the missing id is RETIRED on the row → null", () => {
  const r = row({ live: "S0KS00315", merged: ["H6KS01179"] });
  assert.equal(classifyBinding(r, MORAN, NO_CLAIMS).action, "prior_incomplete");
  assert.equal(plan(r), null);
});

test("O1 every other class plans nothing", () => {
  const cases: Array<[BindingRow, ClaimsMap, string]> = [
    [row({ live: "S0KS00315", prior: ["H6KS01179"] }), NO_CLAIMS, "noop"],
    [row({ live: "S0XX99999" }), NO_CLAIMS, "unlisted_live_id"],
    [row({}), buildClaimsMap([row({ official_id: "stub", bioguide: null, live: "S0KS00315" })]), "double_claim"],
    [row({}), buildClaimsMap([row({ official_id: "x", bioguide: "OTHER", live: "H6KS01179" })]), "cross_bioguide_claim"],
    [row({ bioguide: null }), NO_CLAIMS, "no_bioguide"],
  ];
  for (const [r, claims, expected] of cases) {
    const c = classifyBinding(r, r.bioguide ? MORAN : null, claims);
    assert.equal(c.action, expected);
    assert.equal(planBinding(r, c, claims), null, expected);
  }
  const castor = row({ bioguide: CASTOR.bioguide });
  assert.equal(planBinding(castor, classifyBinding(castor, CASTOR, NO_CLAIMS), NO_CLAIMS), null, "ambiguous_current");
  const lag = row({ bioguide: "NOT_LISTED" });
  assert.equal(planBinding(lag, classifyBinding(lag, null, NO_CLAIMS), NO_CLAIMS), null, "dataset_lag");
});

/** What BIND_SQL does to one row, in memory. */
function applyInMemory(r: BindingRow, w: BindingWrite): BindingRow {
  if (r.live !== w.expect_live) return r; // refused_changed
  const live = w.set_live ?? r.live;
  const prior = w.add_prior.length > 0
    ? [...r.prior.filter((id) => id !== w.set_live), ...w.add_prior.filter((id) => id !== w.set_live && !r.prior.includes(id))]
    : r.prior;
  return { ...r, live, prior };
}

test("O1 idempotence: apply the plan, re-plan the same population — zero writes", () => {
  const rows: BindingRow[] = [
    row({ official_id: "a" }), //                                bind
    row({ official_id: "b", bioguide: REP.bioguide, live: null }), // bind (single id)
  ];
  // A second member for the promote / prior_append rows, so no id is claimed twice.
  const ALT: Listing = { ...MORAN, bioguide: "ALT", fec: ["H1AA01001", "S1AA00001"] };
  const ALT2: Listing = { ...MORAN, bioguide: "ALT2", fec: ["H2BB02002", "S2BB00002"] };
  rows.push(row({ official_id: "c", bioguide: "ALT", live: "H1AA01001" })); //  promote
  rows.push(row({ official_id: "d", bioguide: "ALT2", live: "S2BB00002" })); // prior_append
  const current = [MORAN, REP, ALT, ALT2];
  const first = planBindings(rows, current, buildClaimsMap(rows));
  assert.deepEqual(first.map((p) => p.kind).sort(), ["bind", "bind", "prior_append", "promote"]);
  const after = rows.map((r) => {
    const w = first.find((p) => p.official_id === r.official_id);
    return w ? applyInMemory(r, w) : r;
  });
  assert.deepEqual(planBindings(after, current, buildClaimsMap(after)), [], "a second run plans 0");
  for (const r of after) assert.equal(classifyBinding(r, current.find((l) => l.bioguide === r.bioguide)!, buildClaimsMap(after)).action, "noop");
});

test("O1 planBindings: two claimless rows of one member would both bind the same id → both dropped", () => {
  const rows = [row({ official_id: "x1" }), row({ official_id: "x2" })];
  assert.equal(classifyBinding(rows[0]!, MORAN, buildClaimsMap(rows)).action, "bindable", "each alone looks bindable");
  assert.deepEqual(planBindings(rows, [MORAN], buildClaimsMap(rows)), []);
  // twin: one row binds
  assert.equal(planBindings([rows[0]!], [MORAN], buildClaimsMap([rows[0]!])).length, 1);
});

test("O1 planBindings: a row the CURRENT file does not list is never written (historical-only, or unlisted)", () => {
  const r = row({ official_id: "h", bioguide: "H_ONLY" });
  assert.deepEqual(planBindings([r], [MORAN], NO_CLAIMS), []);
});
