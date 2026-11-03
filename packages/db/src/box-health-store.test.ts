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
  BOX_HEALTH_COMMANDS_PER_SAMPLE,
  BOX_HEALTH_RING_KEY,
  DISK_RATE_MAX_GAP_S,
  diskRates,
  offBoxCommands,
  parseBoxHealthSample,
  parseDiskRaw,
  readBoxHealthRing,
  runBoxHealth,
  sampleSummary,
  type BoxHealthSample,
} from "./box-health-store";
import { METRICS_URL } from "./supabase-prometheus";

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "supabase-metrics-2026-09-24.txt"), "utf8");
// FIX-1375 — two real scrapes one exporter refresh apart (cc-262, 11-03 02:36:15Z / 02:37:17Z).
const DISK_A = readFileSync(join(__dirname, "__fixtures__", "supabase-metrics-2026-11-03-a.txt"), "utf8");
const DISK_B = readFileSync(join(__dirname, "__fixtures__", "supabase-metrics-2026-11-03-b.txt"), "utf8");
const SRC = readFileSync(join(__dirname, "box-health-store.ts"), "utf8");

const UPSTASH = "https://example-upstash.io";
const ENV = {
  SUPABASE_SECRET_KEY: "sb_secret_test",
  UPSTASH_REDIS_REST_URL: UPSTASH,
  UPSTASH_REDIS_REST_TOKEN: "tok",
};

type Call = { url: string; init: RequestInit & { cache?: string } };

/**
 * A fetch that answers the metrics URL with `body`, the ring-head LINDEX with
 * `head` (FIX-1375; a JSON string or null), and every other Upstash call with `upstash`.
 */
function fakeFetch(opts: {
  metrics?: { status: number; body: string } | Error;
  upstash?: unknown;
  upstashStatus?: number;
  head?: string | null;
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
    if (!url.endsWith("/pipeline") && String(init?.body ?? "").startsWith('["LINDEX"')) {
      return new Response(JSON.stringify({ result: opts.head ?? null }), { status: 200 });
    }
    return new Response(JSON.stringify(opts.upstash ?? [{ result: 42 }, { result: "OK" }]), {
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

test("FIX-1125: one firing — metrics, then LPUSH/LTRIM in ONE pipeline, then the on-box stamp", async () => {
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
  // FIX-1375: this fixture carries no diskstats, so no ring-head read is spent on it.
  assert.deepEqual(log, ["metrics", "upstash:pipeline", "on_box"], "off-box FIRST, on-box second");
  assert.equal(r.ok, true);
  assert.equal(r.off_box.ok, true);
  assert.equal((r.off_box as { ring_len: number }).ring_len, 42);

  const body = JSON.parse(String(calls[1]!.init.body)) as string[][];
  assert.deepEqual(body.map((c) => c.slice(0, 2)), [
    ["LPUSH", BOX_HEALTH_RING_KEY],
    ["LTRIM", BOX_HEALTH_RING_KEY],
  ]);
  // FIX-1289: 900 = 30 h at 2 min, so a receipts run up to ~6 h after the
  // 21:00Z slot still holds the whole [slot − 24 h, slot) window.
  assert.deepEqual(body[1], ["LTRIM", "civitics:box_health:mem", "0", "899"], "a 30 h ring at 2 min");
  // cc-153: no `SET civitics:box_health:latest` — the ring's head is the latest sample.
  assert.ok(!body.some((c) => c[0] === "SET"), "no separate latest key");
  assert.equal(JSON.parse(body[0]![2]!).mem_available_bytes, 418258944);
  assert.ok(!body.flat().some((x) => x.startsWith("civitics:rl:")), "never the rate limiter's namespace");

  assert.equal(stamped!.mem_total_bytes, 948195328);
  assert.match(r.line, /^\[cron\/box-health\] mem_avail_mb=399 mem_total_mb=904 avail_pct=44\.1 swap_used_mb=545 load1=0\.14 /);
  // The 09-24 fixture carries no diskstats (trimmed before FIX-1375): the memory sample still lands.
  assert.match(r.line, / disk=missing\(0 filesystem series at \/data\) /);
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

  const partial = fakeFetch({ upstash: [{ result: 3 }, { error: "WRONGTYPE" }] });
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

test("FIX-1125: offBoxCommands is exactly two commands (the quota arithmetic depends on it)", () => {
  const cmds = offBoxCommands({ route_at: "t", scrape_ms: 1, mem_available_bytes: 1, mem_total_bytes: 2 });
  assert.equal(cmds.length, 2);
  assert.equal(cmds.length, BOX_HEALTH_COMMANDS_PER_SAMPLE, "the stated per-sample cost is the real one");
});

test("FIX-1125 cc-153: a pipeline answering the OLD three replies is refused, not half-read", async () => {
  const { fetchImpl } = fakeFetch({ upstash: [{ result: 42 }, { result: "OK" }, { result: "OK" }] });
  const r = await runBoxHealth({ env: ENV, fetchImpl, now, stampOnBox: async () => ({ at: null, error: "x" }) });
  assert.equal(r.ok, false);
  assert.match(r.line, /off_box=FAILED\(upstash pipeline: expected 2 replies/);
});

// ── FIX-1375: the disk counters and rates ────────────────────────────────────

/** Σ node_cpu_seconds_total / ncpu, computed independently of the parser. */
function exporterClock(body: string): number {
  const rows = body.split("\n").filter((l) => l.startsWith("node_cpu_seconds_total{") && l.includes('service_type="db"'));
  const cpus = new Set(rows.map((l) => l.match(/cpu="(\d+)"/)![1]));
  return rows.reduce((s, l) => s + Number(l.slice(l.lastIndexOf(" ") + 1)), 0) / cpus.size;
}

function counter(body: string, name: string, device: string): number {
  const line = body.split("\n").find((l) => l.startsWith(name + "{") && l.includes(`device="${device}"`))!;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

test("FIX-1375: the real 11-03 scrape parses to the /data device's counters, the all-device totals and the exporter clock", () => {
  const p = parseBoxHealthSample(DISK_A, "2026-11-03T02:36:15.732Z", 300);
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(p.disk_missing, null);
  const s = p.sample;
  assert.equal(s.disk_device, "nvme1n1", "the device node_filesystem_size_bytes mounts at /data");
  assert.equal(s.disk_read_bytes, counter(DISK_A, "node_disk_read_bytes_total", "nvme1n1"));
  assert.equal(s.disk_io_time_s, counter(DISK_A, "node_disk_io_time_seconds_total", "nvme1n1"));
  assert.equal(
    s.disk_all_read_bytes,
    counter(DISK_A, "node_disk_read_bytes_total", "nvme1n1") + counter(DISK_A, "node_disk_read_bytes_total", "nvme0n1"),
    "both whole disks: the root volume carries swap",
  );
  assert.equal(s.disk_clock_s, exporterClock(DISK_A));
  assert.ok(s.mem_total_bytes > 0, "the memory keys are unchanged");
  assert.equal(s.io_time_pct, undefined, "a parse alone rates nothing");
});

test("FIX-1375: two scrapes rate on the EXPORTER's clock — every rate is the counter delta over Δclock", () => {
  const a = parseBoxHealthSample(DISK_A, "2026-11-03T02:36:15.732Z", 300);
  const b = parseBoxHealthSample(DISK_B, "2026-11-03T02:37:17.199Z", 300);
  assert.ok(a.ok && b.ok);
  const dt = exporterClock(DISK_B) - exporterClock(DISK_A);
  assert.ok(dt > 50 && dt < 75, `one exporter refresh apart, got ${dt}`);
  const r = diskRates(a.sample, b.sample);
  const d = (name: string, dev = "nvme1n1") => counter(DISK_B, name, dev) - counter(DISK_A, name, dev);
  assert.equal(r.disk_read_mbps, Math.round((d("node_disk_read_bytes_total") / 1e6 / dt) * 100) / 100);
  assert.equal(r.disk_write_mbps, Math.round((d("node_disk_written_bytes_total") / 1e6 / dt) * 100) / 100);
  assert.equal(r.io_time_pct, Math.min(100, Math.round((1000 * d("node_disk_io_time_seconds_total")) / dt) / 10));
  assert.equal(r.io_queue, Math.round((d("node_disk_io_time_weighted_seconds_total") / dt) * 100) / 100);
  assert.equal(r.disk_reads_ps, Math.round((d("node_disk_reads_completed_total") / dt) * 10) / 10);
  assert.equal(r.disk_writes_ps, Math.round((d("node_disk_writes_completed_total") / dt) * 10) / 10);
  const all = d("node_disk_read_bytes_total") + d("node_disk_read_bytes_total", "nvme0n1");
  assert.equal(r.disk_all_read_mbps, Math.round((all / 1e6 / dt) * 100) / 100);
  for (const [k, v] of Object.entries(r)) assert.ok(typeof v === "number" && v >= 0, `${k}=${v}`);
  assert.ok(r.io_time_pct! <= 100);
});

test("FIX-1375: no honest rate → the key is ABSENT (first sample, device change, same snapshot, a gap, a reset)", () => {
  const a = parseBoxHealthSample(DISK_A, "t", 1);
  const b = parseBoxHealthSample(DISK_B, "t", 1);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(diskRates(null, b.sample), {}, "the first sample has no previous");
  assert.deepEqual(diskRates({ route_at: "t" }, b.sample), {}, "a pre-FIX-1375 previous carries no counters");
  assert.deepEqual(diskRates({ ...a.sample, disk_device: "nvme9n1" }, b.sample), {}, "never rated across a device change");
  assert.deepEqual(diskRates(b.sample, b.sample), {}, "the same exporter snapshot twice (Δclock = 0)");
  assert.deepEqual(
    diskRates({ ...a.sample, disk_clock_s: b.sample.disk_clock_s! - DISK_RATE_MAX_GAP_S - 1 }, b.sample),
    {},
    "a gap past 6 min would average a hole away",
  );
  // A counter that went backwards (a node restart) drops THAT rate, not the rest, and never goes negative.
  const reset = diskRates({ ...a.sample, disk_read_bytes: b.sample.disk_read_bytes! + 1 }, b.sample);
  assert.equal(reset.disk_read_mbps, undefined);
  assert.equal(typeof reset.io_time_pct, "number");
  // Serialised, an absent rate is not a null (record_box_health_mem's numeric check would RAISE on null).
  assert.ok(!JSON.stringify(reset).includes("null"));
});

test("FIX-1375: a body without the device or the mount → the memory sample still lands, disk_missing says why", () => {
  const noDisk = DISK_A.split("\n").filter((l) => !l.startsWith("node_disk_")).join("\n");
  const p = parseBoxHealthSample(noDisk, "t", 1);
  assert.ok(p.ok, JSON.stringify(p));
  assert.match(p.disk_missing!, /node_disk_read_bytes_total: 0 series for device nvme1n1/);
  assert.equal(p.sample.disk_device, undefined);
  assert.equal(typeof p.sample.mem_available_bytes, "number");

  const noMount = DISK_A.split("\n").filter((l) => !l.includes('mountpoint="/data"')).join("\n");
  assert.deepEqual(parseDiskRaw(noMount), { missing: "0 filesystem series at /data" });
});

test("FIX-1375: a firing with a previous sample at the ring head pushes the rates to the ring AND the stamp", async () => {
  const a = parseBoxHealthSample(DISK_A, "2026-11-03T02:36:15.732Z", 300);
  assert.ok(a.ok);
  const log: string[] = [];
  const { fetchImpl, calls } = fakeFetch({ metrics: { status: 200, body: DISK_B }, head: JSON.stringify(a.sample), log });
  let stamped: BoxHealthSample | null = null;
  const r = await runBoxHealth({
    env: ENV, fetchImpl, now,
    stampOnBox: async (s) => { log.push("on_box"); stamped = s; return { at: "2026-11-03T02:38:00+00:00", error: null }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(log, ["metrics", "upstash", "upstash:pipeline", "on_box"], "the head read, then off-box, then on-box");
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), ["LINDEX", BOX_HEALTH_RING_KEY, "0"], "one plain LINDEX");
  const pushed = JSON.parse((JSON.parse(String(calls[2]!.init.body)) as string[][])[0]![2]!) as BoxHealthSample;
  assert.equal(typeof pushed.io_time_pct, "number");
  assert.equal(typeof pushed.disk_read_mbps, "number");
  assert.equal(pushed.disk_clock_s, exporterClock(DISK_B), "the raw counters ride along for the next delta");
  assert.equal(stamped!.io_time_pct, pushed.io_time_pct);
  assert.match(r.line, / disk=r[\d.]+\/w[\d.]+MB\/s all=r[\d.]+\/w[\d.]+MB\/s io=[\d.]+% q=[\d.]+ /);

  // An empty ring (or a failed LINDEX) costs the rates, never the sample.
  const first = fakeFetch({ metrics: { status: 200, body: DISK_B }, head: null });
  const r2 = await runBoxHealth({ env: ENV, fetchImpl: first.fetchImpl, now, stampOnBox: async () => ({ at: null, error: "x" }) });
  assert.equal(r2.ok, true);
  assert.match(r2.line, / disk=unrated\(no previous sample\) /);
  const pushed2 = JSON.parse((JSON.parse(String(first.calls[2]!.init.body)) as string[][])[0]![2]!) as BoxHealthSample;
  assert.equal(pushed2.io_time_pct, undefined);
  assert.equal(typeof pushed2.disk_read_bytes, "number");
});
