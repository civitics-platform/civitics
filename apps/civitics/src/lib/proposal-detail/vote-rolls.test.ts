/**
 * FIX-1447 (cc-317 D2, D4) — the roll wording is the gate: a page never prints
 * a verdict derived from recorded counts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ON_RECORD_NOTE,
  groupMembers,
  groupRolls,
  headlineRoll,
  partySplit,
  rollLines,
  rollRecordedLine,
  type MemberVote,
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
