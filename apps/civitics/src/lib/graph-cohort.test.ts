/**
 * FIX-886 — cohort admission rules for /api/graph/group's official branch.
 *
 * These are the checks the route itself can't carry (no route-test harness in
 * this app — every suite under src/ is a pure unit test run by run-tests.mjs),
 * so the rules live in @/lib/graph-cohort and are exercised here directly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseOfficialIds, MAX_GROUP_OFFICIAL_IDS } from "./graph-cohort";

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
