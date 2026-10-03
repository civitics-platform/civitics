/**
 * FIX-1260 — the Senate LIS XML, as senate.gov serves it. The three fixtures
 * are real rolls fetched 2026-10-03 (cc-185), member lists cut to three:
 *   senate-119-2-00256  On the Nomination      / Nomination Confirmed
 *   senate-119-1-00431  On the Cloture Motion  / Cloture Motion Agreed to
 *   senate-119-1-00411  On Passage of the Bill / Bill Passed   (H.R. 4)
 * They are the first Senate fixtures in the tree. Before FIX-1260 the writer
 * read root["result"], which none of them has — every stored Senate roll got
 * vote_result ''.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parseSenateRoll, senateRollResult } from "./votes";
import { mapVoteResult } from "./members";
import { mintStatuses, rollPassageAdvances } from "./bill-status";

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
