/**
 * FIX-1218 — the dispatcher's two canary conditions.
 *
 * Runs via:  tsx --test src/scripts/canary-gha-dispatch.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DISPATCH_FIRST_SLOT, DISPATCH_STALE_HOURS, KEY_DISPATCH_REFUSED, KEY_DISPATCH_STALE, classifyGhaDispatch } from "./canary-gha-dispatch";

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
  assert.equal(c.stamps.length, 6, "the three FIX-1424 stems, absent before their first slots, read not stale");
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

test("FIX-1424 (cc-292): the three weekly stems — 169 h, and absent reads not-stale only until the first slot + 1 h", () => {
  for (const s of ["irs990", "audit", "crs-summaries"]) assert.equal(DISPATCH_STALE_HOURS[s], 169, s);
  assert.deepEqual(DISPATCH_FIRST_SLOT, {
    "crs-summaries": "2026-11-21T10:00:00Z",
    irs990: "2026-11-24T15:00:00Z",
    audit: "2026-11-24T17:00:00Z",
  });
  const daily = { ...healthy };
  const at = (iso: string, rows: Record<string, unknown>) => classifyGhaDispatch(
    { ...rows, gha_dispatch_nightly: { at: new Date(Date.parse(iso) - 3_600_000).toISOString(), status: "dispatched" },
      "gha_dispatch_sync-canary-check": { at: new Date(Date.parse(iso) - 3_600_000).toISOString(), status: "dispatched" },
      "gha_dispatch_platform-snapshot": { at: new Date(Date.parse(iso) - 60_000).toISOString(), status: "dispatched" } },
    new Date(iso));
  // The deploy (Wed 11-18) to crs-summaries' first slot: none stamped, none stale.
  assert.equal(at("2026-11-18T05:00:00Z", daily).stale.tier, null);
  assert.equal(at("2026-11-21T10:59:00Z", daily).stale.tier, null, "inside the hour's grace");
  // Sun 11-22 05:00Z (the canary's next run): crs-summaries never stamped → stale; the Tuesday two not yet due.
  const sun = at("2026-11-22T05:00:00Z", daily);
  assert.equal(sun.stale.severity, 1);
  assert.match(sun.stale.detail, /crs-summaries never stamped/);
  // Stamped on time: fresh for 169 h, stale after.
  const stamped = { "gha_dispatch_crs-summaries": { at: "2026-11-21T10:00:05Z", status: "dispatched", http_status: 204 } };
  assert.equal(at("2026-11-22T05:00:00Z", stamped).stale.tier, null);
  assert.equal(at("2026-11-28T11:00:00Z", stamped).stamps.find((x) => x.stem === "crs-summaries")?.stale, false, "168.99 h");
  assert.match(at("2026-11-28T11:01:00Z", stamped).stale.detail, /crs-summaries last stamped .* limit 169 h/);
  // Wed 11-25 05:00Z: irs990 and audit past their first slots with no stamp → stale.
  const wed = at("2026-11-25T05:00:00Z", stamped);
  assert.equal(wed.stale.severity, 2);
  assert.match(wed.stale.detail, /irs990 never stamped/);
  assert.match(wed.stale.detail, /audit never stamped/);
});
