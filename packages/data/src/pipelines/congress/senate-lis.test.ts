/**
 * FIX-1260 — the Senate LIS XML, as senate.gov serves it. The three fixtures
 * are real rolls fetched 2026-10-03 (cc-185), member lists cut to three:
 *   senate-119-2-00256  On the Nomination      / Nomination Confirmed
 *   senate-119-1-00431  On the Cloture Motion  / Cloture Motion Agreed to
 *   senate-119-1-00411  On Passage of the Bill / Bill Passed   (H.R. 4)
 * They are the first Senate fixtures in the tree. Before FIX-1260 the writer
 * read root["result"], which none of them has — every stored Senate roll got
 * vote_result ''.
 *
 * FIX-1408 adds a fourth, read 2026-11-13 (cc-277):
 *   senate-119-1-00062  On the Motion          / Motion Rejected  (S.Amdt. 454 to S.Con.Res. 7)
 * Its <document> is `S.Amdt.` with an empty number; the bill is in
 * <amendment><amendment_to_document_number>.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parseSenateRoll, senateBillRef, senateRollResult, senateVoteMetadata, type SenateBillRefContext } from "./votes";
import { mapVoteResult } from "./members";
import { mintStatuses, rollPassageAdvances, stampMintStatuses } from "./bill-status";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "__fixtures__", name), "utf8");
const NOMINATION = "lis-senate-119-2-00256-nomination.xml";
const CLOTURE = "lis-senate-119-1-00431-cloture.xml";
const BILL_PASSED = "lis-senate-119-1-00411-bill-passed.xml";

test("FIX-1260 the LIS root carries vote_result, vote_result_text, vote_question_text, vote_title — and no <result>", () => {
  for (const f of [NOMINATION, CLOTURE, BILL_PASSED]) {
    const root = parseSenateRoll(fixture(f));
    assert.ok(root, f);
    for (const el of ["vote_result", "vote_result_text", "vote_question_text", "vote_title", "question"]) {
      assert.ok(el in root!, `${f}: <${el}>`);
    }
    assert.equal(root!["result"], undefined, `${f}: the element the pre-FIX-1260 writer read is absent`);
  }
});

test("FIX-1260 senateRollResult reads <vote_result> and <vote_result_text>", () => {
  assert.deepEqual(senateRollResult(parseSenateRoll(fixture(NOMINATION))!), {
    resultStr: "Nomination Confirmed",
    resultText: "Nomination Confirmed (47-41)",
  });
  assert.deepEqual(senateRollResult(parseSenateRoll(fixture(CLOTURE))!), {
    resultStr: "Cloture Motion Agreed to",
    resultText: "Cloture Motion Agreed to (48-47)",
  });
  assert.deepEqual(senateRollResult(parseSenateRoll(fixture(BILL_PASSED))!), {
    resultStr: "Bill Passed",
    resultText: "Bill Passed (51-48)",
  });
});

test("FIX-1260 <result> stays a fallback; neither element → ''", () => {
  assert.equal(senateRollResult({ result: "Passed" }).resultStr, "Passed");
  assert.equal(senateRollResult({ vote_result: "Bill Passed", result: "x" }).resultStr, "Bill Passed");
  assert.deepEqual(senateRollResult({}), { resultStr: "", resultText: "" });
});

test("FIX-1260 the members still parse (three kept), with the fields the writer keys on", () => {
  const root = parseSenateRoll(fixture(BILL_PASSED))!;
  const members = (root["members"] as { member: Array<Record<string, unknown>> }).member;
  assert.equal(members.length, 3);
  for (const m of members) {
    assert.ok(String(m["last_name"]).length > 0);
    assert.match(String(m["state"]), /^[A-Z]{2}$/);
    assert.ok(["Yea", "Nay", "Not Voting", "Present"].includes(String(m["vote_cast"])));
  }
});

test("FIX-1260 mapVoteResult classifies the LIS vocabulary by suffix", () => {
  const table: Array<[string, string]> = [
    ["Bill Passed", "passed_chamber"],
    ["Joint Resolution Passed", "passed_chamber"],
    ["Resolution Agreed to", "passed_chamber"],
    ["Cloture Motion Agreed to", "passed_chamber"], // the MOTION passed — the question decides what that proves
    ["Nomination Confirmed", "passed_chamber"],
    ["Cloture Motion Rejected", "failed"],
    ["Motion to Table Failed", "failed"],
    ["Amendment Rejected", "failed"],
    ["Motion Not Agreed to", "failed"], // failed-like is tested first
    ["Veto Sustained", "passed_chamber"], // the VETO stood (the override failed) — inert: "On Overriding the Veto" is not a passage question
    ["Point of Order Not Well Taken", "failed"],
    ["Bill Defeated", "failed"], // cc-185 census: 4 rolls, all on "On Passage of the Bill"
    ["Joint Resolution Defeated", "failed"], // 8 rolls, all on "On the Joint Resolution"
    ["Point of Order Well Taken", "floor_vote"],
    ["Not Guilty", "floor_vote"],
    ["Guilty", "floor_vote"],
    ["", "floor_vote"],
    // the House Clerk's three values — unchanged
    ["Passed", "passed_chamber"],
    ["Agreed to", "passed_chamber"],
    ["Failed", "failed"],
  ];
  for (const [r, want] of table) assert.equal(mapVoteResult(r), want, r);
});

test("FIX-1260 + FIX-1261: an agreed-to cloture motion mints floor_vote, never passed_chamber; Bill Passed on passage mints passed_chamber", () => {
  const roll = (f: string, billKey: string) => {
    const root = parseSenateRoll(fixture(f))!;
    return { rollCallId: f, billKey, voteQuestion: String(root["question"]), resultStr: senateRollResult(root).resultStr };
  };
  const cloture = roll(CLOTURE, "119-PN-1");
  const passage = roll(BILL_PASSED, "119-HR-4");
  assert.deepEqual(Object.fromEntries(mintStatuses([cloture, passage])), {
    "119-PN-1": "floor_vote",
    "119-HR-4": "passed_chamber",
  });
  // …and the Senate arm of the existing-bill advance is live: only the passage roll asks.
  assert.deepEqual(
    rollPassageAdvances([cloture, passage], (k) => (k === "119-HR-4" ? "hr4" : "pn1")),
    [{ id: "hr4", status: "passed_chamber", via: BILL_PASSED }],
  );
});

// ---------------------------------------------------------------------------
// FIX-1408 — senateBillRef(), Step 4's bill-reference block lifted out.
// ---------------------------------------------------------------------------

const ctx = (votedAt: string): SenateBillRefContext => ({
  congress: 119,
  votedAt,
  federalId: "fed",
  senateGovBodyId: "senate-body",
  houseGovBodyId: "house-body",
});

test("FIX-1408 pin: the three existing fixtures give exactly the key and mint args the inline block built", () => {
  assert.deepEqual(senateBillRef(parseSenateRoll(fixture(BILL_PASSED))!, "senate-119-1-00411", ctx("2025-07-17")), {
    billKey: "119-HR-4",
    args: {
      billKey: "119-HR-4",
      title: "HR 4",
      billNumber: "HR 4",
      billType: "HR",
      chamber: "house",
      type: "bill",
      status: "floor_vote",
      jurisdictionId: "fed",
      governingBodyId: "house-body",
      congressGovUrl: "https://congress.gov/bill/119th-congress/house-bill/4",
      introducedAt: "2025-07-17T00:00:00.000Z",
      lastActionAt: "2025-07-17T00:00:00.000Z",
      congressNumber: 119,
      session: "119",
    },
    amendmentNumber: null,
    warnings: [],
  });
  assert.deepEqual(senateBillRef(parseSenateRoll(fixture(CLOTURE))!, "senate-119-1-00431", ctx("2025-07-23")), {
    billKey: "119-PN-25-53",
    args: {
      billKey: "119-PN-25-53",
      title: "Aaron Szabo, of Virginia, to be an Assistant Administrator of the Environmental Protection Agency",
      billNumber: "PN 25-53",
      billType: "PN",
      chamber: "senate",
      type: "appointment",
      status: "floor_vote",
      jurisdictionId: "fed",
      governingBodyId: "senate-body",
      congressGovUrl: "https://www.congress.gov/nomination/119th-congress/25-53",
      introducedAt: "2025-07-23T00:00:00.000Z",
      lastActionAt: "2025-07-23T00:00:00.000Z",
      congressNumber: 119,
      session: "119",
    },
    amendmentNumber: null,
    warnings: [],
  });
  assert.deepEqual(senateBillRef(parseSenateRoll(fixture(NOMINATION))!, "senate-119-2-00256", ctx("2026-09-30")), {
    billKey: "119-PN-1129",
    args: {
      billKey: "119-PN-1129",
      title: "Keith Sonderling, of Florida, to be Secretary of Labor",
      billNumber: "PN 1129",
      billType: "PN",
      chamber: "senate",
      type: "appointment",
      status: "floor_vote",
      jurisdictionId: "fed",
      governingBodyId: "senate-body",
      congressGovUrl: "https://www.congress.gov/nomination/119th-congress/1129",
      introducedAt: "2026-09-30T00:00:00.000Z",
      lastActionAt: "2026-09-30T00:00:00.000Z",
      congressNumber: 119,
      session: "119",
    },
    amendmentNumber: null,
    warnings: [],
  });
});

const AMDT_MOTION = "lis-senate-119-1-00062-amendment-motion.xml";
const ROLL_62_TARGET = "<amendment_to_document_number>S.Con.Res. 7</amendment_to_document_number>";
/** Roll 62 with another `<amendment_to_document_number>` ('' → the empty element). */
const roll62Targeting = (target: string) => {
  const xml = fixture(AMDT_MOTION);
  assert.ok(xml.includes(ROLL_62_TARGET));
  return parseSenateRoll(
    xml.replace(ROLL_62_TARGET, target ? `<amendment_to_document_number>${target}</amendment_to_document_number>` : "<amendment_to_document_number/>"),
  )!;
};

test("FIX-1408 roll 62: <document> is S.Amdt. with an EMPTY number — the shape the collector skipped", () => {
  const root = parseSenateRoll(fixture(AMDT_MOTION))!;
  const doc = root["document"] as Record<string, unknown>;
  assert.equal(doc["document_type"], "S.Amdt.");
  assert.equal(doc["document_number"], "");
  assert.equal(root["question"], "On the Motion");
  assert.deepEqual(senateRollResult(root), { resultStr: "Motion Rejected", resultText: "Motion Rejected (47-52, 3/5 majority required)" });
});

test("FIX-1408 D1 + D2: roll 62 is stored against its parent S.Con.Res. 7 and carries S.Amdt. 454", () => {
  assert.deepEqual(senateBillRef(parseSenateRoll(fixture(AMDT_MOTION))!, "senate-119-1-00062", ctx("2025-02-20")), {
    billKey: "119-SCONRES-7",
    args: {
      billKey: "119-SCONRES-7",
      title: "SCONRES 7",
      billNumber: "SCONRES 7",
      billType: "SCONRES",
      chamber: "senate",
      type: "resolution",
      status: "floor_vote",
      jurisdictionId: "fed",
      governingBodyId: "senate-body",
      congressGovUrl: "https://congress.gov/bill/119th-congress/senate-concurrent-resolution/7",
      introducedAt: "2025-02-20T00:00:00.000Z",
      lastActionAt: "2025-02-20T00:00:00.000Z",
      congressNumber: 119,
      session: "119",
    },
    amendmentNumber: "S.Amdt. 454",
    warnings: [],
  });
});

test("FIX-1408 D1: an amendment target of each measure type maps through normalizeSenateDocType to the same key the <document> branch builds", () => {
  const table: Array<[string, string, string, string]> = [
    ["H.R. 1", "119-HR-1", "house", "house-body"],
    ["S. 5", "119-S-5", "senate", "senate-body"],
    ["H.J.Res. 20", "119-HJRES-20", "house", "house-body"],
    ["S.Res. 12", "119-SRES-12", "senate", "senate-body"],
  ];
  for (const [target, key, chamber, body] of table) {
    const ref = senateBillRef(roll62Targeting(target), "senate-119-1-00062", ctx("2025-02-20"));
    assert.equal(ref.billKey, key, target);
    assert.equal(ref.args?.billKey, key, target);
    assert.equal(ref.args?.chamber, chamber, target);
    assert.equal(ref.args?.governingBodyId, body, target);
    assert.equal(ref.amendmentNumber, "S.Amdt. 454", target);
    assert.deepEqual(ref.warnings, [], target);
  }
  // …and the args are the <document> branch's own: H.R. 4 by either route mints the same row.
  const viaTarget = senateBillRef(roll62Targeting("H.R. 4"), "x", ctx("2025-07-17")).args;
  const viaDocument = senateBillRef(parseSenateRoll(fixture(BILL_PASSED))!, "x", ctx("2025-07-17")).args;
  assert.deepEqual(viaTarget, viaDocument);
});

test("FIX-1408 D7: an empty target or one the parser cannot read stays unstored, with one line", () => {
  for (const target of ["", "Treaty Doc. 119-1", "PN 12"]) {
    const ref = senateBillRef(roll62Targeting(target), "senate-119-1-00062", ctx("2025-02-20"));
    assert.equal(ref.billKey, null, target);
    assert.equal(ref.args, null, target);
    assert.equal(ref.amendmentNumber, "S.Amdt. 454", target);
    assert.deepEqual(ref.warnings, [`    senate-119-1-00062: unrecognized amendment target '${target}', skipping bill ref`], target);
  }
});

test("FIX-1408 D2: a roll whose <document> names a bill keeps the document's key and still carries its amendment number", () => {
  const xml = fixture(BILL_PASSED)
    .replace("<amendment_number/>", "<amendment_number>S.Amdt. 2360</amendment_number>")
    .replace("<amendment_to_document_number/>", "<amendment_to_document_number>S. 5</amendment_to_document_number>");
  const ref = senateBillRef(parseSenateRoll(xml)!, "senate-119-1-00411", ctx("2025-07-17"));
  assert.equal(ref.billKey, "119-HR-4");
  assert.equal(ref.amendmentNumber, "S.Amdt. 2360");
  assert.deepEqual(ref.warnings, []);
});

test("FIX-1408 an unrecognized <document> type falls through to the amendment target; neither readable → both lines", () => {
  const xml = (target: string) =>
    fixture(AMDT_MOTION)
      .replace("<document_number/>", "<document_number>3</document_number>")
      .replace("<document_type>S.Amdt.</document_type>", "<document_type>Treaty Doc.</document_type>")
      .replace(ROLL_62_TARGET, target ? `<amendment_to_document_number>${target}</amendment_to_document_number>` : "<amendment_to_document_number/>");
  const read = senateBillRef(parseSenateRoll(xml("S.Con.Res. 7"))!, "r", ctx("2025-02-20"));
  assert.equal(read.billKey, "119-SCONRES-7");
  assert.deepEqual(read.warnings, ["    r: unrecognized Senate document_type 'Treaty Doc.', skipping bill ref"]);
  const neither = senateBillRef(parseSenateRoll(xml(""))!, "r", ctx("2025-02-20"));
  assert.equal(neither.billKey, null);
  assert.deepEqual(neither.warnings, [
    "    r: unrecognized Senate document_type 'Treaty Doc.', skipping bill ref",
    "    r: unrecognized amendment target '', skipping bill ref",
  ]);
});

/** A roll's evidence and mint args as Step 4 buffers them. */
const evidence = (root: Record<string, unknown>, rollCallId: string, votedAt: string) => {
  const ref = senateBillRef(root, rollCallId, ctx(votedAt));
  return {
    ref,
    roll: { rollCallId, billKey: ref.billKey, voteQuestion: String(root["question"]), resultStr: senateRollResult(root).resultStr },
  };
};
/** Roll 62 re-asked as a vote on the amendment itself. */
const amendmentAgreedTo = () =>
  parseSenateRoll(
    fixture(AMDT_MOTION)
      .replace("<question>On the Motion</question>", "<question>On the Amendment</question>")
      .replace("<vote_result>Motion Rejected</vote_result>", "<vote_result>Amendment Agreed to</vote_result>"),
  )!;

test("FIX-1408 D3: an amendment roll and a motion on one ask for no status advance; the parent bill mints floor_vote", () => {
  const motion = evidence(parseSenateRoll(fixture(AMDT_MOTION))!, "senate-119-1-00062", "2025-02-20");
  const agreed = evidence(amendmentAgreedTo(), "senate-119-1-00063", "2025-02-20");
  assert.equal(motion.roll.voteQuestion, "On the Motion");
  assert.equal(motion.roll.resultStr, "Motion Rejected");
  assert.equal(agreed.roll.voteQuestion, "On the Amendment");
  assert.equal(agreed.roll.resultStr, "Amendment Agreed to");
  assert.equal(mapVoteResult("Amendment Agreed to"), "passed_chamber", "the result alone would advance — the question is the gate");

  const rolls = [motion.roll, agreed.roll];
  assert.deepEqual(rollPassageAdvances(rolls, () => "sconres7"), []);
  assert.deepEqual(Object.fromEntries(mintStatuses(rolls)), { "119-SCONRES-7": "floor_vote" });

  // The mint path: the parent first seen through an amendment roll is stamped floor_vote.
  const args = new Map([[motion.ref.billKey!, motion.ref.args!]]);
  stampMintStatuses(args, rolls);
  assert.equal(args.get("119-SCONRES-7")!.status, "floor_vote");
});

test("FIX-1408 D3: an amendment roll beside a passed passage roll on the same bill does not hold it back", () => {
  const agreed = evidence(amendmentAgreedTo(), "a", "2025-07-16").roll;
  const passage = evidence(parseSenateRoll(fixture(BILL_PASSED))!, "p", "2025-07-17").roll;
  const onHr4 = { ...agreed, billKey: "119-HR-4" };
  assert.deepEqual(Object.fromEntries(mintStatuses([onHr4, passage])), { "119-HR-4": "passed_chamber" });
  assert.deepEqual(rollPassageAdvances([onHr4, passage], () => "hr4"), [{ id: "hr4", status: "passed_chamber", via: "p" }]);
});

test("FIX-1408 metadata: byte-identical for every roll with no amendment number; amendment_number last when there is one", () => {
  // The pre-FIX-1408 literal, verbatim from the writer.
  const before = (resultStr: string, resultText: string) =>
    JSON.stringify({ vote_result: resultStr, ...(resultText ? { vote_result_text: resultText } : {}) });
  const want: Array<[string, string]> = [
    [NOMINATION, '{"vote_result":"Nomination Confirmed","vote_result_text":"Nomination Confirmed (47-41)"}'],
    [CLOTURE, '{"vote_result":"Cloture Motion Agreed to","vote_result_text":"Cloture Motion Agreed to (48-47)"}'],
    [BILL_PASSED, '{"vote_result":"Bill Passed","vote_result_text":"Bill Passed (51-48)"}'],
  ];
  for (const [f, json] of want) {
    const root = parseSenateRoll(fixture(f))!;
    const { resultStr, resultText } = senateRollResult(root);
    const { amendmentNumber } = senateBillRef(root, f, ctx("2025-01-01"));
    assert.equal(amendmentNumber, null, f);
    assert.equal(JSON.stringify(senateVoteMetadata({ resultStr, resultText, amendmentNumber })), json, f);
    assert.equal(JSON.stringify(senateVoteMetadata({ resultStr, resultText, amendmentNumber })), before(resultStr, resultText), f);
  }
  // The two shorter shapes: no result text, and no result at all.
  assert.equal(JSON.stringify(senateVoteMetadata({ resultStr: "Bill Passed", resultText: "", amendmentNumber: null })), before("Bill Passed", ""));
  assert.equal(JSON.stringify(senateVoteMetadata({ resultStr: "", resultText: "", amendmentNumber: null })), '{"vote_result":""}');

  const root = parseSenateRoll(fixture(AMDT_MOTION))!;
  const { amendmentNumber } = senateBillRef(root, "senate-119-1-00062", ctx("2025-02-20"));
  assert.equal(
    JSON.stringify(senateVoteMetadata({ ...senateRollResult(root), amendmentNumber })),
    '{"vote_result":"Motion Rejected","vote_result_text":"Motion Rejected (47-52, 3/5 majority required)","amendment_number":"S.Amdt. 454"}',
  );
});
