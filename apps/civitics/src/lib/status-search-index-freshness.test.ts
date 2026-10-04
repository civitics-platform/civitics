/**
 * FIX-1269 — the status snapshot's search-index freshness self-test reads the
 * one-row stamp rebuild_entity_search_index() writes, and sorts the table only
 * when that stamp does not exist yet.
 *
 * Pinned with a fake client that records which tables were touched:
 *   - stamp present          → pipeline_state only; entity_search_index never read
 *   - stamp absent           → the legacy sort, once
 *   - stamp read fails       → the failure is returned; the sort is NOT tried
 *   - stamp without the field → refreshed_at null (reads as "no stamp"), no sort
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readSearchIndexFreshness, type Db } from "../../app/api/claude/status/_lib/sections";

type Result = { data: unknown; error: { message: string } | null };

function fakeDb(byTable: Record<string, Result>) {
  const touched: string[] = [];
  const builder = (table: string) => {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => byTable[table] ?? { data: null, error: null },
    };
    return b;
  };
  const db = {
    from: (table: string) => {
      touched.push(table);
      return builder(table);
    },
  } as unknown as Db;
  return { db, touched };
}

test("FIX-1269: a present stamp is the answer; the table is never sorted", async () => {
  const { db, touched } = fakeDb({
    pipeline_state: { data: { value: { refreshed_at: "2026-10-04T06:04:01+00:00", rows: 367713 } }, error: null },
  });
  const res = await readSearchIndexFreshness(db);
  assert.deepEqual(res, { data: { refreshed_at: "2026-10-04T06:04:01+00:00" }, error: null });
  assert.deepEqual(touched, ["pipeline_state"]);
});

test("FIX-1269: an absent stamp falls back to the legacy sort, once", async () => {
  const { db, touched } = fakeDb({
    pipeline_state: { data: null, error: null },
    entity_search_index: { data: { refreshed_at: "2026-10-03T06:01:15+00:00" }, error: null },
  });
  const res = await readSearchIndexFreshness(db);
  assert.deepEqual(res, { data: { refreshed_at: "2026-10-03T06:01:15+00:00" }, error: null });
  assert.deepEqual(touched, ["pipeline_state", "entity_search_index"]);
});

test("FIX-1269: a failed stamp read is returned as the failure — the expensive sort is not retried", async () => {
  const { db, touched } = fakeDb({
    pipeline_state: { data: null, error: { message: "canceling statement due to statement timeout" } },
  });
  const res = await readSearchIndexFreshness(db);
  assert.equal(res.data, null);
  assert.equal(res.error?.message, "canceling statement due to statement timeout");
  assert.deepEqual(touched, ["pipeline_state"]);
});

test("FIX-1269: a stamp row without refreshed_at reads as no stamp, without sorting", async () => {
  const { db, touched } = fakeDb({ pipeline_state: { data: { value: { rows: 1 } }, error: null } });
  const res = await readSearchIndexFreshness(db);
  assert.deepEqual(res, { data: { refreshed_at: null }, error: null });
  assert.deepEqual(touched, ["pipeline_state"]);
});
