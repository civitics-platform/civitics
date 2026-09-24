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
import {
  computeRunWeekly,
  nominalSlotInstant,
  readSlotOffsetHours,
} from "./weekly-gate";

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

// ---------------------------------------------------------------------------
// FIX-1163 — the nominal day comes from the SLOT, not from the wall clock.
//
// nightly.yml's cron moved to `0 21 * * *`, one UTC day before the run it names,
// because GitHub starts this workflow hours after its slot. A wall-clock gate
// would make Sunday's heavy ingest depend on GitHub being late: the slot fires
// Sat 21:00, so an ON-TIME start is still Saturday and would skip the weekly
// block outright. NIGHTLY_SLOT_OFFSET_HOURS=3 shifts the day read forward so the
// window naming a given day is exactly [slot, slot + 24h).
//
// Dates are built with the local-component constructor for the same reason the
// FIX-743 cases above are, and inside July so no DST transition can move a local
// day under the offset arithmetic. 2026-07-03 Fri / 07-04 Sat / 07-05 Sun /
// 07-06 Mon.
// ---------------------------------------------------------------------------

const SLOT_OFFSET = 3;
/** local-component Date, so getDay() is stable in any runner TZ. */
const at = (day: number, h: number, m = 0, s = 0) => new Date(2026, 6, day, h, m, s);

test("FIX-1163 slot offset: every start in [Sat 21:00, Sun 21:00) is the Sunday run", () => {
  const sundayStarts: Array<[string, Date]> = [
    ["on time — Sat 21:00, the slot itself", at(4, 21, 0)],
    ["Sat 23:59, barely late", at(4, 23, 59)],
    ["Sun 01:43, the fast end of the measured band", at(5, 1, 43)],
    ["Sun 03:41, the slow end of the measured band", at(5, 3, 41)],
    ["Sun 06:41, the worst offset of the recent regime", at(5, 6, 41)],
    ["Sun 08:51, the 11h51 fortnight-old outlier", at(5, 8, 51)],
    ["Sun 20:59:59, a full day late — still the Sunday run", at(5, 20, 59, 59)],
  ];
  for (const [where, now] of sundayStarts) {
    assert.deepEqual(
      computeRunWeekly(now, undefined, SLOT_OFFSET),
      { runWeekly: true, mode: "sunday" },
      `${where} (${now.toISOString()}) must name Sunday`,
    );
  }
});

test("FIX-1163 slot offset: Friday's slot names Saturday, and both edges hold", () => {
  const skipped: Array<[string, Date]> = [
    ["Fri 21:00 — Saturday's slot, on time", at(3, 21, 0)],
    ["Fri 23:59 — Saturday's slot, barely late", at(3, 23, 59)],
    ["Sat 01:43 — Saturday's slot, mid-band", at(4, 1, 43)],
    ["Sat 06:41 — Saturday's slot, worst-case late", at(4, 6, 41)],
    // The two instants either side of the Sunday window.
    ["Sat 20:59:59 — the last instant BEFORE Sunday's slot opens", at(4, 20, 59, 59)],
    ["Sun 21:00:00 — Monday's slot, so no longer Sunday", at(5, 21, 0)],
  ];
  for (const [where, now] of skipped) {
    assert.deepEqual(
      computeRunWeekly(now, undefined, SLOT_OFFSET),
      { runWeekly: false, mode: "skipped" },
      `${where} (${now.toISOString()}) must NOT name Sunday`,
    );
  }
});

test("FIX-1163 slot offset 0 is byte-identical to the pre-FIX-1163 wall-clock gate", () => {
  // Same instants, offset 0: the day is whatever the wall clock says, which is
  // exactly the behaviour every non-scheduled caller keeps.
  for (const [now, expected] of [
    [at(4, 21, 0), false], // Saturday evening is Saturday
    [at(5, 1, 43), true], // Sunday small hours is Sunday
    [at(5, 21, 0), true], // Sunday evening is still Sunday
    [at(6, 1, 43), false], // Monday is Monday
  ] as Array<[Date, boolean]>) {
    assert.deepEqual(computeRunWeekly(now, undefined, 0), {
      runWeekly: expected,
      mode: expected ? "sunday" : "skipped",
    });
    // Omitting the parameter entirely must match passing 0.
    assert.deepEqual(computeRunWeekly(now, undefined), computeRunWeekly(now, undefined, 0));
  }
});

test("FIX-1218 the Vercel dispatch at the slot carries slot_offset_hours=3 and gates exactly like a schedule event", () => {
  // The dispatch fires ON TIME — Sat 21:00:05 — which is the instant the old
  // wall-clock semantics (offset 0 on every workflow_dispatch) would have read
  // as Saturday, skipping Sunday's heavy ingest outright. The input restores the
  // slot rule: the env reads the input's "3", and the gate names Sunday.
  const offset = readSlotOffsetHours("3");
  assert.equal(offset, 3);
  assert.deepEqual(computeRunWeekly(at(4, 21, 0, 5), undefined, offset), { runWeekly: true, mode: "sunday" });
  // Friday's dispatch names Saturday — a weekday skip, as the schedule event does.
  assert.deepEqual(computeRunWeekly(at(3, 21, 0, 5), undefined, offset), { runWeekly: false, mode: "skipped" });
  // What the tree did BEFORE the input (the regression this row pins): offset 0.
  assert.deepEqual(computeRunWeekly(at(4, 21, 0, 5), undefined, 0), { runWeekly: false, mode: "skipped" });
  // A manual dispatch leaves the input at its default "0" — wall clock, unchanged.
  assert.equal(readSlotOffsetHours("0"), 0);
});

test("FIX-1163 force_weekly still supersedes the slot gate", () => {
  // A supervised dispatch runs the heavy block whatever day the slot names.
  assert.deepEqual(computeRunWeekly(at(4, 21, 0), "true", SLOT_OFFSET), {
    runWeekly: true,
    mode: "forced",
  });
  assert.deepEqual(computeRunWeekly(at(6, 12, 0), "true", SLOT_OFFSET), {
    runWeekly: true,
    mode: "forced",
  });
});

test("FIX-1163 readSlotOffsetHours refuses anything but an integer in [0,23]", () => {
  assert.equal(readSlotOffsetHours("3"), 3);
  assert.equal(readSlotOffsetHours(" 3 "), 3);
  assert.equal(readSlotOffsetHours("0"), 0);
  assert.equal(readSlotOffsetHours("23"), 23);
  // Absent/empty — every caller that does not set the var.
  assert.equal(readSlotOffsetHours(undefined), 0);
  assert.equal(readSlotOffsetHours(""), 0);
  assert.equal(readSlotOffsetHours("   "), 0);
  // Refused: a bad value must degrade to the old gate, never rotate the day by
  // more than a day.
  for (const bad of ["24", "30", "-1", "3.5", "three", "1e1", "0x3", "NaN", "Infinity"]) {
    assert.equal(readSlotOffsetHours(bad), 0, `${JSON.stringify(bad)} must be refused`);
  }
});

test("FIX-1163 nominalSlotInstant shifts by exactly the offset, and 0 is identity", () => {
  const now = at(4, 21, 0);
  assert.equal(nominalSlotInstant(now, 0), now, "offset 0 must return the same object");
  assert.equal(
    nominalSlotInstant(now, SLOT_OFFSET).getTime() - now.getTime(),
    SLOT_OFFSET * 3_600_000,
  );
  // The shifted instant is the one whose calendar day is read.
  assert.equal(nominalSlotInstant(now, SLOT_OFFSET).getDay(), 0, "Sat 21:00 + 3h is a Sunday");
});
