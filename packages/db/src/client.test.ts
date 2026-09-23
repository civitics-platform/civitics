import test from "node:test";
import assert from "node:assert/strict";

import { createAdminClient, noStoreFetch } from "./client";

// ---------------------------------------------------------------------------
// FIX-1208 — createAdminClient's fetch option, and noStoreFetch.
//
// The failure these guard: the cron-watchdog route's `run_cron_watchdogs` RPC
// was answered from Next's Data Cache for 17 h (every Vercel log line carried
// the same `at=2026-09-22T01:20:18.610822+00:00`). The fix is a fetch that
// forces `cache: "no-store"`, threaded into supabase-js. Two things must hold
// and neither is visible from the route: supabase-js must actually send through
// the fetch it was given, and the wrapper must reach the GLOBAL fetch (Next's
// patched one) with `cache: "no-store"` and the original request intact.
//
// The global fetch is swapped for a recorder, so nothing leaves the process.
// The URL is loopback on purpose: createAdminClient's FIX-158 pipeline guard
// exits the process on a non-local URL outside Next.
// ---------------------------------------------------------------------------

// `cache` is not on @types/node's RequestInit (this package has no DOM lib).
type InitWithCache = RequestInit & { cache?: string };
type Seen = { url: string; init: InitWithCache | undefined };

function withRecordingFetch(fn: (seen: Seen[]) => Promise<void>): () => Promise<void> {
  return async () => {
    const seen: Seen[] = [];
    const realFetch = globalThis.fetch;
    const envBefore = {
      url: process.env["NEXT_PUBLIC_SUPABASE_URL"],
      key: process.env["SUPABASE_SECRET_KEY"],
    };
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: InitWithCache) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ at: "2026-09-23T00:00:00+00:00" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "http://127.0.0.1:54321";
    process.env["SUPABASE_SECRET_KEY"] = "sb_secret_test";
    try {
      await fn(seen);
    } finally {
      globalThis.fetch = realFetch;
      if (envBefore.url === undefined) delete process.env["NEXT_PUBLIC_SUPABASE_URL"];
      else process.env["NEXT_PUBLIC_SUPABASE_URL"] = envBefore.url;
      if (envBefore.key === undefined) delete process.env["SUPABASE_SECRET_KEY"];
      else process.env["SUPABASE_SECRET_KEY"] = envBefore.key;
    }
  };
}

test(
  "FIX-1208: noStoreFetch forces cache:no-store and keeps method, body and headers",
  withRecordingFetch(async (seen) => {
    const init: InitWithCache = {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer x" },
      cache: "force-cache",
    };
    await noStoreFetch("http://127.0.0.1:54321/rest/v1/rpc/run_cron_watchdogs", init);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.init?.cache, "no-store", "an explicit cache mode is overridden, not merged");
    assert.equal(seen[0]?.init?.method, "POST");
    assert.equal(seen[0]?.init?.body, "{}");
    assert.deepEqual(seen[0]?.init?.headers, { authorization: "Bearer x" });
  }),
);

test(
  "FIX-1208: createAdminClient({ fetch: noStoreFetch }) sends the RPC through it — cache:no-store reaches the global fetch",
  withRecordingFetch(async (seen) => {
    const db = createAdminClient({ fetch: noStoreFetch });
    const { data, error } = await db.rpc("run_cron_watchdogs");
    assert.equal(error, null);
    assert.deepEqual(data, { at: "2026-09-23T00:00:00+00:00" });
    const rpc = seen.filter((s) => s.url.includes("/rest/v1/rpc/run_cron_watchdogs"));
    assert.equal(rpc.length, 1, "exactly one RPC request: " + JSON.stringify(seen.map((s) => s.url)));
    assert.equal(rpc[0]?.init?.cache, "no-store");
    assert.equal(rpc[0]?.init?.method, "POST");
  }),
);

test(
  "FIX-1208: createAdminClient() with no options is unchanged — no cache mode is imposed on the 150-odd other callers",
  withRecordingFetch(async (seen) => {
    const db = createAdminClient();
    await db.rpc("run_cron_watchdogs");
    const rpc = seen.filter((s) => s.url.includes("/rest/v1/rpc/run_cron_watchdogs"));
    assert.equal(rpc.length, 1);
    assert.equal(rpc[0]?.init?.cache, undefined);
  }),
);
