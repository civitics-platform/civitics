/**
 * FIX-1218 — the dispatcher's two canary conditions.
 *
 * Runs via:  tsx --test src/scripts/canary-gha-dispatch.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { KEY_DISPATCH_REFUSED, KEY_DISPATCH_STALE, classifyGhaDispatch } from "./canary-gha-dispatch";

const NOW = new Date("2026-09-25T06:00:00Z");

const healthy = {
  gha_dispatch_nightly: { at: "2026-09-24T21:00:01Z", status: "dispatched", http_status: 200, last_dispatched_at: "2026-09-24T21:00:01Z" },
  "gha_dispatch_sync-canary-check": { at: "2026-09-25T05:00:01Z", status: "dispatched", http_status: 200 },
  "gha_dispatch_platform-snapshot": { at: "2026-09-25T05:50:02Z", status: "dispatched", http_status: 204 },
};

test("keys are the spellings the registry holds", () => {
  assert.equal(KEY_DISPATCH_REFUSED, "gha_dispatch_refused");
  assert.equal(KEY_DISPATCH_STALE, "gha_dispatch_stale");
});

test("a healthy dispatcher raises nothing", () => {
  const c = classifyGhaDispatch(healthy, NOW);
  assert.equal(c.refused.tier, null);
  assert.equal(c.stale.tier, null);
  assert.equal(c.stamps.length, 3);
});

test("an expired PAT (401) is refused — report-only — and names the last good dispatch", () => {
  const c = classifyGhaDispatch(
    {
      ...healthy,
      gha_dispatch_nightly: {
        at: "2026-09-24T21:00:01Z",
        status: "refused",
        http_status: 401,
        detail: "Bad credentials",
        last_dispatched_at: "2026-09-23T21:00:02Z",
      },
    },
    NOW,
  );
  assert.equal(c.refused.tier, "report");
  assert.equal(c.refused.severity, 1);
  assert.match(c.refused.detail, /nightly refused http=401 "Bad credentials"/);
  assert.match(c.refused.detail, /last good dispatch 2026-09-23T21:00:02Z/);
  // Refused is not stale: the route IS being called.
  assert.equal(c.stale.tier, null);
});

test("stale per cadence: nightly past 25 h, platform-snapshot past 30 min", () => {
  const c = classifyGhaDispatch(
    {
      ...healthy,
      gha_dispatch_nightly: { at: "2026-09-24T04:59:00Z", status: "dispatched" }, // 25.02 h
      "gha_dispatch_platform-snapshot": { at: "2026-09-25T05:29:00Z", status: "dispatched" }, // 31 min
    },
    NOW,
  );
  assert.equal(c.stale.tier, "report");
  assert.equal(c.stale.severity, 2);
  assert.match(c.stale.detail, /nightly last stamped .* limit 25 h/);
  assert.match(c.stale.detail, /platform-snapshot last stamped .* limit 0.5 h/);
  // Inside the limits: 24 h for nightly, 20 min for platform-snapshot.
  const ok = classifyGhaDispatch(
    {
      ...healthy,
      gha_dispatch_nightly: { at: "2026-09-24T06:00:00Z", status: "dispatched" },
      "gha_dispatch_platform-snapshot": { at: "2026-09-25T05:40:00Z", status: "dispatched" },
    },
    NOW,
  );
  assert.equal(ok.stale.tier, null);
});

test("a stem with no row at all is stale ('never stamped'), not silently fine", () => {
  const c = classifyGhaDispatch({}, NOW);
  assert.equal(c.stale.tier, "report");
  assert.equal(c.stale.severity, 3);
  assert.match(c.stale.detail, /nightly never stamped/);
  // …and not refused: there is no status to disagree with.
  assert.equal(c.refused.tier, null);
});
