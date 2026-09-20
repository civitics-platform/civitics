/**
 * FIX-1180's sibling — a FAILED get_official_page must not render as an empty
 * official.
 *
 * Runs via:  tsx --test src/lib/official-page-outcome.test.ts
 *
 * The assertion that carries the weight is `failed` vs `skipped`. Those two
 * produced byte-identical pages before this change, because `withDbTimeout`
 * hands back `{ data: null, error }` and the page shimmed `data ?? {}` — so
 * every case here is paired against the state it used to be confused with. A
 * test that only checked "an error yields failed" would pass against a
 * classifier that returned `failed` for everything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOfficialPage } from "./official-page-outcome";

test("a cancelled RPC is failed, not an empty official", () => {
  // Exactly what the page saw on 80 of 446 calls: PostgREST's 57014 envelope.
  const cancelled = {
    data: null,
    error: { code: "57014", message: "canceling statement due to statement timeout" },
  };
  assert.equal(classifyOfficialPage(true, cancelled), "failed");
});

test("a client-side timeout is failed too — withDbTimeout fabricates the envelope", () => {
  const timedOut = { data: null, error: new Error("Supabase query timed out after 5000ms") };
  assert.equal(classifyOfficialPage(true, timedOut), "failed");
});

test("a schema-cache miss is failed", () => {
  const miss = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  assert.equal(classifyOfficialPage(true, miss), "failed");
});

test("the FIX-683 skip stays skipped — the RPC was never called", () => {
  // Not content-bearing: the page passes `{ data: null }` with NO error, and
  // this must keep rendering the ordinary empty state, banner-free.
  assert.equal(classifyOfficialPage(false, { data: null }), "skipped");
  assert.equal(classifyOfficialPage(false, null), "skipped");
  // Even if an error somehow rode along, "not content bearing" wins: there is
  // nothing to degrade, and generateMetadata already noindexes it.
  assert.equal(classifyOfficialPage(false, { data: null, error: new Error("x") }), "skipped");
});

test("a successful RPC is ok", () => {
  assert.equal(classifyOfficialPage(true, { data: { vote_count: 1882 } }), "ok");
});

test("a real official with genuinely null sections is ok, NOT failed", () => {
  // The case that forbids keying on `data == null`. A content-bearing official
  // whose RPC answered with nothing to show must not get a red banner telling
  // visitors the read broke — it did not.
  assert.equal(classifyOfficialPage(true, { data: null }), "ok");
  assert.equal(classifyOfficialPage(true, { data: null, error: null }), "ok");
  assert.equal(classifyOfficialPage(true, { data: null, error: undefined }), "ok");
});

test("undefined envelope is ok, not failed — absence is not an error", () => {
  assert.equal(classifyOfficialPage(true, undefined), "ok");
});
