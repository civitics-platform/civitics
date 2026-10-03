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
import {
  mapBillStatus,
  isPassageQuestion,
  rollPassageAdvances,
  mintStatuses,
  stampMintStatuses,
  MINT_FLOOR,
  type RollEvidence,
} from "./bill-status";
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

// FIX-1262 — the same function WITH the origin chamber. The table above is the
// chamber-less call and is unchanged; these are the only texts the chamber moves.
const WITH_CHAMBER: Array<[string, "house" | "senate", ProposalStatus | null]> = [
  ["Received in the Senate.", "house", "passed_chamber"],
  ["Received in the Senate and Read twice and referred to the Committee on Finance.", "house", "passed_chamber"], // was in_committee
  ["Held at the desk.", "senate", "passed_chamber"],
  ["Message on Senate action sent to the House.", "senate", "passed_chamber"],
  ["Message on Senate action sent to the House.", "house", "passed_chamber"], // the Senate acted on a House measure
  // the wrong chamber proves nothing new
  ["Received in the Senate.", "senate", null],
  ["Received in the Senate and Read twice and referred to the Committee on Finance.", "senate", "in_committee"],
  ["Held at the desk.", "house", null],
  // stronger evidence still wins; unrelated texts are unchanged
  ["Became Public Law No: 119-12.", "house", "enacted"],
  ["Passed Senate without amendment by Unanimous Consent.", "senate", "passed_chamber"],
  ["Referred to the House Committee on the Judiciary.", "house", "in_committee"],
  ["Motion to reconsider laid on the table Agreed to without objection.", "house", null],
  ["Introduced in Senate", "senate", "introduced"],
];

for (const [text, chamber, want] of WITH_CHAMBER) {
  test(`FIX-1262 mapBillStatus(${JSON.stringify(text)}, ${chamber}) → ${want}`, () => {
    assert.equal(mapBillStatus(text, chamber), want);
  });
}

test("FIX-1262 without the chamber, every FIX-1262 text maps exactly as before (rule 105: the arm is chamber-gated)", () => {
  assert.equal(mapBillStatus("Received in the Senate."), null);
  assert.equal(mapBillStatus("Received in the Senate and Read twice and referred to the Committee on Finance."), "in_committee");
  assert.equal(mapBillStatus("Held at the desk."), null);
  assert.equal(mapBillStatus("Message on Senate action sent to the House."), null);
});

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

// ---------------------------------------------------------------------------
// FIX-1261 — the vote-path mint reads the question, over every buffered roll
// ---------------------------------------------------------------------------

test("FIX-1261 isPassageQuestion — resolution adoption and concurrence join; procedural questions stay out", () => {
  for (const q of [
    // House resolutions (cc-185 read 2: 249 + 12 + 26 + 17 + 2 + 3 + 1 rolls)
    "On Agreeing to the Resolution",
    "On Agreeing to the Resolution, as Amended",
    "On Motion to Suspend the Rules and Agree",
    "On Motion to Suspend the Rules and Agree, as Amended",
    "On Motion to Suspend the Rules and Agree, As Amended",
    "On Motion to Suspend the Rules and Agree to the Resolution",
    "On Motion to Suspend the Rules and Agree to the Resolution, as Amended",
    // concurrence — proves this chamber passed the measure
    "On Motion to Concur in the Senate Amendment",
    "On Motion to Suspend the Rules and Concur in the Senate Amendment",
    // Senate measures
    "On the Joint Resolution",
    "On the Resolution",
    "On the Concurrent Resolution",
    "On the Conference Report",
  ]) {
    assert.equal(isPassageQuestion(q), true, q);
  }
  for (const q of [
    "On Ordering the Previous Question", // 182 rolls; the HRES passed_chamber mint artifact
    "On Consideration of the Resolution",
    "On Motion to Table",
    "Table Motion to Reconsider",
    "On Motion to Discharge",
    "On the Nomination",
    "On the Motion", // the Senate names the motion only in vote_title
    "On the Motion to Proceed",
    "On Cloture on the Motion to Proceed",
    "On Overriding the Veto",
  ]) {
    assert.equal(isPassageQuestion(q), false, q);
  }
});

const minted = (rolls: RollEvidence[]) => Object.fromEntries(mintStatuses(rolls));

// Rule 105: each of the first three is RED against the pre-FIX-1261 mint
// (mapVoteResult of the FIRST roll) — failed, failed, passed_chamber.
test("FIX-1261 a failed recommit motion as the first (and only) roll mints floor_vote, not failed", () => {
  assert.deepEqual(minted([roll("2026-house-101", "119-HR-1", "On Motion to Recommit", "Failed")]), { "119-HR-1": "floor_vote" });
});

test("FIX-1261 a failed first roll then a passed passage roll mints passed_chamber — decided over every roll, not the first", () => {
  assert.deepEqual(
    minted([
      roll("2026-house-101", "119-HR-1", "On Motion to Recommit", "Failed"),
      roll("2026-house-102", "119-HR-1", "On Passage", "Passed"),
    ]),
    { "119-HR-1": "passed_chamber" },
  );
});

test("FIX-1261 a passed previous-question vote mints floor_vote; the resolution's own adoption roll makes it passed_chamber", () => {
  assert.deepEqual(minted([roll("2026-house-201", "119-HRES-9", "On Ordering the Previous Question", "Passed")]), {
    "119-HRES-9": "floor_vote",
  });
  assert.deepEqual(
    minted([
      roll("2026-house-201", "119-HRES-9", "On Ordering the Previous Question", "Passed"),
      roll("2026-house-202", "119-HRES-9", "On Agreeing to the Resolution", "Agreed to"),
    ]),
    { "119-HRES-9": "passed_chamber" },
  );
});

test("FIX-1261 a FAILED passage roll mints floor_vote — a failed passage vote is not terminal (bills get re-voted)", () => {
  assert.deepEqual(minted([roll("2026-house-301", "119-HR-3", "On Motion to Suspend the Rules and Pass", "Failed")]), {
    "119-HR-3": "floor_vote",
  });
});

test("FIX-1261 a passed amendment roll is not passage — floor_vote", () => {
  assert.deepEqual(minted([roll("2026-house-401", "119-HR-4", "On Agreeing to the Amendment", "Agreed to")]), {
    "119-HR-4": "floor_vote",
  });
});

test("FIX-1261 a nomination mints floor_vote whatever its result — what every PN on prod carries", () => {
  assert.deepEqual(
    minted([
      roll("senate-119-2-00256", "119-PN-1129", "On the Cloture Motion", "Cloture Motion Agreed to"),
      roll("senate-119-2-00257", "119-PN-1129", "On the Nomination", "Nomination Confirmed"),
    ]),
    { "119-PN-1129": "floor_vote" },
  );
});

test("FIX-1261 failed is never minted — every result on every question", () => {
  const qs = ["On Passage", "On Motion to Recommit", "On Agreeing to the Amendment", "On the Cloture Motion", "On the Nomination"];
  const rs = ["Failed", "Rejected", "Amendment Rejected", "Motion Rejected", "Nomination Rejected", ""];
  for (const q of qs) {
    for (const r of rs) {
      assert.notEqual(mintStatuses([roll("r", "k", q, r)]).get("k"), "failed", `${q} / ${r}`);
    }
  }
});

test("FIX-1261 stampMintStatuses overwrites the placeholder on every buffered bill; a roll with no bill is ignored", () => {
  const args = new Map([
    ["119-HR-1", { status: MINT_FLOOR as ProposalStatus | null }],
    ["119-HR-2", { status: MINT_FLOOR as ProposalStatus | null }],
    ["119-HR-3", { status: "failed" as ProposalStatus | null }], // a key with no buffered roll → MINT_FLOOR
  ]);
  stampMintStatuses(args, [
    roll("2026-house-001", "119-HR-1", "On Passage", "Passed"),
    roll("2026-house-002", "119-HR-2", "On Motion to Recommit", "Failed"),
    roll("2026-house-003", null, "On Passage", "Passed"),
  ]);
  assert.deepEqual(Object.fromEntries([...args].map(([k, a]) => [k, a.status])), {
    "119-HR-1": "passed_chamber",
    "119-HR-2": "floor_vote",
    "119-HR-3": "floor_vote",
  });
});

test("FIX-1261 rollPassageAdvances uses the extended list — a resolution adopted by roll advances", () => {
  const pairs = rollPassageAdvances(
    [roll("2026-house-202", "119-HRES-9", "On Agreeing to the Resolution", "Agreed to")],
    () => "hres9",
  );
  assert.deepEqual(pairs, [{ id: "hres9", status: "passed_chamber", via: "2026-house-202" }]);
});
