/**
 * FIX-1061 — streamed writer core.
 *
 * Pins the two properties the array writers used to get for free and that a
 * streamed writer has to earn:
 *
 *   1. GROUP ALIGNMENT — a batch never splits a group key. Two aggregates that
 *      collide on the upsert arbiter are contiguous in the sort order, so an
 *      aligned batch sees both and the in-batch merge is exactly equivalent to
 *      the whole-population merge it replaces. Splitting them across two
 *      statements would silently OVERWRITE rather than sum.
 *   2. CURSOR DOMAIN — the FIX-754 cursor now counts ITEMS CONSUMED from the
 *      sorted stream, not rows in a materialized array. Resume must skip
 *      exactly the consumed prefix, and a stored total from the old (row)
 *      domain must trip the defensive reset rather than resume into garbage.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/writer-stream.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { batchByGroup } from "./writer";
import { resolveResumeCursor } from "./run-state";

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------
// batchByGroup
// ---------------------------------------------------------------------------

test("batchByGroup: fills to size when every group is a singleton", async () => {
  const items = ["a", "b", "c", "d", "e"];
  const batches = await collect(batchByGroup(from(items), 2, (x) => x));
  assert.deepEqual(batches, [["a", "b"], ["c", "d"], ["e"]]);
});

test("batchByGroup: never splits a group across two batches", async () => {
  // Group "b" straddles the size-2 boundary; the batch must extend to hold it.
  const items = ["a", "b", "b", "b", "c"];
  const batches = await collect(batchByGroup(from(items), 2, (x) => x));
  assert.deepEqual(batches, [["a", "b", "b", "b"], ["c"]]);
  for (const batch of batches) {
    const keys = new Set(batch);
    for (const key of keys) {
      const elsewhere = batches.filter((b) => b !== batch && b.includes(key));
      assert.equal(elsewhere.length, 0, `group ${key} was split across batches`);
    }
  }
});

test("batchByGroup: a group larger than the batch size stays whole", async () => {
  const items = ["x", "x", "x", "x", "x", "y"];
  const batches = await collect(batchByGroup(from(items), 2, (x) => x));
  assert.deepEqual(batches, [["x", "x", "x", "x", "x"], ["y"]]);
});

test("batchByGroup: empty source yields no batches", async () => {
  const batches = await collect(batchByGroup(from([] as string[]), 4, (x) => x));
  assert.deepEqual(batches, []);
});

test("batchByGroup: every item is emitted exactly once, in order", async () => {
  const items = Array.from({ length: 97 }, (_, i) => `fp${Math.floor(i / 3)}`);
  const batches = await collect(batchByGroup(from(items), 10, (x) => x));
  assert.deepEqual(batches.flat(), items);
});

// ---------------------------------------------------------------------------
// Cursor domain
// ---------------------------------------------------------------------------

test("resume: a cursor in the item domain resumes at the stored offset", () => {
  const r = resolveResumeCursor({ status: "in-progress", cursor: 8000, total_rows: 20000 }, 20000);
  assert.deepEqual(r, { start: 8000, reset: false });
});

test("resume: a pre-FIX-1061 total (row domain) trips the defensive reset", () => {
  // The old cursor counted merged ROWS (post-filter); the new one counts sorted
  // ITEMS. The two differ whenever anything was dropped, so the stored total
  // will not match and the stage restarts from 0 — idempotent, never wrong.
  const r = resolveResumeCursor({ status: "in-progress", cursor: 500_000, total_rows: 762_891 }, 780_000);
  assert.deepEqual(r, { start: 0, reset: true });
});

test("resume: a cursor past the total is clamped, not trusted", () => {
  const r = resolveResumeCursor({ status: "in-progress", cursor: 99_999, total_rows: 1000 }, 1000);
  assert.equal(r.start, 1000);
  assert.equal(r.reset, false);
});

// ---------------------------------------------------------------------------
// Batch-skip arithmetic (the loop inside upsertStreamed)
// ---------------------------------------------------------------------------

/**
 * Mirror of upsertStreamed's resume arithmetic: batches wholly below the cursor
 * are skipped without building rows; a batch straddling it is redone in full
 * (idempotent). Pinned here because the invariant that matters — the cursor
 * never goes BACKWARDS and never skips an unprocessed item — is arithmetic, and
 * exercising it through a real upsert would need a DB.
 */
function simulate(batchSizes: number[], startItem: number): { processed: number[]; finalCursor: number } {
  const processed: number[] = [];
  let consumed = 0;
  for (const len of batchSizes) {
    if (consumed + len <= startItem) { consumed += len; continue; }
    consumed += len;
    processed.push(consumed);
  }
  return { processed, finalCursor: consumed };
}

test("resume arithmetic: whole batches below the cursor are skipped", () => {
  const { processed, finalCursor } = simulate([100, 100, 100, 100], 200);
  assert.deepEqual(processed, [300, 400]);
  assert.equal(finalCursor, 400);
});

test("resume arithmetic: a straddling batch is re-done in full, never partially", () => {
  const { processed } = simulate([100, 100, 100], 150);
  // The cursor landed inside batch 2 → batch 2 is redone whole (idempotent
  // upsert), and no item is ever skipped without being processed.
  assert.deepEqual(processed, [200, 300]);
});

test("resume arithmetic: cursor 0 processes everything", () => {
  const { processed, finalCursor } = simulate([4000, 4000, 1234], 0);
  assert.deepEqual(processed, [4000, 8000, 9234]);
  assert.equal(finalCursor, 9234);
});

test("resume arithmetic: a complete cursor processes nothing", () => {
  const { processed, finalCursor } = simulate([4000, 4000, 1234], 9234);
  assert.deepEqual(processed, []);
  assert.equal(finalCursor, 9234);
});
