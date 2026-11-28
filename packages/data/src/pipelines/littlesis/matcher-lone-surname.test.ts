/**
 * FIX-1468 (cc-342 G3) — a lone surname needs the first name.
 *
 * `matchPerson` bound an official whenever its surname pool (narrowed by a
 * state hint when one exists) held ONE row, with no first-name check; only a
 * pool of two or more consulted the first three letters of the first name.
 * Now the lone pool takes the same test, FIX-929's rule for fec-bulk's lone
 * surname: the official's first name must start with the first three letters
 * of the LittleSis first token. A first token under three letters, or a
 * disagreement, queues as `lone_surname_first_mismatch`. The multi-row branches
 * are unchanged (matcher-keyset.test.ts still pins them).
 *
 * Runs via:  tsx --test src/pipelines/littlesis/matcher-lone-surname.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPerson, type MatchIndex, type OfficialRow } from "./matcher";
import type { LittleSisEntity } from "./util";

function official(id: string, full_name: string, first_name: string | null, last_name: string | null, state_abbr: string | null = null): OfficialRow {
  return { id, full_name, first_name, last_name, state_abbr, role_title: null };
}

function index(officials: OfficialRow[]): MatchIndex {
  const officialsByLastName = new Map<string, OfficialRow[]>();
  for (const o of officials) {
    // The same surname key buildMatchIndex builds.
    const last = (o.last_name ?? o.full_name.split(/\s+/).pop() ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    officialsByLastName.set(last, [...(officialsByLastName.get(last) ?? []), o]);
  }
  return { officialsByLastName, personsBySortKey: new Map(), orgsByCanonical: new Map() };
}

const person = (id: number, name: string, extra: Partial<LittleSisEntity> = {}): LittleSisEntity =>
  ({ id, name, primary_ext: "Person", ...extra });

test("G3: a lone surname with an agreeing first name binds as today", () => {
  const idx = index([official("o-pritzker", "Penny Pritzker", "Penny", "Pritzker", "IL")]);
  assert.deepEqual(matchPerson(person(1, "Penny Pritzker"), idx), {
    kind: "medium", civitics_type: "official", civitics_id: "o-pritzker",
  });
  // Three letters are the test, not the whole name.
  assert.deepEqual(matchPerson(person(2, "Penelope Pritzker"), idx), {
    kind: "medium", civitics_type: "official", civitics_id: "o-pritzker",
  });
});

test("G3: a lone surname with a disagreeing first name queues with the new reason", () => {
  const idx = index([official("o-yang", "Andrew Yang", "Andrew", "Yang")]);
  assert.deepEqual(matchPerson(person(3, "Jerry Yang"), idx), {
    kind: "queue",
    reason: "lone_surname_first_mismatch",
    candidates: [{ id: "o-yang", type: "official", reason: "lone_surname" }],
  });
});

test("G3: a one- or two-letter first token queues", () => {
  const idx = index([official("o-lee", "Al Lee", "Al", "Lee")]);
  for (const name of ["J Lee", "Al Lee"]) {
    const m = matchPerson(person(4, name), idx);
    assert.equal(m.kind, "queue", name);
    assert.equal(m.kind === "queue" && m.reason, "lone_surname_first_mismatch", name);
  }
});

test("G3: an official with no first_name is tested on its full_name's first token", () => {
  // 17,157 of prod's 39,380 officials rows carry no first_name (cc-342 read 2,
  // 9,494 of them PLUM appointees). The surname key already falls back to
  // full_name's last token; the first-name test falls back to its first.
  const idx = index([official("o-luby", "MATTHEW LUBY", null, null)]);
  assert.deepEqual(matchPerson(person(5, "Matthew Luby"), idx), {
    kind: "medium", civitics_type: "official", civitics_id: "o-luby",
  });
  assert.equal(matchPerson(person(6, "Sarah Luby"), idx).kind, "queue");
});

test("G3: a suffix surname is the case the rule exists for", () => {
  // `JULIUS GAMBLE, II` has no last_name, so its surname key is `II`: before
  // cc-342 every LittleSis person whose last token is II and whose pool held
  // that one row bound to it (one prod row holds 547 LittleSis people).
  const idx = index([official("o-gamble", "JULIUS GAMBLE, II", null, null)]);
  assert.equal(matchPerson(person(7, "Robert Smith II"), idx).kind, "queue");
  assert.deepEqual(matchPerson(person(8, "Julius Gamble II"), idx), {
    kind: "medium", civitics_type: "official", civitics_id: "o-gamble",
  });
});

test("G3: a state-narrowed lone row takes the same test, and keeps `high` when it passes", () => {
  const idx = index([
    official("o-ga", "Jon Ossoff", "Jon", "Ossoff", "GA"),
    official("o-tx", "Mary Ossoff", "Mary", "Ossoff", "TX"),
  ]);
  const inGa = { types: ["Democratic_Party_US_GA"] };
  assert.deepEqual(matchPerson(person(9, "Jon Ossoff", inGa), idx), {
    kind: "high", civitics_type: "official", civitics_id: "o-ga",
  });
  // The hint narrows the pool to the one Georgia row; a disagreeing first name
  // now queues rather than binding by state alone.
  assert.deepEqual(matchPerson(person(10, "Mary Ossoff", inGa), idx), {
    kind: "queue",
    reason: "lone_surname_first_mismatch",
    candidates: [{ id: "o-ga", type: "official", reason: "lone_surname" }],
  });
});

test("G3: the multi-row branches are unchanged", () => {
  const idx = index([
    official("o-1", "Mark Smith", "Mark", "Smith"),
    official("o-2", "Nancy Smith", "Nancy", "Smith"),
    official("o-3", "Mark Smith", "Mark", "Smith"),
  ]);
  assert.deepEqual(matchPerson(person(11, "Nancy Smith"), idx), {
    kind: "medium", civitics_type: "official", civitics_id: "o-2",
  });
  const two = matchPerson(person(12, "Mark Smith"), idx);
  assert.equal(two.kind === "queue" && two.reason, "multi_after_state_and_first_prefix");
  const none = matchPerson(person(13, "Jo Smith"), idx);
  assert.equal(none.kind === "queue" && none.reason, "multi_after_state_narrow");
});
