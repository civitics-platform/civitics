// FIX-1283 unit tests for the edge's institution slug → id resolver.
//
// Same shape as official-redirects.test.ts (whose resolver this reuses): no
// network, a recording fake fetch and a settable clock. What is pinned here is
// what differs — the list read, the slug → id direction, exact-case matching —
// plus the four behaviours middleware.ts relies on: hit, miss, failed load →
// null (the request falls through to the page), and the TTL.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ROW_CAP } from "./official-redirects";
import { createInstitutionSlugResolver } from "./institution-slug-redirects";

const SLUG = "administrative-services-department";
const ID = "86d888f1-7453-4fc3-9461-f5528fd7230e";
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
  return createInstitutionSlugResolver({
    supabaseUrl: URL_,
    publishableKey: KEY,
    fetchImpl,
    now: () => clock,
    log: (m) => logs.push(m),
  });
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  calls = [];
  logs = [];
});

describe("institution-slug resolver", () => {
  it("reads governing_bodies' slugged rows from PostgREST with the publishable key, capped", async () => {
    const r = resolver(fakeFetch(() => json([])));
    await r.resolve(SLUG);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${URL_}/rest/v1/governing_bodies?select=id,slug&slug=not.is.null&limit=${ROW_CAP}`);
    const h = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(h["apikey"], KEY);
    assert.equal(h["Authorization"], `Bearer ${KEY}`);
    assert.ok(calls[0]!.init!.signal, "the read is bounded by an abort signal");
  });

  it("hit: a listed slug resolves to its id", async () => {
    const r = resolver(fakeFetch(() => json([{ id: ID, slug: SLUG }])));
    assert.equal(await r.resolve(SLUG), ID);
  });

  it("miss: an unlisted slug is null, so the page keeps it", async () => {
    const r = resolver(fakeFetch(() => json([{ id: ID, slug: SLUG }])));
    assert.equal(await r.resolve("no-such-institution"), null);
  });

  it("matches exactly, as the page's .eq('slug', …) does", async () => {
    const r = resolver(fakeFetch(() => json([{ id: ID, slug: SLUG }])));
    assert.equal(await r.resolve(SLUG.toUpperCase()), null);
  });

  it("failed load: a 500 is null (fail open) and logs under its own name", async () => {
    const r = resolver(fakeFetch(() => json({ message: "boom" }, 500)));
    assert.equal(await r.resolve(SLUG), null);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /^\[institution-slugs\] list read failed \(HTTP 500\) — serving no redirects for 60s/);
  });

  it("failed load: a thrown fetch is null", async () => {
    const r = resolver(fakeFetch(() => {
      throw new TypeError("fetch failed");
    }));
    assert.equal(await r.resolve(SLUG), null);
  });

  it("TTL: one read per hour however many slugs are resolved; the next read after it", async () => {
    const r = resolver(fakeFetch(() => json([{ id: ID, slug: SLUG }])));
    for (let i = 0; i < 20; i++) await r.resolve(i % 2 ? SLUG : "other");
    clock += 3_600_000 - 1;
    assert.equal(await r.resolve(SLUG), ID);
    assert.equal(calls.length, 1);
    clock += 1;
    await r.resolve(SLUG);
    assert.equal(calls.length, 2, "the first call at ttlMs re-reads");
  });

  it("a failed load is retried after the 60 s fail TTL, not before", async () => {
    let status = 500;
    const r = resolver(fakeFetch(() => (status === 500 ? json({}, 500) : json([{ id: ID, slug: SLUG }]))));
    assert.equal(await r.resolve(SLUG), null);
    status = 200;
    clock += 60_000 - 1;
    assert.equal(await r.resolve(SLUG), null);
    assert.equal(calls.length, 1);
    clock += 1;
    assert.equal(await r.resolve(SLUG), ID);
  });

  it("rows without a string slug or id are skipped", async () => {
    const r = resolver(fakeFetch(() => json([{ id: ID, slug: null }, { id: null, slug: "x" }, { id: ID, slug: SLUG }])));
    assert.equal(await r.resolve(SLUG), ID);
    assert.equal(await r.resolve("x"), null);
  });
});
