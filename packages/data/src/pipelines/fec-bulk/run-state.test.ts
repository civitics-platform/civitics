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
  saveRunState,
  newCheckpointThrottle,
  shouldPersistCheckpoint,
  describeCheckpointStats,
  CHECKPOINT_MIN_INTERVAL_MS,
  FEC_RUN_STATE_KEY,
  FEC_CYCLE_WATERMARK_KEY,
  parseCycleWatermarks,
  stampCycleStage,
  cycleFullPassAt,
  saveCycleStageWatermark,
  type FecBulkRunState,
  type FecCycleWatermarks,
} from "./run-state";
import type { Client } from "pg";

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

// ---------------------------------------------------------------------------
// FIX-996 — saveRunState transport (direct-pg vs PostgREST fallback)
// ---------------------------------------------------------------------------

/** PostgREST-shaped stub: db.from(t).upsert(row, opts) → { error }. */
function fakeDb(error: { message: string } | null = null) {
  const calls: Array<{ table: string; row: Record<string, unknown>; opts: unknown }> = [];
  const db = {
    from: (table: string) => ({
      upsert: async (row: Record<string, unknown>, opts: unknown) => {
        calls.push({ table, row, opts });
        return { error };
      },
    }),
  };
  return { db, calls };
}

/** pg.Client-shaped stub. */
function fakePgClient(throws?: Error) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (throws) throw throws;
      return { rows: [] };
    },
  } as unknown as Client;
  return { client, calls };
}

test("FIX-996 saveRunState WITH a client writes over direct-pg and never touches PostgREST", async () => {
  const state = freshState();
  updateStageCursor(state, "donor-entities", 484000, 840338);
  const { db, calls: pgrstCalls } = fakeDb();
  const { client, calls } = fakePgClient();

  const ok = await saveRunState(db, state, client);

  assert.equal(ok, true);
  assert.equal(pgrstCalls.length, 0, "the PostgREST path must not be used when a client is supplied");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /INSERT INTO public\.pipeline_state/);
  assert.match(calls[0]!.sql, /ON CONFLICT \(key\) DO UPDATE/, "arbiter must match PostgREST's onConflict:'key'");
  assert.equal(calls[0]!.params[0], FEC_RUN_STATE_KEY);
  // The value goes over as a JSON string cast ::jsonb — round-trip it to prove
  // the cursor actually made it into the payload.
  const sent = JSON.parse(String(calls[0]!.params[1])) as FecBulkRunState;
  assert.equal(sent.stages["donor-entities"]?.cursor, 484000);
  assert.equal(sent.cycle, "2026");
});

test("FIX-996 saveRunState WITHOUT a client falls back to PostgREST (unchanged behavior)", async () => {
  const state = freshState();
  const { db, calls } = fakeDb();

  const ok = await saveRunState(db, state);

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.table, "pipeline_state");
  assert.equal(calls[0]!.row["key"], FEC_RUN_STATE_KEY);
  assert.deepEqual(calls[0]!.opts, { onConflict: "key" });
});

test("FIX-996 saveRunState preserves the best-effort contract on BOTH transports", async () => {
  const state = freshState();

  // direct-pg throws → swallowed, reported as false, no rejection.
  const { client } = fakePgClient(new Error("connection terminated unexpectedly"));
  assert.equal(await saveRunState(fakeDb().db, state, client), false);

  // PostgREST returns an error → swallowed, reported as false.
  const { db } = fakeDb({ message: "upstream request timeout" });
  assert.equal(await saveRunState(db, state), false);
});

test("FIX-996 saveRunState stamps updated_at on every attempt, including failures", async () => {
  const state = freshState();
  const before = state.updated_at;
  const { client } = fakePgClient(new Error("boom"));
  await saveRunState(fakeDb().db, state, client);
  assert.notEqual(state.updated_at, before, "updated_at is stamped before the write is attempted");
});

// ---------------------------------------------------------------------------
// FIX-996 — checkpoint cadence
// ---------------------------------------------------------------------------

test("FIX-996 the first checkpoint of a stage always persists", () => {
  const t = newCheckpointThrottle();
  assert.equal(shouldPersistCheckpoint(t, 1_000_000, false), true, "lastSavedAtMs=0 ⇒ persist");
});

test("FIX-996 persists at most once per CHECKPOINT_MIN_INTERVAL_MS", () => {
  const t = newCheckpointThrottle();
  t.lastSavedAtMs = 1_000_000;

  assert.equal(shouldPersistCheckpoint(t, 1_000_000 + 1, false), false, "immediately after a save: skip");
  assert.equal(
    shouldPersistCheckpoint(t, 1_000_000 + CHECKPOINT_MIN_INTERVAL_MS - 1, false),
    false,
    "just inside the window: skip",
  );
  assert.equal(
    shouldPersistCheckpoint(t, 1_000_000 + CHECKPOINT_MIN_INTERVAL_MS, false),
    true,
    "exactly at the window: persist",
  );
});

test("FIX-996 stage completion FORCES a persist regardless of the window", () => {
  const t = newCheckpointThrottle();
  t.lastSavedAtMs = 1_000_000;
  assert.equal(
    shouldPersistCheckpoint(t, 1_000_000 + 1, true),
    true,
    "the last cursor of a stage must land, or a kill right after the final chunk re-does the tail",
  );
});

test("FIX-996 a FAILED save does not start the throttle clock", () => {
  // The stageResume hook advances lastSavedAtMs ONLY on success. So after a
  // failure the clock is still wherever the last SUCCESSFUL save left it, and
  // the retry is not suppressed by the failure itself. Modelled here at a
  // realistic wall-clock epoch, since the throttle compares absolute ms.
  const NOW = Date.parse("2026-08-08T04:30:59.632Z");

  // Never saved: the clock is 0, so any real timestamp is past the window.
  const fresh = newCheckpointThrottle();
  fresh.stats.attempted = 1;
  fresh.stats.failed = 1;
  assert.equal(fresh.lastSavedAtMs, 0, "a failure must not advance the clock");
  assert.equal(shouldPersistCheckpoint(fresh, NOW, false), true, "retry immediately");

  // Saved once, then a failure 30s later: the clock still reads the SUCCESS,
  // so the next chunk (>20s past that success) persists rather than waiting on
  // the failed attempt.
  const t = newCheckpointThrottle();
  t.lastSavedAtMs = NOW;
  assert.equal(shouldPersistCheckpoint(t, NOW + 30_000, false), true);
  t.stats.attempted++; t.stats.failed++;      // the attempt fails — clock untouched
  assert.equal(t.lastSavedAtMs, NOW);
  assert.equal(shouldPersistCheckpoint(t, NOW + 31_000, false), true, "not suppressed by the failure");
});

test("FIX-996 the stage-end summary names ok / failed / throttled", () => {
  const line = describeCheckpointStats({ attempted: 44, saved: 41, failed: 3, throttled: 166 });
  assert.equal(line, "checkpoint saves: 41 ok / 3 failed / 166 throttled");
});

// ---------------------------------------------------------------------------
// FIX-957 — per-cycle "last full pass" watermarks
//
// The question is "was this row written by the most recent full pass for its
// cycle?". `max(updated_at)` was measured and rejected as a proxy — it marked
// 1,622,392 of 1,734,219 cycle-2024 rows stale, because the recent runs were
// partial. So the stamp must be SUCCESS-ONLY: a killed or partial stage must
// never advance it, and the durable store must survive the run-state row being
// deleted at cycle completion (which is why these live under their own
// pipeline_state key — see the run-state.ts header).
// ---------------------------------------------------------------------------

const WM_LM = "Sun, 12 Jul 2026 09:00:00 GMT";

/** PostgREST-shaped stub supporting BOTH the select→eq→maybeSingle read and the
 *  upsert write, so loadCycleWatermarks + saveCycleStageWatermark round-trip. */
function fakeWatermarkDb(initial: unknown = null, upsertError: { message: string } | null = null) {
  const store: { value: unknown } = { value: initial };
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: store.value === null ? null : { value: store.value }, error: null }),
        }),
      }),
      upsert: async (row: Record<string, unknown>) => {
        writes.push(row);
        if (upsertError) return { error: upsertError };
        store.value = row["value"];
        return { error: null };
      },
    }),
  };
  return { db, store, writes };
}

test("FIX-957 a SUCCESSFUL stage advances its cycle+stage stamp", async () => {
  const { db, writes, store } = fakeWatermarkDb();
  const after = await saveCycleStageWatermark(
    db, "2026", "indiv-to-candidate", WM_LM, "2026-08-11T05:00:00.000Z",
  );

  assert.equal(writes.length, 1, "one upsert");
  assert.equal(writes[0]!["key"], FEC_CYCLE_WATERMARK_KEY, "written under the DURABLE key");
  assert.notEqual(
    writes[0]!["key"],
    FEC_RUN_STATE_KEY,
    "never the resume key — that row is DELETEd on cycle completion",
  );
  assert.deepEqual(after["2026"]!["indiv-to-candidate"], {
    completed_at: "2026-08-11T05:00:00.000Z",
    fec_last_modified: WM_LM,
  });
  assert.deepEqual((store.value as FecCycleWatermarks)["2026"]!["indiv-to-candidate"], {
    completed_at: "2026-08-11T05:00:00.000Z",
    fec_last_modified: WM_LM,
  });
});

test("FIX-957 a KILLED stage leaves no stamp — the write only happens on success", () => {
  // The kill shape: three writer stages stamped, the fourth never reached. This
  // is the state a SIGTERM at the GHA budget leaves behind, and the scalar must
  // refuse to call it a full pass.
  let wm: FecCycleWatermarks = {};
  for (const stage of ["donor-entities", "indiv-to-candidate", "recipient-entities"] as const) {
    wm = stampCycleStage(wm, "2026", stage, "2026-08-09T05:00:00.000Z", WM_LM);
  }
  assert.equal(Object.keys(wm["2026"]!).length, 3);
  assert.equal(
    cycleFullPassAt(wm, "2026"),
    null,
    "indiv-to-committee never completed — this cycle has NO full pass",
  );

  // …and the moment the last writer stage does complete, it does.
  wm = stampCycleStage(wm, "2026", "indiv-to-committee", "2026-08-10T05:30:00.000Z", WM_LM);
  assert.equal(cycleFullPassAt(wm, "2026"), "2026-08-09T05:00:00.000Z");
});

test("FIX-957 the full-pass scalar is the MIN over writer stages, not the MAX", () => {
  // The four stages can legitimately complete on different nights via the
  // FIX-754 resume path. MAX would let one fast stage vouch for three that
  // never re-ran; the cycle is only re-derived once the SLOWEST finished.
  let wm: FecCycleWatermarks = {};
  wm = stampCycleStage(wm, "2024", "donor-entities",     "2026-07-13T04:10:00.000Z", WM_LM);
  wm = stampCycleStage(wm, "2024", "indiv-to-candidate", "2026-07-13T05:20:00.000Z", WM_LM);
  wm = stampCycleStage(wm, "2024", "recipient-entities", "2026-07-13T05:25:00.000Z", WM_LM);
  wm = stampCycleStage(wm, "2024", "indiv-to-committee", "2026-07-13T06:40:00.000Z", WM_LM);
  assert.equal(cycleFullPassAt(wm, "2024"), "2026-07-13T04:10:00.000Z");
});

test("FIX-957 the IE stage neither completes nor blocks a full pass", () => {
  // independent-expenditures writes ie_support/ie_oppose, not 'donation', and
  // the pipeline explicitly tolerates its failure. It must not gate the
  // donation-side watermark in either direction.
  let ieOnly: FecCycleWatermarks = {};
  ieOnly = stampCycleStage(ieOnly, "2024", "independent-expenditures", "2026-07-13T06:55:00.000Z", WM_LM);
  assert.equal(cycleFullPassAt(ieOnly, "2024"), null, "IE alone is not a full pass");

  let full: FecCycleWatermarks = {};
  for (const s of INDIV_WRITER_STAGES) {
    full = stampCycleStage(full, "2024", s, "2026-07-13T04:10:00.000Z", WM_LM);
  }
  const withIe = stampCycleStage(full, "2024", "independent-expenditures", "2026-07-13T06:55:00.000Z", WM_LM);
  assert.equal(
    cycleFullPassAt(withIe, "2024"),
    "2026-07-13T04:10:00.000Z",
    "a LATER IE completion must not drag the scalar forward",
  );
});

test("FIX-957 stamps are monotonic — an older completion never walks one back", () => {
  const wm = stampCycleStage({}, "2026", "donor-entities", "2026-08-10T05:00:00.000Z", WM_LM);
  const older = stampCycleStage(wm, "2026", "donor-entities", "2026-08-01T05:00:00.000Z", WM_LM);
  assert.equal(older, wm, "an out-of-order write is refused by identity, not merged");
  assert.equal(older["2026"]!["donor-entities"]!.completed_at, "2026-08-10T05:00:00.000Z");
});

test("FIX-957 a monotonic refusal writes nothing to the DB at all", async () => {
  const seeded = stampCycleStage({}, "2026", "donor-entities", "2026-08-10T05:00:00.000Z", WM_LM);
  const { db, writes } = fakeWatermarkDb(seeded);
  await saveCycleStageWatermark(db, "2026", "donor-entities", WM_LM, "2026-08-01T05:00:00.000Z");
  assert.deepEqual(writes, [], "no upsert is issued when the stamp would go backwards");
});

test("FIX-957 stamping one cycle leaves every other cycle intact", async () => {
  // The fec phase can run for hours; a write-back must not clobber a stamp made
  // for a different cycle in the meantime, which is why the save re-reads first.
  const seeded = stampCycleStage({}, "2024", "donor-entities", "2026-07-13T04:10:00.000Z", WM_LM);
  const { db } = fakeWatermarkDb(seeded);
  const after = await saveCycleStageWatermark(
    db, "2026", "donor-entities", WM_LM, "2026-08-11T05:00:00.000Z",
  );
  assert.equal(after["2024"]!["donor-entities"]!.completed_at, "2026-07-13T04:10:00.000Z");
  assert.equal(after["2026"]!["donor-entities"]!.completed_at, "2026-08-11T05:00:00.000Z");
});

test("FIX-957 a failed watermark write is best-effort and never throws", async () => {
  const { db } = fakeWatermarkDb(null, { message: "upstream request timeout" });
  const after = await saveCycleStageWatermark(
    db, "2026", "donor-entities", WM_LM, "2026-08-11T05:00:00.000Z",
  );
  // The work already happened; a stale watermark must not abort the pipeline.
  assert.equal(after["2026"]!["donor-entities"]!.completed_at, "2026-08-11T05:00:00.000Z");
});

test("FIX-957 a malformed stored blob degrades to NO watermark, never a bogus one", () => {
  assert.deepEqual(parseCycleWatermarks(null), {});
  assert.deepEqual(parseCycleWatermarks("nope"), {});
  assert.deepEqual(parseCycleWatermarks([1, 2, 3]), {});
  assert.deepEqual(parseCycleWatermarks({ "2026": "nope" }), {});
  assert.deepEqual(parseCycleWatermarks({ notacycle: { "donor-entities": { completed_at: "x" } } }), {});
  // A stage name outside TRACKED_STAGES is dropped rather than trusted.
  assert.deepEqual(
    parseCycleWatermarks({ "2026": { "made-up-stage": { completed_at: "2026-08-11T00:00:00Z" } } }),
    {},
  );
  // A stage row with no completed_at is not a completion.
  assert.deepEqual(parseCycleWatermarks({ "2026": { "donor-entities": { fec_last_modified: WM_LM } } }), {});
});

test("FIX-957 a valid blob round-trips, with a missing fec_last_modified normalised to null", () => {
  const parsed = parseCycleWatermarks({
    "2026": {
      "donor-entities": { completed_at: "2026-08-11T05:00:00.000Z", fec_last_modified: WM_LM },
      "indiv-to-candidate": { completed_at: "2026-08-11T06:00:00.000Z" },
    },
  });
  assert.deepEqual(parsed["2026"]!["donor-entities"], {
    completed_at: "2026-08-11T05:00:00.000Z",
    fec_last_modified: WM_LM,
  });
  assert.deepEqual(parsed["2026"]!["indiv-to-candidate"], {
    completed_at: "2026-08-11T06:00:00.000Z",
    fec_last_modified: null,
  });
});

test("FIX-957 an unstamped cycle reports NULL rather than a guess", () => {
  assert.equal(cycleFullPassAt({}, "2020"), null);
  assert.equal(cycleFullPassAt(parseCycleWatermarks({ "2024": {} }), "2024"), null);
});
