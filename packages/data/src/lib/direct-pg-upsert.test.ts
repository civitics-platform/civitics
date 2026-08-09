/**
 * FIX-462 — pure-SQL-builder anchors for the direct-pg indiv upsert path.
 *
 * Runs via:  tsx --test src/lib/direct-pg-upsert.test.ts
 *
 * These pin the generated `INSERT ... ON CONFLICT` shape that replaced the
 * PostgREST `.upsert()` calls in fec-bulk/writer.ts. The arbiters MUST stay the
 * full unique indexes financial_entities_donor_fingerprint_unique and
 * financial_relationships_relcycle_unique — a partial arbiter would silently
 * stop deduping and re-insert every donor/donation row each Sunday.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { buildUpsertStatement, bulkUpsert } from "./direct-pg-upsert";

const DONOR_COLUMNS = [
  "canonical_name",
  "display_name",
  "entity_type",
  "fec_committee_id",
  "donor_fingerprint",
  "total_donated_cents",
  "total_received_cents",
  "metadata",
];

const REL_COLUMNS = [
  "relationship_type",
  "from_type",
  "from_id",
  "to_type",
  "to_id",
  "amount_cents",
  "occurred_at",
  "started_at",
  "ended_at",
  "cycle_year",
  "source_url",
  "metadata",
];

test("donor upsert: single row — placeholders, jsonb cast, conflict, returning", () => {
  const sql = buildUpsertStatement({
    table: "financial_entities",
    columns: DONOR_COLUMNS,
    conflictColumns: ["donor_fingerprint"],
    jsonbColumns: ["metadata"],
    returningColumns: ["id", "donor_fingerprint"],
    rowCount: 1,
  });

  // 8 columns; metadata ($8) cast ::jsonb.
  assert.match(sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8::jsonb\)/);
  assert.match(sql, /ON CONFLICT \("donor_fingerprint"\) DO UPDATE SET/);
  // Conflict key is NOT in the SET list; every other column is.
  assert.doesNotMatch(sql, /SET[^]*"donor_fingerprint" = EXCLUDED/);
  assert.match(sql, /"canonical_name" = EXCLUDED\."canonical_name"/);
  assert.match(sql, /"metadata" = EXCLUDED\."metadata"/);
  assert.match(sql, /RETURNING "id", "donor_fingerprint"$/);
});

test("donor upsert: multi-row placeholder numbering is row-major", () => {
  const sql = buildUpsertStatement({
    table: "financial_entities",
    columns: DONOR_COLUMNS,
    conflictColumns: ["donor_fingerprint"],
    jsonbColumns: ["metadata"],
    rowCount: 3,
  });
  // Row 1 ends at $8, row 2 spans $9..$16, row 3 spans $17..$24.
  assert.match(sql, /\(\$9, \$10, \$11, \$12, \$13, \$14, \$15, \$16::jsonb\)/);
  assert.match(sql, /\(\$17, \$18, \$19, \$20, \$21, \$22, \$23, \$24::jsonb\)/);
});

test("relationship upsert: 4-col arbiter matches financial_relationships_relcycle_unique", () => {
  const sql = buildUpsertStatement({
    table: "financial_relationships",
    columns: REL_COLUMNS,
    conflictColumns: ["relationship_type", "from_id", "to_id", "cycle_year"],
    jsonbColumns: ["metadata"],
    rowCount: 1,
  });
  assert.match(
    sql,
    /ON CONFLICT \("relationship_type", "from_id", "to_id", "cycle_year"\) DO UPDATE SET/,
  );
  // metadata ($12) is the only jsonb cast; arbiter columns excluded from SET.
  assert.match(sql, /\$12::jsonb\)/);
  assert.doesNotMatch(sql, /"cycle_year" = EXCLUDED/);
  assert.match(sql, /"amount_cents" = EXCLUDED\."amount_cents"/);
});

test("empty updateColumns → DO NOTHING", () => {
  const sql = buildUpsertStatement({
    table: "financial_entities",
    columns: ["donor_fingerprint"],
    conflictColumns: ["donor_fingerprint"],
    updateColumns: [],
    rowCount: 1,
  });
  assert.match(sql, /ON CONFLICT \("donor_fingerprint"\) DO NOTHING$/);
});

test("rejects unsafe identifiers (injection guard)", () => {
  assert.throws(
    () =>
      buildUpsertStatement({
        table: "financial_entities; DROP TABLE x",
        columns: DONOR_COLUMNS,
        conflictColumns: ["donor_fingerprint"],
        rowCount: 1,
      }),
    /unsafe identifier/,
  );
  assert.throws(
    () =>
      buildUpsertStatement({
        table: "financial_entities",
        columns: ["ok", "bad col"],
        conflictColumns: ["ok"],
        rowCount: 1,
      }),
    /unsafe identifier/,
  );
});

test("rejects zero rows / empty columns", () => {
  assert.throws(
    () =>
      buildUpsertStatement({
        table: "t",
        columns: ["a"],
        conflictColumns: ["a"],
        rowCount: 0,
      }),
    /rowCount/,
  );
  assert.throws(
    () =>
      buildUpsertStatement({
        table: "t",
        columns: [],
        conflictColumns: [],
        rowCount: 1,
      }),
    /columns is empty/,
  );
});

// ---------------------------------------------------------------------------
// FIX-754 — resume cursor support (startRowOffset + onChunkProcessed)
// ---------------------------------------------------------------------------

/** Fake pg client that records the first bind param of each query. */
function fakeClient(): { client: Client; firstParams: unknown[] } {
  const firstParams: unknown[] = [];
  const client = {
    query: async (_sql: string, params: unknown[]) => {
      firstParams.push(params[0]);
      return { rows: [] };
    },
  } as unknown as Client;
  return { client, firstParams };
}

test("FIX-754 startRowOffset skips already-committed rows and reports the delta", async () => {
  const { client, firstParams } = fakeClient();
  const rows = Array.from({ length: 10 }, (_, i) => [`row-${i}`]);

  const res = await bulkUpsert(client, {
    table: "t",
    columns: ["a"],
    conflictColumns: ["a"],
    rows,
    chunkSize: 3,
    startRowOffset: 6,
  });

  assert.equal(res.upserted, 4, "only rows 6..9 processed this run");
  assert.deepEqual(firstParams, ["row-6", "row-9"], "chunks start at the offset (3+1 rows)");
});

test("FIX-754 startRowOffset clamps: negative → 0, past the end → no-op", async () => {
  const rows = [["a"], ["b"]];
  {
    const { client } = fakeClient();
    const res = await bulkUpsert(client, {
      table: "t", columns: ["a"], conflictColumns: ["a"], rows, startRowOffset: -5,
    });
    assert.equal(res.upserted, 2);
  }
  {
    const { client, firstParams } = fakeClient();
    const res = await bulkUpsert(client, {
      table: "t", columns: ["a"], conflictColumns: ["a"], rows, startRowOffset: 99,
    });
    assert.equal(res.upserted, 0, "everything already committed");
    assert.equal(firstParams.length, 0, "no query issued");
  }
});

test("FIX-754 onChunkProcessed is awaited with the absolute row offset after every chunk", async () => {
  const { client } = fakeClient();
  const rows = Array.from({ length: 10 }, (_, i) => [i]);
  const offsets: number[] = [];

  await bulkUpsert(client, {
    table: "t",
    columns: ["a"],
    conflictColumns: ["a"],
    rows,
    chunkSize: 4,
    startRowOffset: 4,
    onChunkProcessed: async (n) => { offsets.push(n); },
  });

  assert.deepEqual(offsets, [8, 10], "absolute offsets, resumed from 4");
});

test("FIX-754 onChunkProcessed still fires when a chunk fails (cursor matches live accounting)", async () => {
  let call = 0;
  const client = {
    query: async () => {
      call++;
      if (call === 1) throw new Error("boom");
      return { rows: [] };
    },
  } as unknown as Client;

  const offsets: number[] = [];
  const res = await bulkUpsert(client, {
    table: "t",
    columns: ["a"],
    conflictColumns: ["a"],
    rows: Array.from({ length: 6 }, (_, i) => [i]),
    chunkSize: 3,
    onChunkProcessed: (n) => { offsets.push(n); },
  });

  assert.equal(res.failed, 3, "first chunk counted failed");
  assert.equal(res.upserted, 3, "second chunk landed");
  assert.deepEqual(offsets, [3, 6], "cursor advances past the failed chunk — it is not retried on resume");
});

// ---------------------------------------------------------------------------
// FIX-995 — onReturnedRows: per-chunk delivery instead of whole-stage retention
// ---------------------------------------------------------------------------

/** A client that RETURNs one synthetic row per input row of each chunk. */
function returningClient(): Client {
  return {
    query: async (_sql: string, params: unknown[]) => ({
      rows: params.map((p) => ({ id: `id-${String(p)}`, donor_fingerprint: `fp-${String(p)}` })),
    }),
  } as unknown as Client;
}

test("FIX-995 onReturnedRows: `returned` stays EMPTY and the callback sees every row exactly once", async () => {
  const seen: string[] = [];
  const chunkSizes: number[] = [];

  const res = await bulkUpsert(returningClient(), {
    table: "financial_entities",
    columns: ["a"],
    conflictColumns: ["a"],
    returningColumns: ["id", "donor_fingerprint"],
    rows: Array.from({ length: 10 }, (_, i) => [i]),
    chunkSize: 4,
    onReturnedRows: (rows) => {
      chunkSizes.push(rows.length);
      for (const r of rows) seen.push(String(r["donor_fingerprint"]));
    },
  });

  assert.deepEqual(res.returned, [], "rows must NOT be accumulated when the callback took delivery");
  assert.equal(res.upserted, 10);
  assert.deepEqual(chunkSizes, [4, 4, 2], "delivered per chunk, not once at the end");
  assert.deepEqual(
    seen,
    Array.from({ length: 10 }, (_, i) => `fp-${i}`),
    "every row exactly once, in order",
  );
  assert.equal(new Set(seen).size, 10, "no duplicates");
});

test("FIX-995 without the callback, `returned` is unchanged (today's behavior)", async () => {
  const res = await bulkUpsert(returningClient(), {
    table: "financial_entities",
    columns: ["a"],
    conflictColumns: ["a"],
    returningColumns: ["id", "donor_fingerprint"],
    rows: Array.from({ length: 10 }, (_, i) => [i]),
    chunkSize: 4,
  });

  assert.equal(res.returned.length, 10, "accumulated across every chunk, as before");
  assert.deepEqual(res.returned[0], { id: "id-0", donor_fingerprint: "fp-0" });
  assert.deepEqual(res.returned[9], { id: "id-9", donor_fingerprint: "fp-9" });
});

test("FIX-995 onReturnedRows composes with the FIX-754 resume offset", async () => {
  const seen: string[] = [];
  const res = await bulkUpsert(returningClient(), {
    table: "financial_entities",
    columns: ["a"],
    conflictColumns: ["a"],
    returningColumns: ["id", "donor_fingerprint"],
    rows: Array.from({ length: 10 }, (_, i) => [i]),
    chunkSize: 4,
    startRowOffset: 6,
    onReturnedRows: (rows) => { for (const r of rows) seen.push(String(r["donor_fingerprint"])); },
  });

  // Only rows 6..9 are re-upserted, so only those RETURN. Rows 0..5 landed in a
  // prior run and are backfilled by fec-bulk's fetchDonorIdsByFingerprint —
  // this is the pre-existing FIX-754 behavior, unchanged by the callback.
  assert.deepEqual(seen, ["fp-6", "fp-7", "fp-8", "fp-9"]);
  assert.deepEqual(res.returned, []);
  assert.equal(res.upserted, 4);
});

test("FIX-995 the callback is not invoked when there are no returningColumns", async () => {
  let calls = 0;
  const res = await bulkUpsert(returningClient(), {
    table: "t",
    columns: ["a"],
    conflictColumns: ["a"],
    rows: Array.from({ length: 5 }, (_, i) => [i]),
    chunkSize: 2,
    onReturnedRows: () => { calls++; },
  });

  assert.equal(calls, 0, "no RETURNING ⇒ nothing to deliver");
  assert.deepEqual(res.returned, []);
});

// ---------------------------------------------------------------------------
// FIX-1008 — skipUnchangedRows (no-op re-upserts are not rewritten)
// ---------------------------------------------------------------------------

test("FIX-1008 skipUnchangedRows adds a WHERE over EXACTLY the SET columns", () => {
  const sql = buildUpsertStatement({
    table: "financial_relationships",
    columns: REL_COLUMNS,
    conflictColumns: ["relationship_type", "from_id", "to_id", "cycle_year"],
    jsonbColumns: ["metadata"],
    skipUnchangedRows: true,
    rowCount: 1,
  });

  assert.match(sql, /DO UPDATE SET .* WHERE \(/, "predicate follows the SET list");
  // Every SET column is in the predicate...
  for (const c of REL_COLUMNS) {
    if (["relationship_type", "from_id", "to_id", "cycle_year"].includes(c)) continue;
    assert.match(
      sql,
      new RegExp(`"financial_relationships"\."${c}" IS DISTINCT FROM EXCLUDED\."${c}"`),
      `${c} must be covered — a SET column outside the predicate can change silently`,
    );
  }
  // ...and the arbiter columns are in neither the SET nor the predicate (they
  // are equal by definition of the conflict).
  assert.doesNotMatch(sql, /"cycle_year" IS DISTINCT FROM/);
  assert.match(sql, /\)$/, "no RETURNING here, so the predicate closes the statement");
});

test("FIX-1008 predicate is disjunctive — ANY differing SET column rewrites the row", () => {
  const sql = buildUpsertStatement({
    table: "t",
    columns: ["k", "a", "b"],
    conflictColumns: ["k"],
    skipUnchangedRows: true,
    rowCount: 1,
  });
  assert.match(
    sql,
    /WHERE \("t"\."a" IS DISTINCT FROM EXCLUDED\."a" OR "t"\."b" IS DISTINCT FROM EXCLUDED\."b"\)$/,
  );
});

test("FIX-1008 RETURNING still trails the predicate", () => {
  const sql = buildUpsertStatement({
    table: "financial_entities",
    columns: DONOR_COLUMNS,
    conflictColumns: ["donor_fingerprint"],
    jsonbColumns: ["metadata"],
    returningColumns: ["id", "donor_fingerprint"],
    skipUnchangedRows: true,
    rowCount: 1,
  });
  assert.match(sql, /IS DISTINCT FROM EXCLUDED\."metadata"\) RETURNING "id", "donor_fingerprint"$/);
});

test("FIX-1008 omitting the flag leaves the statement byte-identical to today", () => {
  const base = {
    table: "financial_relationships",
    columns: REL_COLUMNS,
    conflictColumns: ["relationship_type", "from_id", "to_id", "cycle_year"],
    jsonbColumns: ["metadata"],
    rowCount: 2,
  };
  assert.equal(
    buildUpsertStatement(base),
    buildUpsertStatement({ ...base, skipUnchangedRows: false }),
  );
  assert.doesNotMatch(buildUpsertStatement(base), /IS DISTINCT FROM/);
});

test("FIX-1008 DO NOTHING is never given a predicate", () => {
  const sql = buildUpsertStatement({
    table: "t",
    columns: ["k"],
    conflictColumns: ["k"],
    updateColumns: [],
    skipUnchangedRows: true,
    rowCount: 1,
  });
  assert.match(sql, /ON CONFLICT \("k"\) DO NOTHING$/);
  assert.doesNotMatch(sql, /WHERE/);
});

test("FIX-1008 `changed` reports the server row count, `upserted` still counts attempts", async () => {
  // Server writes only 1 of every 4 rows (the rest failed the predicate).
  const client = {
    query: async () => ({ rows: [], rowCount: 1 }),
  } as unknown as Client;

  const res = await bulkUpsert(client, {
    table: "t",
    columns: ["k", "a"],
    conflictColumns: ["k"],
    skipUnchangedRows: true,
    rows: Array.from({ length: 12 }, (_, i) => [i, i]),
    chunkSize: 4,
  });

  assert.equal(res.upserted, 12, "rows processed — unchanged semantics for existing callers");
  assert.equal(res.changed, 3, "3 chunks × rowCount 1 actually written");
});

test("FIX-1008 `changed` equals `upserted` when the driver omits rowCount", async () => {
  const client = { query: async () => ({ rows: [] }) } as unknown as Client;
  const res = await bulkUpsert(client, {
    table: "t",
    columns: ["a"],
    conflictColumns: ["a"],
    rows: Array.from({ length: 5 }, (_, i) => [i]),
    chunkSize: 2,
  });
  assert.equal(res.changed, res.upserted);
});
