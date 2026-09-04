/**
 * FIX-984 — the keyset walk's contract.
 *
 * Every case here is about a property the OFFSET helpers it replaces either had
 * (fail-loud on a page error, `minRows`, `maxRows` → truncated, bounded retry)
 * or could not have (a cursor that must strictly advance). The fake `page`
 * factory below is a real in-memory keyset server: it filters `id > after`,
 * sorts, and slices — so a boundary bug in the loop shows up as a wrong row set,
 * not as a mocked assertion.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectAllKeyset, fetchAllKeyset, type ReadResult } from "./read-helpers";

type Row = { id: string; n: number };

/** `count` rows with zero-padded ids so string ordering matches numeric. */
const makeRows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}`, n: i }));

/**
 * An in-memory keyset endpoint over `rows`. Records every page request so the
 * tests can assert on page COUNT (the thing that used to grow quadratically).
 */
function server(rows: Row[], opts: { failOn?: number[]; error?: string } = {}) {
  const calls: Array<string | null> = [];
  let requests = 0;
  const page = (after: string | null, limit: number): PromiseLike<ReadResult<Row>> => {
    calls.push(after);
    const attempt = requests++;
    if (opts.failOn?.includes(attempt)) {
      return Promise.resolve({ data: null, error: { message: opts.error ?? "boom" } });
    }
    const slice = rows
      .filter((r) => after === null || r.id > after)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
    return Promise.resolve({ data: slice, error: null });
  };
  return { page, calls, get requests() { return requests; } };
}

describe("selectAllKeyset", () => {
  test("walks every row across page boundaries, in order, no duplicates", async () => {
    const rows = makeRows(2500);
    const s = server(rows);
    const out = await selectAllKeyset<Row, string>("t", s.page, {
      key: (r) => r.id,
      pageSize: 1000,
    });
    assert.equal(out.length, 2500);
    assert.deepEqual(out.map((r) => r.n), rows.map((r) => r.n));
    assert.equal(new Set(out.map((r) => r.id)).size, 2500);
    // 1000 + 1000 + 500(short) — three requests, and the cursor advanced.
    assert.equal(s.requests, 3);
    assert.deepEqual(s.calls, [null, "id-00999", "id-01999"]);
  });

  test("an EXACT multiple of pageSize costs one extra (empty) page", async () => {
    // The short-page terminator cannot fire on a full last page, so the loop
    // must ask once more and get zero rows. Off-by-one here would drop the tail.
    const s = server(makeRows(2000));
    const out = await selectAllKeyset<Row, string>("t", s.page, {
      key: (r) => r.id,
      pageSize: 1000,
    });
    assert.equal(out.length, 2000);
    assert.equal(s.requests, 3);
  });

  test("empty table → no rows, one request", async () => {
    const s = server([]);
    const out = await selectAllKeyset<Row, string>("t", s.page, { key: (r) => r.id });
    assert.deepEqual(out, []);
    assert.equal(s.requests, 1);
  });

  test("throws on a page error rather than returning a partial set", async () => {
    // Fail the SECOND page: the failure mode this contract exists to prevent is
    // page 1's rows being consumed as if they were the whole table.
    const s = server(makeRows(2500), { failOn: [1], error: "gateway 502" });
    await assert.rejects(
      () => selectAllKeyset<Row, string>("t", s.page, {
        key: (r) => r.id, pageSize: 1000, retries: 0,
      }),
      (e: Error) => {
        assert.match(e.message, /gateway 502/);
        assert.match(e.message, /after=id-00999/);
        return true;
      },
    );
  });

  test("retries a failing page and succeeds within the budget", async () => {
    const s = server(makeRows(1500), { failOn: [1, 2] });
    const out = await selectAllKeyset<Row, string>("t", s.page, {
      key: (r) => r.id, pageSize: 1000, retries: 2,
    });
    assert.equal(out.length, 1500);
    assert.equal(s.requests, 4); // page0, fail, fail, ok
  });

  test("minRows floor throws when the table comes back short", async () => {
    const s = server(makeRows(40));
    await assert.rejects(
      () => selectAllKeyset<Row, string>("states", s.page, { key: (r) => r.id, minRows: 50 }),
      /returned 40 rows, expected at least 50/,
    );
  });

  test("a non-advancing cursor throws instead of looping forever", async () => {
    // Every row shares an id → `key > after` can never make progress. A
    // non-unique key is the one way to misuse this helper, so it is loud.
    const stuck = Array.from({ length: 10 }, (_, i) => ({ id: "same", n: i }));
    let calls = 0;
    const page = () => {
      calls++;
      return Promise.resolve({ data: stuck.slice(0, 5), error: null });
    };
    await assert.rejects(
      () => selectAllKeyset<Row, string>("t", page, { key: (r) => r.id, pageSize: 5 }),
      /cursor did not advance \(same → same\)/,
    );
    assert.ok(calls <= 3, `expected the loop to abort, got ${calls} requests`);
  });
});

describe("fetchAllKeyset", () => {
  test("returns the page error instead of throwing, with the rows it did get", async () => {
    const s = server(makeRows(2500), { failOn: [1], error: "ECONNRESET" });
    const res = await fetchAllKeyset<Row, string>("t", s.page, {
      key: (r) => r.id, pageSize: 1000,
    });
    assert.equal(res.rows.length, 1000);
    assert.match(res.error!.message, /ECONNRESET/);
    assert.equal(res.truncated, false);
  });

  test("maxRows stops the walk early and reports truncated", async () => {
    const s = server(makeRows(10_000));
    const res = await fetchAllKeyset<Row, string>("t", s.page, {
      key: (r) => r.id, pageSize: 1000, maxRows: 2000,
    });
    assert.equal(res.truncated, true);
    assert.equal(res.error, null);
    assert.equal(res.rows.length, 2000);
    assert.equal(s.requests, 2); // ceiling checked after a full page, as fetchAllRows did
  });

  test("maxRows is not reported truncated when the walk exhausts first", async () => {
    const s = server(makeRows(1500));
    const res = await fetchAllKeyset<Row, string>("t", s.page, {
      key: (r) => r.id, pageSize: 1000, maxRows: 5000,
    });
    assert.equal(res.truncated, false);
    assert.equal(res.rows.length, 1500);
  });

  test("does not retry by default — fetchAllRows returned on the first error", async () => {
    const s = server(makeRows(2500), { failOn: [0] });
    const res = await fetchAllKeyset<Row, string>("t", s.page, { key: (r) => r.id });
    assert.equal(res.rows.length, 0);
    assert.ok(res.error);
    assert.equal(s.requests, 1);
  });

  test("numeric keys walk in numeric order", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, n: i }));
    const calls: Array<number | null> = [];
    const page = (after: number | null, limit: number) => {
      calls.push(after);
      const slice = rows.filter((r) => after === null || r.n > after).slice(0, limit);
      return Promise.resolve({ data: slice, error: null });
    };
    const res = await fetchAllKeyset<Row, number>("t", page, { key: (r) => r.n, pageSize: 100 });
    assert.equal(res.rows.length, 250);
    assert.deepEqual(calls, [null, 99, 199]);
  });
});
