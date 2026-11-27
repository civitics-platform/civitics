/**
 * FIX-1447 (cc-317 D2, D4) — the roll wording is the gate: a page never prints
 * a verdict derived from recorded counts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ON_RECORD_NOTE,
  ON_RECORD_NOTE_OFFICIAL,
  groupMembers,
  groupRolls,
  headlineRoll,
  onRecordNote,
  partySplit,
  requirementPhrase,
  rollLines,
  rollRecordedLine,
  type MemberVote,
  type OfficialRoll,
  type VoteRoll,
} from "./vote-rolls";

function roll(over: Partial<VoteRoll> = {}): VoteRoll {
  return {
    roll_call_id: "2025-house-145",
    chamber: "House",
    vote_question: "On Passage",
    roll_class: "final",
    voted_at: "2025-05-22T00:00:00+00:00",
    source_url: "https://clerk.house.gov/Votes/2025145",
    vote_result: null,
    rows_on_record: 423,
    yes: 211,
    no: 212,
    present: 0,
    not_voting: 0,
    other: 0,
    by_party: null,
    ...over,
  };
}

/** Any verdict a page could derive from counts, or a score printed as one. */
const DERIVED = /\b(passed|failed|agreed|rejected|confirmed|tied?|carried|defeated|won|lost)\b|\d+\s*[–—-]\s*\d+/i;

test("D2: a Passed roll whose stored yes <= no prints the source's result and the recorded counts — no derived verdict", () => {
  // HR 1's passage roll on the clone: stored 211 yes / 212 no, result Passed.
  const l = rollLines(roll({ vote_result: "Passed" }));
  assert.equal(l.result, "Result: Passed");
  assert.equal(
    l.recorded,
    "Recorded here: 211 yes · 212 no · 0 present · 0 not voting — 423 member votes on record",
  );
  assert.equal(l.heading, "On Passage · House · May 22, 2025");
  // The result line is the only place a verdict word may appear, and it is the source's.
  assert.doesNotMatch(l.heading, DERIVED);
  assert.doesNotMatch(l.recorded.replace(/^Recorded here: /, ""), DERIVED);
});

test("D2: a NULL result prints none, whatever the counts say", () => {
  for (const [yes, no] of [[49, 49], [80, 18], [3, 95]] as const) {
    const l = rollLines(roll({ chamber: "Senate", vote_result: null, yes, no, rows_on_record: yes + no }));
    assert.equal(l.result, null);
    for (const s of [l.heading, l.recorded]) assert.doesNotMatch(s.replace(/^Recorded here: /, ""), DERIVED, s);
  }
  // An empty-string result (pre-FIX-1260 Senate rolls) is no result either.
  assert.equal(rollLines(roll({ vote_result: "  " })).result, null);
});

test("D2: the recorded line shows other casts only when there are some, so the parts sum to the total", () => {
  assert.equal(
    rollRecordedLine({ yes: 1, no: 0, present: 0, not_voting: 0, other: 0, rows_on_record: 1 }),
    "Recorded here: 1 yes · 0 no · 0 present · 0 not voting — 1 member vote on record",
  );
  assert.equal(
    rollRecordedLine({ yes: 5, no: 2, present: 1, not_voting: 0, other: 2, rows_on_record: 10 }),
    "Recorded here: 5 yes · 2 no · 1 present · 0 not voting · 2 other — 10 member votes on record",
  );
});

test("D2: the note says counts can be short and the official roll is the source", () => {
  assert.match(ON_RECORD_NOTE, /short of the official/);
  assert.match(ON_RECORD_NOTE, /official roll is the linked source/);
});

test("D2: a roll with no question or chamber still reads", () => {
  const l = rollLines(roll({ vote_question: null, chamber: "", voted_at: "2026-01-05T00:00:00+00:00" }));
  assert.equal(l.heading, "Recorded vote · January 5, 2026");
});

test("D4: groups are final, advance, other, in input order; five shown and the rest behind details", () => {
  const rolls: VoteRoll[] = [
    ...Array.from({ length: 7 }, (_, i) => roll({ roll_call_id: `f${i}`, roll_class: "final" })),
    roll({ roll_call_id: "o1", roll_class: "other" }),
    roll({ roll_call_id: "a1", roll_class: "advance" }),
    roll({ roll_call_id: "x1", roll_class: "something-new" }),
  ];
  const g = groupRolls(rolls);
  assert.deepEqual(g.map((x) => x.cls), ["final", "advance", "other"]);
  assert.deepEqual(g.map((x) => x.title), ["Votes on passage or confirmation", "Votes to advance", "Procedural votes"]);
  assert.deepEqual(g[0]!.shown.map((r) => r.roll_call_id), ["f0", "f1", "f2", "f3", "f4"]);
  assert.deepEqual(g[0]!.more.map((r) => r.roll_call_id), ["f5", "f6"]);
  assert.deepEqual(g[2]!.shown.map((r) => r.roll_call_id), ["o1", "x1"]);
  assert.equal(g[2]!.more.length, 0);
  assert.deepEqual(groupRolls([roll({ roll_class: "advance" })]).map((x) => x.cls), ["advance"]);
  assert.deepEqual(groupRolls([]), []);
});

test("D4: the headline roll is the newest final roll, else the newest roll", () => {
  const rolls = [
    roll({ roll_call_id: "newest-other", roll_class: "other" }),
    roll({ roll_call_id: "newest-final", roll_class: "final" }),
    roll({ roll_call_id: "older-final", roll_class: "final" }),
  ];
  assert.equal(headlineRoll(rolls)?.roll_call_id, "newest-final");
  assert.equal(
    headlineRoll([roll({ roll_call_id: "a", roll_class: "advance" }), roll({ roll_call_id: "b", roll_class: "other" })])
      ?.roll_call_id,
    "a",
  );
  assert.equal(headlineRoll([]), null);
});

test("D4: a cast's recorded party split, zero parties left out", () => {
  const byParty = {
    democrat: { yes: 0, no: 210, present: 0, not_voting: 0 },
    republican: { yes: 213, no: 2, present: 0, not_voting: 1 },
    independent: { yes: 1, no: 0, present: 0, not_voting: 0 },
  };
  assert.equal(partySplit(byParty, "yes"), "R 213 · I 1");
  assert.equal(partySplit(byParty, "no"), "D 210 · R 2");
  assert.equal(partySplit(byParty, "present"), null);
  assert.equal(partySplit(byParty, "paired_yes"), null);
  assert.equal(partySplit(null, "yes"), null);
  assert.equal(partySplit({ other: { yes: 3, no: 0, present: 0, not_voting: 0 } }, "yes"), "Other 3");
});

test("D4: members group by cast in a fixed order, by name inside a cast", () => {
  const m = (id: string, vote: string, name: string): MemberVote => ({
    id,
    vote,
    official: { id: `o${id}`, full_name: name, party: null, district_name: null, role_title: "Senator" },
  });
  const g = groupMembers([m("1", "no", "Zed"), m("2", "yes", "Bea"), m("3", "yes", "Al"), m("4", "weird", "Q"), m("5", "not_voting", "C")]);
  assert.deepEqual(g.map((x) => x.vote), ["yes", "no", "not_voting", "weird"]);
  assert.deepEqual(g.map((x) => x.label), ["Yes", "No", "Not Voting", "weird"]);
  assert.deepEqual(g[0]!.members.map((x) => x.official?.full_name), ["Al", "Bea"]);
});

// ── FIX-1461 (cc-332 V1–V10): the roll's own row in vote_rolls ───────────────
// Values are cc-331's fixtures (packages/data/src/pipelines/congress/__fixtures__)
// and cc-332's prod reads, copied.

function official(over: Partial<OfficialRoll> = {}): OfficialRoll {
  return {
    roll_call_id: "2025-house-145",
    question: null,
    title: null,
    result: null,
    yea: null,
    nay: null,
    present: null,
    not_voting: null,
    majority_requirement: null,
    tie_breaker: null,
    by_party: null,
    detail_source: null,
    ...over,
  };
}

test("V2–V5: a detailed House roll prints the clerk's result, the four counts and N of M on record", () => {
  // HR 1's House passage roll (prod read 3): 215 / 214 / 1 / 2, YEA-AND-NAY, 426 rows stored.
  const r = roll({ vote_result: "Passed", rows_on_record: 426, yes: 213, no: 211, present: 1, not_voting: 1 });
  const o = official({
    result: "Passed", yea: 215, nay: 214, present: 1, not_voting: 2,
    majority_requirement: "YEA-AND-NAY", detail_source: "clerk_xml", title: "One Big Beautiful Act",
  });
  const l = rollLines(r, o, { measureTitle: "An act to provide for reconciliation pursuant to title II of H. Con. Res. 14.", number: "HR 1" });
  assert.equal(l.result, "Result: Passed");
  assert.equal(l.official, "Official count: 215 yea · 214 nay · 1 present · 2 not voting");
  assert.equal(l.recorded, "Recorded here: 213 yes · 211 no · 1 present · 1 not voting — 426 of 432 member votes on record");
  assert.equal(l.title, "One Big Beautiful Act");
  assert.equal(l.tieBreaker, null);
});

test("V4: a two-thirds roll that failed with more yeas carries the requirement on its result line", () => {
  // HJRES 1's 2026-house-293 (prod read 3): Failed, 212 yea / 206 nay / 0 / 15, 432 of 433.
  const r = roll({ roll_call_id: "2026-house-293", vote_result: "Failed", rows_on_record: 432, yes: 211, no: 206, present: 0, not_voting: 15 });
  const o = official({
    roll_call_id: "2026-house-293", result: "Failed", yea: 212, nay: 206, present: 0, not_voting: 15,
    majority_requirement: "2/3 YEA-AND-NAY", detail_source: "clerk_xml",
  });
  const l = rollLines(r, o);
  assert.equal(l.result, "Result: Failed · two-thirds required");
  assert.equal(l.official, "Official count: 212 yea · 206 nay · 0 present · 15 not voting");
  assert.match(l.recorded, /— 432 of 433 member votes on record$/);
  // The result stays the source's word: nothing here says the yeas "won".
  assert.doesNotMatch(`${l.result} ${l.official}`, /\b(passed|carried|won|majority)\b/i);
});

test("V4: the vocabulary — only a leading fraction is a requirement", () => {
  // cc-332 read 2: every majority_requirement value on prod.
  assert.equal(requirementPhrase("2/3 YEA-AND-NAY"), "two-thirds required");
  assert.equal(requirementPhrase("2/3 RECORDED VOTE"), "two-thirds required");
  assert.equal(requirementPhrase("YEA-AND-NAY"), null);
  assert.equal(requirementPhrase("RECORDED VOTE"), null);
  assert.equal(requirementPhrase("1/2"), null);
  assert.equal(requirementPhrase("3/5"), "three-fifths required");
  assert.equal(requirementPhrase("3/4"), "3/4 required");
  assert.equal(requirementPhrase(null), null);
  // YEA-AND-NAY and RECORDED VOTE rolls print a plain result line.
  for (const req of ["YEA-AND-NAY", "RECORDED VOTE"]) {
    const l = rollLines(roll({ vote_result: "Passed" }), official({ result: "Passed", majority_requirement: req, detail_source: "clerk_xml" }));
    assert.equal(l.result, "Result: Passed", req);
  }
  // The requirement stands alone when no result is held.
  assert.equal(
    rollLines(roll({ vote_result: null }), official({ majority_requirement: "3/5", detail_source: "lis_roll_xml" })).result,
    "Three-fifths required",
  );
});

test("V3/V5/V6: a list-only Senate roll prints yea and nay only, no 'of M', its title cut at the first '; '", () => {
  // senate-119-2-00243 as the session list prints it (lis-vote-menu-119-2.xml).
  const r = roll({ roll_call_id: "senate-119-2-00243", chamber: "Senate", vote_question: "On the Cloture Motion", roll_class: "advance", vote_result: null, rows_on_record: 98, yes: 73, no: 25, present: 0, not_voting: 0 });
  const o = official({
    roll_call_id: "senate-119-2-00243", question: "On the Cloture Motion", result: "Agreed to", yea: 74, nay: 25,
    title: "Motion to Invoke Cloture: S. 4668, as Amended; A bill to protect the name, image, and likeness rights of, and provide protections for, student athletes and to promote fair competition among intercollegiate athletics, and for other purposes.",
  });
  const l = rollLines(r, o);
  assert.equal(l.result, "Result: Agreed to");
  assert.equal(l.official, "Official count: 74 yea · 25 nay");
  assert.doesNotMatch(l.official!, /present|not voting/);
  assert.equal(l.recorded, "Recorded here: 73 yes · 25 no · 0 present · 0 not voting — 98 member votes on record");
  assert.equal(l.title, "Motion to Invoke Cloture: S. 4668, as Amended");
  assert.equal(l.byParty, null);
});

test("V2: a list-only roll keeps the stored per-roll result over the list's short form; a detailed roll prints its file's", () => {
  // HR 1's senate-119-1-00366 on prod: stored "Amendment Rejected", list "Rejected".
  const listOnly = official({ result: "Rejected", yea: 49, nay: 51 });
  assert.equal(rollLines(roll({ vote_result: "Amendment Rejected" }), listOnly).result, "Result: Amendment Rejected");
  // senate-119-1-00359: nothing stored, so the list's word.
  assert.equal(rollLines(roll({ vote_result: null }), listOnly).result, "Result: Rejected");
  // A detailed row's own result wins over the stored one.
  const detailed = official({ result: "Amendment Rejected", detail_source: "lis_roll_xml", yea: 49, nay: 51, present: 0, not_voting: 0 });
  assert.equal(rollLines(roll({ vote_result: "Rejected" }), detailed).result, "Result: Amendment Rejected");
});

test("V3/V4: a detailed Senate roll at 3/5 prints its four counts and three-fifths required", () => {
  // lis-senate-119-2-00243-cloture-three-fifths.xml: 74 / 25 / <present/> = 0 / absent 1.
  const r = roll({ roll_call_id: "senate-119-2-00243", chamber: "Senate", roll_class: "advance", vote_result: "Cloture Motion Agreed to", rows_on_record: 98, yes: 73, no: 25 });
  const o = official({
    result: "Cloture Motion Agreed to", yea: 74, nay: 25, present: 0, not_voting: 1, majority_requirement: "3/5",
    detail_source: "lis_roll_xml", title: "Motion to Invoke Cloture: S. 4668, as Amended",
  });
  const l = rollLines(r, o);
  assert.equal(l.result, "Result: Cloture Motion Agreed to · three-fifths required");
  assert.equal(l.official, "Official count: 74 yea · 25 nay · 0 present · 1 not voting");
  assert.match(l.recorded, /— 98 of 100 member votes on record$/);
  // A detailed Senate title has no document text appended, so nothing is cut.
  assert.equal(l.title, "Motion to Invoke Cloture: S. 4668, as Amended");
});

test("V7: a tie-breaking vote is printed when the row has one", () => {
  // lis-senate-119-1-00372-tie-breaker.xml — HR 1's Senate passage, 50–50.
  const o = official({
    result: "Bill Passed", yea: 50, nay: 50, present: 0, not_voting: 0, majority_requirement: "1/2",
    detail_source: "lis_roll_xml", title: "H.R. 1, as Amended",
    tie_breaker: { by_whom: "Vice President of the United States", vote: "Yea" },
  });
  const l = rollLines(roll({ chamber: "Senate", vote_result: "Bill Passed", rows_on_record: 99 }), o, { number: "HR 1" });
  assert.equal(l.tieBreaker, "Tie-breaking vote: Vice President of the United States — Yea");
  assert.equal(l.result, "Result: Bill Passed");
  assert.equal(l.title, "H.R. 1, as Amended");
  assert.equal(rollLines(roll(), official({ tie_breaker: { by_whom: "Vice President", vote: null } })).tieBreaker, "Tie-breaking vote: Vice President");
  assert.equal(rollLines(roll(), official()).tieBreaker, null);
});

test("V5: rows on record above the official sum print no 'of'", () => {
  const l = rollLines(roll({ rows_on_record: 440 }), official({ yea: 215, nay: 214, present: 1, not_voting: 2, detail_source: "clerk_xml" }));
  assert.equal(l.recorded, "Recorded here: 211 yes · 212 no · 0 present · 0 not voting — 440 member votes on record");
  // Exactly the sum is still "of".
  assert.match(rollLines(roll({ rows_on_record: 432 }), official({ yea: 215, nay: 214, present: 1, not_voting: 2 })).recorded, /— 432 of 432 member/);
});

test("V1: a roll with no row, and a failed read, print today's lines byte for byte", () => {
  const r = roll({ vote_result: "Passed" });
  const before = {
    heading: "On Passage · House · May 22, 2025",
    result: "Result: Passed",
    recorded: "Recorded here: 211 yes · 212 no · 0 present · 0 not voting — 423 member votes on record",
  };
  for (const l of [rollLines(r), rollLines(r, null), rollLines(r, null, { measureTitle: "x", number: "HR 1" })]) {
    assert.deepEqual({ heading: l.heading, result: l.result, recorded: l.recorded }, before);
    assert.equal(l.official, null);
    assert.equal(l.title, null);
    assert.equal(l.byParty, null);
    assert.equal(l.tieBreaker, null);
  }
  // A row whose fields are all NULL (a House roll not read yet) changes nothing either.
  const empty = rollLines(r, official());
  assert.deepEqual({ heading: empty.heading, result: empty.result, recorded: empty.recorded }, before);
  assert.equal(empty.official, null);
});

test("V8: the official count by party on a final roll, absent on a procedural one", () => {
  // clerk-house-2025-362-passage.xml — HR 498, On Passage.
  const by_party = [
    { party: "Republican", yea: 211, nay: 0, present: 0, not_voting: 9 },
    { party: "Democratic", yea: 4, nay: 201, present: 0, not_voting: 8 },
    { party: "Independent", yea: 0, nay: 0, present: 0, not_voting: 0 },
  ];
  const o = official({ result: "Passed", yea: 215, nay: 201, present: 0, not_voting: 17, by_party, detail_source: "clerk_xml" });
  assert.equal(rollLines(roll({ roll_class: "final" }), o).byParty, "By party (yea–nay): Republican 211–0 · Democratic 4–201");
  assert.equal(rollLines(roll({ roll_class: "advance" }), o).byParty, "By party (yea–nay): Republican 211–0 · Democratic 4–201");
  assert.equal(rollLines(roll({ roll_class: "other" }), o).byParty, null);
  assert.equal(rollLines(roll({ roll_class: "final" }), official({ by_party: null })).byParty, null);
});

test("V6: the roll's title is omitted when it is the measure's title, short title or number", () => {
  const o = official({ title: "One Big Beautiful Bill Act", detail_source: "clerk_xml" });
  assert.equal(rollLines(roll(), o, { shortTitle: "One Big Beautiful Bill Act" }).title, null);
  assert.equal(rollLines(roll(), o, { measureTitle: "one big  BEAUTIFUL bill act" }).title, null);
  assert.equal(rollLines(roll(), official({ title: "H.R. 1" }), { number: "HR 1" }).title, null);
  assert.equal(rollLines(roll(), o, { measureTitle: "An act to provide for reconciliation" }).title, "One Big Beautiful Bill Act");
});

test("V9: the note names the chamber's count once one roll prints it, and keeps today's sentence otherwise", () => {
  assert.equal(onRecordNote(false), ON_RECORD_NOTE);
  assert.equal(
    onRecordNote(true),
    "The result and the official count are the chamber's own, read from the linked roll. “Recorded here” counts only the members Civitics holds a record for, so it can be short of the official count.",
  );
  assert.equal(ON_RECORD_NOTE_OFFICIAL, onRecordNote(true));
});

test("V10: the heading falls back to the roll's own question when the stored one is empty", () => {
  const l = rollLines(roll({ vote_question: "  " }), official({ question: "On the Cloture Motion" }));
  assert.equal(l.heading, "On the Cloture Motion · House · May 22, 2025");
  assert.equal(rollLines(roll({ vote_question: "On Passage" }), official({ question: "Other" })).heading, "On Passage · House · May 22, 2025");
});

test("V3: a NULL count is never printed as 0", () => {
  for (const o of [official({ yea: 10 }), official({ nay: 10 }), official({ yea: null, nay: null, present: 0, not_voting: 0 })]) {
    assert.equal(rollLines(roll(), o).official, null);
  }
  assert.equal(rollLines(roll(), official({ yea: 10, nay: 2, not_voting: 1 })).official, "Official count: 10 yea · 2 nay · 1 not voting");
});
