/**
 * FIX-1100 / FIX-975 — anchors for the vacuum tail.
 *
 * Runs via:  tsx --test src/lib/vacuum-tail.test.ts
 *
 * Two things are pinned here, both of which have already failed in production
 * once in some form:
 *
 *   1. The tail issues `VACUUM (ANALYZE)` and NEVER `VACUUM FULL`. FULL takes
 *      ACCESS EXCLUSIVE and rewrites the whole heap — on
 *      `financial_relationships` that is an outage, not a repair.
 *
 *   2. A failing vacuum is swallowed, loudly. The rewrite that preceded it has
 *      already committed; throwing here would convert a degraded visibility map
 *      into a lost data refresh, which is strictly worse. FIX-1100 depends on
 *      this directly — the compensating tail runs BEFORE the resume ingest, so
 *      a throw would block the very work it exists to protect.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import {
  vacuumRewritten,
  vacuumTables,
  REWRITE_TARGETS,
  KILLED_FEC_WRITER_TABLES,
} from "./vacuum-tail";

/** Minimal Client stand-in: records every SQL string it is handed. */
function fakeClient(opts: { failOn?: RegExp } = {}) {
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (opts.failOn?.test(sql)) throw new Error("simulated vacuum failure");
      return { rows: [] };
    },
  } as unknown as Client;
  return { client, queries };
}

test("vacuumTables issues VACUUM (ANALYZE), never VACUUM FULL", async () => {
  const { client, queries } = fakeClient();
  const logs: string[] = [];
  await vacuumTables(client, ["public.a", "public.b"], "unit test", (m) => logs.push(m));

  assert.deepEqual(queries, ["VACUUM (ANALYZE) public.a", "VACUUM (ANALYZE) public.b"]);
  for (const q of queries) assert.ok(!/FULL/i.test(q), `must never emit VACUUM FULL: ${q}`);
  assert.equal(logs.length, 2);
  assert.ok(logs[0]?.includes("unit test"), "reason is carried into the log line");
  assert.ok(logs[0]?.includes("FIX-943"), "log line names the standing rule");
});

test("vacuumTables does not throw when a vacuum fails, and still tries the rest", async () => {
  const { client, queries } = fakeClient({ failOn: /public\.a/ });
  const logs: string[] = [];

  await vacuumTables(client, ["public.a", "public.b"], "unit test", (m) => logs.push(m));

  // Both attempted — one bad table must not strand the others.
  assert.deepEqual(queries, ["VACUUM (ANALYZE) public.a", "VACUUM (ANALYZE) public.b"]);
  // Only the survivor logged through the success channel; the failure went to
  // console.error, which is the greppable signal the backstop cron relies on.
  assert.equal(logs.length, 1);
  assert.ok(logs[0]?.includes("public.b"));
});

test("vacuumRewritten is a no-op for a writer with no mapped targets", async () => {
  const { client, queries } = fakeClient();
  await vacuumRewritten(client, "some_writer_that_rewrites_nothing", () => {});
  assert.deepEqual(queries, []);
});

test("vacuumRewritten vacuums exactly the writer's mapped targets", async () => {
  const writer = "rebuild_financial_entity_donation_totals";
  const { client, queries } = fakeClient();
  await vacuumRewritten(client, writer, () => {});

  const expected = (REWRITE_TARGETS[writer] ?? []).map((t) => `VACUUM (ANALYZE) ${t}`);
  assert.ok(expected.length > 0, "fixture writer must have targets");
  assert.deepEqual(queries, expected);
});

test("FIX-1100 killed-writer table list covers both tables fec_bulk bulk-rewrites", () => {
  // The indiv stage writes donor entities AND the donation relationships. A
  // tail that covered only one would leave the other's visibility map degraded
  // — which is the 2026-08-24 state that motivated FIX-1100 (FR at 80.66%
  // all-visible with no last_vacuum, while FE had been vacuumed).
  assert.deepEqual([...KILLED_FEC_WRITER_TABLES], [
    "public.financial_relationships",
    "public.financial_entities",
  ]);
});
