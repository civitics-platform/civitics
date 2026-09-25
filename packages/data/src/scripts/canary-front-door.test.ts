/**
 * FIX-1219 — the front-door watch's blind corroborator, as a report-only key.
 *
 * Runs via:  tsx --test src/scripts/canary-front-door.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { BLIND_STATE, KEY_FRONT_DOOR_BLIND, classifyFrontDoorWatch, type FrontDoorWatchRow } from "./canary-front-door";

const row = (at: string, state: string, logs_api = "4 bucket(s)"): FrontDoorWatchRow => ({
  started_at: at,
  metadata: { state, reason: "…", logs_api },
});

test("the key is the spelling the registry holds, and the state is the verdict's", () => {
  assert.equal(KEY_FRONT_DOOR_BLIND, "front_door_corroborator_unavailable");
  assert.equal(BLIND_STATE, "corroborator_unavailable");
});

test("a newest firing that is blind raises a report-only condition naming the 410", () => {
  const c = classifyFrontDoorWatch([
    row("2026-09-25T01:00:28Z", BLIND_STATE, "unavailable (410, FIX-1219)"),
    row("2026-09-25T00:45:28Z", BLIND_STATE, "unavailable (410, FIX-1219)"),
    row("2026-09-25T00:30:28Z", "ok"),
  ]);
  assert.equal(c.tier, "report");
  assert.equal(c.severity, 1, "one fact; a longer outage must not read as worse");
  assert.equal(c.blind, 2);
  assert.equal(c.firings, 3);
  assert.match(c.detail, /corroborator unavailable \(410, FIX-1219\) on 2 of 3 firing\(s\)/);
  assert.match(c.detail, /the direct probe still pages/);
});

test("a watch that sees again, a healthy watch, and no rows at all raise nothing", () => {
  assert.equal(classifyFrontDoorWatch([row("01:00", "ok"), row("00:45", BLIND_STATE)]).tier, null, "recovered on the newest firing");
  assert.equal(classifyFrontDoorWatch([row("01:00", "ok"), row("00:45", "ok")]).tier, null);
  const none = classifyFrontDoorWatch([]);
  assert.equal(none.tier, null);
  assert.match(none.detail, /staleness is the rollup registry's/);
  assert.equal(classifyFrontDoorWatch([row("01:00", "down")]).tier, null, "down pages from the route, not from here");
});

test("a pre-FIX-1219 row (state ok, logs_api absent) is not blind — the old silent ok is exactly what this cannot see, by design", () => {
  const c = classifyFrontDoorWatch([{ started_at: "2026-09-24T23:45:28Z", metadata: { state: "ok", reason: "no sustained 52x" } }]);
  assert.equal(c.tier, null);
});
