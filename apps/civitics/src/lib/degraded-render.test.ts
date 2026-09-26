// FIX-1227 — a degraded read is recorded per request, and a degraded render
// opts out of Next's cache. The page-level receipt (a locked read renders once
// and the next request re-renders) is cc-161 read 5; these pin the pieces.

import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  assertRenderNotDegraded,
  createDegradedSink,
  recordDegradedRead,
  requestDegradedSink,
} from "./degraded-render";
import { withDbTimeout, withDbTimeoutValue } from "./supabase-check";

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const slow = <T>(value: T, ms: number): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  mock.restoreAll();
});

describe("the sink", () => {
  it("two sinks are independent", () => {
    const a = createDegradedSink();
    const b = createDegradedSink();
    recordDegradedRead("donors:inbound", "timed out after 3000ms", a);
    assert.equal(a.reads.length, 1);
    assert.equal(b.reads.length, 0);
  });

  it("outside a render the request accessor is a call-through — no shared state", () => {
    // No React request here, exactly as in a Route Handler: every call is a
    // fresh sink, so a record made outside a page render reaches no one.
    const a = requestDegradedSink();
    recordDegradedRead("x", "y");
    assert.notEqual(requestDegradedSink(), a);
    assert.equal(requestDegradedSink().reads.length, 0);
  });
});

describe("withDbTimeout records what did not complete", () => {
  it("logs a labelled line and records on its own timeout", async () => {
    const err = mock.method(console, "error", () => {});
    const sink = createDegradedSink();
    const r = await withDbTimeout<{ data: unknown; error: Error | null }>(never(), 10, "donors:inbound", sink);
    assert.equal(r.data, null);
    assert.equal(err.mock.callCount(), 1);
    assert.match(String(err.mock.calls[0]?.arguments[0]), /\[withDbTimeout\] timed out after 10ms \[label=donors:inbound\]/);
    assert.deepEqual(sink.reads, [{ label: "donors:inbound", reason: "timed out after 10ms" }]);
  });

  it("a read that wins the race never records late — the timer is cleared", async () => {
    const err = mock.method(console, "error", () => {});
    const sink = createDegradedSink();
    await withDbTimeout(slow({ data: [1], error: null }, 1), 20, "fast", sink);
    await wait(40);
    assert.equal(err.mock.callCount(), 0);
    assert.equal(sink.reads.length, 0);
  });

  it("records a server-side statement timeout (57014) and a pool timeout (PGRST003)", async () => {
    mock.method(console, "error", () => {});
    const sink = createDegradedSink();
    await withDbTimeout(Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }), 50, "officials:page-rpc", sink);
    await withDbTimeout(Promise.resolve({ data: null, error: { code: "PGRST003", message: "Timed out acquiring connection" } }), 50, "p", sink);
    assert.deepEqual(sink.reads.map((r) => r.reason), ["57014", "PGRST003"]);
  });

  it("does not record an error that is not a timeout", async () => {
    mock.method(console, "error", () => {});
    const sink = createDegradedSink();
    await withDbTimeout(Promise.resolve({ data: null, error: { code: "42703", message: "column does not exist" } }), 50, "s", sink);
    await withDbTimeout(Promise.resolve({ data: null, error: { code: "PGRST116", message: "multiple rows" } }), 50, "m", sink);
    assert.equal(sink.reads.length, 0);
  });

  it("withDbTimeoutValue records its timeout too", async () => {
    mock.method(console, "error", () => {});
    const sink = createDegradedSink();
    assert.equal(await withDbTimeoutValue(never(), 10, "status/core:snapshot", sink), null);
    assert.deepEqual(sink.reads, [{ label: "status/core:snapshot", reason: "timed out after 10ms" }]);
  });
});

describe("assertRenderNotDegraded", () => {
  it("a healthy render: no noStore(), nothing logged", () => {
    const err = mock.method(console, "error", () => {});
    const noStore = mock.fn();
    assert.deepEqual(assertRenderNotDegraded({ sink: createDegradedSink(), noStore }), []);
    assert.equal(noStore.mock.callCount(), 0);
    assert.equal(err.mock.callCount(), 0);
  });

  it("a degraded render: logs every read and calls noStore() once", () => {
    const err = mock.method(console, "error", () => {});
    const noStore = mock.fn();
    const sink = createDegradedSink();
    recordDegradedRead("donors:inbound", "timed out after 3000ms", sink);
    recordDegradedRead("donors:inbound-totals", "57014", sink);
    const reads = assertRenderNotDegraded({ sink, noStore });
    assert.equal(reads.length, 2);
    assert.equal(noStore.mock.callCount(), 1);
    assert.match(String(err.mock.calls[0]?.arguments[0]), /\[degraded-render\] 2 read\(s\).*donors:inbound .*donors:inbound-totals/);
  });

  it("noStore()'s throw — what it does inside an ISR render — propagates", () => {
    mock.method(console, "error", () => {});
    const sink = createDegradedSink();
    recordDegradedRead("x", "timed out after 1ms", sink);
    assert.throws(
      () => assertRenderNotDegraded({ sink, noStore: () => { throw new Error("DynamicServerError"); } }),
      /DynamicServerError/,
    );
  });
});
