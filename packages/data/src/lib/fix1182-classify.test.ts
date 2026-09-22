/**
 * FIX-1182 experiment (1) — the classifier, on a fixture that covers all three
 * classes plus the two rows that must NOT become retractions: a PARTIAL row in
 * set A, and a row younger than set A.
 *
 * The assertion that matters is not "the counts add up" — it is that the only
 * class the apply may ever touch is the one where an earlier complete run
 * DEMONSTRABLY held rows a later complete run dropped. Everything else is
 * FIX-1182's hazard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { type ManifestRow, classify, parseLastWrite, totals } from "./fix1182-classify";

const A_GENERATED = new Date("2026-09-14T00:51:58.216Z");

function row(p: Partial<ManifestRow> & { to_id: string; cls: string }): ManifestRow {
  return {
    cls: p.cls,
    to_type: p.to_type ?? "official",
    to_id: p.to_id,
    name: p.name ?? `name-${p.to_id}`,
    rows: p.rows ?? 10,
    cents: p.cents ?? 1000,
    last_write: p.last_write ?? "2026-09-01 00:00:00+00",
    emitted_rows: p.emitted_rows ?? 0,
  };
}

// Six rows across the two sets:
//   both   — DROPPED-OUT in A and B          → (i)   unproven
//   clean  — absent from A, DROPPED-OUT in B → (ii)  retraction
//   part   — PARTIAL in A, DROPPED-OUT in B  → (ii)  retraction (partial→dropped)
//   young  — absent from A, DROPPED-OUT in B, but written AFTER A → (i) demoted
//   back   — DROPPED-OUT in A, absent from B → (iii) re-emitted
//   quiet  — PARTIAL in both                 → not in any class
const SET_A: ManifestRow[] = [
  row({ to_id: "both", cls: "DROPPED-OUT", rows: 5, cents: 500 }),
  row({ to_id: "part", cls: "PARTIAL", rows: 2, cents: 200, emitted_rows: 40 }),
  row({ to_id: "back", cls: "DROPPED-OUT", rows: 7, cents: 700 }),
  row({ to_id: "quiet", cls: "PARTIAL", rows: 1, cents: 100 }),
];

const SET_B: ManifestRow[] = [
  row({ to_id: "both", cls: "DROPPED-OUT", rows: 5, cents: 500 }),
  row({ to_id: "clean", cls: "DROPPED-OUT", rows: 9, cents: 900 }),
  row({ to_id: "part", cls: "DROPPED-OUT", rows: 42, cents: 4200 }),
  row({ to_id: "young", cls: "DROPPED-OUT", rows: 3, cents: 300, last_write: "2026-09-19 12:00:00+00" }),
  row({ to_id: "quiet", cls: "PARTIAL", rows: 1, cents: 100 }),
];

const classified = classify({ setA: SET_A, setB: SET_B, generatedA: A_GENERATED });
const byId = new Map(classified.map((r) => [r.to_id, r]));

test("DROPPED-OUT in both runs is UNPROVEN, never applicable", () => {
  assert.equal(byId.get("both")?.klass, "unproven-both");
});

test("absent from A and DROPPED-OUT in B is the retraction class", () => {
  assert.equal(byId.get("clean")?.klass, "retraction");
});

test("PARTIAL in A then DROPPED-OUT in B is a retraction, and is flagged as partial", () => {
  // A PARTIAL row is NOT membership of A's DROPPED-OUT list: A emitted some of
  // its rows, so B dropping all of them is a real retraction.
  const r = byId.get("part");
  assert.equal(r?.klass, "retraction");
  assert.equal(r?.wasPartialInA, true);
});

test("a PARTIAL row that stays PARTIAL is in no class at all", () => {
  assert.equal(byId.has("quiet"), false);
});

test("a row younger than set A is DEMOTED to unproven, not deleted", () => {
  // The provenance check. Absence from a list cut before the rows existed is
  // not evidence of anything.
  const r = byId.get("young");
  assert.equal(r?.klass, "unproven-both");
  assert.match(r?.demotedReason ?? "", /not older than set A/);
});

test("DROPPED-OUT in A but not in B was re-emitted — deleting it is the FIX-1182 hazard", () => {
  assert.equal(byId.get("back")?.klass, "re-emitted");
});

test("the Postgres '+00' zone parses — it is not ISO, and Date rejects it raw", () => {
  // The bug this caught: `new Date("2026-09-01T01:17:41.714183+00")` is
  // Invalid Date, so every candidate retraction demoted to unproven and the
  // whole experiment reported an empty apply for the right-looking reason.
  const d = parseLastWrite("2026-09-01 01:17:41.714183+00");
  assert.notEqual(d, null);
  assert.equal(d?.toISOString(), "2026-09-01T01:17:41.714Z");
  assert.ok((d as Date) < A_GENERATED, "a 09-01 write must read as older than a 09-14 set A");
});

test("an unparseable last_write fails closed", () => {
  const out = classify({
    setA: [],
    setB: [row({ to_id: "odd", cls: "DROPPED-OUT", last_write: "not-a-date" })],
    generatedA: A_GENERATED,
  });
  assert.equal(out[0]?.klass, "unproven-both");
  assert.equal(parseLastWrite("not-a-date"), null);
});

test("totals reconcile: A's DROPPED-OUT = (i)+(iii), B's = (i)+(ii)", () => {
  const i = totals(classified, "unproven-both");
  const ii = totals(classified, "retraction");
  const iii = totals(classified, "re-emitted");

  const aDropped = SET_A.filter((r) => r.cls === "DROPPED-OUT").length;
  const bDropped = SET_B.filter((r) => r.cls === "DROPPED-OUT").length;

  // "young" sits in (i) by demotion while being absent from A, so the A-side
  // identity holds over the rows A actually listed — which is what it claims.
  assert.equal(i.recipients + ii.recipients, bDropped, "B's DROPPED-OUT = (i)+(ii)");
  assert.equal(
    classified.filter((r) => r.klass === "unproven-both" && r.demotedReason === undefined).length + iii.recipients,
    aDropped,
    "A's DROPPED-OUT = (i, undemoted)+(iii)",
  );
  assert.equal(ii.rows, 9 + 42);
  assert.equal(ii.cents, 900 + 4200);
});
