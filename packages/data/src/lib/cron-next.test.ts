/**
 * FIX-1251 — the cron grammar the receipts verdict reads. The board carries a
 * twin (`scripts/board.mjs` parseCron/cronEvents); these fixtures pin THIS
 * side, and use the same schedules the board suite does where they overlap.
 *
 * Runs via:  tsx --test src/lib/cron-next.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCronOccurrence, parseCronSchedule, restrictsDayOfMonthOrMonth } from "./cron-next";

const at = (iso: string) => new Date(iso);
const next = (s: string, iso: string) => nextCronOccurrence(s, at(iso))?.toISOString() ?? null;

test("the five prod monthlies are day-of-month schedules; weekly/daily/sub-daily are not", () => {
  for (const s of ["0 12 1 * *", "30 12 1 * *", "0 13 1 * *", "30 13 1 * *", "30 11 1 * *"]) {
    assert.equal(restrictsDayOfMonthOrMonth(s), true, s);
  }
  for (const s of ["37 2 * * 6", "0 15 * * 2", "30 3 * * *", "*/2 * * * *", "0 2 * * 0,3"]) {
    assert.equal(restrictsDayOfMonthOrMonth(s), false, s);
  }
  assert.equal(restrictsDayOfMonthOrMonth("0 0 * 6 *"), true, "a month restriction counts too");
  assert.equal(restrictsDayOfMonthOrMonth(null), false);
  assert.equal(restrictsDayOfMonthOrMonth("not a cron"), false);
});

test("next occurrence of each monthly from the 2026-09-30 receipts' generated_at", () => {
  const from = "2026-09-30T00:01:15.618Z";
  assert.equal(next("30 11 1 * *", from), "2026-10-01T11:30:00.000Z");
  assert.equal(next("0 12 1 * *", from), "2026-10-01T12:00:00.000Z");
  assert.equal(next("30 12 1 * *", from), "2026-10-01T12:30:00.000Z");
  assert.equal(next("0 13 1 * *", from), "2026-10-01T13:00:00.000Z");
  assert.equal(next("30 13 1 * *", from), "2026-10-01T13:30:00.000Z");
});

test("strictly after: at the firing instant the next one is a month on (Sun 11-01)", () => {
  assert.equal(next("0 12 1 * *", "2026-10-01T12:00:00Z"), "2026-11-01T12:00:00.000Z");
  assert.equal(next("0 12 1 * *", "2026-10-01T11:59:59Z"), "2026-10-01T12:00:00.000Z");
});

test("weekly, daily and stepped schedules", () => {
  assert.equal(next("0 15 * * 2", "2026-09-28T00:00:00Z"), "2026-09-29T15:00:00.000Z", "Mon → Tue 15:00 (the board fixture)");
  assert.equal(next("37 2 * * 6", "2026-09-30T00:00:00Z"), "2026-10-03T02:37:00.000Z", "jobid 56's first Saturday");
  assert.equal(next("30 3 * * *", "2026-09-30T04:00:00Z"), "2026-10-01T03:30:00.000Z");
  assert.equal(next("*/15 * * * 1", "2026-09-28T00:07:00Z"), "2026-09-28T00:15:00.000Z");
  assert.equal(next("0 8 * * 7", "2026-09-28T00:00:00Z"), "2026-10-04T08:00:00.000Z", "dow 7 is Sunday");
});

test("Vixie rule: day-of-month AND day-of-week restricted → either fires", () => {
  // The 15th, or any Monday. From Tue 09-29: Mon 10-05 comes before the 15th.
  assert.equal(next("0 0 15 * 1", "2026-09-29T00:00:00Z"), "2026-10-05T00:00:00.000Z");
});

test("a schedule that never fires, or does not parse, is null", () => {
  assert.equal(nextCronOccurrence("0 0 31 2 *", at("2026-01-01T00:00:00Z")), null);
  assert.equal(parseCronSchedule("0 0 * *"), null);
  assert.equal(parseCronSchedule("61 0 * * *"), null);
  assert.equal(parseCronSchedule("0 0 L * *"), null);
});
