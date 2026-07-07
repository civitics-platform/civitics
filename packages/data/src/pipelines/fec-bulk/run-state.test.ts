/**
 * FIX-754 — checkpoint/resume decision logic for the fec_bulk indiv ingest.
 *
 * Pins the pure helpers in run-state.ts: run identity (cycle + FEC
 * Last-Modified), the per-cycle resume plan, stage-marker transitions, and the
 * cursor-resolution defensive reset. No I/O — the DB wrappers are thin enough
 * that the local kill/resume proof covers them.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/run-state.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEC_RUN_STATE_VERSION,
  TRACKED_STAGES,
  INDIV_WRITER_STAGES,
  createRunState,
  parseRunState,
  sameLastModified,
  planCycleResume,
  stageIsComplete,
  allIndivWriterStagesComplete,
  markStageComplete,
  updateStageCursor,
  resolveResumeCursor,
  describeRunState,
  type FecBulkRunState,
} from "./run-state";

const LM_A = "Sun, 05 Jul 2026 11:04:33 GMT";
const LM_B = "Sun, 12 Jul 2026 11:02:10 GMT";

function freshState(): FecBulkRunState {
  return createRunState("2026", LM_A, '"etag-a"', "2026-07-05T21:50:00.000Z");
}

// ---------------------------------------------------------------------------
// createRunState / parseRunState
// ---------------------------------------------------------------------------

test("FIX-754 createRunState → parseRunState roundtrips through JSON", () => {
  const state = freshState();
  const parsed = parseRunState(JSON.parse(JSON.stringify(state)));
  assert.ok(parsed, "roundtrip parses");
  assert.equal(parsed.cycle, "2026");
  assert.equal(parsed.fec_last_modified, LM_A);
  assert.equal(parsed.version, FEC_RUN_STATE_VERSION);
});

test("FIX-754 parseRunState rejects garbage, wrong version, and missing fields", () => {
  assert.equal(parseRunState(null), null);
  assert.equal(parseRunState("a string"), null);
  assert.equal(parseRunState([]), null);
  assert.equal(parseRunState({}), null);
  const good = JSON.parse(JSON.stringify(freshState()));
  assert.equal(parseRunState({ ...good, version: FEC_RUN_STATE_VERSION + 1 }), null, "future version rejected");
  assert.equal(parseRunState({ ...good, cycle: "" }), null);
  assert.equal(parseRunState({ ...good, fec_last_modified: undefined }), null);
  assert.equal(parseRunState({ ...good, stages: null }), null);
});

// ---------------------------------------------------------------------------
// sameLastModified
// ---------------------------------------------------------------------------

test("FIX-754 sameLastModified compares parsed timestamps, format-tolerant", () => {
  assert.ok(sameLastModified(LM_A, LM_A));
  // Same instant, different textual form.
  assert.ok(sameLastModified(LM_A, "2026-07-05T11:04:33.000Z"));
  assert.equal(sameLastModified(LM_A, LM_B), false);
  assert.equal(sameLastModified(LM_A, null), false);
  assert.equal(sameLastModified(null, LM_A), false);
  assert.equal(sameLastModified(LM_A, "not a date"), false);
});

// ---------------------------------------------------------------------------
// planCycleResume
// ---------------------------------------------------------------------------

test("FIX-754 planCycleResume: no state / other cycle / unverifiable / stale", () => {
  const state = freshState();
  assert.equal(planCycleResume(null, "2026", LM_A), "none");
  assert.equal(planCycleResume(state, "2024", LM_A), "other-cycle");
  assert.equal(planCycleResume(state, "2026", null), "unverifiable", "HEAD failure");
  assert.equal(planCycleResume(state, "2026", "garbage"), "unverifiable", "unparseable probe");
  assert.equal(planCycleResume(state, "2026", LM_B), "stale", "FEC published a new drop");
});

test("FIX-754 planCycleResume: resume while writer work remains, skip-indiv when all four done", () => {
  const state = freshState();
  assert.equal(planCycleResume(state, "2026", LM_A), "resume", "no stages done yet");

  updateStageCursor(state, "donor-entities", 240_000, 784_120);
  assert.equal(planCycleResume(state, "2026", LM_A), "resume", "in-progress cursor still resumes");

  for (const s of INDIV_WRITER_STAGES) markStageComplete(state, s);
  assert.equal(
    planCycleResume(state, "2026", LM_A),
    "skip-indiv",
    "all writer stages complete → stream skip (IE pending is fine)",
  );
});

// ---------------------------------------------------------------------------
// stage transitions
// ---------------------------------------------------------------------------

test("FIX-754 stage markers: cursor → complete, writer-stage completeness excludes IE", () => {
  const state = freshState();
  assert.equal(stageIsComplete(state, "donor-entities"), false);

  updateStageCursor(state, "donor-entities", 4000, 784_120);
  assert.equal(stageIsComplete(state, "donor-entities"), false, "in-progress is not complete");
  assert.equal(state.stages["donor-entities"]?.cursor, 4000);
  assert.equal(state.stages["donor-entities"]?.total_rows, 784_120);

  markStageComplete(state, "donor-entities");
  assert.equal(stageIsComplete(state, "donor-entities"), true);
  assert.equal(state.stages["donor-entities"]?.cursor, 4000, "cursor preserved for observability");

  assert.equal(allIndivWriterStagesComplete(state), false);
  for (const s of INDIV_WRITER_STAGES) markStageComplete(state, s);
  assert.equal(allIndivWriterStagesComplete(state), true);
  assert.equal(
    stageIsComplete(state, "independent-expenditures"),
    false,
    "IE is tracked but not part of the writer-stage completeness gate",
  );
});

// ---------------------------------------------------------------------------
// resolveResumeCursor — the defensive reset
// ---------------------------------------------------------------------------

test("FIX-754 resolveResumeCursor: fresh / matching / mismatched totals", () => {
  assert.deepEqual(resolveResumeCursor(undefined, 1000), { start: 0, reset: false });
  assert.deepEqual(
    resolveResumeCursor({ status: "in-progress", cursor: 0, total_rows: 1000 }, 1000),
    { start: 0, reset: false },
    "cursor 0 is a plain fresh start, not a reset",
  );
  assert.deepEqual(
    resolveResumeCursor({ status: "in-progress", cursor: 240_000, total_rows: 634_463 }, 634_463),
    { start: 240_000, reset: false },
    "matching total → trust the cursor",
  );
  assert.deepEqual(
    resolveResumeCursor({ status: "in-progress", cursor: 240_000, total_rows: 634_463 }, 634_500),
    { start: 0, reset: true },
    "rebuilt rows drifted (officials churn) → reset to 0 and flag it",
  );
  assert.deepEqual(
    resolveResumeCursor({ status: "in-progress", cursor: 240_000 }, 634_463),
    { start: 0, reset: true },
    "missing recorded total cannot be trusted",
  );
});

// ---------------------------------------------------------------------------
// describeRunState — smoke (feeds the loud RESUMING log lines)
// ---------------------------------------------------------------------------

test("FIX-754 describeRunState names every tracked stage with its progress", () => {
  const state = freshState();
  markStageComplete(state, "donor-entities");
  updateStageCursor(state, "indiv-to-candidate", 240_000, 634_463);
  const s = describeRunState(state);
  assert.match(s, /cycle=2026/);
  assert.match(s, /donor-entities=done/);
  assert.match(s, /indiv-to-candidate=240000\/634463/);
  assert.match(s, /indiv-to-committee=pending/);
  for (const stage of TRACKED_STAGES) assert.ok(s.includes(stage), `${stage} present`);
});
