/**
 * FIX-918 — fetchIndustryTagsByEntityId reads the SQL rule; it does not own one.
 *
 * The ranking (curated > confidence > rule-before-ai > tag) lives in exactly one
 * place, the SQL function primary_industry_tag(). These tests pin the TS side of
 * that contract with a stub client:
 *
 *   - it calls the RPC, never `entity_tags` directly (the pre-FIX-918 read had
 *     no ORDER BY and kept whichever row came first);
 *   - ids are deduped and chunked at ID_CHUNK_SIZE, so no call can return more
 *     than PostgREST's 1,000-row cap on a set-returning RPC;
 *   - the row the RPC returns IS the answer — nothing is re-ranked client-side;
 *   - a failed chunk throws rather than rendering its donors as untagged.
 *
 * That the SQL function itself picks correctly is proven against the clone by
 * `pnpm --filter @civitics/data data:verify:primary-industry`, which checks the
 * function and this reader against the same thirteen fixture donors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchIndustryTagsByEntityId } from "./entity-industry";
import { ID_CHUNK_SIZE } from "../read-helpers";

type Row = { entity_id: string; tag: string; display_label: string | null; display_icon: string | null };

function stubDb(answer: (ids: string[]) => { data: Row[] | null; error: { message: string } | null }) {
  const calls: Array<{ fn: string; ids: string[] }> = [];
  const db = {
    rpc(fn: string, args: { p_entity_ids: string[] }) {
      calls.push({ fn, ids: args.p_entity_ids });
      return Promise.resolve(answer(args.p_entity_ids));
    },
    from() {
      throw new Error("fetchIndustryTagsByEntityId must not read a table directly");
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, calls };
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("an empty id list makes no call", async () => {
  const { db, calls } = stubDb(() => ({ data: [], error: null }));
  const out = await fetchIndustryTagsByEntityId(db, []);
  assert.equal(out.size, 0);
  assert.equal(calls.length, 0);
});

test("reads primary_industry_tag, deduped and chunked at ID_CHUNK_SIZE", async () => {
  const ids = Array.from({ length: 450 }, (_, i) => id(i));
  const { db, calls } = stubDb(() => ({ data: [], error: null }));
  await fetchIndustryTagsByEntityId(db, [...ids, ...ids.slice(0, 10)]);
  assert.ok(calls.every((c) => c.fn === "primary_industry_tag"));
  assert.deepEqual(calls.map((c) => c.ids.length), [ID_CHUNK_SIZE, ID_CHUNK_SIZE, 450 - 2 * ID_CHUNK_SIZE]);
  assert.equal(new Set(calls.flatMap((c) => c.ids)).size, 450);
  assert.ok(ID_CHUNK_SIZE <= 1000, "a chunk must fit under the set-returning RPC row cap");
});

test("the RPC's row is the answer — no client-side re-ranking", async () => {
  // A multi-tag donor whose alphabetical-first tag is agriculture; the SQL rule
  // picked tech. The reader must return what SQL returned.
  const { db } = stubDb(() => ({
    data: [{ entity_id: id(1), tag: "tech", display_label: "Tech", display_icon: null }],
    error: null,
  }));
  const out = await fetchIndustryTagsByEntityId(db, [id(1), id(2)]);
  assert.deepEqual(out.get(id(1)), { tag: "tech", display_label: "Tech" });
  assert.equal(out.has(id(2)), false, "no row → no entry (untagged), never a guess");
});

test("a null display_label falls back to the tag", async () => {
  const { db } = stubDb(() => ({
    data: [{ entity_id: id(1), tag: "oil_gas", display_label: null, display_icon: null }],
    error: null,
  }));
  const out = await fetchIndustryTagsByEntityId(db, [id(1)]);
  assert.deepEqual(out.get(id(1)), { tag: "oil_gas", display_label: "oil_gas" });
});

test("a failed chunk throws instead of rendering its donors untagged", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => id(i));
  const { db } = stubDb((chunk) =>
    chunk.includes(id(249)) ? { data: null, error: { message: "boom" } } : { data: [], error: null },
  );
  await assert.rejects(fetchIndustryTagsByEntityId(db, ids));
});
