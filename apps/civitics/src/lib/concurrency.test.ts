// FIX-1121 / FIX-1126 regression tests — the two fan-out limiters.
//
// The property under test is the one the prod incident turned on: the pool must
// never exceed its bound, including across a release/acquire handoff, because
// the whole point is keeping N PostgREST requests off the authenticator role at
// once. Ordering and pass-through are tested alongside it since both call sites
// destructure positionally and a silently-reordered result would be worse than
// a slow one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { concurrencyGate, mapWithConcurrency } from "./concurrency";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

/** Tracks in-flight count so a test can assert the peak, not just the total. */
function tracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    peak: () => peak,
    async run<R>(value: R, delayMs = 1): Promise<R> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return value;
    },
  };
}

describe("mapWithConcurrency", () => {
  it("returns results positionally, not in completion order", async () => {
    // Descending delays: completion order is the exact reverse of input order,
    // so an implementation that pushed results would fail this.
    const out = await mapWithConcurrency([5, 4, 3, 2, 1], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 10;
    });
    assert.deepEqual(out, [50, 40, 30, 20, 10]);
  });

  it("never exceeds the limit", async () => {
    const t = tracker();
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, (i) => t.run(i, 2));
    assert.equal(t.peak(), 4);
  });

  it("handles an empty list and a limit above the item count", async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
    const t = tracker();
    const out = await mapWithConcurrency([1, 2], 99, (i) => t.run(i));
    assert.deepEqual(out, [1, 2]);
    assert.equal(t.peak(), 2);
  });
});

describe("concurrencyGate", () => {
  it("passes the task's value through unchanged", async () => {
    const gate = concurrencyGate(3);
    const row = { count: 969_302, error: null };
    assert.equal(await gate(async () => row), row);
  });

  it("bounds a Promise.all fan-out while preserving tuple order", async () => {
    const t = tracker();
    const gate = concurrencyGate(3);
    const out = await Promise.all([
      gate(() => t.run("a", 5)),
      gate(() => t.run("b", 4)),
      gate(() => t.run("c", 3)),
      gate(() => t.run("d", 2)),
      gate(() => t.run("e", 1)),
    ]);
    assert.deepEqual(out, ["a", "b", "c", "d", "e"]);
    assert.equal(t.peak(), 3);
  });

  // The handoff case. A caller arriving *after* some tasks have released must
  // not be able to claim a slot that has already been promised to a waiter —
  // that is the overcommit a decrement-then-wake release would allow.
  it("stays bounded when new callers arrive mid-drain", async () => {
    const t = tracker();
    const gate = concurrencyGate(2);
    const first = Array.from({ length: 5 }, (_, i) => gate(() => t.run(i, 3)));
    await tick();
    const second = Array.from({ length: 5 }, (_, i) => gate(() => t.run(i, 3)));
    await Promise.all([...first, ...second]);
    assert.equal(t.peak(), 2);
  });

  it("releases the permit when a task throws, so the queue cannot wedge", async () => {
    const gate = concurrencyGate(1);
    await assert.rejects(gate(async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await gate(async () => "still open"), "still open");
  });

  it("treats a limit below 1 as 1 rather than deadlocking", async () => {
    const t = tracker();
    const gate = concurrencyGate(0);
    await Promise.all([gate(() => t.run(1)), gate(() => t.run(2))]);
    assert.equal(t.peak(), 1);
  });
});
