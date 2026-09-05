/**
 * FIX-759 — end-of-run FEC ID persist must be a SERVER-SIDE jsonb merge.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/persist-new-fec-ids.test.ts
 *
 * These pin the shape that replaced the stale read-modify-write
 * (`{ ...snapshot.source_ids, [key]: fecId }` through PostgREST .update()):
 * the UPDATE must merge against the row's LIVE source_ids with `||`, never
 * send a client-built full jsonb. A regression back to a whole-column write
 * re-opens the lost-update window that dropped keys other writers merged in
 * mid-run (congress nightly, promotion's fec_candidate_id — the FIX-755/758
 * clobber class).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { persistNewFecIds, type NewFecIdRow } from "./writer";

function fakeClient(): { client: Client; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Client;
  return { client, calls };
}

test("merge write: server-side || against live source_ids, one UPDATE per id", async () => {
  const { client, calls } = fakeClient();
  const ids: NewFecIdRow[] = [
    { officialId: "11111111-1111-1111-1111-111111111111", fecId: "H8CA05035", storageKey: "fec_id" },
    { officialId: "22222222-2222-2222-2222-222222222222", fecId: "S6TX00123", storageKey: "fec_candidate_id" },
  ];

  await persistNewFecIds(client, ids);

  assert.equal(calls.length, 2, "one statement per discovered id");
  for (const { sql } of calls) {
    // The merge MUST read the row's live value — `source_ids ||`, guarded by
    // COALESCE so a NULL column doesn't nullify the merge.
    assert.match(sql, /SET source_ids = COALESCE\(source_ids, '\{\}'::jsonb\) \|\| jsonb_build_object\(\$1::text, \$2::text\)/);
    assert.match(sql, /WHERE id = \$3::uuid/);
    // No client-built jsonb payload anywhere: the only params are key/value/id.
    assert.doesNotMatch(sql, /::jsonb\s*WHERE/i, "no whole-column jsonb bind");
  }
  assert.deepEqual(calls[0]?.params, ["fec_id", "H8CA05035", "11111111-1111-1111-1111-111111111111"]);
  assert.deepEqual(calls[1]?.params, ["fec_candidate_id", "S6TX00123", "22222222-2222-2222-2222-222222222222"]);
});

test("empty input issues no queries", async () => {
  const { client, calls } = fakeClient();
  await persistNewFecIds(client, []);
  assert.equal(calls.length, 0);
});

test("FIX-955/956: the guard refuses a re-claim under EITHER marker shape", async () => {
  const { client, calls } = fakeClient();
  await persistNewFecIds(client, [
    { officialId: "33333333-3333-3333-3333-333333333333", fecId: "S4IN00196", storageKey: "fec_candidate_id" },
  ]);
  assert.equal(calls.length, 1);
  const sql = calls[0]!.sql.replace(/\s+/g, " ");

  // The legacy scalar (86 prod rows as of 2026-09-05).
  assert.match(
    sql,
    /COALESCE\(source_ids->>'merged_fec_candidate_id', ''\) <> \$2::text/,
    "scalar marker guard must survive",
  );
  // FIX-956 — the array shape every writer now emits. Without this arm, a row
  // that retired TWO ids (expressible only as the array) would be re-claimed
  // here, which is the exact defect FIX-955 closed for the scalar.
  assert.match(
    sql,
    /NOT \(COALESCE\(source_ids->'merged_fec_candidate_ids', '\[\]'::jsonb\) \? \$2::text\)/,
    "array marker guard must be present",
  );
  // The retired id is the parameter both arms test, not an interpolated literal.
  assert.deepEqual(calls[0]!.params, [
    "fec_candidate_id", "S4IN00196", "33333333-3333-3333-3333-333333333333",
  ]);
});
