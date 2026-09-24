/**
 * FIX-1194 P1-B / FIX-1125 — the two report-only box-health canary keys.
 * Pure; no DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOX_HEALTH_CANARY_STALE_MIN,
  KEY_MEM_STALE,
  KEY_PROBE_STALE,
  classifyBoxHealth,
} from "./canary-box-health";

const NOW = new Date("2026-09-24T12:00:00Z");

test("FIX-1194: fresh stamps carry no tier; the trail is still recorded", () => {
  const c = classifyBoxHealth(
    { box_health: { at: "2026-09-24T11:59:00Z" }, box_health_mem: { at: "2026-09-24T11:58:00Z" } },
    NOW,
  )!;
  assert.equal(c.probe.tier, null);
  assert.equal(c.probe.ageMinutes, 1);
  assert.equal(c.mem.tier, null);
  assert.equal(c.mem.ageMinutes, 2);
  assert.match(c.probe.detail, /fresh/);
});

test("FIX-1194: past 10 min each stamp REPORTS under its own key, severity = age", () => {
  assert.equal(BOX_HEALTH_CANARY_STALE_MIN, 10);
  const c = classifyBoxHealth(
    { box_health: { at: "2026-09-24T11:49:30Z" }, box_health_mem: { at: "2026-09-24T11:50:00Z" } },
    NOW,
  )!;
  assert.equal(c.probe.key, KEY_PROBE_STALE);
  assert.equal(c.probe.tier, "report");
  assert.equal(c.probe.severity, 10.5);
  assert.match(c.probe.detail, /STALE: last stamp 2026-09-24T11:49:30Z \(10\.5 min ago, threshold 10 min\)/);
  assert.equal(c.mem.key, KEY_MEM_STALE);
  assert.equal(c.mem.tier, null, "exactly 10 min is not over");
});

test("FIX-1194: an absent row reports (never escalates); a failed read reports nothing", () => {
  const c = classifyBoxHealth({}, NOW)!;
  assert.equal(c.probe.tier, "report");
  assert.equal(c.mem.tier, "report");
  assert.equal(c.probe.severity, 1_000_000);
  assert.match(c.mem.detail, /no stamp/);
  assert.equal(classifyBoxHealth(null, NOW), null);
});
