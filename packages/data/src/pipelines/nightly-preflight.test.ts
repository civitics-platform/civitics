/**
 * FIX-1218 — the nightly's nominal-day preflight.
 *
 * Runs via:  tsx --test src/pipelines/nightly-preflight.test.ts
 *
 * The dispatched run (vercel-cron, 21:00 UTC) and the late scheduled fallback
 * name the same nominal day; the second one to arrive must find the first's
 * rows and stand down, while a human dispatch and a re-run of the same run must
 * never be refused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCHED_BY_ENV,
  decidePreflight,
  nightlyRunStamp,
  nominalDay,
  readDispatchedBy,
  type PriorNightlyRow,
} from "./nightly-preflight";

const row = (over: Partial<PriorNightlyRow> = {}): PriorNightlyRow => ({
  id: "r1",
  status: "complete",
  started_at: "2026-09-24T21:00:40Z",
  phase: "fec",
  github_run_id: "111",
  dispatched_by: "vercel-cron",
  ...over,
});

test("nominalDay: the dispatch at the slot and the late fallback name the same UTC day", () => {
  // Thu 21:00:05 dispatched, offset 3 (the input) → Friday.
  assert.equal(nominalDay(new Date("2026-09-24T21:00:05Z"), 3), "2026-09-25");
  // The scheduled fallback at the measured band's two ends, offset 3 (the event).
  assert.equal(nominalDay(new Date("2026-09-24T22:35:19Z"), 3), "2026-09-25");
  assert.equal(nominalDay(new Date("2026-09-24T23:44:30Z"), 3), "2026-09-25");
  // A fallback queued behind a long Sunday night still names the same day.
  assert.equal(nominalDay(new Date("2026-09-25T20:59:59Z"), 3), "2026-09-25");
  // The window's far edge belongs to the next slot.
  assert.equal(nominalDay(new Date("2026-09-25T21:00:00Z"), 3), "2026-09-26");
  // Offset 0 (a plain manual dispatch) is the wall-clock UTC date.
  assert.equal(nominalDay(new Date("2026-09-24T21:00:05Z"), 0), "2026-09-24");
});

test("readDispatchedBy: a short slug or nothing", () => {
  assert.equal(readDispatchedBy("vercel-cron"), "vercel-cron");
  assert.equal(readDispatchedBy(" schedule "), "schedule");
  assert.equal(readDispatchedBy("manual"), "manual");
  for (const bad of [undefined, "", "   ", "Vercel-Cron", "a b", "x;rm -rf", "-lead", "a".repeat(33)]) {
    assert.equal(readDispatchedBy(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("nightlyRunStamp: nominal_day always, dispatched_by only when the env names one", () => {
  const now = new Date("2026-09-24T21:00:05Z");
  assert.deepEqual(nightlyRunStamp(now, 3, { [DISPATCHED_BY_ENV]: "vercel-cron" }), {
    nominal_day: "2026-09-25",
    dispatched_by: "vercel-cron",
  });
  assert.deepEqual(nightlyRunStamp(now, 3, {}), { nominal_day: "2026-09-25" });
  assert.deepEqual(nightlyRunStamp(now, 3, { [DISPATCHED_BY_ENV]: "NOT A SLUG" }), {
    nominal_day: "2026-09-25",
  });
});

test("the fallback stands down when the dispatched run's rows exist", () => {
  const v = decidePreflight({
    nominalDay: "2026-09-25",
    dispatchedBy: "schedule",
    runId: "222",
    rows: [row(), row({ id: "r2", phase: "enrichment-heavy" })],
  });
  assert.equal(v.alreadyRan, true);
  assert.equal(v.matched.length, 2);
  assert.match(v.reason, /nominal day 2026-09-25 already ran \(run 111/);
});

test("either automated trigger stands down — whichever arrives second", () => {
  // A dispatcher that fired LATE (after the schedule run already did the night).
  const v = decidePreflight({
    nominalDay: "2026-09-25",
    dispatchedBy: "vercel-cron",
    runId: "333",
    rows: [row({ github_run_id: "222", dispatched_by: "schedule" })],
  });
  assert.equal(v.alreadyRan, true);
});

test("an empty day runs — the fallback covers a dead dispatcher", () => {
  const v = decidePreflight({ nominalDay: "2026-09-25", dispatchedBy: "schedule", runId: "222", rows: [] });
  assert.equal(v.alreadyRan, false);
  assert.deepEqual(v.matched, []);
});

test("every status but skipped counts as ran", () => {
  for (const status of ["running", "complete", "partial", "failed", "reaped"]) {
    const v = decidePreflight({
      nominalDay: "2026-09-25",
      dispatchedBy: "schedule",
      runId: "222",
      rows: [row({ status })],
    });
    assert.equal(v.alreadyRan, true, `${status} must count as ran`);
  }
  // A FIX-950-held night did not run: the fallback may do it once the hold is off.
  const held = decidePreflight({
    nominalDay: "2026-09-25",
    dispatchedBy: "schedule",
    runId: "222",
    rows: [row({ status: "skipped" }), row({ id: "r2", phase: "enrichment-heavy", status: "skipped" })],
  });
  assert.equal(held.alreadyRan, false);
});

test("a re-run of the SAME run (same GITHUB_RUN_ID, next attempt) is not a duplicate", () => {
  const v = decidePreflight({
    nominalDay: "2026-09-25",
    dispatchedBy: "vercel-cron",
    runId: "111",
    rows: [row({ github_run_id: "111" })],
  });
  assert.equal(v.alreadyRan, false);
});

test("a human dispatch is never guarded, even on a claimed day", () => {
  for (const by of ["manual", null, "someone-else"]) {
    const v = decidePreflight({
      nominalDay: "2026-09-25",
      dispatchedBy: by,
      runId: "444",
      rows: [row()],
    });
    assert.equal(v.alreadyRan, false, `dispatched_by=${String(by)} must run`);
    assert.match(v.reason, /not an automated firing path/);
  }
});

test("a row with no run id (pre-FIX-971a shape) still counts", () => {
  const v = decidePreflight({
    nominalDay: "2026-09-25",
    dispatchedBy: "schedule",
    runId: "222",
    rows: [row({ github_run_id: null })],
  });
  assert.equal(v.alreadyRan, true);
  assert.match(v.reason, /\(no run id\)/);
});
