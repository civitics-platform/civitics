// FIX-1278 unit tests for the edge's retired-official-id resolver.
//
// Pure surface: no network. fetch is a fake that records its calls, and time is
// a settable clock, so the TTL and fail-TTL windows are stepped, not slept for.
// middleware.ts itself is outside src/ and never discovered by run-tests.mjs —
// the logic it calls lives here so it can be tested.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRedirectResolver, ROW_CAP } from "./official-redirects";

const OLD = "88b9e155-0d06-48f3-94e5-bec952869441";
const NEW = "893a581e-4fc0-4190-b43f-6afafc7aa917";
const URL_ = "https://proj.supabase.co";
const KEY = "sb_publishable_test";

type Call = { url: string; init: RequestInit | undefined };

let clock = 1_700_000_000_000;
let calls: Call[] = [];
let logs: string[] = [];

function fakeFetch(respond: () => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function resolver(fetchImpl: typeof fetch) {
  return createRedirectResolver({
    supabaseUrl: URL_,
    publishableKey: KEY,
    fetchImpl,
    ttlMs: 3_600_000,
    failTtlMs: 60_000,
    now: () => clock,
    timeoutMs: 1_500,
    log: (m) => logs.push(m),
  });
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  calls = [];
  logs = [];
});

describe("official-redirects resolver", () => {
  it("a listed id resolves to its survivor; an unlisted id is null", async () => {
    const r = resolver(fakeFetch(() => json([{ old_id: OLD, new_id: NEW }])));
    assert.equal(await r.resolve(OLD), NEW);
    assert.equal(await r.resolve("00000000-0000-4000-8000-000000000000"), null);
    // UUID_RE in middleware is case-insensitive; PostgREST answers lowercase.
    assert.equal(await r.resolve(OLD.toUpperCase()), NEW);
  });

  it("reads PostgREST directly with the publishable key, capped at the row limit", async () => {
    const r = resolver(fakeFetch(() => json([])));
    await r.resolve(OLD);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${URL_}/rest/v1/official_redirects?select=old_id,new_id&limit=${ROW_CAP}`);
    const h = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(h["apikey"], KEY);
    assert.equal(h["Authorization"], `Bearer ${KEY}`);
    assert.equal(h["Accept"], "application/json");
    assert.ok(calls[0]!.init!.signal, "the read is bounded by an abort signal");
  });

  it("fetches the list ONCE inside ttlMs, however many ids are resolved", async () => {
    const r = resolver(fakeFetch(() => json([{ old_id: OLD, new_id: NEW }])));
    for (let i = 0; i < 50; i++) await r.resolve(i % 2 ? OLD : "x");
    clock += 3_600_000 - 1;
    await r.resolve(OLD);
    assert.equal(calls.length, 1);
    clock += 1;
    await r.resolve(OLD);
    assert.equal(calls.length, 2, "the first call at ttlMs re-reads");
  });

  it("a cold isolate's concurrent burst shares one read", async () => {
    const r = resolver(fakeFetch(() => json([{ old_id: OLD, new_id: NEW }])));
    const got = await Promise.all(Array.from({ length: 10 }, () => r.resolve(OLD)));
    assert.deepEqual(new Set(got), new Set([NEW]));
    assert.equal(calls.length, 1);
  });

  it("a 500 fails open, and is not retried inside failTtlMs", async () => {
    let status = 500;
    const r = resolver(fakeFetch(() => (status === 500 ? json({ message: "boom" }, 500) : json([{ old_id: OLD, new_id: NEW }]))));
    assert.equal(await r.resolve(OLD), null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^\[official-redirects\] list read failed \(HTTP 500\)/);

    status = 200;
    clock += 60_000 - 1;
    assert.equal(await r.resolve(OLD), null, "still inside failTtlMs — the empty list is served");
    assert.equal(calls.length, 1, "no refetch inside failTtlMs");

    clock += 1;
    assert.equal(await r.resolve(OLD), NEW, "the first call after failTtlMs re-reads");
    assert.equal(calls.length, 2);
  });

  it("a timeout (AbortError from fetch) fails open", async () => {
    const r = resolver(fakeFetch(() => {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError";
      throw e;
    }));
    assert.equal(await r.resolve(OLD), null);
    assert.match(logs[0]!, /timeout after 1500ms/);
  });

  it("the timeout really aborts a hung read", async () => {
    const hung = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as typeof fetch;
    const r = createRedirectResolver({
      supabaseUrl: URL_, publishableKey: KEY, fetchImpl: hung, timeoutMs: 20, log: (m) => logs.push(m),
    });
    assert.equal(await r.resolve(OLD), null);
    assert.match(logs[0]!, /timeout after 20ms/);
  });

  it("a non-array body fails open", async () => {
    const r = resolver(fakeFetch(() => json({ code: "42P01", message: "relation does not exist" })));
    assert.equal(await r.resolve(OLD), null);
    assert.match(logs[0]!, /non-array body/);
  });

  it("a list at the row cap is served AND flagged", async () => {
    const rows = Array.from({ length: ROW_CAP }, (_, i) => ({
      old_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      new_id: NEW,
    }));
    rows[ROW_CAP - 1] = { old_id: OLD, new_id: NEW };
    const r = resolver(fakeFetch(() => json(rows)));
    assert.equal(await r.resolve(OLD), NEW);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^\[official-redirects\] list at the 1,000-row cap/);
  });

  it("with the Supabase env absent it never fetches", async () => {
    const r = createRedirectResolver({
      supabaseUrl: undefined,
      publishableKey: undefined,
      fetchImpl: fakeFetch(() => json([{ old_id: OLD, new_id: NEW }])),
      log: (m) => logs.push(m),
    });
    assert.equal(await r.resolve(OLD), null);
    assert.equal(await r.resolve(OLD), null);
    assert.equal(calls.length, 0);
    assert.equal(logs.length, 1, "warns once, not per request");
  });
});
