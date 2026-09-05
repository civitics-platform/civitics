// FIX-1029 regression tests — an error is never a 200, and only a
// summary-bearing 200 is ever CDN-cached.
//
// These pin the four outcomes of the /api/officials/[id]/summary contract at
// the layer that decides them. The route is a driver over this module
// precisely so the contract can be asserted without mocking supabase-js, the
// Anthropic client and a Next route handler under a Node-20 runner.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  summaryUnavailable,
  summaryNone,
  summaryText,
  officialsReadOutcome,
  spendCentsOrThrow,
  capDecision,
} from "./summary-policy";
import { CDN_HOT_S_MAXAGE, CDN_HOT_SWR } from "./cdn-cache";

const CDN = `public, s-maxage=${CDN_HOT_S_MAXAGE}, stale-while-revalidate=${CDN_HOT_SWR}`;

describe("FIX-1029 — an infrastructure failure is a 503, and is never cached", () => {
  it("summaryUnavailable is 503 with no-store and NO CDN headers", async () => {
    const res = summaryUnavailable();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("CDN-Cache-Control"), null);
    assert.equal(res.headers.get("Vercel-CDN-Cache-Control"), null);
    assert.deepEqual(await res.json(), { summary: null, error: "unavailable" });
  });

  it("a failed officials read is 'unavailable', not 'no such official'", () => {
    // supabase-js resolves with {data:null, error} rather than throwing — the
    // exact shape that used to be reported as a missing row.
    assert.equal(
      officialsReadOutcome({ data: null, error: { message: "connection refused" } }),
      "unavailable",
    );
  });

  it("the spend-cap read FAILS CLOSED — it throws instead of reading as $0", () => {
    assert.throws(
      () => spendCentsOrThrow({ data: null, error: { message: "timeout" } }),
      /spend-cap read failed/,
    );
  });

  it("a cap-read failure is decided BEFORE any generate decision exists", () => {
    // capDecision is only reachable with a number; spendCentsOrThrow is the
    // only producer of that number and it throws on error. There is no input
    // to this pair that both fails the read and returns "generate".
    assert.throws(() => capDecision(spendCentsOrThrow({ data: null, error: {} }), 400));
  });
});

describe("FIX-1029 — a genuine no-record is a 200, and is still not cached", () => {
  it("no error and no row is 'no_record'", () => {
    assert.equal(officialsReadOutcome({ data: null, error: null }), "no_record");
  });

  it("a row with no error is 'ok'", () => {
    assert.equal(officialsReadOutcome({ data: { id: "x" }, error: null }), "ok");
  });

  it("summaryNone is 200 {summary:null} with NO CDN headers", async () => {
    const res = summaryNone();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("CDN-Cache-Control"), null);
    assert.equal(res.headers.get("Vercel-CDN-Cache-Control"), null);
    assert.deepEqual(await res.json(), { summary: null });
  });

  it("the kill switch and the spend cap are 200s carrying their reason", async () => {
    const disabled = summaryNone("disabled");
    assert.equal(disabled.status, 200);
    assert.equal(disabled.headers.get("CDN-Cache-Control"), null);
    assert.deepEqual(await disabled.json(), { summary: null, error: "disabled" });

    const capped = summaryNone("monthly_cap_reached");
    assert.equal(capped.status, 200);
    assert.equal(capped.headers.get("CDN-Cache-Control"), null);
    assert.deepEqual(await capped.json(), { summary: null, error: "monthly_cap_reached" });
  });
});

describe("FIX-796 — only the summary-bearing 200 is CDN-cached", () => {
  it("summaryText is 200 WITH both CDN headers", async () => {
    const res = summaryText("Two neutral sentences.");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("CDN-Cache-Control"), CDN);
    assert.equal(res.headers.get("Vercel-CDN-Cache-Control"), CDN);
    assert.deepEqual(await res.json(), { summary: "Two neutral sentences." });
  });

  it("no null-carrying response is ever stamped", () => {
    for (const res of [summaryUnavailable(), summaryNone(), summaryNone("disabled"), summaryNone("monthly_cap_reached")]) {
      assert.equal(res.headers.get("CDN-Cache-Control"), null, "a null summary must never be edge-cached");
    }
  });
});

describe("the spend cap itself", () => {
  it("sums cost_cents and tolerates nulls / an empty ledger", () => {
    assert.equal(spendCentsOrThrow({ data: [], error: null }), 0);
    assert.equal(spendCentsOrThrow({ data: null, error: null }), 0);
    assert.equal(
      spendCentsOrThrow({ data: [{ cost_cents: 12.5 }, { cost_cents: null }, { cost_cents: 7.5 }], error: null }),
      20,
    );
  });

  it("caps at >= the limit, generates below it", () => {
    assert.equal(capDecision(399.9, 400), "generate");
    assert.equal(capDecision(400, 400), "cap_reached");
    assert.equal(capDecision(1200, 400), "cap_reached");
  });
});
