/**
 * FIX-1468 (cc-342 G1) — irs990's officials name index settles a shared name
 * by one stated rule, never by the order the rows were read.
 *
 * A key held by one row resolves to it. A key held by several resolves to its
 * single active elected-tier row when there is exactly one, else to nobody —
 * and the loader reports every key it refused. Both keys (first + last, and
 * `full_name`) share the one namespace and the one rule.
 *
 * Runs via:  tsx --test src/pipelines/irs990/name-index.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { REFUSED_NAME_EXAMPLES, buildOfficialNameIndex, type OfficialNameRow } from "./writer";

function row(id: string, name: string, tier: string, is_active: boolean): OfficialNameRow {
  const [first, ...rest] = name.split(" ");
  return { id, full_name: name, first_name: first ?? null, last_name: rest.join(" ") || null, tier, is_active };
}
const sitting = (id: string, name: string) => row(id, name, "elected", true);
const stub    = (id: string, name: string) => row(id, name, "candidate", true);
const former  = (id: string, name: string) => row(id, name, "former", false);

test("G1: a key held by one row resolves to it", () => {
  const idx = buildOfficialNameIndex([sitting("a", "Ann Lee")]);
  assert.equal(idx.byName.get("ANN LEE"), "a");
  assert.equal(idx.settled, 0);
  assert.deepEqual(idx.refused, { count: 0, examples: [] });
});

test("G1: a sitting row beside two candidate stubs → the sitting row", () => {
  const idx = buildOfficialNameIndex([stub("s1", "Keith Self"), sitting("m", "Keith Self"), stub("s2", "Keith Self")]);
  assert.equal(idx.byName.get("KEITH SELF"), "m");
  assert.equal(idx.settled, 1);
  assert.equal(idx.refused.count, 0);
});

test("G1: a sitting row beside a former row → the sitting row", () => {
  const idx = buildOfficialNameIndex([former("f", "Rob Menendez"), sitting("m", "Rob Menendez")]);
  assert.equal(idx.byName.get("ROB MENENDEZ"), "m");
});

test("G1: two active elected rows → nobody, and the key is reported with its rows and tiers", () => {
  const idx = buildOfficialNameIndex([sitting("b", "John Smith"), sitting("a", "John Smith"), stub("c", "John Smith")]);
  assert.equal(idx.byName.has("JOHN SMITH"), false);
  assert.deepEqual(idx.refused, {
    count: 1,
    examples: [{ key: "JOHN SMITH", ids: ["a", "b", "c"], tiers: ["elected", "elected", "candidate"] }],
  });
});

test("G1: a former row beside a stub → nobody", () => {
  const idx = buildOfficialNameIndex([former("f", "Mark Green"), stub("s", "Mark Green")]);
  assert.equal(idx.byName.has("MARK GREEN"), false);
  assert.deepEqual(idx.refused.examples, [{ key: "MARK GREEN", ids: ["f", "s"], tiers: ["former (inactive)", "candidate"] }]);
});

test("G1: the full_name key and the first + last key are one namespace under one rule", () => {
  // Row x is reachable as JANE Q DOE (full_name) and JANE DOE (first + last);
  // row y's full_name is JANE DOE. Before cc-342 the first + last key was
  // last-write-wins and the full_name key first-write-wins, so which row held
  // JANE DOE depended on id order. Now it is shared, and neither is elected.
  const x: OfficialNameRow = { id: "x", full_name: "Jane Q. Doe", first_name: "Jane", last_name: "Doe", tier: "candidate", is_active: true };
  const y: OfficialNameRow = { id: "y", full_name: "Jane Doe", first_name: null, last_name: null, tier: "former", is_active: false };
  for (const rows of [[x, y], [y, x]]) {
    const idx = buildOfficialNameIndex(rows);
    assert.equal(idx.byName.get("JANE Q DOE"), "x");
    assert.equal(idx.byName.has("JANE DOE"), false);
    assert.deepEqual(idx.refused.examples.map((r) => r.key), ["JANE DOE"]);
  }
});

test("G1: the result does not change when the rows are read in reverse id order", () => {
  const rows: OfficialNameRow[] = [
    stub("01", "Keith Self"), sitting("02", "Keith Self"),
    sitting("03", "John Smith"), sitting("04", "John Smith"),
    former("05", "Mark Green"), stub("06", "Mark Green"),
    sitting("07", "Ann Lee"),
    { id: "08", full_name: "Jane Q. Doe", first_name: "Jane", last_name: "Doe", tier: "elected", is_active: true },
    { id: "09", full_name: "Jane Doe", first_name: null, last_name: null, tier: "candidate", is_active: true },
  ];
  const forward = buildOfficialNameIndex(rows);
  const reverse = buildOfficialNameIndex([...rows].reverse());
  assert.deepEqual(reverse, forward);
  assert.equal(forward.byName.get("JANE DOE"), "08", "the one active elected row settles the shared key");
  assert.equal(forward.settled, 2);
  assert.equal(forward.refused.count, 2);
});

test("G1: the refused examples are capped, sorted by key, and the count is the whole", () => {
  const rows: OfficialNameRow[] = [];
  for (let i = 0; i < REFUSED_NAME_EXAMPLES + 5; i++) {
    const name = `Pat Name${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
    rows.push(stub(`s${i}`, name), stub(`t${i}`, name));
  }
  const idx = buildOfficialNameIndex(rows);
  assert.equal(idx.refused.count, REFUSED_NAME_EXAMPLES + 5);
  assert.equal(idx.refused.examples.length, REFUSED_NAME_EXAMPLES);
  const keys = idx.refused.examples.map((r) => r.key);
  assert.deepEqual(keys, [...keys].sort());
});
