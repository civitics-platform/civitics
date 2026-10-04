/**
 * FIX-1277 — accents fold, they are not deleted.
 *
 * Runs via:  tsx --test src/pipelines/congress/diacritics.test.ts
 *
 * The six accented surnames of the FIX-1189 stubs (census 2026-10-04 line
 * 1685) must key identically to their FEC spellings, through the TS fold, the
 * promotion's name key and the SQL `translate()` table. The wrong-but-green
 * twin is the OLD key — upper() then strip — which must NOT match, so this
 * test would have caught the defect rather than merely agreeing with the fix.
 * An ASCII name is byte-identical under every form.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { foldDiacritics, sqlFoldUpper, sqlLetterKey, SQL_FOLD_FROM, SQL_FOLD_TO } from "./diacritics";
import { normName } from "./promote-candidates";
import { normalizeSurname } from "./votes-maps";

/** Congress.gov spelling → FEC spelling (Table A3 of the census). */
const PAIRS: Array<[string, string]> = [
  ["Luján", "Lujan"],
  ["García", "Garcia"],
  ["Hernández", "Hernandez"],
  ["Barragán", "Barragan"],
  ["Velázquez", "Velazquez"],
  ["Sánchez", "Sanchez"],
];

/** The pre-FIX-1277 SQL key: upper(), then delete everything not A–Z. */
const oldKey = (s: string): string => s.toUpperCase().replace(/[^A-Z]/g, "");

test("FIX-1277 TS fold: each accented surname folds to its FEC spelling", () => {
  for (const [cg, fec] of PAIRS) assert.equal(foldDiacritics(cg), fec, cg);
});

test("FIX-1277 SQL key: each accented surname keys as its FEC spelling", () => {
  for (const [cg, fec] of PAIRS) assert.equal(sqlLetterKey(cg), sqlLetterKey(fec), cg);
  assert.equal(sqlLetterKey("Barragán"), "BARRAGAN");
  assert.equal(sqlLetterKey("Ángel"), "ANGEL");
});

test("FIX-1277 twin: the OLD key deletes the accented letter and never matches", () => {
  for (const [cg, fec] of PAIRS) assert.notEqual(oldKey(cg), oldKey(fec), cg);
  assert.equal(oldKey("Barragán"), "BARRAGN", "the defect, as the census measured it");
});

test("FIX-1277 ASCII names are byte-identical under every form", () => {
  for (const s of ["Watson Coleman", "McClain Delaney", "O'Rourke", "Scott", "", "Hernandez Rivera"]) {
    assert.equal(foldDiacritics(s), s);
    assert.equal(sqlLetterKey(s), oldKey(s));
  }
  assert.equal(normName("  Roger   Marshall "), "roger marshall");
  assert.equal(normalizeSurname(" Grassley "), "grassley");
});

test("FIX-1277 the promotion's name key and the Senate vote map fold too", () => {
  assert.equal(normName("Nanette Diaz Barragán"), "nanette diaz barragan");
  assert.equal(normName("Ben Lujan"), normName("Ben Luján"));
  assert.equal(normalizeSurname("Luján"), "lujan");
});

test("FIX-1277 the translate() table is well-formed: equal length, upper-case targets", () => {
  assert.equal([...SQL_FOLD_FROM].length, [...SQL_FOLD_TO].length);
  assert.match(SQL_FOLD_TO, /^[A-Z]+$/);
  assert.equal(new Set(SQL_FOLD_FROM).size, [...SQL_FOLD_FROM].length, "no letter listed twice");
  assert.equal(
    sqlFoldUpper("x"),
    `translate(upper(x), '${SQL_FOLD_FROM}', '${SQL_FOLD_TO}')`,
  );
});
