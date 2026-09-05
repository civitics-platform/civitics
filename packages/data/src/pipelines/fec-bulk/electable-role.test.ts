/**
 * FIX-1025 — the office↔role table, pinned.
 *
 * This rule used to be spelled six ways across the package, two of them wrong:
 * `role.includes("Senator")` accepted "State Senator" (2,012 rows on prod), and
 * buildMatchIndex's exact pair had no President arm at all. This test is the
 * thing that stops the seventh spelling.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/electable-role.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEC_ELECTABLE_ROLE_TITLES,
  fecOfficePrefixFor,
  roleMayHoldFecOffice,
  isFecElectableRole,
} from "./electable-role";

/** role_title → the ONE office prefix it may hold, or null for "no federal seat". */
const TABLE: Array<[string, "H" | "S" | "P" | null]> = [
  // Accepted, per office.
  ["Senator",                      "S"],
  ["Candidate for Senator",        "S"],
  ["Representative",               "H"],
  ["Candidate for Representative", "H"],
  ["President",                    "P"],
  ["Candidate for President",      "P"],
  ["Vice President",               "P"],
  // Refused for EVERY office. The first two are the substring trap
  // (`"State Senator".includes("Senator")`); the third is the allow-list's
  // whole point; the fourth is the real USPS row that `.includes("President")`
  // accepted; the rest are prod role_titles that carry federal ids today.
  ["State Senator",                null],
  ["State Representative",         null],
  ["Council Member",               null],
  ["Vice President, Marketing",    null],
  ["Mayor",                        null],
  ["Judge",                        null],
  ["",                             null],
];

test("FIX-1025: fecOfficePrefixFor pins the whole table", () => {
  for (const [role, want] of TABLE) {
    assert.equal(fecOfficePrefixFor(role), want, `role_title ${JSON.stringify(role)}`);
  }
});

test("FIX-1025: roleMayHoldFecOffice accepts exactly one office per role", () => {
  for (const [role, want] of TABLE) {
    for (const office of ["H", "S", "P"] as const) {
      assert.equal(
        roleMayHoldFecOffice(role, office),
        want === office,
        `${JSON.stringify(role)} vs office ${office}`,
      );
    }
  }
});

test("FIX-1025: a non-H/S/P office is refused even for an electable role", () => {
  for (const office of ["", "X", "Z", "h ", null, undefined]) {
    assert.equal(roleMayHoldFecOffice("Senator", office), false, `office ${String(office)}`);
  }
  // …but the prefix is read case-insensitively, since callers pass candId[0].
  assert.equal(roleMayHoldFecOffice("Senator", "s"), true);
});

test("FIX-1025: null/undefined role_title holds no office", () => {
  assert.equal(fecOfficePrefixFor(null), null);
  assert.equal(fecOfficePrefixFor(undefined), null);
  assert.equal(roleMayHoldFecOffice(null, "S"), false);
});

test("FIX-1025: role titles are trimmed, never substring-matched", () => {
  assert.equal(fecOfficePrefixFor("  Senator  "), "S");
  // The trap, stated as an assertion rather than a comment.
  assert.ok("State Senator".includes("Senator"));
  assert.equal(fecOfficePrefixFor("State Senator"), null);
  assert.ok("Vice President, Marketing".includes("President"));
  assert.equal(fecOfficePrefixFor("Vice President, Marketing"), null);
});

test("FIX-937/1025: isFecElectableRole and the allow-list derive from the table", () => {
  for (const [role, want] of TABLE) {
    assert.equal(isFecElectableRole({ role_title: role }), want !== null, role);
    assert.equal(FEC_ELECTABLE_ROLE_TITLES.has(role), want !== null, role);
  }
  // The set and the prefix function cannot disagree, by construction.
  for (const role of FEC_ELECTABLE_ROLE_TITLES) {
    assert.notEqual(fecOfficePrefixFor(role), null, role);
  }
});
