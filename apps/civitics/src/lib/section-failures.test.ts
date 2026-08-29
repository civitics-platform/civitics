// FIX-1121 regression tests — per-metric failure reporting.
//
// The property that matters is asymmetric, so both directions are exercised on
// every shape: a failed count must NEVER render as a number (the stored value
// is a zero nobody measured), and a good count must ALWAYS render (withholding
// a measured number is its own dishonesty, and withholding four of them was the
// bug). The old-payload case gets its own block because `status_snapshot`
// retains rows for days and this code reads back rows written before it shipped.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countFailureFields,
  failedMetrics,
  isMetricAvailable,
  metricValue,
} from "./section-failures";

/** The shape getDatabase returns: every count present, failure fields spread on. */
const section = (errored: string[]) => ({
  officials: errored.includes("officials") ? 0 : 37_242,
  proposals: errored.includes("proposals") ? 0 : 90_201,
  votes: errored.includes("votes") ? 0 : 969_302,
  entity_connections: 5_100_000,
  ...countFailureFields(errored),
});

describe("countFailureFields", () => {
  it("adds nothing when every count succeeded", () => {
    assert.deepEqual(countFailureFields([]), {});
  });

  it("keeps partial + error identical to the pre-FIX-1121 shape", () => {
    // computeStatusPayload's failedSections list and status_snapshot.error both
    // key off these two, so their meaning must not move.
    const f = countFailureFields(["votes"]);
    assert.equal((f as { partial: true }).partial, true);
    assert.equal((f as { error: string }).error, "count failed for: votes");
  });

  it("preserves the multi-failure message and order", () => {
    const f = countFailureFields(["proposals", "votes"]);
    assert.equal((f as { error: string }).error, "count failed for: proposals, votes");
    assert.deepEqual((f as { failed: string[] }).failed, ["proposals", "votes"]);
  });
});

describe("failedMetrics", () => {
  it("is null for a healthy section", () => {
    assert.equal(failedMetrics(section([])), null);
  });

  it("names the failed metrics on a new-shape partial section", () => {
    assert.deepEqual(failedMetrics(section(["votes"])), ["votes"]);
  });

  it("is empty — meaning 'unknown' — for a section that threw outright", () => {
    // What section() produces when a helper rejects: no counts, no failed list.
    assert.deepEqual(failedMetrics({ error: "boom", partial: true }), []);
  });

  it("is empty for a missing section", () => {
    assert.deepEqual(failedMetrics(undefined), []);
    assert.deepEqual(failedMetrics(null), []);
  });
});

describe("isMetricAvailable / metricValue", () => {
  it("renders every metric of a healthy section", () => {
    const s = section([]);
    for (const m of ["officials", "proposals", "votes", "entity_connections"]) {
      assert.equal(isMetricAvailable(s, m), true, m);
    }
    assert.equal(metricValue(s, "votes"), 969_302);
  });

  it("withholds only the failed metric — this is the four-card blackout fix", () => {
    const s = section(["votes"]);
    assert.equal(metricValue(s, "votes"), null);
    assert.equal(metricValue(s, "officials"), 37_242);
    assert.equal(metricValue(s, "proposals"), 90_201);
    assert.equal(metricValue(s, "entity_connections"), 5_100_000);
  });

  it("never leaks the lying zero a failed count stores", () => {
    const s = section(["votes", "proposals"]);
    assert.equal(s.votes, 0, "precondition: the payload really does carry 0");
    assert.equal(metricValue(s, "votes"), null);
    assert.equal(metricValue(s, "proposals"), null);
  });

  it("withholds EVERY metric on a pre-FIX-1121 payload (no failed key)", () => {
    // A retained snapshot row written before this shipped. Which counts failed
    // is genuinely unknown, so the old blanking behaviour is the correct read.
    const old = {
      officials: 37_242,
      proposals: 90_201,
      votes: 0,
      entity_connections: 5_100_000,
      error: "count failed for: votes",
      partial: true,
    };
    for (const m of ["officials", "proposals", "votes", "entity_connections"]) {
      assert.equal(isMetricAvailable(old, m), false, m);
      assert.equal(metricValue(old, m), null, m);
    }
  });

  it("withholds everything when the section is missing or is the loading placeholder", () => {
    for (const s of [undefined, null, { error: "Loading", partial: true }]) {
      assert.equal(isMetricAvailable(s, "officials"), false);
      assert.equal(metricValue(s, "officials"), null);
    }
  });

  it("withholds a metric whose stored value is not a number", () => {
    assert.equal(metricValue({ officials: null }, "officials"), null);
    assert.equal(metricValue({}, "officials"), null);
  });
});
