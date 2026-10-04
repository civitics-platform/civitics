/**
 * FIX-1259 — upsertTags must hand bulkUpsert the provenance guard.
 *
 * entity_tags' conflict key is (entity_type, entity_id, tag, tag_category) and
 * carries no generated_by, so without a predicate the rule tagger's DO UPDATE
 * rewrote an ai row as 'rule' (cc-176 §5.7; prod 2,126 → 2,075 ai industry
 * rows across two tails, cc-180 read 4). The builder's own tests pin the SQL
 * shape; this pins that the ONE function all three rule taggers write through
 * actually asks for it. The behaviour against a real table is proven by
 * `pnpm --filter @civitics/data data:verify:tag-provenance` on the clone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { upsertTags } from "./rules";

function captureClient(rowCount: number) {
  const sql: string[] = [];
  const client = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: [], rowCount };
    },
  };
  return { client: client as unknown as Client, sql };
}

const tag = (entity_id: string, t: string) => ({
  entity_type: "financial_entity" as const,
  entity_id,
  tag: t,
  tag_category: "industry",
  display_label: t,
  display_icon: null,
  visibility: "primary" as const,
  generated_by: "rule" as const,
  confidence: 0.85,
  pipeline_version: "v1",
  metadata: { naics_code: "541512" },
});

test("upsertTags only overwrites rows whose generated_by matches the incoming row", async () => {
  const { client, sql } = captureClient(2);
  await upsertTags(client, [tag("00000000-0000-4000-8000-000000000001", "tech"),
                            tag("00000000-0000-4000-8000-000000000002", "defense")]);
  assert.equal(sql.length, 1);
  assert.match(
    sql[0]!,
    /ON CONFLICT \("entity_type", "entity_id", "tag", "tag_category"\) DO UPDATE SET .* WHERE \("entity_tags"\."generated_by" IS NOT DISTINCT FROM EXCLUDED\."generated_by"\)$/,
  );
});

// FIX-1273 — the kept count leaves the function, so the rule tagger can stamp it
// into data_sync_log instead of only printing it to the GHA log.
test("upsertTags returns { upserted: 2, kept: 1 } when the server wrote 1 of 2", async () => {
  // The server wrote 1 of 2: the other conflicted with a different provenance.
  const { client } = captureClient(1);
  const n = await upsertTags(client, [tag("00000000-0000-4000-8000-000000000001", "tech"),
                                      tag("00000000-0000-4000-8000-000000000002", "defense")]);
  assert.deepEqual(n, { upserted: 2, kept: 1 });
});

test("upsertTags reports kept 0 when the server wrote every row", async () => {
  const { client } = captureClient(2);
  const n = await upsertTags(client, [tag("00000000-0000-4000-8000-000000000001", "tech"),
                                      tag("00000000-0000-4000-8000-000000000002", "defense")]);
  assert.deepEqual(n, { upserted: 2, kept: 0 });
});

test("upsertTags on an empty set writes nothing and keeps nothing", async () => {
  const { client, sql } = captureClient(0);
  assert.deepEqual(await upsertTags(client, []), { upserted: 0, kept: 0 });
  assert.equal(sql.length, 0);
});
