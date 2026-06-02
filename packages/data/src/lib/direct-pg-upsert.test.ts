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
import { buildUpsertStatement } from "./direct-pg-upsert";

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
