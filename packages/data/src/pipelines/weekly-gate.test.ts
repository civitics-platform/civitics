/**
 * FIX-743 — force_weekly dispatch knob.
 *
 * Runs via:  tsx --test src/pipelines/weekly-gate.test.ts
 *
 * The heavy ingest block (FEC bulk, IRS-990, LittleSis, EDGAR-weekly, OpenStates
 * API, agencies/OPM/PLUM/elections/committees/agency-*, tag-industry) is day-gated
 * to Sunday. A `workflow_dispatch` with `force_weekly=true` sets
 * NIGHTLY_FORCE_WEEKLY=true so the whole heavy path runs supervised off-Sunday.
 * computeRunWeekly is the pure gate; these assert:
 *   - default/unset === today's behavior exactly (Sunday runs, weekday skips)
 *   - the flag forces the weekly stages on a weekday
 *   - only the literal "true" forces (any other value is falsey → today's behavior)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRunWeekly } from "./weekly-gate";

// 2026-07-05 is a Sunday; 2026-07-06 is a Monday. Built via the local-component
// constructor (not an ISO/UTC string) because computeRunWeekly reads local
// getDay() — matching production's `new Date().getDay()` — so a UTC-parsed date
// would shift the weekday under a negative-offset runner and flake the suite.
const SUNDAY = new Date(2026, 6, 5);
const MONDAY = new Date(2026, 6, 6);

test("default (flag unset): Sunday runs weekly, weekday skips — today's behavior", () => {
  assert.deepEqual(computeRunWeekly(SUNDAY, undefined), { runWeekly: true, mode: "sunday" });
  assert.deepEqual(computeRunWeekly(MONDAY, undefined), { runWeekly: false, mode: "skipped" });
});

test("force_weekly=true forces the weekly stages on a weekday", () => {
  assert.deepEqual(computeRunWeekly(MONDAY, "true"), { runWeekly: true, mode: "forced" });
});

test("force_weekly=true on Sunday still runs (forced supersedes sunday)", () => {
  assert.deepEqual(computeRunWeekly(SUNDAY, "true"), { runWeekly: true, mode: "forced" });
});

test('only the literal "true" forces — other values are today\'s behavior', () => {
  for (const v of ["false", "", "1", "TRUE", "yes", undefined]) {
    // On a weekday every non-"true" value must skip, exactly like the flag was absent.
    assert.deepEqual(
      computeRunWeekly(MONDAY, v),
      { runWeekly: false, mode: "skipped" },
      `weekday + force=${JSON.stringify(v)} should skip`,
    );
    // On Sunday every non-"true" value must still run as an ordinary Sunday.
    assert.deepEqual(
      computeRunWeekly(SUNDAY, v),
      { runWeekly: true, mode: "sunday" },
      `sunday + force=${JSON.stringify(v)} should run as sunday`,
    );
  }
});
