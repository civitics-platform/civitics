/**
 * FIX-1257 — the status evidence the congress path reads.
 *
 * mapBillStatus: the texts are prod's most common federal `latest_action`
 * classes (cc-181 read 3, 2026-10-03). The ones that prove no stage now map to
 * null — before FIX-1257 they fell to `introduced`, and the sync wrote that
 * over a bill that had passed a chamber.
 *
 * rollPassageAdvances: only a PASSAGE roll with a passing result is evidence;
 * cloture, amendments, recommit motions and failed rolls are not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapBillStatus, isPassageQuestion, rollPassageAdvances, type RollEvidence } from "./bill-status";
import type { ProposalStatus } from "./status-rank";

const TEXTS: Array<[string | undefined, ProposalStatus | null]> = [
  // stage-less: null (each was `introduced` before FIX-1257)
  ["Motion to reconsider laid on the table Agreed to without objection.", null],
  ["Received in the Senate.", null],
  ["Held at the desk.", null],
  ["Message on Senate action sent to the House.", null],
  ["Placed on the Union Calendar, Calendar No. 312.", null],
  ["Placed on Senate Legislative Calendar under General Orders. Calendar No. 140.", null],
  ["Committee on Energy and Natural Resources Subcommittee on Public Lands, Forests, and Mining. Hearings held.", null],
  ["Committee on Energy and Natural Resources. Hearings held.", null],
  ["Subcommittee Hearings Held", null],
  ["Forwarded by Subcommittee to Full Committee by Voice Vote.", null],
  ["Motion to proceed to consideration of measure rejected in Senate by Yea-Nay Vote. 45 - 52. Record Vote Number: 101.", null],
  ["Presented to President.", null],
  // positive matches — unchanged
  ["Introduced in House", "introduced"],
  ["Introduced in Senate", "introduced"],
  [undefined, "introduced"],
  ["", "introduced"],
  ["Referred to the House Committee on the Judiciary.", "in_committee"],
  ["Read twice and referred to the Committee on Finance.", "in_committee"],
  ["Received in the Senate and Read twice and referred to the Committee on Health, Education, Labor, and Pensions.", "in_committee"],
  ["Ordered to be Reported (Amended) by the Yeas and Nays: 30 - 20.", "passed_committee"],
  ["Ordered to be Reported in the Nature of a Substitute (Amended) by Voice Vote.", "passed_committee"],
  ["Passed Senate without amendment by Unanimous Consent.", "passed_chamber"],
  [
    "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by the Yeas and Nays: (2/3 required): 399 - 15 (Roll no. 250).",
    "passed_chamber",
  ],
  ["Vetoed by President.", "vetoed"],
  ["Signed by President.", "enacted"],
  ["Became Public Law No: 119-12.", "enacted"],
];

for (const [text, want] of TEXTS) {
  test(`FIX-1257 mapBillStatus(${JSON.stringify(text)}) → ${want}`, () => {
    assert.equal(mapBillStatus(text), want);
  });
}

test("FIX-1257 isPassageQuestion — prod's passage questions in, everything else out", () => {
  for (const q of [
    "On Passage",
    "On Passage of the Bill",
    "On Motion to Suspend the Rules and Pass",
    "On Motion to Suspend the Rules and Pass, as Amended",
    "  on   passage ",
  ]) {
    assert.equal(isPassageQuestion(q), true, q);
  }
  for (const q of [
    "On Motion to Recommit",
    "On Agreeing to the Amendment",
    "On Cloture on the Motion to Proceed",
    "On the Cloture Motion",
    "On Motion to Commit",
    "On Ordering the Previous Question",
    "Passage, Objections of the President To The Contrary Notwithstanding",
    "",
  ]) {
    assert.equal(isPassageQuestion(q), false, q);
  }
});

const roll = (rollCallId: string, billKey: string | null, voteQuestion: string, resultStr: string): RollEvidence => ({
  rollCallId,
  billKey,
  voteQuestion,
  resultStr,
});

test("FIX-1257 rollPassageAdvances — a passed passage roll asks for passed_chamber; nothing else does", () => {
  const ids = new Map([
    ["119-HR-1", "p1"],
    ["119-HR-2", "p2"],
    ["119-HR-3", "p3"],
    ["119-HR-4", "p4"],
    ["119-HR-5", "p5"],
  ]);
  const pairs = rollPassageAdvances(
    [
      roll("2026-house-001", "119-HR-1", "On Passage", "Passed"),
      roll("2026-house-002", "119-HR-2", "On Motion to Suspend the Rules and Pass, as Amended", "Passed"),
      roll("2026-house-003", "119-HR-3", "On Motion to Recommit", "Passed"), // procedural — not evidence
      roll("2026-house-004", "119-HR-4", "On Passage", "Failed"), // a failed roll writes nothing
      roll("2026-house-005", "119-HR-5", "On Agreeing to the Amendment", "Agreed to"), // amendment
      roll("2026-house-006", "119-HR-1", "On Passage", "Passed"), // second roll, same bill — one pair
      roll("2026-house-007", null, "On Passage", "Passed"), // no bill
      roll("senate-119-2-00250", "119-S-9", "On Passage of the Bill", ""), // Senate today: result "" (FIX-1260)
    ],
    (k) => (k ? (ids.get(k) ?? null) : null),
  );
  assert.deepEqual(pairs, [
    { id: "p1", status: "passed_chamber", via: "2026-house-001" },
    { id: "p2", status: "passed_chamber", via: "2026-house-002" },
  ]);
});
