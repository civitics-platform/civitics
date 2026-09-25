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
  KEY_HOLD_STALE,
  KEY_LABEL_STALE,
  KEY_OVERRUN,
  KEY_READ_FAILED,
  QUIET_FAILURE,
  classifyHoldStale,
  classifySessionReads,
  type SessionRead,
  type SessionHoldRow,
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

// ---------------------------------------------------------------------------
// FIX-1177 / FIX-1172 — the hold-stale detector
// ---------------------------------------------------------------------------

const NOW = new Date("2026-09-18T12:00:00Z");
const held2h = (pipeline: string): SessionHoldRow => ({
  pipeline,
  held_since: "2026-09-18T10:00:00Z",
});

test("no session-set holds is clear, and carries no tier", () => {
  const s = classifyHoldStale([], false, NOW);
  assert.equal(s.tier, null);
  assert.equal(s.pipelines.length, 0);
  assert.equal(s.oldestAgeHours, null);
});

test("holds WITH a live session are the mechanism working — no tier", () => {
  // This is the case that happens on every supervised landing. Tiering it would
  // page on the interlock doing its job, which is the FIX-943 cause-vs-
  // consequence rule and the same reason `held` itself carries no tier.
  const s = classifyHoldStale([held2h("financial_entity_totals_refresh")], true, NOW);
  assert.equal(s.tier, null);
  assert.match(s.detail, /held by the live supervised session/);
  assert.equal(s.oldestAgeHours, 2);
});

test("holds with NOBODY on the box report — a hold must not blind instruments silently", () => {
  const s = classifyHoldStale(
    [held2h("financial_entity_totals_refresh"), held2h("donor_rollup_refresh")],
    false,
    NOW,
  );
  assert.equal(s.tier, "report");
  assert.equal(s.severity, 2);
  assert.deepEqual(s.pipelines, ["donor_rollup_refresh", "financial_entity_totals_refresh"]);
  // The detail has to say what the hold COSTS, not just that it exists.
  assert.match(s.detail, /reports and escalates NOTHING/);
  assert.match(s.detail, /next claimProdSession\(\) clears it/);
});

test("the oldest hold drives the severity, not the newest or the count", () => {
  const s = classifyHoldStale(
    [
      { pipeline: "a", held_since: "2026-09-18T11:30:00Z" },
      { pipeline: "b", held_since: "2026-09-15T12:00:00Z" },
    ],
    false,
    NOW,
  );
  assert.equal(s.oldestAgeHours, 72);
  assert.equal(s.severity, 72);
});

test("a null held_since still reports — a row with no timestamp is not health", () => {
  // The column is populated by the upsert, so a null means something else wrote
  // it. Treating "I cannot date this hold" as clear would be the exact
  // fail-open the canary contract forbids.
  const s = classifyHoldStale([{ pipeline: "a", held_since: null }], false, NOW);
  assert.equal(s.tier, "report");
  assert.equal(s.oldestAgeHours, null);
  assert.ok(s.severity > 0, "an undateable stale hold must still sort above clear");
});

test("the condition key is stable", () => {
  assert.equal(KEY_HOLD_STALE, "prod_session_hold_stale");
});

// ---------------------------------------------------------------------------
// FIX-1224 — prod_session_read_failed
// ---------------------------------------------------------------------------

/** What every GHA canary run logged from 2026-09-11 to 2026-09-25, verbatim. */
const NO_DSN =
  "buildDbUrl: need SUPABASE_DB_URL, a local NEXT_PUBLIC_SUPABASE_URL, or " +
  "(NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD) to compose a DSN";

function reads(prod: Partial<SessionRead>, holds: Partial<SessionRead>): SessionRead[] {
  return [
    { name: "prod session", ok: true, error: null, ...prod },
    { name: "session holds", ok: true, error: null, ...holds },
  ];
}

test("both reads answered: no finding", () => {
  const s = classifySessionReads(reads({}, {}));
  assert.equal(s.tier, null);
  assert.equal(s.severity, 0);
  assert.deepEqual(s.failed, []);
});

test("the cc-156 shape — no DSN, both reads threw — REPORTS, never escalates", () => {
  const s = classifySessionReads(reads({ ok: false, error: NO_DSN }, { ok: false, error: NO_DSN }));
  assert.equal(s.tier, "report", "a blind instrument wants a look, not a nightly page");
  assert.equal(s.severity, 2);
  assert.deepEqual(s.failed, ["prod session", "session holds"]);
  assert.match(s.detail, /prod session: buildDbUrl: need SUPABASE_DB_URL/);
  assert.match(s.detail, /session holds: buildDbUrl: need SUPABASE_DB_URL/);
  // It names what it blinds, so the tile says why three other keys are quiet.
  for (const k of [KEY_OVERRUN, KEY_LABEL_STALE, KEY_HOLD_STALE]) assert.match(s.detail, new RegExp(k));
  assert.match(s.detail, /FIX-1224/);
});

test("one read failing reports on that read alone, and ranks below both failing", () => {
  const one = classifySessionReads(reads({}, { ok: false, error: "connection terminated unexpectedly" }));
  const both = classifySessionReads(reads({ ok: false, error: NO_DSN }, { ok: false, error: NO_DSN }));
  assert.equal(one.tier, "report");
  assert.deepEqual(one.failed, ["session holds"]);
  assert.match(one.detail, /1 of 2/);
  assert.doesNotMatch(one.detail, /prod session: /);
  assert.ok(both.severity > one.severity, "severity must be monotone-worse for the transition classifier");
});

test("a read that failed WITHOUT throwing still reports — null is not health", () => {
  // withClient() swallows a failed connection (a wrong password included) and
  // readProdSessionState() a failed query; both return null, so the canary sees
  // no status AND no error. Measured locally with an unreachable DSN: both reads
  // came back exactly like this. It is the common blind shape, not an edge.
  const s = classifySessionReads(reads({ ok: false, error: null }, { ok: false, error: null }));
  assert.equal(s.tier, "report");
  assert.equal(s.severity, 2);
  assert.ok(s.detail.includes(`prod session: ${QUIET_FAILURE}`));
  assert.ok(s.detail.includes(`session holds: ${QUIET_FAILURE}`));
});

test("the read-failed key is stable", () => {
  assert.equal(KEY_READ_FAILED, "prod_session_read_failed");
});
