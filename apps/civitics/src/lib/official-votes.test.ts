/**
 * FIX-1449 (cc-325 D2–D4) — the officials page's vote words.
 *
 * Runs via:  tsx --test src/lib/official-votes.test.ts
 *
 * The load-bearing assertions: the caption never says "all" over the window the
 * body returns; a row from the body before FIX-1449 (no voted_at, no
 * roll_class) yields NO class line and NO class word rather than zeros; the
 * issue bars count only final rolls; a row without a title never prints
 * "Procedural vote".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakdownCaption,
  breakdownClasses,
  issueCaption,
  officialVoteBreakdown,
  passageVotes,
  voteClass,
  voteRowLine,
  type OfficialVoteRow,
} from "./official-votes";

/** A row as the FIX-1449 body returns it. */
const row = (over: Partial<OfficialVoteRow> = {}): OfficialVoteRow => ({
  vote: "yes",
  voted_at: "2026-07-03T00:00:00+00:00",
  roll_call_id: "2026-house-190",
  vote_question: "On Passage",
  chamber: "House",
  roll_class: "final",
  ...over,
});

/** A row as the body BEFORE FIX-1449 returned it: vote and proposal only. */
const oldRow = (vote = "yes"): OfficialVoteRow => ({ vote });

// ── D2: the caption ─────────────────────────────────────────────────────────

test("D2: the new body's 500 rows read 'Last 500 votes'", () => {
  const rows = Array.from({ length: 500 }, () => row());
  assert.equal(breakdownCaption(rows), "Last 500 votes");
});

test("D2: shape (b) never prints 'all' — not at 500, not when the window holds every vote, not at 1", () => {
  for (const len of [1, 2, 37, 499, 500]) {
    const rows = Array.from({ length: len }, () => row());
    const b = officialVoteBreakdown(rows);
    for (const words of [b.caption, b.classes, issueCaption(rows)]) {
      assert.doesNotMatch(words ?? "", /\ball\b/i, `${len}: ${words}`);
    }
  }
  assert.equal(breakdownCaption([row()]), "Last 1 vote");
  assert.equal(breakdownCaption(Array.from({ length: 37 }, () => row())), "Last 37 votes");
});

test("D2: the old body's unordered 500 is a sample, not the last 500", () => {
  const rows = Array.from({ length: 500 }, () => oldRow());
  assert.equal(breakdownCaption(rows), "A sample of 500 votes");
  assert.doesNotMatch(breakdownCaption(rows) ?? "", /last|all/i);
});

test("D2: no rows, no caption — a failed or empty read is not a claim", () => {
  assert.equal(breakdownCaption([]), null);
  assert.deepEqual(officialVoteBreakdown([]), { yes: 0, no: 0, abstain: 0, total: 0, caption: null, classes: null });
});

// ── D2/D3: the class line ───────────────────────────────────────────────────

test("D3: the class line counts each roll class; an unknown class is procedural", () => {
  const rows = [
    row({ roll_class: "final" }),
    row({ roll_class: "final" }),
    row({ roll_class: "advance" }),
    row({ roll_class: "other" }),
    row({ roll_class: "something-new" }),
  ];
  assert.equal(breakdownClasses(rows), "2 on passage · 1 to advance · 2 procedural");
  assert.equal(breakdownClasses(Array.from({ length: 1200 }, () => row())), "1,200 on passage · 0 to advance · 0 procedural");
});

test("D3: a key the old body lacks reads as absent, never as zero", () => {
  const b = officialVoteBreakdown([oldRow("yes"), oldRow("no"), oldRow("not_voting")]);
  assert.equal(b.classes, null, "no '0 on passage' over rows that carry no class");
  assert.equal(b.caption, "A sample of 3 votes");
  assert.deepEqual([b.yes, b.no, b.abstain, b.total], [1, 1, 1, 3]);
  assert.equal(issueCaption([oldRow()]), null);
  assert.deepEqual(passageVotes([oldRow(), oldRow()]), [], "no issue bars from unclassed rows");
});

test("the cast boxes keep their grouping: paired with its side, present and not voting with abstain", () => {
  const casts = ["yes", "paired_yes", "no", "paired_no", "abstain", "not_voting", "present"];
  const b = officialVoteBreakdown(casts.map((vote) => row({ vote })));
  assert.deepEqual([b.yes, b.no, b.abstain, b.total], [2, 2, 3, 7]);
});

// ── D3: the issue bars ──────────────────────────────────────────────────────

test("D3: the issue bars count only final rolls, and their caption says so", () => {
  const rows = [
    row({ roll_call_id: "f1", roll_class: "final" }),
    row({ roll_call_id: "a1", roll_class: "advance" }),
    row({ roll_call_id: "o1", roll_class: "other" }),
    row({ roll_call_id: "f2", roll_class: "final" }),
    row({ roll_call_id: "n1", roll_class: null }),
  ];
  assert.deepEqual(passageVotes(rows).map((r) => r.roll_call_id), ["f1", "f2"]);
  const five = rows.filter((r) => r.roll_class != null);
  assert.equal(issueCaption(five), "On passage votes among the last 4");
  assert.equal(issueCaption(Array.from({ length: 500 }, () => row())), "On passage votes among the last 500");
});

// ── D4: a vote row ──────────────────────────────────────────────────────────

test("D4: a final row prints its title, then question · chamber, and no class word", () => {
  assert.deepEqual(
    voteRowLine({ title: "Lower Energy Costs Act", vote_question: "On Passage", chamber: "House", roll_class: "final" }),
    { title: "Lower Energy Costs Act", detail: "On Passage · House", classWord: null },
  );
});

test("D4: an advance row carries 'to advance'", () => {
  assert.deepEqual(
    voteRowLine({ title: "A bill", vote_question: "On the Cloture Motion", chamber: "Senate", roll_class: "advance" }),
    { title: "A bill", detail: "On the Cloture Motion · Senate", classWord: "to advance" },
  );
});

test("D4: an other row carries 'procedural'", () => {
  assert.deepEqual(
    voteRowLine({ title: "A bill", vote_question: "On Motion to Recommit", chamber: "House", roll_class: "other" }),
    { title: "A bill", detail: "On Motion to Recommit · House", classWord: "procedural" },
  );
});

test("D4: a row with no title prints the question as its title — never 'Procedural vote'", () => {
  const line = voteRowLine({ title: "", vote_question: "On the Nomination", chamber: "Senate", roll_class: "final" });
  assert.deepEqual(line, { title: "On the Nomination", detail: "Senate", classWord: null });
  const bare = voteRowLine({ title: null, vote_question: null, chamber: null, roll_class: null });
  assert.equal(bare.title, "Recorded vote");
  for (const l of [line, bare]) assert.doesNotMatch(JSON.stringify(l), /Procedural vote/);
});

test("D4: an old-body row (no question, chamber or class) prints its title alone", () => {
  assert.deepEqual(voteRowLine({ title: "A bill" }), { title: "A bill", detail: null, classWord: null });
  assert.equal(voteClass(undefined), null);
  assert.equal(voteClass("final"), "final");
  assert.equal(voteClass("weird"), "other");
});
