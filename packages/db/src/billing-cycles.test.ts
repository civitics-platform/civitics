/**
 * FIX-1089 — per-provider billing cycles.
 *
 * The two cases that matter are the two providers that are NOT on the calendar
 * month, and both are pinned here with the real numbers read off the vendors on
 * 2026-08-22: Vercel's stated Aug 14 – Sep 14 window, and Upstash's 13th-of-
 * month anniversary derived from `creation_time`.
 *
 * The rest are edge cases that would each produce a confidently wrong date:
 * short-month clamping, an anniversary that has not happened yet this month,
 * and an inverted vendor window that must refuse rather than degrade silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anniversaryCycle,
  calendarMonthCycle,
  vendorWindowCycle,
} from "./billing-cycles";

const NOW = new Date("2026-08-22T18:00:00.000Z");

test("calendar month is UTC, matching date_trunc('month') on the database", () => {
  const c = calendarMonthCycle(NOW);
  assert.equal(c.start, "2026-08-01T00:00:00.000Z");
  assert.equal(c.end, "2026-09-01T00:00:00.000Z");
  assert.equal(c.source, "calendar");
  assert.equal(c.label, "Aug 1 – Sep 1");
  assert.equal(c.days_remaining, 9);
  // 21.75 of 31 days.
  assert.ok(c.elapsed_pct > 70 && c.elapsed_pct < 71, `got ${c.elapsed_pct}`);
});

test("Vercel: the vendor's own window, and it is NOT the calendar month", () => {
  // GET /v2/teams/{id} → billing.period, read 2026-08-22.
  const c = vendorWindowCycle(1786690800000, 1789369200000, NOW, "from the vendor");
  assert.ok(c, "a well-formed vendor window must be accepted");
  assert.equal(c.start, "2026-08-14T07:00:00.000Z");
  assert.equal(c.end, "2026-09-14T07:00:00.000Z");
  assert.equal(c.source, "api");
  assert.equal(c.label, "Aug 14 – Sep 14");
  // The calendar-month assumption would have said 9 days left. It is 22.
  assert.equal(c.days_remaining, 22);
  assert.notEqual(c.days_remaining, calendarMonthCycle(NOW).days_remaining);
});

test("a missing or inverted vendor window refuses rather than degrading silently", () => {
  // Returning a calendar month here would report an assumption with the
  // vendor's authority behind it — the caller must choose the fallback itself.
  assert.equal(vendorWindowCycle(null, null, NOW, ""), null);
  assert.equal(vendorWindowCycle(1786690800000, undefined, NOW, ""), null);
  assert.equal(vendorWindowCycle(1789369200000, 1786690800000, NOW, ""), null);
  assert.equal(vendorWindowCycle(Number.NaN, 1789369200000, NOW, ""), null);
});

test("Upstash: the allotment rolls on the 13th, not the 1st", () => {
  // creation_time 1781337093 (epoch SECONDS) = 2026-06-13T07:51:33Z.
  const anchor = new Date(1781337093 * 1000);
  assert.equal(anchor.toISOString(), "2026-06-13T07:51:33.000Z");

  const c = anniversaryCycle(anchor, NOW, "from creation_time", "api");
  assert.equal(c.start, "2026-08-13T00:00:00.000Z");
  assert.equal(c.end, "2026-09-13T00:00:00.000Z");
  assert.equal(c.source, "api");
  // THE number the 2026-08-15 incident needed: when does the limiter come back.
  // The calendar-month answer (Sep 1) is wrong by twelve days.
  assert.equal(c.days_remaining, 21);
});

test("an anniversary later this month means the cycle started LAST month", () => {
  // Aug 5, anchor on the 13th → the current cycle is Jul 13 – Aug 13.
  const c = anniversaryCycle(
    new Date("2026-06-13T07:51:33.000Z"),
    new Date("2026-08-05T00:00:00.000Z"),
    "",
  );
  assert.equal(c.start, "2026-07-13T00:00:00.000Z");
  assert.equal(c.end, "2026-08-13T00:00:00.000Z");
  assert.ok(c.elapsed_pct > 0, "elapsed must never go negative");
});

test("a 31st anchor clamps into short months instead of overflowing", () => {
  // Without the clamp, Feb's anniversary computes as Mar 3 — a start date in
  // the future, and a negative elapsed_pct.
  const anchor = new Date("2026-01-31T00:00:00.000Z");
  const c = anniversaryCycle(anchor, new Date("2026-03-01T00:00:00.000Z"), "");
  assert.equal(c.start, "2026-02-28T00:00:00.000Z");
  assert.equal(c.end, "2026-03-31T00:00:00.000Z");
  assert.ok(c.elapsed_pct >= 0 && c.elapsed_pct <= 100);
});

test("elapsed_pct saturates at 100 rather than running past a stale cycle end", () => {
  const c = vendorWindowCycle(
    Date.UTC(2026, 0, 1),
    Date.UTC(2026, 1, 1),
    new Date("2026-08-22T00:00:00.000Z"),
    "",
  );
  assert.equal(c?.elapsed_pct, 100);
  assert.equal(c?.days_remaining, 0);
});
