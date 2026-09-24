/**
 * FIX-1125 / FIX-1194 P1-B — the box-health store and one route firing.
 *
 * The fixture is cc-149 read 2's REAL scrape of the prod metrics endpoint
 * (2026-09-24 01:34 UTC), trimmed to the node_memory / node_load / node_vmstat
 * families plus the body's first 40 lines of other families, so the parser has
 * something to skip. The numbers asserted below are that scrape's.
 *
 * Every Upstash and metrics call goes through a fake fetch that RECORDS its
 * calls, so the order (metrics → Upstash pipeline → on-box stamp), the three
 * commands and the `cache: "no-store"` on every call are asserted rather than
 * assumed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BOX_HEALTH_LATEST_KEY,
  BOX_HEALTH_RING_KEY,
  offBoxCommands,
  parseBoxHealthSample,
  readBoxHealthRing,
  runBoxHealth,
  sampleSummary,
  type BoxHealthSample,
} from "./box-health-store";
import { METRICS_URL } from "./supabase-prometheus";

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "supabase-metrics-2026-09-24.txt"), "utf8");
const SRC = readFileSync(join(__dirname, "box-health-store.ts"), "utf8");

const UPSTASH = "https://example-upstash.io";
const ENV = {
  SUPABASE_SECRET_KEY: "sb_secret_test",
  UPSTASH_REDIS_REST_URL: UPSTASH,
  UPSTASH_REDIS_REST_TOKEN: "tok",
};

type Call = { url: string; init: RequestInit & { cache?: string } };

/** A fetch that answers the metrics URL with `body` and Upstash with `upstash`. */
function fakeFetch(opts: {
  metrics?: { status: number; body: string } | Error;
  upstash?: unknown;
  upstashStatus?: number;
  log?: string[];
}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: (init ?? {}) as Call["init"] });
    if (url === METRICS_URL) {
      opts.log?.push("metrics");
      if (opts.metrics instanceof Error) throw opts.metrics;
      const m = opts.metrics ?? { status: 200, body: FIXTURE };
      return new Response(m.body, { status: m.status });
    }
    opts.log?.push(url.endsWith("/pipeline") ? "upstash:pipeline" : "upstash");
    return new Response(JSON.stringify(opts.upstash ?? [{ result: 42 }, { result: "OK" }, { result: "OK" }]), {
      status: opts.upstashStatus ?? 200,
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let clock = 1_790_000_000_000;
const now = () => (clock += 7);

// ── parse ────────────────────────────────────────────────────────────────────

test("FIX-1125: the real scrape parses to read 2's numbers", () => {
  const p = parseBoxHealthSample(FIXTURE, "2026-09-24T01:34:29.602Z", 493);
  assert.ok(p.ok, JSON.stringify(p));
  const s = p.sample;
  assert.equal(s.mem_available_bytes, 418258944);
  assert.equal(s.mem_total_bytes, 948195328);
  assert.equal(s.swap_total_bytes, 1073737728);
  assert.equal(s.swap_free_bytes, 502247424);
  assert.equal(s.load1, 0.14);
  assert.equal(s.pswpin, 4980534);
  assert.equal(s.pswpout, 5071728);
  assert.equal(s.pgmajfault, 2731732);
  assert.equal(s.oom_kill, 0);
  assert.deepEqual(p.ambiguous, []);
  assert.deepEqual(sampleSummary(s), {
    mem_avail_mb: 399, mem_total_mb: 904, avail_pct: 44.1, swap_used_mb: 545, load1: 0.14,
  });
});

test("FIX-1125: ambiguity is REFUSED for a required metric and DROPPED for an optional one (FIX-1104)", () => {
  const avail = FIXTURE.split("\n").find((l) => l.startsWith("node_memory_MemAvailable_bytes{"))!;
  const load = FIXTURE.split("\n").find((l) => l.startsWith("node_load1{"))!;

  const twoAvail = parseBoxHealthSample(FIXTURE + avail + "\n", "t", 1);
  assert.equal(twoAvail.ok, false);
  assert.match((twoAvail as { error: string }).error, /MemAvailable_bytes: 2 series/);

  const twoLoad = parseBoxHealthSample(FIXTURE + load + "\n", "t", 1);
  assert.ok(twoLoad.ok);
  assert.equal(twoLoad.sample.load1, undefined, "an ambiguous optional is not summed");
  assert.deepEqual(twoLoad.ambiguous, ["node_load1 (2 series)"]);

  const none = parseBoxHealthSample(FIXTURE.replace(avail, ""), "t", 1);
  assert.equal(none.ok, false);
  assert.match((none as { error: string }).error, /MemAvailable_bytes: 0 series/);

  // A series from another service_type is not this box's.
  const other = parseBoxHealthSample(FIXTURE.replace(avail, avail.replace('service_type="db"', 'service_type="pooler"')), "t", 1);
  assert.equal(other.ok, false);
});

// ── the firing ───────────────────────────────────────────────────────────────

test("FIX-1125: one firing — metrics, then LPUSH/LTRIM/SET in ONE pipeline, then the on-box stamp", async () => {
  const log: string[] = [];
  const { fetchImpl, calls } = fakeFetch({ log });
  let stamped: BoxHealthSample | null = null;
  const r = await runBoxHealth({
    env: ENV, fetchImpl, now,
    stampOnBox: async (s) => {
      log.push("on_box");
      stamped = s;
      return { at: "2026-09-24T01:36:00.123+00:00", error: null };
    },
  });
  assert.deepEqual(log, ["metrics", "upstash:pipeline", "on_box"], "off-box FIRST, on-box second");
  assert.equal(r.ok, true);
  assert.equal(r.off_box.ok, true);
  assert.equal((r.off_box as { ring_len: number }).ring_len, 42);

  const body = JSON.parse(String(calls[1]!.init.body)) as string[][];
  assert.deepEqual(body.map((c) => c.slice(0, 2)), [
    ["LPUSH", BOX_HEALTH_RING_KEY],
    ["LTRIM", BOX_HEALTH_RING_KEY],
    ["SET", BOX_HEALTH_LATEST_KEY],
  ]);
  assert.deepEqual(body[1], ["LTRIM", "civitics:box_health:mem", "0", "719"], "a 24 h ring at 2 min");
  assert.equal(body[0]![2], body[2]![2], "the ring and `latest` carry the same sample");
  assert.equal(JSON.parse(body[0]![2]!).mem_available_bytes, 418258944);
  assert.ok(!body.flat().some((x) => x.startsWith("civitics:rl:")), "never the rate limiter's namespace");

  assert.equal(stamped!.mem_total_bytes, 948195328);
  assert.match(r.line, /^\[cron\/box-health\] mem_avail_mb=399 mem_total_mb=904 avail_pct=44\.1 swap_used_mb=545 load1=0\.14 /);
  assert.match(r.line, /off_box=ok ring=42 on_box=ok at=2026-09-24T01:36:00\.123\+00:00\(db\) /);
});

test("FIX-1125: the on-box stamp failing (error OR throw) leaves the route ok — the ring is the deliverable", async () => {
  for (const stampOnBox of [
    async () => ({ at: null, error: "Could not find the function public.record_box_health_mem" }),
    async () => { throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY"); },
  ]) {
    const { fetchImpl } = fakeFetch({});
    const r = await runBoxHealth({ env: ENV, fetchImpl, now, stampOnBox });
    assert.equal(r.ok, true);
    assert.equal(r.on_box.ok, false);
    assert.match(r.line, /on_box=FAILED\(/);
    assert.match(r.line, / at=\d{4}-\d\d-\d\dT[\d:.]+Z\(route\) /, "labelled as the ROUTE clock");
  }
});

test("FIX-1125: an Upstash refusal is not ok, and the on-box stamp is still attempted", async () => {
  const { fetchImpl } = fakeFetch({ upstash: { error: "ERR max requests limit exceeded. Limit: 500000, Usage: 500002." } });
  let attempted = false;
  const r = await runBoxHealth({
    env: ENV, fetchImpl, now,
    stampOnBox: async () => { attempted = true; return { at: "2026-09-24T01:36:00+00:00", error: null }; },
  });
  assert.equal(r.ok, false);
  assert.equal(attempted, true);
  assert.match(r.line, /off_box=FAILED\(upstash 200: ERR max requests limit exceeded/);

  const partial = fakeFetch({ upstash: [{ result: 3 }, { error: "WRONGTYPE" }, { result: "OK" }] });
  const r2 = await runBoxHealth({ env: ENV, fetchImpl: partial.fetchImpl, now, stampOnBox: async () => ({ at: null, error: "x" }) });
  assert.equal(r2.ok, false);
  assert.match(r2.line, /off_box=FAILED\(upstash LTRIM: WRONGTYPE\)/);
});

test("FIX-1125: no Upstash env → not ok, named; no secret or a dead endpoint → nothing written", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const r = await runBoxHealth({
    env: { SUPABASE_SECRET_KEY: "k" }, fetchImpl, now,
    stampOnBox: async () => ({ at: "2026-09-24T01:36:00+00:00", error: null }),
  });
  assert.equal(r.ok, false);
  assert.match(r.line, /off_box=FAILED\(UPSTASH_REDIS_REST_URL\/TOKEN not set\)/);
  assert.equal(calls.length, 1, "only the scrape");

  let stamped = false;
  const dead = fakeFetch({ metrics: new Error("fetch failed") });
  const r2 = await runBoxHealth({ env: ENV, fetchImpl: dead.fetchImpl, now, stampOnBox: async () => { stamped = true; return { at: null, error: null }; } });
  assert.equal(r2.ok, false);
  assert.equal(stamped, false);
  assert.equal(dead.calls.length, 1, "a failed scrape writes nothing anywhere");
  assert.match(r2.line, /scrape failed: metrics fetch: fetch failed/);

  const r3 = await runBoxHealth({ env: {}, fetchImpl, now, stampOnBox: async () => ({ at: null, error: null }) });
  assert.match(r3.line, /scrape failed: SUPABASE_SECRET_KEY not set/);

  const http = fakeFetch({ metrics: { status: 522, body: "origin unreachable" } });
  const r4 = await runBoxHealth({ env: ENV, fetchImpl: http.fetchImpl, now, stampOnBox: async () => ({ at: null, error: null }) });
  assert.match(r4.line, /scrape failed: metrics HTTP 522: origin unreachable/);
});

// ── rule 171: no-store on every call ─────────────────────────────────────────

test("FIX-1125: every fetch passes cache: \"no-store\" — at runtime and in the source", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  await runBoxHealth({ env: ENV, fetchImpl, now, stampOnBox: async () => ({ at: null, error: "x" }) });
  await readBoxHealthRing({ url: UPSTASH, token: "tok" }, fakeFetch({ upstash: { result: [] } }).fetchImpl);
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.equal(c.init.cache, "no-store", c.url);

  // The source: every fetchImpl( call's init carries it, so a new call site cannot forget.
  const sites = [...SRC.matchAll(/fetchImpl\(/g)].map((m) => m.index!);
  assert.equal(sites.length, 2, "the scrape and the Upstash helper");
  for (const at of sites) {
    const init = SRC.slice(at, SRC.indexOf("} as RequestInit)", at));
    assert.match(init, /cache: "no-store"/, SRC.slice(at, at + 80));
  }
});

// ── the ring reader ──────────────────────────────────────────────────────────

test("FIX-1125: readBoxHealthRing parses LRANGE newest-first and counts what it could not parse", async () => {
  const a = { route_at: "2026-09-24T01:36:00Z", scrape_ms: 400, mem_available_bytes: 1, mem_total_bytes: 2 };
  const b = { route_at: "2026-09-24T01:34:00Z", scrape_ms: 400, mem_available_bytes: 1, mem_total_bytes: 2 };
  const { fetchImpl, calls } = fakeFetch({ upstash: { result: [JSON.stringify(a), "not json", JSON.stringify(b), "{}"] } });
  const r = await readBoxHealthRing({ url: UPSTASH + "/", token: "tok" }, fetchImpl, 30);
  assert.ok(r.ok);
  assert.deepEqual(r.samples.map((s) => s.route_at), [a.route_at, b.route_at]);
  assert.equal(r.unparseable, 2);
  assert.equal(calls[0]!.url, UPSTASH, "trailing slash normalised; one plain command, not a pipeline");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), ["LRANGE", BOX_HEALTH_RING_KEY, "0", "29"]);
});

test("FIX-1125: offBoxCommands is exactly three commands (the quota arithmetic depends on it)", () => {
  const cmds = offBoxCommands({ route_at: "t", scrape_ms: 1, mem_available_bytes: 1, mem_total_bytes: 2 });
  assert.equal(cmds.length, 3);
});
