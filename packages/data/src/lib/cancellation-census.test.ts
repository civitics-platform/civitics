/**
 * The census's two verdicts, against the cases that decide whether a prod op
 * goes ahead.
 *
 * The fixture that matters most is the LAST one: zero traffic passes the 5xx
 * gate and must not be read as evidence of health, because a front door that is
 * answering nothing at all is exactly the FIX-1130 wedge.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  edgeVerdictFor,
  verdictFor,
  PCT_5XX_GATE,
  RATIO_GATE,
  type CancellationBucket,
  type EdgeBucket,
} from "./cancellation-census";

const min = (startMs: number, timeouts: number, userRequests = 0): CancellationBucket => ({
  startMs,
  timeouts,
  userRequests,
});

const bucket = (startMs: number, requests: number, n5xx: number): EdgeBucket => ({
  startMs,
  requests,
  n5xx,
});

test("the baseline hour passes — 2 cancellations in 60 min is 0.033/min", () => {
  // cc-129's measured baseline, which is the number the gate is stated against.
  const v = verdictFor({ cancellations: [min(0, 1), min(60_000, 1)], minutes: 60, baseline: 0.033 });
  assert.equal(v.total, 2);
  assert.ok(Math.abs(v.rate - 0.0333) < 0.001);
  assert.ok(Math.abs(v.ratio - 1.01) < 0.02);
  assert.equal(v.pass, true);
});

test("exactly 2x passes — the gate is <=, not <", () => {
  // 4 in 60 min = 0.0667/min = exactly 2 x 0.0333. A strict inequality here
  // would fail a run that is precisely at the stated boundary, which makes the
  // boundary unquotable.
  const v = verdictFor({
    cancellations: [min(0, 4)],
    minutes: 60,
    baseline: 4 / 60 / RATIO_GATE,
  });
  assert.equal(v.ratio, RATIO_GATE);
  assert.equal(v.pass, true);
});

test("just past 2x fails", () => {
  const v = verdictFor({ cancellations: [min(0, 5)], minutes: 60, baseline: 4 / 60 / RATIO_GATE });
  assert.ok(v.ratio > RATIO_GATE);
  assert.equal(v.pass, false);
});

test("the 2026-09-07 shape fails loudly — 202 cancellations, ~70x baseline", () => {
  // The run this whole gate exists because of: FIX-1165's set-2 apply, 202
  // cancellations against a baseline of 1 over the equivalent window.
  const v = verdictFor({ cancellations: [min(0, 202)], minutes: 60, baseline: 0.033 });
  assert.equal(v.pass, false);
  assert.ok(v.ratio > 100);
});

test("zero cancellations passes and says so", () => {
  const v = verdictFor({ cancellations: [], minutes: 60, baseline: 0.033 });
  assert.equal(v.total, 0);
  assert.equal(v.rate, 0);
  assert.equal(v.pass, true);
  assert.match(v.note, /no cancellations/);
});

test("user-request cancels never enter the gated total", () => {
  // A cancel somebody issued by hand is a different event with a different
  // cause. Folding it in would fail a window whose only cancellations were an
  // operator pressing Ctrl-C.
  const v = verdictFor({
    cancellations: [min(0, 0, 40), min(60_000, 1, 9)],
    minutes: 60,
    baseline: 0.033,
  });
  assert.equal(v.total, 1);
  assert.equal(v.pass, true);
});

test("a zero baseline is called out rather than dividing to Infinity", () => {
  const clean = verdictFor({ cancellations: [], minutes: 60, baseline: 0 });
  assert.equal(clean.pass, true);
  assert.match(clean.note, /baseline is 0/);

  const dirty = verdictFor({ cancellations: [min(0, 1)], minutes: 60, baseline: 0 });
  assert.equal(dirty.pass, false);
  assert.equal(dirty.ratio, Number.POSITIVE_INFINITY);
});

test("the edge gate reads the last bucket WITH traffic, not the last bucket", () => {
  // The newest bucket is routinely empty (the window is aligned to a boundary
  // that has only just passed). Reading it literally would gate on 0 of 0.
  const v = edgeVerdictFor([
    bucket(0, 500, 0),
    bucket(900_000, 400, 20), // 5.0 % — the one that should decide
    bucket(1_800_000, 0, 0),
  ]);
  assert.equal(v.lastClosed?.startMs, 900_000);
  assert.ok(v.pct5xx !== null && Math.abs(v.pct5xx - 5) < 0.001);
  assert.equal(v.pass, false);
});

test("1 % exactly passes", () => {
  const v = edgeVerdictFor([bucket(0, 1000, 10)]);
  assert.equal(v.pct5xx, PCT_5XX_GATE);
  assert.equal(v.pass, true);
});

test("no traffic at all passes, and the note refuses to call it health", () => {
  // The wrong-but-green shape. A front door answering nothing is the FIX-1130
  // wedge, and the verdict must not read as a clean bill just because 0/0 has
  // no 5xx in it.
  const v = edgeVerdictFor([bucket(0, 0, 0), bucket(900_000, 0, 0)]);
  assert.equal(v.lastClosed, null);
  assert.equal(v.pct5xx, null);
  assert.equal(v.pass, true);
  assert.match(v.note, /nothing proved/);
});

test("an empty bucket list is the same case as empty buckets", () => {
  const v = edgeVerdictFor([]);
  assert.equal(v.pass, true);
  assert.match(v.note, /no traffic/);
});
