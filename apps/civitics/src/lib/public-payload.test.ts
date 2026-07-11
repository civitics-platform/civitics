// FIX-788 regression test — the CDN-cached public list payloads must contain
// zero viewer-keyed fields.
//
// /api/statements and /api/questions responses are held in the shared Vercel
// edge cache (not varied by Cookie), so a per-viewer field in either payload is
// served cross-user — the FIX-786/787 incident class. Both routes pass their
// response body through stripViewerKeys(); these tests pin that contract with
// fixtures mirroring the real get_entity_statements / get_entity_questions RPC
// shapes. If a new viewer-keyed field is ever added to either RPC, add it to
// VIEWER_KEYED_FIELDS — never let it ride a cached payload.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VIEWER_KEYED_FIELDS,
  findViewerKeys,
  stripViewerKeys,
} from "./public-payload";

// Mirrors the /api/statements GET body: get_entity_statements' jsonb result
// (each statement carries my_vote — null for anon, but the KEY must not leak
// into the cached body at all) plus the route-added slowMode flag.
const statementsResponse = {
  statements: [
    {
      id: "9f6b2c1e-0000-4000-8000-000000000001",
      body: "This proposal should include a sunset clause.",
      status: "visible",
      source_comment_id: null,
      vote_summary: { agree: 4, disagree: 1, pass: 2 },
      is_constituent: true,
      author_name: "citizen-9f6b2c1e",
      author_is_synthetic: false,
      my_vote: 1,
      created_at: "2026-07-01T00:00:00Z",
    },
    {
      id: "9f6b2c1e-0000-4000-8000-000000000002",
      body: "Second statement.",
      status: "needs_review",
      source_comment_id: "9f6b2c1e-0000-4000-8000-00000000000a",
      vote_summary: { agree: 0, disagree: 0, pass: 0 },
      is_constituent: false,
      author_name: "citizen-11111111",
      author_is_synthetic: true,
      my_vote: null,
      created_at: "2026-07-02T00:00:00Z",
    },
  ],
  nextCursor: "7|2026-07-02T00:00:00Z|9f6b2c1e-0000-4000-8000-000000000002",
  slowMode: false,
};

// Mirrors the /api/questions GET body: get_entity_questions' jsonb result —
// can_answer at the top level, nested answers + community_notes per question.
const questionsResponse = {
  can_answer: true,
  total: 2,
  awaiting: 1,
  questions: [
    {
      id: "9f6b2c1e-0000-4000-8000-000000000003",
      body: "Will you support the transit funding bill?",
      status: "visible",
      created_at: "2026-07-01T00:00:00Z",
      want_count: 12,
      rating_summary: { valuable_up: 12 },
      answered: true,
      answered_at: "2026-07-03T00:00:00Z",
      is_constituent: true,
      asker_name: "citizen-22222222",
      asker_is_synthetic: false,
      answers: [
        {
          id: "9f6b2c1e-0000-4000-8000-000000000004",
          body: "Yes.",
          created_at: "2026-07-03T00:00:00Z",
          is_official: true,
          author_name: "Official Name",
          author_is_synthetic: false,
        },
      ],
      community_notes: [
        {
          id: "9f6b2c1e-0000-4000-8000-000000000005",
          body: "They voted NO on a similar measure — see /votes/x",
          created_at: "2026-07-02T00:00:00Z",
          bridge_score: 0.7,
          rating_summary: { agree_up: 3 },
          is_constituent: false,
          is_endorsed: true,
          author_name: "citizen-33333333",
          author_is_synthetic: false,
        },
      ],
      community_note_count: 1,
    },
  ],
  nextCursor: null,
};

describe("stripViewerKeys", () => {
  it("removes my_vote from every statement in the statements payload", () => {
    const out = stripViewerKeys(statementsResponse);
    assert.deepEqual(findViewerKeys(out), []);
    // The public fields survive untouched.
    assert.equal(out.statements.length, 2);
    const first = out.statements[0];
    const second = out.statements[1];
    const inputFirst = statementsResponse.statements[0];
    assert.ok(first && second && inputFirst);
    assert.equal(first.body, inputFirst.body);
    assert.deepEqual(first.vote_summary, { agree: 4, disagree: 1, pass: 2 });
    assert.equal(out.nextCursor, statementsResponse.nextCursor);
    assert.equal(out.slowMode, false);
    assert.ok(!("my_vote" in first));
    assert.ok(!("my_vote" in second));
  });

  it("removes can_answer from the questions payload, keeps nested lanes intact", () => {
    const out = stripViewerKeys(questionsResponse);
    assert.deepEqual(findViewerKeys(out), []);
    assert.equal(out.total, 2);
    const question = out.questions[0];
    assert.ok(question);
    const answer = question.answers[0];
    const note = question.community_notes[0];
    assert.ok(answer && note);
    assert.equal(answer.body, "Yes.");
    assert.equal(note.is_endorsed, true);
    assert.equal(question.community_note_count, 1);
    // Last: the `in`-absence assertion narrows `out` to never under tsc-strict,
    // so nothing may read `out` after it.
    assert.ok(!("can_answer" in out));
  });

  it("strips viewer keys at ANY depth, including inside arrays", () => {
    const nested = {
      a: [{ my_vote: 1, keep: true }, [{ can_answer: true, deep: { my_vote: null } }]],
      b: { c: { can_answer: false } },
    };
    const out = stripViewerKeys(nested);
    assert.deepEqual(findViewerKeys(out), []);
    assert.equal((out.a[0] as { keep: boolean }).keep, true);
  });

  it("does not mutate the input", () => {
    const input = { my_vote: 1, keep: { can_answer: true } };
    const snapshot = JSON.stringify(input);
    stripViewerKeys(input);
    assert.equal(JSON.stringify(input), snapshot);
  });

  it("passes primitives and null through unchanged", () => {
    assert.equal(stripViewerKeys(null), null);
    assert.equal(stripViewerKeys("my_vote"), "my_vote"); // string VALUES are fine
    assert.equal(stripViewerKeys(42), 42);
  });
});

describe("findViewerKeys", () => {
  it("locates every viewer-keyed field with its path", () => {
    const paths = findViewerKeys(statementsResponse);
    assert.deepEqual(paths, ["$.statements[0].my_vote", "$.statements[1].my_vote"]);
    assert.ok(findViewerKeys(questionsResponse).includes("$.can_answer"));
  });

  it("covers the full documented field list", () => {
    assert.deepEqual([...VIEWER_KEYED_FIELDS], ["my_vote", "can_answer"]);
  });
});
