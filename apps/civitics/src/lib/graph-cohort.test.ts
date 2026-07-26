/**
 * FIX-886/887 — cohort admission rules for /api/graph/group's official branch.
 *
 * These are the checks the route itself can't carry (no route-test harness in
 * this app — every suite under src/ is a pure unit test run by run-tests.mjs),
 * so the rules live in @/lib/graph-cohort and are exercised here directly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseOfficialIds,
  checkLiveCohort,
  MAX_GROUP_OFFICIAL_IDS,
  MAX_LIVE_COHORT,
} from "./graph-cohort";

const U = (n: number) => `0000000${n.toString(16).padStart(1, "0")}-1111-2222-3333-444444444444`;

// ── parseOfficialIds (FIX-886) ─────────────────────────────────────────────────

test("absent or blank officialIds means 'no ids mode', not an error", () => {
  assert.deepEqual(parseOfficialIds(null), { ok: true, ids: [] });
  assert.deepEqual(parseOfficialIds(""), { ok: true, ids: [] });
  assert.deepEqual(parseOfficialIds(" , , "), { ok: true, ids: [] });
});

test("valid ids parse, trim, and dedup case-insensitively", () => {
  const res = parseOfficialIds(` ${U(1)} , ${U(2)},${U(1).toUpperCase()} `);
  assert.equal(res.ok, true);
  assert.deepEqual(res.ok && res.ids, [U(1), U(2)]);
});

test("a non-UUID value is refused rather than silently dropped", () => {
  // Dropping it would shrink the cohort the user picked without saying so; an
  // empty result would fall through to filter resolution — the FIX-886 bug.
  const res = parseOfficialIds(`${U(1)},not-a-uuid`);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error, "officialIds_invalid");
});

test("over-cap id lists are refused with the count (route maps this to 400)", () => {
  const many = Array.from({ length: MAX_GROUP_OFFICIAL_IDS + 1 }, (_, i) =>
    `${i.toString(16).padStart(8, "0")}-1111-2222-3333-444444444444`,
  );
  const res = parseOfficialIds(many.join(","));
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error, "officialIds_too_many");
  assert.equal(res.ok === false && res.count, MAX_GROUP_OFFICIAL_IDS + 1);
});

test("exactly the cap is allowed", () => {
  const atCap = Array.from({ length: MAX_GROUP_OFFICIAL_IDS }, (_, i) =>
    `${i.toString(16).padStart(8, "0")}-1111-2222-3333-444444444444`,
  );
  const res = parseOfficialIds(atCap.join(","));
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.ids.length, MAX_GROUP_OFFICIAL_IDS);
});

// ── checkLiveCohort (FIX-887) ──────────────────────────────────────────────────

const base = {
  hasGoverningBody: false,
  hasParty: false,
  hasState: false,
  hasOfficialIds: false,
  memberCount: 100,
};

test("legacy no-gb cohort with no narrowing at all is refused as filter_too_broad", () => {
  // This is exactly what the FIX-886 handoff bug produced: {entity_type:'official'}
  // resolving to every active official (27,753 on prod).
  const v = checkLiveCohort({ ...base, memberCount: 27_753 });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.error, "filter_too_broad");
  assert.equal(v.ok === false && v.memberCount, 27_753);
});

test("any single narrowing filter admits the cohort", () => {
  for (const key of ["hasGoverningBody", "hasParty", "hasState", "hasOfficialIds"] as const) {
    assert.deepEqual(checkLiveCohort({ ...base, [key]: true }), { ok: true }, key);
  }
});

test("cohorts real affordances produce all pass", () => {
  // Sizes measured on prod, 2026-07-25 (see graph-cohort.ts header).
  const cases: Array<[string, Parameters<typeof checkLiveCohort>[0]]> = [
    ["bundle of 4 officials",   { ...base, hasOfficialIds: true, memberCount: 4 }],
    ["House roster (rollup miss)", { ...base, hasGoverningBody: true, memberCount: 437 }],
    ["state=CA legacy cohort",  { ...base, hasState: true, memberCount: 1_180 }],
    ["party=republican legacy", { ...base, hasParty: true, memberCount: 9_345 }],
  ];
  for (const [label, input] of cases) {
    assert.deepEqual(checkLiveCohort(input), { ok: true }, label);
  }
});

test("a narrowed but still platform-scale cohort is refused as cohort_too_large", () => {
  const v = checkLiveCohort({ ...base, hasParty: true, memberCount: MAX_LIVE_COHORT + 1 });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.error, "cohort_too_large");
  assert.equal(v.ok === false && v.memberCount, MAX_LIVE_COHORT + 1);
});

test("exactly MAX_LIVE_COHORT is admitted", () => {
  assert.deepEqual(
    checkLiveCohort({ ...base, hasParty: true, memberCount: MAX_LIVE_COHORT }),
    { ok: true },
  );
});

test("the broadness rule wins over the size rule when both would fire", () => {
  // An unnarrowed cohort should read as filter_too_broad — the actionable
  // message ("add a filter") — not as a size complaint.
  const v = checkLiveCohort({ ...base, memberCount: MAX_LIVE_COHORT + 1 });
  assert.equal(v.ok === false && v.error, "filter_too_broad");
});
