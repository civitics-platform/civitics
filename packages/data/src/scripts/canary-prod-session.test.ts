/**
 * FIX-950 — the prod-session canary's three states and the overrun boundary.
 *
 * The one that matters: a HELD session carries NO tier. FIX-950 exists so an
 * operator can hold the box without cancelling the nightly; a canary that
 * reported every hold would make holding the box cost an alert, which is the
 * FIX-943 cause-vs-consequence rule and the same reason FIX-1166 leaves
 * `pending-within-window` untiered.
 *
 * Runs via:  tsx --test src/scripts/canary-prod-session.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProdSession,
  KEY_LABEL_STALE,
  KEY_OVERRUN,
  OVERRUN_FACTOR,
} from "./canary-prod-session";
import { DEFAULT_EXPECTED_MINUTES, type ProdSessionState } from "../lib/prod-session";

function state(over: Partial<ProdSessionState> = {}): ProdSessionState {
  return {
    held: false,
    defer: false,
    label_present: false,
    label_stale: false,
    reason: null,
    claimed_by: null,
    claimed_at: null,
    age_seconds: null,
    expected_minutes: null,
    pid: null,
    live_writers: [],
    live_writer_detail: [],
    reason_text: "clear",
    ...over,
  };
}

test("clear: no session, no finding", () => {
  const s = classifyProdSession(state());
  assert.equal(s?.state, "clear");
  assert.equal(s?.tier, null);
  assert.equal(s?.severity, 0);
});

test("held within estimate: recorded, NOT tiered", () => {
  const s = classifyProdSession(
    state({
      held: true, defer: true, label_present: true,
      claimed_by: "craig@box", reason: "FIX-954 set 3 apply",
      age_seconds: 30 * 60, expected_minutes: 90,
    }),
  );
  assert.equal(s?.state, "held");
  assert.equal(s?.tier, null, "a held session must never be a finding — that is the whole point");
  assert.equal(s?.ageMinutes, 30);
  assert.match(s?.detail ?? "", /FIX-954 set 3 apply/);
  assert.match(s?.detail ?? "", /craig@box/);
});

test("held: a --force claim names what it was claimed over", () => {
  const s = classifyProdSession(
    state({
      held: true, claimed_by: "craig@box", reason: "urgent",
      age_seconds: 60, expected_minutes: 30,
      live_writers: ["refresh_derived_mvs"],
    }),
  );
  assert.equal(s?.state, "held");
  assert.deepEqual(s?.liveWriters, ["refresh_derived_mvs"]);
  assert.match(s?.detail ?? "", /claimed over refresh_derived_mvs/);
});

test("overrun: past 2x the CLAIM's own estimate, not a fixed clock", () => {
  // 61 minutes against a 30-minute estimate: over. The same 61 minutes against
  // a 90-minute estimate is not — which is the point of deriving the threshold
  // from the claim rather than configuring one here.
  const over = classifyProdSession(
    state({ held: true, claimed_by: "a@b", reason: "r", age_seconds: 61 * 60, expected_minutes: 30 }),
  );
  assert.equal(over?.state, "overrun");
  assert.equal(over?.tier, "report");

  const under = classifyProdSession(
    state({ held: true, claimed_by: "a@b", reason: "r", age_seconds: 61 * 60, expected_minutes: 90 }),
  );
  assert.equal(under?.state, "held");
  assert.equal(under?.tier, null);
});

test("overrun: the boundary is strictly greater than, so exactly 2x is still held", () => {
  const at = classifyProdSession(
    state({ held: true, age_seconds: 60 * 60 * OVERRUN_FACTOR, expected_minutes: 60 }),
  );
  assert.equal(at?.state, "held", "exactly 2x is not yet an overrun");

  const past = classifyProdSession(
    state({ held: true, age_seconds: 60 * 60 * OVERRUN_FACTOR + 60, expected_minutes: 60 }),
  );
  assert.equal(past?.state, "overrun");
});

test("overrun: a claim with no estimate falls back to the CLI's own default", () => {
  const s = classifyProdSession(
    state({ held: true, age_seconds: (DEFAULT_EXPECTED_MINUTES * OVERRUN_FACTOR + 1) * 60 }),
  );
  assert.equal(s?.state, "overrun");
  assert.match(s?.detail ?? "", new RegExp(`estimate of ${DEFAULT_EXPECTED_MINUTES}m`));
});

test("label-stale: a dead session reports, and says it defers nothing", () => {
  const s = classifyProdSession(
    state({
      held: false, label_present: true, label_stale: true,
      claimed_by: "ghost@box", reason: "a session that died", age_seconds: 4000,
    }),
  );
  assert.equal(s?.state, "label-stale");
  assert.equal(s?.tier, "report");
  assert.match(s?.detail ?? "", /defers nothing/);
  assert.match(s?.detail ?? "", /ghost@box/);
});

test("label-stale outranks everything: age is read off a session that is not running", () => {
  // held=false with a very old label. Without the ordering this would fall into
  // the `!held` clear branch and the dead label would never be reported.
  const s = classifyProdSession(
    state({ held: false, label_present: true, label_stale: true, age_seconds: 99_999 }),
  );
  assert.equal(s?.state, "label-stale");
});

test("an unreadable interlock is reported as nothing, never as health", () => {
  assert.equal(classifyProdSession(null), null);
});

test("the condition keys are stable", () => {
  assert.equal(KEY_OVERRUN, "prod_session_overrun");
  assert.equal(KEY_LABEL_STALE, "prod_session_label_stale");
});
