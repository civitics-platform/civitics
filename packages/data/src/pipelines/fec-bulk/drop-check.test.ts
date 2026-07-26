/**
 * FIX-903 — weekday "new FEC drop" trigger.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/drop-check.test.ts
 *
 * FEC publishes indiv{yy}.zip on Sundays ~15:20 UTC, hours after the nightly's
 * Sunday heavy run has already finished, so a weekday nightly needs its own
 * reason to invoke fec_bulk. indivDropIsAhead is that reason; currentFecCycle
 * decides which cycle both the probe and the run it triggers operate on.
 *
 * These are the pure halves only — no network, no DB. indivDropPending (the
 * HEAD + pipeline_state wrapper) is deliberately untested here: exercising it
 * would mean real I/O against fec.gov.
 *
 * Timestamps below are the real measured values from the 2026-07-26
 * investigation that surfaced this bug.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { currentFecCycle, indivDropIsAhead, resolveProbeCycle } from "./drop-check";

// Measured 2026-07-26 against prod + a live HEAD of indiv26.zip.
const WATERMARK_JUL_12 = "Sun, 12 Jul 2026 15:23:58 GMT";
const RUNSTATE_JUL_19  = "Sun, 19 Jul 2026 15:25:22 GMT";
const LIVE_JUL_26      = "Sun, 26 Jul 2026 15:18:36 GMT";

// ---------------------------------------------------------------------------
// indivDropIsAhead
// ---------------------------------------------------------------------------

test("probe ahead of the watermark → a drop is pending", () => {
  assert.equal(indivDropIsAhead(WATERMARK_JUL_12, LIVE_JUL_26), true);
  assert.equal(indivDropIsAhead(WATERMARK_JUL_12, RUNSTATE_JUL_19), true);
});

test("probe equal to the watermark → NOT pending (the FIX-193 gate would skip it anyway)", () => {
  assert.equal(indivDropIsAhead(LIVE_JUL_26, LIVE_JUL_26), false);
});

test("probe equal to the watermark in a different but equivalent HTTP date format → NOT pending", () => {
  // Comparison is by parsed timestamp, not string equality, so a header format
  // change on FEC's side must not read as a new drop.
  assert.equal(indivDropIsAhead("Sun, 26 Jul 2026 15:18:36 GMT", "Sun, 26 Jul 2026 15:18:36 UTC"), false);
});

test("probe behind the watermark → NOT pending", () => {
  assert.equal(indivDropIsAhead(LIVE_JUL_26, WATERMARK_JUL_12), false);
});

test("probe null/unparseable (HEAD failed) → fail closed, never launch a ~2.5h ingest", () => {
  for (const probe of [null, undefined, "", "not-a-date"]) {
    assert.equal(
      indivDropIsAhead(WATERMARK_JUL_12, probe),
      false,
      `probe=${JSON.stringify(probe)} must fail closed`,
    );
  }
});

test("stored null/unparseable (cycle never ingested) with a good probe → pending", () => {
  for (const stored of [null, undefined, "", "not-a-date"]) {
    assert.equal(
      indivDropIsAhead(stored, LIVE_JUL_26),
      true,
      `stored=${JSON.stringify(stored)} with a live probe means there IS work to do`,
    );
  }
});

test("both unparseable → NOT pending (the probe side still fails closed)", () => {
  assert.equal(indivDropIsAhead(null, null), false);
  assert.equal(indivDropIsAhead("garbage", "garbage"), false);
});

// ---------------------------------------------------------------------------
// currentFecCycle
// ---------------------------------------------------------------------------

test("currentFecCycle: an even year IS the cycle", () => {
  assert.equal(currentFecCycle(new Date(2026, 6, 26)), "2026");
  assert.equal(currentFecCycle(new Date(2024, 0, 1)),  "2024");
});

test("currentFecCycle: an odd year files into the following even year", () => {
  assert.equal(currentFecCycle(new Date(2027, 6, 26)), "2028");
  assert.equal(currentFecCycle(new Date(2025, 11, 31)), "2026");
});

// ---------------------------------------------------------------------------
// resolveProbeCycle
// ---------------------------------------------------------------------------

test("resolveProbeCycle: no override → the calendar-derived active cycle", () => {
  assert.equal(resolveProbeCycle(new Date(2026, 6, 26), undefined), "2026");
  assert.equal(resolveProbeCycle(new Date(2027, 6, 26), ""), "2028");
});

test("resolveProbeCycle: an explicit FEC_INDIV_CYCLES override wins", () => {
  assert.equal(resolveProbeCycle(new Date(2026, 6, 26), "2024"), "2024");
});

test("resolveProbeCycle: a multi-cycle override probes the highest listed cycle", () => {
  assert.equal(resolveProbeCycle(new Date(2026, 6, 26), "2020,2022,2024"), "2024");
  assert.equal(resolveProbeCycle(new Date(2026, 6, 26), " 2024 , 2020 "),  "2024");
});

test("resolveProbeCycle: a malformed override falls back to the active cycle", () => {
  for (const v of [",", "abc", "24", "2024x"]) {
    assert.equal(
      resolveProbeCycle(new Date(2026, 6, 26), v),
      "2026",
      `override=${JSON.stringify(v)} should fall back`,
    );
  }
});
