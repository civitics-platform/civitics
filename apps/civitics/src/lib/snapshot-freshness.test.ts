// FIX-1094 regression test — the dashboard's snapshot-age cue.
//
// Both directions are exercised for every state: the cue must stay silent while
// the snapshot is fresh (a cue that fires on healthy data is noise nobody reads)
// and must fire with honest copy once it is not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifySnapshotAge,
  formatAge,
  SNAPSHOT_AGING_MS,
  SNAPSHOT_STALE_MS,
} from "./snapshot-freshness";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("classifySnapshotAge", () => {
  it("is silent on a fresh snapshot", () => {
    for (const ageMs of [0, 60_000, 30 * 60_000, SNAPSHOT_AGING_MS - 1]) {
      const r = classifySnapshotAge(at(ageMs), NOW);
      assert.equal(r.level, "fresh", `age ${ageMs}`);
      assert.equal(r.label, null, `age ${ageMs}`);
    }
  });

  it("goes amber at the aging threshold and stays amber up to stale", () => {
    for (const ageMs of [SNAPSHOT_AGING_MS, 2 * 60 * 60_000, SNAPSHOT_STALE_MS - 1]) {
      const r = classifySnapshotAge(at(ageMs), NOW);
      assert.equal(r.level, "aging", `age ${ageMs}`);
      assert.match(r.label ?? "", /^snapshot .+ old$/);
    }
  });

  it("goes red at SNAPSHOT_STALE_MS with copy that says what is wrong", () => {
    const r = classifySnapshotAge(at(SNAPSHOT_STALE_MS), NOW);
    assert.equal(r.level, "stale");
    assert.match(r.label ?? "", /snapshot 4h old — the 10-min refresh has not landed/);
  });

  // The failure mode to avoid is a broken timestamp reading as a healthy one.
  it("treats a missing or unparseable timestamp as stale, never fresh", () => {
    for (const bad of [null, undefined, "", "not-a-date"]) {
      const r = classifySnapshotAge(bad, NOW);
      assert.equal(r.level, "stale", String(bad));
      assert.equal(r.label, "snapshot age unknown");
    }
  });

  // Clock skew between the snapshot writer and the reader is real; a negative
  // age must not render as "-3m old".
  it("clamps a future timestamp to age zero rather than going negative", () => {
    const r = classifySnapshotAge(new Date(NOW + 5 * 60_000).toISOString(), NOW);
    assert.equal(r.level, "fresh");
    assert.equal(r.ageMs, 0);
  });
});

describe("formatAge", () => {
  it("formats minutes, hours and days coarsely", () => {
    assert.equal(formatAge(0), "0m");
    assert.equal(formatAge(45 * 60_000), "45m");
    assert.equal(formatAge(60 * 60_000), "1h");
    assert.equal(formatAge(72 * 60_000), "1h 12m");
    assert.equal(formatAge(26 * 60 * 60_000), "1d 2h");
    assert.equal(formatAge(48 * 60 * 60_000), "2d");
  });
});
