/**
 * FIX-409: former-member reconciliation diff + partial-fetch guard.
 *
 * Runs via:  tsx --test src/pipelines/congress/reconcile-former-members.test.ts
 *
 * Pins the pure diff/guard logic (computeFormerMemberDiff) without a database:
 *  - a healthy feed returns exactly the active officials whose bioguideId is
 *    absent from the feed (the genuine departures),
 *  - a short feed (below ROSTER_FLOOR) returns NONE — the guard fires and
 *    refuses to mass-deactivate on a truncated/failed fetch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFormerMemberDiff,
  ROSTER_FLOOR,
} from "./reconcile-former-members";

// A plausibly-complete feed: ROSTER_FLOOR present members, bioguideIds B0001…
function fullFeedSet(extra: string[] = []): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < ROSTER_FLOOR; i++) {
    s.add(`B${String(i).padStart(4, "0")}`);
  }
  for (const e of extra) s.add(e);
  return s;
}

test("healthy feed: departed members (∉ feed) are returned as stale", () => {
  const feed = fullFeedSet(["PRESENT1", "PRESENT2"]);
  const active = [
    { id: "id-present-1", bioguideId: "PRESENT1" }, // in feed → stays
    { id: "id-present-2", bioguideId: "PRESENT2" }, // in feed → stays
    { id: "id-gone-1", bioguideId: "DEPARTED1" }, // ∉ feed → stale
    { id: "id-gone-2", bioguideId: "DEPARTED2" }, // ∉ feed → stale
  ];

  const diff = computeFormerMemberDiff({
    feedBioguideIds: feed,
    feedMemberCount: feed.size,
    activeOfficials: active,
  });

  assert.equal(diff.guardPassed, true);
  assert.deepEqual(diff.staleIds, ["id-gone-1", "id-gone-2"]);
  assert.deepEqual(diff.staleBioguideIds, ["DEPARTED1", "DEPARTED2"]);
});

test("healthy feed, no departures: empty stale set", () => {
  const feed = fullFeedSet(["PRESENT1"]);
  const active = [{ id: "id-present-1", bioguideId: "PRESENT1" }];

  const diff = computeFormerMemberDiff({
    feedBioguideIds: feed,
    feedMemberCount: feed.size,
    activeOfficials: active,
  });

  assert.equal(diff.guardPassed, true);
  assert.deepEqual(diff.staleIds, []);
});

test("short feed (below floor): guard fires, returns NONE", () => {
  // Even though DEPARTED1 is genuinely absent from this tiny feed, the guard
  // must refuse to deactivate anything — the feed is implausibly small.
  const feed = new Set(["PRESENT1"]);
  const active = [
    { id: "id-present-1", bioguideId: "PRESENT1" },
    { id: "id-gone-1", bioguideId: "DEPARTED1" },
  ];

  const diff = computeFormerMemberDiff({
    feedBioguideIds: feed,
    feedMemberCount: 1, // << ROSTER_FLOOR
    activeOfficials: active,
  });

  assert.equal(diff.guardPassed, false);
  assert.deepEqual(diff.staleIds, []);
  assert.deepEqual(diff.staleBioguideIds, []);
});

test("guard boundary: exactly ROSTER_FLOOR passes, one below fails", () => {
  const active = [{ id: "id-gone", bioguideId: "DEPARTED" }];

  const atFloor = computeFormerMemberDiff({
    feedBioguideIds: fullFeedSet(),
    feedMemberCount: ROSTER_FLOOR,
    activeOfficials: active,
  });
  assert.equal(atFloor.guardPassed, true);
  assert.deepEqual(atFloor.staleIds, ["id-gone"]);

  const belowFloor = computeFormerMemberDiff({
    feedBioguideIds: fullFeedSet(),
    feedMemberCount: ROSTER_FLOOR - 1,
    activeOfficials: active,
  });
  assert.equal(belowFloor.guardPassed, false);
  assert.deepEqual(belowFloor.staleIds, []);
});

test("custom rosterFloor override is honored", () => {
  const feed = new Set(["A", "B", "C"]);
  const active = [{ id: "id-x", bioguideId: "X" }];

  const diff = computeFormerMemberDiff({
    feedBioguideIds: feed,
    feedMemberCount: 3,
    activeOfficials: active,
    rosterFloor: 3,
  });
  assert.equal(diff.guardPassed, true);
  assert.deepEqual(diff.staleIds, ["id-x"]);
});
