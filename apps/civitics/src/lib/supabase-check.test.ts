// FIX-1120 regression tests — the two timeout wrappers return different things
// on timeout, and that difference is the whole point of there being two.
//
// The bug this pins down: withDbTimeout's timeout branch resolves a fabricated
// `{data:null,error}` envelope cast `as unknown as T`. For a PostgREST builder
// that is the right shape. For an already-unwrapped promise it is a TRUTHY
// object wearing a type annotation that says "row or null", so `if (!snapshot)`
// takes the wrong branch and a deliberately-written 503 becomes a 500 on
// `payload.version`. The last test walks that exact route branch.

import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { withDbTimeout, withDbTimeoutValue } from "./supabase-check";

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const slow = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

afterEach(() => {
  mock.restoreAll();
});

describe("withDbTimeout (builder envelope — unchanged)", () => {
  it("passes a resolved builder result straight through", async () => {
    const r = await withDbTimeout(Promise.resolve({ data: [1, 2], error: null }), 50);
    assert.deepEqual(r, { data: [1, 2], error: null });
  });

  it("still resolves the {data:null,error} envelope on timeout", async () => {
    const r = await withDbTimeout<{ data: unknown; error: Error | null }>(never(), 10);
    assert.equal(r.data, null);
    assert.ok(r.error instanceof Error);
  });
});

describe("withDbTimeoutValue (plain promise)", () => {
  it("passes a resolved value straight through", async () => {
    const row = { fetched_at: "2026-08-29T18:24:24Z", payload: { version: "abc" } };
    assert.equal(await withDbTimeoutValue(Promise.resolve(row), 50), row);
  });

  it("passes a legitimate null through — indistinguishable from 'no row', by design", async () => {
    assert.equal(await withDbTimeoutValue(Promise.resolve(null), 50), null);
  });

  it("resolves null on timeout instead of a truthy sentinel", async () => {
    mock.method(console, "error", () => {});
    assert.equal(await withDbTimeoutValue(never<{ fetched_at: string }>(), 10), null);
  });

  it("logs a labelled line on timeout so a degraded route is greppable", async () => {
    const err = mock.method(console, "error", () => {});
    await withDbTimeoutValue(never(), 10, "status/core:snapshot");
    assert.equal(err.mock.callCount(), 1);
    const line = String(err.mock.calls[0].arguments[0]);
    assert.match(line, /withDbTimeoutValue/);
    assert.match(line, /status\/core:snapshot/);
  });

  it("does not log when the promise wins the race", async () => {
    const err = mock.method(console, "error", () => {});
    await withDbTimeoutValue(slow("ok", 1), 200, "label");
    assert.equal(err.mock.callCount(), 0);
  });
});

describe("the route guard the sentinel used to defeat", () => {
  // Reduction of the /api/claude/status/core branch: read the snapshot, and if
  // there is none, return 503. Nothing else about the route matters here.
  const routeStatus = async (
    read: () => Promise<{ fetched_at: string; payload: { version: string } } | null>,
    wrap: "envelope" | "value",
  ): Promise<number> => {
    const snapshot =
      wrap === "value"
        ? await withDbTimeoutValue(read(), 10)
        : await withDbTimeout<Awaited<ReturnType<typeof read>>>(read(), 10);
    if (!snapshot) return 503;
    // The line that actually threw on prod: TypeError, Cannot read properties
    // of undefined (reading 'version').
    return snapshot.payload.version ? 200 : 200;
  };

  it("returns 200 when a snapshot is read in time", async () => {
    const read = async () => ({ fetched_at: "2026-08-29T18:24:24Z", payload: { version: "abc" } });
    assert.equal(await routeStatus(read, "value"), 200);
  });

  it("returns 503 — not a TypeError — when the read times out", async () => {
    mock.method(console, "error", () => {});
    assert.equal(await routeStatus(() => never(), "value"), 503);
  });

  it("pins the old behaviour: the envelope wrapper throws past the 503 guard", async () => {
    await assert.rejects(() => routeStatus(() => never(), "envelope"), TypeError);
  });
});
