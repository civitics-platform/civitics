// FIX-901 — fetchChunkedByIds contract tests.
//
// The bug class this guards (FIX-509/514/774/899): an `.in()` over an
// unbounded id list builds a request URL past the gateway's header limit, the
// gateway 414s before PostgREST sees it, `withDbTimeout` returns
// `{ data: null }`, and the call site's `?? []` renders the failure as an empty
// result on an HTTP 200. Two properties keep the helper from reproducing that
// one layer down, and both are asserted here: it chunks by ID_CHUNK_SIZE, and
// a failed chunk is REPORTED rather than silently dropped.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { fetchChunkedByIds, ID_CHUNK_SIZE, ID_CHUNK_CONCURRENCY } from "./paginate";

type Row = { id: string };

const ids = (n: number, prefix = "id") => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

type BuildCtx = { index: number; label: string };

/** A build() that echoes each requested id back as a row and never errors. */
function okBuilder() {
  return mock.fn((chunk: string[], _ctx: BuildCtx) =>
    Promise.resolve({ data: chunk.map((id) => ({ id })), error: null }),
  );
}

describe("fetchChunkedByIds", () => {
  it("defaults to a 200-id chunk — the URL-length bound, not the 1000-row cap", () => {
    assert.equal(ID_CHUNK_SIZE, 200);
  });

  it("splits an over-limit id list into the expected number of calls", async () => {
    const build = okBuilder();
    const res = await fetchChunkedByIds<Row>(ids(450), build);

    assert.equal(build.mock.callCount(), 3);          // 200 + 200 + 50
    assert.equal(res.chunkCount, 3);
    assert.deepEqual(
      build.mock.calls.map((c) => (c.arguments[0] as string[]).length),
      [200, 200, 50],
    );
    assert.equal(res.rows.length, 450);
    assert.equal(res.complete, true);
    assert.deepEqual(res.failed, []);
  });

  it("issues a single call when the list fits in one chunk", async () => {
    const build = okBuilder();
    const res = await fetchChunkedByIds<Row>(ids(200), build);
    assert.equal(build.mock.callCount(), 1);
    assert.equal(res.rows.length, 200);
  });

  it("honours an explicit chunkSize", async () => {
    const build = okBuilder();
    await fetchChunkedByIds<Row>(ids(25), build, { chunkSize: 10 });
    assert.equal(build.mock.callCount(), 3);
  });

  it("reports a failed chunk instead of silently returning a short array", async () => {
    // THE regression: chunk 1 dies (a 414 / timeout). The rows from chunks 0
    // and 2 still come back, but `complete` is false and `failed` names the
    // ids that never arrived — a caller can no longer mistake a short read for
    // a complete one, which is what FIX-899 did for months.
    const build = mock.fn((chunk: string[]) =>
      chunk[0] === "id-200"
        ? Promise.resolve({ data: null, error: { message: "URI too long" } })
        : Promise.resolve({ data: chunk.map((id) => ({ id })), error: null }),
    );

    const res = await fetchChunkedByIds<Row>(ids(450), build);

    assert.equal(build.mock.callCount(), 3);
    assert.equal(res.complete, false);
    assert.equal(res.rows.length, 250);               // 200 + 50, chunk 1 missing
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0]!.index, 1);
    assert.equal(res.failed[0]!.ids.length, 200);
    assert.equal(res.failed[0]!.error.message, "URI too long");
    // The failed ids are recoverable from the result, not just countable.
    assert.equal(res.failed[0]!.ids[0], "id-200");
  });

  it("strict mode surfaces the failure by throwing", async () => {
    const build = mock.fn((chunk: string[]) =>
      chunk[0] === "id-200"
        ? Promise.resolve({ data: null, error: { message: "URI too long" } })
        : Promise.resolve({ data: chunk.map((id) => ({ id })), error: null }),
    );

    await assert.rejects(
      () => fetchChunkedByIds<Row>(ids(450), build, { strict: true }),
      (err: { message: string }) => err.message === "URI too long",
    );
    // Every chunk was still issued — strict decides how the failure is
    // reported, not whether the other chunks run.
    assert.equal(build.mock.callCount(), 3);
  });

  it("dedupes ids before chunking", async () => {
    const build = okBuilder();
    // 300 slots, only 150 distinct → one chunk, not two.
    const dupes = [...ids(150), ...ids(150)];
    const res = await fetchChunkedByIds<Row>(dupes, build);

    assert.equal(build.mock.callCount(), 1);
    assert.equal((build.mock.calls[0]!.arguments[0] as string[]).length, 150);
    assert.equal(res.rows.length, 150);
  });

  it("drops empty and nullish ids", async () => {
    const build = okBuilder();
    const res = await fetchChunkedByIds<Row>(["a", null, "b", undefined, "", "c"], build);
    assert.deepEqual(build.mock.calls[0]!.arguments[0], ["a", "b", "c"]);
    assert.equal(res.rows.length, 3);
  });

  it("issues zero calls for an empty list", async () => {
    const build = okBuilder();
    const res = await fetchChunkedByIds<Row>([], build);
    assert.equal(build.mock.callCount(), 0);
    assert.equal(res.chunkCount, 0);
    assert.deepEqual(res.rows, []);
    assert.equal(res.complete, true);                 // nothing asked, nothing lost
  });

  it("issues zero calls when every id is nullish (never sends .in(col, []))", async () => {
    const build = okBuilder();
    const res = await fetchChunkedByIds<Row>([null, undefined, ""], build);
    assert.equal(build.mock.callCount(), 0);
    assert.equal(res.chunkCount, 0);
  });

  it("hands build() a per-chunk label ready for withDbTimeout", async () => {
    const build = okBuilder();
    await fetchChunkedByIds<Row>(ids(450), build, { label: "officials:directory-tags" });
    assert.deepEqual(
      build.mock.calls.map((c) => c.arguments[1].label),
      [
        "officials:directory-tags:0",
        "officials:directory-tags:1",
        "officials:directory-tags:2",
      ],
    );
    assert.deepEqual(
      build.mock.calls.map((c) => c.arguments[1].index),
      [0, 1, 2],
    );
  });

  it("tolerates a build() whose result carries no error key at all", async () => {
    const build = mock.fn((chunk: string[]) => Promise.resolve({ data: chunk.map((id) => ({ id })) }));
    const res = await fetchChunkedByIds<Row>(ids(10), build);
    assert.equal(res.rows.length, 10);
    assert.equal(res.complete, true);
  });

  it("treats a null data payload as zero rows, not a failure", async () => {
    const build = mock.fn(() => Promise.resolve({ data: null, error: null }));
    const res = await fetchChunkedByIds<Row>(ids(10), build);
    assert.deepEqual(res.rows, []);
    assert.equal(res.complete, true);
  });
});

// ── FIX-926: bounded concurrency ───────────────────────────────────────────────
//
// The cap bounds one call site's share of the shared connection/socket budget.
// It is a SCHEDULING concern only: it must be invisible in the output for any
// input, and it must not change WHICH chunks get issued. The strict-mode case
// is the one that actually constrains the implementation — a pool that
// cancelled the queue on first error would break the FIX-901 contract that
// `strict` decides how a failure is reported, not whether the rest run.

/**
 * A build() that resolves on the next microtask tick and records how many calls
 * are simultaneously outstanding, so the pool's ceiling is observable.
 */
function instrumentedBuilder(opts: { failIndexes?: number[] } = {}) {
  const fail = new Set(opts.failIndexes ?? []);
  const state = { inFlight: 0, peak: 0 };
  const build = mock.fn(async (chunk: string[], ctx: BuildCtx) => {
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    // Yield enough times that a bug which issues everything up front is
    // guaranteed to show a peak above the cap rather than racing past it.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    state.inFlight--;
    return fail.has(ctx.index)
      ? { data: null, error: { message: `chunk ${ctx.index} died` } }
      : { data: chunk.map((id) => ({ id })), error: null };
  });
  return { build, state };
}

describe("fetchChunkedByIds — concurrency cap (FIX-926)", () => {
  it("defaults to 6 in flight — a connection-budget bound, not a row or URL bound", () => {
    assert.equal(ID_CHUNK_CONCURRENCY, 6);
    assert.notEqual(ID_CHUNK_CONCURRENCY, ID_CHUNK_SIZE);
  });

  it("never exceeds the cap in flight, and still issues every chunk", async () => {
    const { build, state } = instrumentedBuilder();
    const res = await fetchChunkedByIds<Row>(ids(2000), build, {
      chunkSize: 100,             // 20 chunks
      maxConcurrency: 3,
    });

    assert.equal(res.chunkCount, 20);
    assert.equal(build.mock.callCount(), 20);
    assert.equal(state.peak, 3, "peak in-flight must equal the cap, never exceed it");
    assert.equal(state.inFlight, 0);
    assert.equal(res.rows.length, 2000);
    assert.equal(res.complete, true);
  });

  it("respects the default cap when maxConcurrency is not given", async () => {
    const { build, state } = instrumentedBuilder();
    await fetchChunkedByIds<Row>(ids(2000), build, { chunkSize: 100 });
    assert.equal(state.peak, ID_CHUNK_CONCURRENCY);
  });

  it("keeps rows and failed in CHUNK order under a cap smaller than chunkCount", async () => {
    // Out-of-order completion is the normal case under a cap; the result must be
    // indexed by chunk, not by whichever request landed first.
    const { build } = instrumentedBuilder({ failIndexes: [1, 5] });
    const res = await fetchChunkedByIds<Row>(ids(700), build, {
      chunkSize: 100,             // 7 chunks, 2 of them failing
      maxConcurrency: 2,
    });

    assert.equal(res.chunkCount, 7);
    assert.equal(build.mock.callCount(), 7);
    assert.equal(res.complete, false);
    assert.deepEqual(res.failed.map((f) => f.index), [1, 5]);
    // 5 surviving chunks × 100, in chunk order: 0,2,3,4,6 → first row is id-0
    // and the row after chunk 0's 100 is chunk 2's first id (chunk 1 is gone).
    assert.equal(res.rows.length, 500);
    assert.equal(res.rows[0]!.id, "id-0");
    assert.equal(res.rows[100]!.id, "id-200");
    assert.equal(res.rows[499]!.id, "id-699");
  });

  it("strict: true still issues EVERY chunk before throwing, even under a cap", async () => {
    // The regression guard. `strict` decides how a failure is reported, not
    // whether the remaining chunks run — a pool that drained the queue on first
    // error would silently stop issuing work here.
    const { build } = instrumentedBuilder({ failIndexes: [0] });

    await assert.rejects(
      () =>
        fetchChunkedByIds<Row>(ids(600), build, {
          chunkSize: 100,         // 6 chunks, the FIRST one fails
          maxConcurrency: 2,
          strict: true,
        }),
      (err: { message: string }) => err.message === "chunk 0 died",
    );
    assert.equal(build.mock.callCount(), 6);
  });

  it("a cap larger than chunkCount is a no-op — same calls, same output", async () => {
    const capped = instrumentedBuilder();
    const uncapped = instrumentedBuilder();
    const a = await fetchChunkedByIds<Row>(ids(450), capped.build, { maxConcurrency: 999 });
    const b = await fetchChunkedByIds<Row>(ids(450), uncapped.build);

    assert.equal(capped.build.mock.callCount(), 3);
    assert.equal(capped.state.peak, 3, "only 3 chunks exist — the cap can't create work");
    assert.deepEqual(a.rows, b.rows);
    assert.equal(a.chunkCount, b.chunkCount);
    assert.equal(a.complete, b.complete);
  });

  it("maxConcurrency of 0 or negative clamps to 1 rather than deadlocking", async () => {
    for (const bad of [0, -5]) {
      const { build, state } = instrumentedBuilder();
      const res = await fetchChunkedByIds<Row>(ids(500), build, {
        chunkSize: 100,
        maxConcurrency: bad,
      });
      assert.equal(build.mock.callCount(), 5, `maxConcurrency:${bad} must still issue every chunk`);
      assert.equal(state.peak, 1, `maxConcurrency:${bad} must clamp to serial, not stall`);
      assert.equal(res.rows.length, 500);
      assert.equal(res.complete, true);
    }
  });
});
