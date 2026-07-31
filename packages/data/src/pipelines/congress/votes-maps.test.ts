/**
 * FIX-940 — the Senate vote writer's name map must never resolve a sitting
 * Senator to an FEC candidate stub, and must never silently pick a winner when
 * two rows claim one key.
 *
 * Before this gate, `buildOfficialMaps` iterated EVERY official in the Senate
 * governing body — 2,054 rows on the 2026-07-30 clone, of which 1,953 are
 * `tier='candidate'` stubs minted by the FEC cn{yy} stage — ordered by uuid, and
 * did an unconditional `.set()`. Roughly half of contested `(surname, state)`
 * slots therefore resolved to the stub, and 1,755 votes across 49 candidate-tier
 * officials landed on rows nobody can see. No error: the insert succeeded, the
 * public page just stopped. The tier filter now lives at the call site
 * (`currentGoverningBodyMembers`); the collision refusal lives here.
 *
 * Runs via:  tsx --test src/pipelines/congress/votes-maps.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBioguideMap,
  buildSenatorNameStateMap,
  normalizeSurname,
  senateNameKey,
  type SenatorRow,
} from "./votes-maps";

// The real Ossoff rows. `1376dc1e…` is the sitting Senator (bioguide O000174,
// 1,801 votes through 2026-05-20); `4719d31a…` is the "T Ossoff" cn{yy} stub
// that took the `ossoff:GA` slot and collected 57 votes from 2026-06-01 on.
const OSSOFF_ELECTED = "1376dc1e-f697-40b2-8c0f-780f8fe8ea00";
const OSSOFF_STUB    = "4719d31a-7db4-4f6f-b933-8442a1fb1f76";

function senator(id: string, last_name: string | null, state: string | null): SenatorRow {
  return { id, last_name, state };
}

// ---------------------------------------------------------------------------
// The pool filter is what keeps candidate stubs out
// ---------------------------------------------------------------------------

test("a candidate-tier row never takes a slot from an elected row", () => {
  // The call site scopes the pool with currentGoverningBodyMembers(), so a
  // candidate stub is not in `rows` at all — the elected row holds the slot
  // regardless of uuid order. This pins the post-filter contract.
  const { map, collisions } = buildSenatorNameStateMap([
    senator(OSSOFF_ELECTED, "Ossoff", "GA"),
  ]);

  assert.equal(map.get("ossoff:GA"), OSSOFF_ELECTED);
  assert.deepEqual(collisions, []);
});

test("the Ossoff shape specifically — the stub must not win the ossoff:GA slot", () => {
  // Belt-and-braces: even if a candidate row somehow reached the builder, the
  // refusal guard means the FIRST row keeps the slot rather than the last one
  // by uuid. `1376dc1e…` sorts before `4719d31a…` under .order("id"), so the
  // sitting Senator is the holder and the stub is refused, not silently taken.
  const { map, collisions } = buildSenatorNameStateMap([
    senator(OSSOFF_ELECTED, "Ossoff", "GA"),
    senator(OSSOFF_STUB, "Ossoff", "GA"),
  ]);

  assert.equal(map.get("ossoff:GA"), OSSOFF_ELECTED);
  assert.notEqual(map.get("ossoff:GA"), OSSOFF_STUB);
  assert.equal(collisions.length, 1);
  assert.deepEqual(collisions[0], {
    key: "ossoff:GA",
    kept: OSSOFF_ELECTED,
    refused: OSSOFF_STUB,
  });
});

// ---------------------------------------------------------------------------
// Collision refusal within the elected pool
// ---------------------------------------------------------------------------

test("two elected rows sharing (surname, state) leave the slot at the first and report", () => {
  const a = "00000000-0000-0000-0000-00000000000a";
  const b = "ffffffff-ffff-ffff-ffff-ffffffffffff";

  const { map, collisions } = buildSenatorNameStateMap([
    senator(a, "Smith", "TX"),
    senator(b, "Smith", "TX"),
  ]);

  // Last-write-wins would have handed the slot to `b`.
  assert.equal(map.get("smith:TX"), a);
  assert.equal(map.size, 1);
  assert.deepEqual(collisions, [{ key: "smith:TX", kept: a, refused: b }]);
});

test("same surname in different states is not a collision", () => {
  // Rick Scott (FL) and Tim Scott (SC) both sit today — the state component is
  // what keeps them apart, and neither may be refused.
  const fl = "aaaaaaaa-0000-0000-0000-000000000001";
  const sc = "bbbbbbbb-0000-0000-0000-000000000002";

  const { map, collisions } = buildSenatorNameStateMap([
    senator(fl, "Scott", "FL"),
    senator(sc, "Scott", "SC"),
  ]);

  assert.equal(map.get("scott:FL"), fl);
  assert.equal(map.get("scott:SC"), sc);
  assert.deepEqual(collisions, []);
});

test("re-reading the same row twice is a no-op, not a collision", () => {
  const { map, collisions } = buildSenatorNameStateMap([
    senator(OSSOFF_ELECTED, "Ossoff", "GA"),
    senator(OSSOFF_ELECTED, "Ossoff", "GA"),
  ]);

  assert.equal(map.get("ossoff:GA"), OSSOFF_ELECTED);
  assert.deepEqual(collisions, []);
});

test("rows missing a surname or a state are skipped, never keyed on the empty string", () => {
  const { map, collisions } = buildSenatorNameStateMap([
    senator("no-name", null, "GA"),
    senator("no-state", "Ossoff", null),
    senator("blank-state", "Ossoff", "   "),
  ]);

  assert.equal(map.size, 0);
  assert.deepEqual(collisions, []);
});

// ---------------------------------------------------------------------------
// Diacritics — the Luján case
// ---------------------------------------------------------------------------

test("senateNameKey folds diacritics so Luján matches the XML's ASCII Lujan", () => {
  // Senate roll-call XML spells every surname ASCII-only —
  // `<last_name>Lujan</last_name>` with `<state>NM</state>` — while `officials`
  // stores "Luján". He is the ONLY sitting Senator with a non-ASCII surname,
  // and his elected row holds ZERO votes because the key never matched: his
  // roll-calls fell through to the ASCII "Ben Lujan" candidate stub. A tier
  // filter alone would have turned those misfiled votes into dropped ones.
  assert.equal(senateNameKey("Luján", "NM"), "lujan:NM");
  assert.equal(senateNameKey("Lujan", "NM"), "lujan:NM");
  assert.equal(senateNameKey("Luján", "NM"), senateNameKey("Lujan", "nm"));
});

test("the map is keyed on the folded surname, so the XML lookup resolves", () => {
  const lujan = "eadbf1fd-e245-44ff-91ec-794407411f69";
  const { map } = buildSenatorNameStateMap([senator(lujan, "Luján", "NM")]);

  // What the writer computes from the XML side.
  assert.equal(map.get(senateNameKey("Lujan", "NM")), lujan);
});

test("normalizeSurname is idempotent and case-folding", () => {
  assert.equal(normalizeSurname("Cortez Masto"), "cortez masto");
  assert.equal(normalizeSurname("  Ossoff  "), "ossoff");
  assert.equal(normalizeSurname(normalizeSurname("Luján")), "lujan");
  assert.equal(normalizeSurname(null), "");
});

// ---------------------------------------------------------------------------
// Bioguide map (House branch)
// ---------------------------------------------------------------------------

test("bioguide map refuses a duplicated congress_gov id rather than overwriting", () => {
  // FIX-933's merge now puts congress_gov and fec_candidate_id on the same row,
  // so one-row-per-bioguide is worth asserting rather than assuming.
  const first  = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";

  const { map, collisions } = buildBioguideMap([
    { id: first,  source_ids: { congress_gov: "O000174" } },
    { id: second, source_ids: { congress_gov: "O000174" } },
    { id: "no-bioguide", source_ids: { fec_candidate_id: "S8GA00180" } },
    { id: "null-source-ids", source_ids: null },
  ]);

  assert.equal(map.get("O000174"), first);
  assert.equal(map.size, 1);
  assert.deepEqual(collisions, [{ key: "O000174", kept: first, refused: second }]);
});
