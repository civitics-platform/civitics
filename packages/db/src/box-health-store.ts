/**
 * FIX-1125 / FIX-1194 P1-B — the box's memory series, kept OFF the box.
 *
 * WHY THIS EXISTS. Nothing in this codebase recorded memory. cc-145 read the
 * 09-22 outage and said a `node_memory_MemAvailable_bytes` series at 2-minute
 * resolution would have shown the ramp in the ten minutes before the fork
 * failure. It also said the series has to persist somewhere that does not need
 * this database, because the snapshot route wrote no rows 15:30–22:00 that day.
 * front-door-watch's header says there is no Postgres-independent state store
 * in this codebase. This module adds one, for one series.
 *
 * ── The metric names are READ, not assumed (rule 8, rule 122) ────────────────
 *
 * One scrape of the prod endpoint, 2026-09-24 01:34 UTC (cc-149 read 2),
 * 285,952 bytes in 493 ms:
 *   node_memory_MemAvailable_bytes   418,258,944   (399 MB)
 *   node_memory_MemTotal_bytes       948,195,328   (904 MB)
 *   node_memory_SwapTotal_bytes    1,073,737,728
 *   node_memory_SwapFree_bytes       502,247,424   (545 MB of swap IN USE)
 *   node_load1                              0.14
 *   node_vmstat_pswpin / pswpout / pgmajfault / oom_kill   (counters)
 * PSI (`node_pressure_*`) is NOT exported, so it is not in the list. Every
 * series above is exactly one row with service_type="db". The endpoint also
 * serves gotrue, pooler, postgresql and postgrest series, so the label is part
 * of the match.
 *
 * ── Refused, not summed (the FIX-1104 lesson) ────────────────────────────────
 *
 * parsePrometheusText SUMS every matching row. For "how much memory is
 * available" a sum of two rows would be invented. So each metric's series
 * count is checked first. A required metric with 0 or 2+ series fails the
 * sample. An optional one is dropped and named in `ambiguous`.
 *
 * ── The store ────────────────────────────────────────────────────────────────
 *
 * Upstash, over REST, in ONE pipelined request per sample:
 *   LPUSH civitics:box_health:mem <json>
 *   LTRIM civitics:box_health:mem 0 899     — a 30 h ring at 2-min cadence
 * These are 2 commands against the 500k/month allotment the rate limiter
 * shares: 720 samples/day × 2 = 1,440/day, about 43k per 30-day month, 8.6 %.
 * That is set by the CADENCE, not the ring length: FIX-1289 took the ring from
 * 720 (24 h) to 900 (30 h) at the same 2 commands a sample, so the command
 * share is unchanged and only the stored list grows, by 25 %. The 30 h is so
 * the receipts job, which runs after the 21:00Z slot (up to ~100 min after on a
 * Sunday drop night, ~3 h for the schedule fallback), still holds the whole
 * [slot − 24 h, slot) window it banks.
 * The latest sample IS the ring's head (LINDEX … 0 — one command, the same as
 * a GET). cc-153 dropped the `SET civitics:box_health:latest` that duplicated
 * it: nothing read that key, and it cost 21,600 commands a month. The on-box
 * latest is pipeline_state.box_health_mem. cc-149 read 6 had the period at 86,666 (17.3 %) on day 23, all rate limiter. This
 * module never touches `civitics:rl:*`, and ratelimit.ts's private getRedis()
 * is untouched. The REST API is called with fetch, as upstash-usage.ts does,
 * so packages/db takes no @upstash/redis dependency.
 *
 * ── Blind spot, stated ───────────────────────────────────────────────────────
 *
 * The metrics endpoint is served from the same host as the ingress that
 * returned 522 on 09-22 from 16:00. So the series shows the RAMP before a
 * failure and goes dark WITH it. The ring keeps the ramp, and that is the
 * point.
 *
 * Every fetch here passes `cache: "no-store"` explicitly, whatever fetch it was
 * handed (rule 171). Next 14 Data-Caches an identical-body POST inside a GET
 * Route Handler, and this module's first caller is one.
 *
 * ── Disk rates (FIX-1375, cc-262) ────────────────────────────────────────────
 *
 * The 11-02 stall was an IO throttle with flat memory, and this series could
 * not see it. cc-262 read the same body for diskstats (11-03 01:34Z): node_disk_*
 * for TWO devices, nvme1n1 (/data) and nvme0n1 (the root volume, where swap
 * lives; its reads since boot equal /data's). Every sample now carries the /data
 * device's raw counters, the all-device byte totals (the Micro's burst budget is
 * per instance, not per volume), and the exporter's own clock. The rates come
 * from the previous sample, which is the ring's head, read with one LINDEX
 * before the push. That is the third command a sample costs: 2,160 a day,
 * ~65k per 30-day month, ~13 % of the 500k allotment, up from 8.6 %.
 *
 * The clock is NOT the route's. The endpoint refreshes its values once a
 * minute (cc-262: a 10 s poll saw them change every 60 s), so two scrapes 120
 * route-seconds apart can span 60 or 180 exporter-seconds, and a route-clock
 * rate read io_time at 184 %. Σ node_cpu_seconds_total / ncpu advances at
 * exactly one second per second on the exporter's side, so it is the
 * denominator. A rate is omitted, never null and never negative, on the first
 * sample, a device change, a counter that went backwards, the same exporter
 * snapshot twice, or a gap over 6 min. Omitted rather than null because
 * record_box_health_mem's numeric check would RAISE on a null key once its
 * whitelist carries these.
 */

import { METRICS_URL, parsePrometheusText, type PromMatch } from "./supabase-prometheus";

export const BOX_HEALTH_RING_KEY = "civitics:box_health:mem";
/** 30 h at the route's 2-minute cadence (FIX-1289; was 720 = 24 h). */
export const BOX_HEALTH_RING_LEN = 900;
/** Upstash commands in each sample's write pipeline (LPUSH + LTRIM), stated so the quota share is checkable. */
export const BOX_HEALTH_COMMANDS_PER_SAMPLE = 2;
/** FIX-1375 — plus the one LINDEX that reads the previous sample for the disk rates. */
export const BOX_HEALTH_HEAD_READS_PER_SAMPLE = 1;
/** FIX-1375 — the head read is one small command; past 1 s the rates are skipped, not the sample. */
export const BOX_HEALTH_HEAD_TIMEOUT_MS = 1_000;

/** Only the db host's series. The endpoint also serves gotrue/pooler/postgresql/postgrest. */
export const BOX_HEALTH_LABEL = 'service_type="db"';

/**
 * Sample field → metric name. Derived from read 2 (rule 122): every name here
 * was present in the real body; nothing absent (PSI) is listed.
 */
export const BOX_HEALTH_REQUIRED = {
  mem_available_bytes: "node_memory_MemAvailable_bytes",
  mem_total_bytes: "node_memory_MemTotal_bytes",
} as const;

export const BOX_HEALTH_OPTIONAL = {
  swap_total_bytes: "node_memory_SwapTotal_bytes",
  swap_free_bytes: "node_memory_SwapFree_bytes",
  load1: "node_load1",
  pswpin: "node_vmstat_pswpin",
  pswpout: "node_vmstat_pswpout",
  pgmajfault: "node_vmstat_pgmajfault",
  oom_kill: "node_vmstat_oom_kill",
} as const;

/**
 * FIX-1375 — the /data device's diskstats counters. The names are READ (cc-262
 * read 1); the device is whichever one node_filesystem_size_bytes mounts at /data.
 */
export const BOX_HEALTH_DISK_COUNTERS = {
  disk_read_bytes: "node_disk_read_bytes_total",
  disk_written_bytes: "node_disk_written_bytes_total",
  disk_io_time_s: "node_disk_io_time_seconds_total",
  disk_io_weighted_s: "node_disk_io_time_weighted_seconds_total",
  disk_reads: "node_disk_reads_completed_total",
  disk_writes: "node_disk_writes_completed_total",
} as const;

export const BOX_HEALTH_DATA_MOUNT = "/data";

type RequiredField = keyof typeof BOX_HEALTH_REQUIRED;
type OptionalField = keyof typeof BOX_HEALTH_OPTIONAL;
type DiskCounterField = keyof typeof BOX_HEALTH_DISK_COUNTERS;

/** FIX-1375 — the raw counters a sample carries so the NEXT sample can rate them. */
export type DiskRaw = {
  /** The /data device, e.g. "nvme1n1". A different device on the next sample is not rated across. */
  disk_device: string;
  /** Σ node_cpu_seconds_total / ncpu: the exporter's clock, the rates' denominator. */
  disk_clock_s: number;
  /** Bytes read / written across every whole disk on the db host: the instance's burst budget is shared. */
  disk_all_read_bytes: number;
  disk_all_written_bytes: number;
} & Record<DiskCounterField, number>;

/** FIX-1375 — the rates over the interval since the previous sample. MB is 10^6 bytes, as EBS quotes it. */
export type DiskRates = {
  disk_read_mbps: number;
  disk_write_mbps: number;
  /** % of the interval the /data device had IO in flight, 0–100. */
  io_time_pct: number;
  /** Average IOs in flight (weighted io_time Δ / Δt). */
  io_queue: number;
  disk_reads_ps: number;
  disk_writes_ps: number;
  disk_all_read_mbps: number;
  disk_all_write_mbps: number;
};

export type BoxHealthSample = {
  /** ISO time the route scraped, by the route's clock. */
  route_at: string;
  /** Wall time of the metrics fetch. */
  scrape_ms: number;
} & Record<RequiredField, number> &
  Partial<Record<OptionalField, number>> &
  Partial<DiskRaw> &
  Partial<DiskRates>;

export type ParsedSample =
  | { ok: true; sample: BoxHealthSample; ambiguous: string[]; disk_missing: string | null }
  | { ok: false; error: string };

/** How many rows of `name` carry `label`. */
function seriesCount(body: string, name: string, label: string): number {
  let n = 0;
  for (const line of body.split("\n")) {
    if (line.startsWith(name + "{") && line.slice(0, line.indexOf(" ")).includes(label)) n += 1;
  }
  return n;
}

/**
 * Parse one scrape body into a sample. Pure.
 *
 * Uses parsePrometheusText, not getSupabasePrometheusMetrics: the latter has a
 * 5-minute module cache, writes supabase_prometheus_state and calls
 * get_supabase_cpu_max. None of those belong in a two-minute memory sampler.
 */
export function parseBoxHealthSample(body: string, routeAt: string, scrapeMs: number): ParsedSample {
  const all = { ...BOX_HEALTH_REQUIRED, ...BOX_HEALTH_OPTIONAL } as Record<string, string>;
  const wants: PromMatch[] = Object.values(all).map((name) => ({ name, labelContains: BOX_HEALTH_LABEL }));
  const values = parsePrometheusText(body, wants);

  const sample: Record<string, number | string> = { route_at: routeAt, scrape_ms: scrapeMs };
  const ambiguous: string[] = [];

  for (const [field, name] of Object.entries(BOX_HEALTH_REQUIRED)) {
    const n = seriesCount(body, name, BOX_HEALTH_LABEL);
    if (n !== 1) {
      return { ok: false, error: `${name}: ${n} series with ${BOX_HEALTH_LABEL}, need exactly 1` };
    }
    sample[field] = values.get(`${name}|${BOX_HEALTH_LABEL}`)!;
  }
  for (const [field, name] of Object.entries(BOX_HEALTH_OPTIONAL)) {
    const n = seriesCount(body, name, BOX_HEALTH_LABEL);
    if (n === 1) sample[field] = values.get(`${name}|${BOX_HEALTH_LABEL}`)!;
    else if (n > 1) ambiguous.push(`${name} (${n} series)`);
  }
  const avail = sample["mem_available_bytes"] as number;
  const total = sample["mem_total_bytes"] as number;
  if (!(total > 0) || avail < 0 || avail > total) {
    return { ok: false, error: `inconsistent memory reading: available ${avail} of total ${total}` };
  }
  // FIX-1375: the disk counters are an addition, never a reason to lose the memory sample.
  const disk = parseDiskRaw(body);
  if ("missing" in disk) return { ok: true, sample: sample as BoxHealthSample, ambiguous, disk_missing: disk.missing };
  return { ok: true, sample: { ...(sample as BoxHealthSample), ...disk }, ambiguous, disk_missing: null };
}

type Row = { name: string; labels: string; value: number };

/** The db host's rows of the named families. */
function dbRows(body: string, names: Set<string>): Row[] {
  const out: Row[] = [];
  for (const line of body.split("\n")) {
    const brace = line.indexOf("{");
    if (brace <= 0 || line.startsWith("#")) continue;
    const name = line.slice(0, brace);
    if (!names.has(name)) continue;
    const close = line.indexOf("}", brace);
    if (close === -1) continue;
    const labels = line.slice(brace, close + 1);
    if (!labels.includes(BOX_HEALTH_LABEL)) continue;
    const value = Number(line.slice(close + 1).trim().split(" ")[0]);
    if (Number.isFinite(value)) out.push({ name, labels, value });
  }
  return out;
}

/** A whole disk, not a partition or a pseudo-device, so the all-device sum counts each byte once. */
function isWholeDisk(device: string): boolean {
  return !/^(loop|ram|dm-|sr)/.test(device) && !/^nvme\d+n\d+p\d+$/.test(device) && !/^[shv]d[a-z]+\d+$/.test(device);
}

/**
 * FIX-1375 — the /data device's counters, the all-device byte totals and the
 * exporter's clock, or why there are none. Refused, not summed, on an
 * ambiguous mount or device (the FIX-1104 lesson). Pure.
 */
export function parseDiskRaw(body: string): DiskRaw | { missing: string } {
  const counterNames = Object.values(BOX_HEALTH_DISK_COUNTERS) as string[];
  const rows = dbRows(body, new Set(["node_filesystem_size_bytes", "node_cpu_seconds_total", ...counterNames]));

  const mounts = rows.filter((r) => r.name === "node_filesystem_size_bytes" && r.labels.includes(`mountpoint="${BOX_HEALTH_DATA_MOUNT}"`));
  if (mounts.length !== 1) return { missing: `${mounts.length} filesystem series at ${BOX_HEALTH_DATA_MOUNT}` };
  const device = mounts[0]!.labels.match(/device="(?:\/dev\/)?([^"]+)"/)?.[1];
  if (!device) return { missing: `no device label on the ${BOX_HEALTH_DATA_MOUNT} filesystem` };

  const raw: Record<string, number | string> = { disk_device: device };
  for (const [field, name] of Object.entries(BOX_HEALTH_DISK_COUNTERS)) {
    const m = rows.filter((r) => r.name === name && r.labels.includes(`device="${device}"`));
    if (m.length !== 1) return { missing: `${name}: ${m.length} series for device ${device}` };
    raw[field] = m[0]!.value;
  }
  const sumAll = (name: string) =>
    rows
      .filter((r) => r.name === name && isWholeDisk(r.labels.match(/device="([^"]+)"/)?.[1] ?? ""))
      .reduce((s, r) => s + r.value, 0);
  raw["disk_all_read_bytes"] = sumAll(BOX_HEALTH_DISK_COUNTERS.disk_read_bytes);
  raw["disk_all_written_bytes"] = sumAll(BOX_HEALTH_DISK_COUNTERS.disk_written_bytes);

  const cpu = rows.filter((r) => r.name === "node_cpu_seconds_total");
  const cpus = new Set(cpu.map((r) => r.labels.match(/cpu="([^"]+)"/)?.[1] ?? "?"));
  if (cpu.length === 0) return { missing: "no node_cpu_seconds_total series (the exporter clock)" };
  raw["disk_clock_s"] = cpu.reduce((s, r) => s + r.value, 0) / cpus.size;
  return raw as DiskRaw;
}

/** Three missed 2-minute firings, the series' MAX_RATE_GAP_S: past this a rate would average a hole away. */
export const DISK_RATE_MAX_GAP_S = 6 * 60;

/**
 * FIX-1375 — the rates since `prev`, or as many of them as are honest. Pure.
 * Returns {} on the first sample, a device change, the same exporter snapshot
 * twice (Δclock ≤ 0) or a gap over DISK_RATE_MAX_GAP_S; drops any single rate
 * whose counter went backwards. Never null, never negative.
 */
export function diskRates(prev: Partial<BoxHealthSample> | null, cur: Partial<BoxHealthSample>): Partial<DiskRates> {
  if (!prev || cur.disk_device === undefined || prev.disk_device !== cur.disk_device) return {};
  if (typeof prev.disk_clock_s !== "number" || typeof cur.disk_clock_s !== "number") return {};
  const dt = cur.disk_clock_s - prev.disk_clock_s;
  if (!(dt > 0) || dt > DISK_RATE_MAX_GAP_S) return {};

  const delta = (k: keyof DiskRaw): number | null => {
    const a = prev[k];
    const b = cur[k];
    if (typeof a !== "number" || typeof b !== "number" || b < a) return null;
    return b - a;
  };
  const out: Partial<DiskRates> = {};
  const put = (k: keyof DiskRates, d: number | null, scale: number, digits: number) => {
    if (d === null) return;
    const f = 10 ** digits;
    out[k] = Math.round((d / scale / dt) * f) / f;
  };
  put("disk_read_mbps", delta("disk_read_bytes"), 1e6, 2);
  put("disk_write_mbps", delta("disk_written_bytes"), 1e6, 2);
  put("io_queue", delta("disk_io_weighted_s"), 1, 2);
  put("disk_reads_ps", delta("disk_reads"), 1, 1);
  put("disk_writes_ps", delta("disk_writes"), 1, 1);
  put("disk_all_read_mbps", delta("disk_all_read_bytes"), 1e6, 2);
  put("disk_all_write_mbps", delta("disk_all_written_bytes"), 1e6, 2);
  const io = delta("disk_io_time_s");
  if (io !== null) out.io_time_pct = Math.min(100, Math.round((1000 * io) / dt) / 10);
  return out;
}

const MB = 1024 * 1024;

/** The numbers a human reads, derived once so the log, the series and the receipt agree. */
export function sampleSummary(s: BoxHealthSample): {
  mem_avail_mb: number;
  mem_total_mb: number;
  avail_pct: number;
  swap_used_mb: number | null;
  load1: number | null;
} {
  return {
    mem_avail_mb: Math.round(s.mem_available_bytes / MB),
    mem_total_mb: Math.round(s.mem_total_bytes / MB),
    avail_pct: Math.round((1000 * s.mem_available_bytes) / s.mem_total_bytes) / 10,
    swap_used_mb:
      s.swap_total_bytes !== undefined && s.swap_free_bytes !== undefined
        ? Math.round((s.swap_total_bytes - s.swap_free_bytes) / MB)
        : null,
    load1: s.load1 ?? null,
  };
}

// ── The scrape ───────────────────────────────────────────────────────────────

export type ScrapeResult =
  | { ok: true; sample: BoxHealthSample; ambiguous: string[]; disk_missing: string | null; bytes: number }
  | { ok: false; error: string; scrape_ms: number };

export async function scrapeBoxHealth(opts: {
  secret: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): Promise<ScrapeResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const routeAt = new Date(t0).toISOString();
  try {
    const res = await opts.fetchImpl(METRICS_URL, {
      headers: {
        Authorization: "Basic " + Buffer.from(`service_role:${opts.secret}`).toString("base64"),
        Accept: "text/plain",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    } as RequestInit);
    const body = await res.text();
    const ms = now() - t0;
    if (!res.ok) return { ok: false, error: `metrics HTTP ${res.status}: ${body.slice(0, 120)}`, scrape_ms: ms };
    const parsed = parseBoxHealthSample(body, routeAt, ms);
    if (!parsed.ok) return { ok: false, error: parsed.error, scrape_ms: ms };
    return { ok: true, sample: parsed.sample, ambiguous: parsed.ambiguous, disk_missing: parsed.disk_missing, bytes: body.length };
  } catch (err) {
    return { ok: false, error: `metrics fetch: ${err instanceof Error ? err.message : String(err)}`, scrape_ms: now() - t0 };
  }
}

// ── Upstash REST ─────────────────────────────────────────────────────────────

export type UpstashCreds = { url: string; token: string };

export type UpstashReply = { result?: unknown; error?: string };

/**
 * One Upstash REST request: a single command at "" or a list at "/pipeline".
 * Exported for FIX-1285, whose restart state (front-door-restart.ts) is the
 * second Postgres-free store on the same credentials.
 */
export async function upstashRequest(
  creds: UpstashCreds,
  path: "" | "/pipeline",
  body: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: true; reply: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(creds.url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    let reply: unknown = null;
    try {
      reply = await res.json();
    } catch {
      reply = null;
    }
    // Upstash reports quota and auth failures as {"error": …}, sometimes with
    // HTTP 200 (upstash-usage.ts) — so the body is checked either way.
    const vendorError = (reply as UpstashReply | null)?.error;
    if (vendorError) return { ok: false, error: `upstash ${res.status}: ${vendorError}` };
    if (!res.ok) return { ok: false, error: `upstash HTTP ${res.status}` };
    return { ok: true, reply };
  } catch (err) {
    return { ok: false, error: `upstash: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The two commands, in order. Exported so a test pins the order and the trim bound. */
export function offBoxCommands(sample: BoxHealthSample): string[][] {
  return [
    ["LPUSH", BOX_HEALTH_RING_KEY, JSON.stringify(sample)],
    ["LTRIM", BOX_HEALTH_RING_KEY, "0", String(BOX_HEALTH_RING_LEN - 1)],
  ];
}

export type OffBoxResult = { ok: true; ring_len: number } | { ok: false; error: string };

/** Write one sample to the ring, in ONE pipelined request. */
export async function writeBoxHealthOffBox(
  sample: BoxHealthSample,
  creds: UpstashCreds,
  fetchImpl: typeof fetch,
  timeoutMs = 5_000,
): Promise<OffBoxResult> {
  const r = await upstashRequest(creds, "/pipeline", offBoxCommands(sample), fetchImpl, timeoutMs);
  if (!r.ok) return r;
  const replies = Array.isArray(r.reply) ? (r.reply as UpstashReply[]) : null;
  if (replies === null || replies.length !== BOX_HEALTH_COMMANDS_PER_SAMPLE) {
    return {
      ok: false,
      error: `upstash pipeline: expected ${BOX_HEALTH_COMMANDS_PER_SAMPLE} replies, got ${JSON.stringify(r.reply).slice(0, 120)}`,
    };
  }
  const failed = replies.findIndex((x) => x?.error);
  if (failed >= 0) return { ok: false, error: `upstash ${offBoxCommands(sample)[failed]![0]}: ${replies[failed]!.error}` };
  // LPUSH answers the length BEFORE the trim.
  const pushed = Number(replies[0]!.result);
  return { ok: true, ring_len: Number.isFinite(pushed) ? Math.min(pushed, BOX_HEALTH_RING_LEN) : NaN };
}

export type RingRead =
  | { ok: true; samples: BoxHealthSample[]; unparseable: number }
  | { ok: false; error: string };

/** The ring, NEWEST FIRST. One LRANGE — one command. */
export async function readBoxHealthRing(
  creds: UpstashCreds,
  fetchImpl: typeof fetch,
  count = BOX_HEALTH_RING_LEN,
  timeoutMs = 10_000,
): Promise<RingRead> {
  const r = await upstashRequest(creds, "", ["LRANGE", BOX_HEALTH_RING_KEY, "0", String(count - 1)], fetchImpl, timeoutMs);
  if (!r.ok) return r;
  const raw = (r.reply as UpstashReply | null)?.result;
  if (!Array.isArray(raw)) return { ok: false, error: `upstash LRANGE: unexpected ${JSON.stringify(raw).slice(0, 120)}` };
  const samples: BoxHealthSample[] = [];
  let unparseable = 0;
  for (const item of raw) {
    try {
      const s = JSON.parse(String(item)) as BoxHealthSample;
      if (typeof s.route_at === "string" && typeof s.mem_available_bytes === "number") samples.push(s);
      else unparseable += 1;
    } catch {
      unparseable += 1;
    }
  }
  return { ok: true, samples, unparseable };
}

/**
 * FIX-1375 — the ring's head (the previous sample), one LINDEX, or null on any
 * failure: a missing head costs this sample its rates, never the sample.
 */
export async function readBoxHealthHead(
  creds: UpstashCreds,
  fetchImpl: typeof fetch,
  timeoutMs = BOX_HEALTH_HEAD_TIMEOUT_MS,
): Promise<Partial<BoxHealthSample> | null> {
  const r = await upstashRequest(creds, "", ["LINDEX", BOX_HEALTH_RING_KEY, "0"], fetchImpl, timeoutMs);
  if (!r.ok) return null;
  const raw = (r.reply as UpstashReply | null)?.result;
  if (typeof raw !== "string") return null;
  try {
    const s = JSON.parse(raw) as Partial<BoxHealthSample>;
    return s !== null && typeof s === "object" && typeof s.route_at === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Upstash creds from the environment, or null when either half is absent. */
export function upstashCredsFromEnv(env: Record<string, string | undefined>): UpstashCreds | null {
  const url = env["UPSTASH_REDIS_REST_URL"];
  const token = env["UPSTASH_REDIS_REST_TOKEN"];
  return url && token ? { url, token } : null;
}

// ── One firing of /api/cron/box-health ───────────────────────────────────────

export type OnBoxStamp = { at: string | null; error: string | null };

export type BoxHealthRun = {
  /** True when the OFF-box write landed — the deliverable. */
  ok: boolean;
  sample: BoxHealthSample | null;
  off_box: OffBoxResult | { ok: false; error: string };
  on_box: { ok: boolean; at: string | null; error: string | null };
  ambiguous: string[];
  line: string;
  elapsed_ms: number;
};

/**
 * One firing: scrape, write OFF the box FIRST, then ON the box best-effort.
 *
 * The route is a thin wrapper around this, so every branch is testable with a
 * fake fetch and a fake stamp. The order is the design (cc-149 D2). The off-box
 * ring is the deliverable. The on-box stamp is a mirror whose failure is logged
 * and changes nothing else. Never throws.
 */
export async function runBoxHealth(deps: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stampOnBox: (sample: BoxHealthSample) => Promise<OnBoxStamp>;
  now?: () => number;
}): Promise<BoxHealthRun> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const elapsed = () => now() - t0;
  const tag = "[cron/box-health]";

  const secret = deps.env["SUPABASE_SECRET_KEY"];
  if (!secret) {
    const error = "SUPABASE_SECRET_KEY not set";
    return {
      ok: false, sample: null, off_box: { ok: false, error: "not attempted" },
      on_box: { ok: false, at: null, error: "not attempted" }, ambiguous: [],
      line: `${tag} scrape failed: ${error} elapsed_ms=${elapsed()}`, elapsed_ms: elapsed(),
    };
  }

  const scraped = await scrapeBoxHealth({ secret, fetchImpl: deps.fetchImpl, now });
  if (!scraped.ok) {
    return {
      ok: false, sample: null, off_box: { ok: false, error: "not attempted" },
      on_box: { ok: false, at: null, error: "not attempted" }, ambiguous: [],
      line: `${tag} scrape failed: ${scraped.error} scrape_ms=${scraped.scrape_ms} elapsed_ms=${elapsed()}`,
      elapsed_ms: elapsed(),
    };
  }
  const sample = scraped.sample;
  const creds = upstashCredsFromEnv(deps.env);

  // FIX-1375: the disk rates, from the previous sample (the ring's head).
  let diskNote: string;
  if (scraped.disk_missing !== null) diskNote = `missing(${scraped.disk_missing})`;
  else if (!creds) diskNote = "unrated(no ring)";
  else {
    const prev = await readBoxHealthHead(creds, deps.fetchImpl);
    const rates = diskRates(prev, sample);
    Object.assign(sample, rates);
    diskNote =
      rates.io_time_pct === undefined
        ? `unrated(${prev === null ? "no previous sample" : "no comparable previous sample"})`
        : `r${rates.disk_read_mbps ?? "-"}/w${rates.disk_write_mbps ?? "-"}MB/s` +
          ` all=r${rates.disk_all_read_mbps ?? "-"}/w${rates.disk_all_write_mbps ?? "-"}MB/s` +
          ` io=${rates.io_time_pct}% q=${rates.io_queue ?? "-"}`;
  }

  // (a) OFF the box, first.
  const offBox: OffBoxResult = creds
    ? await writeBoxHealthOffBox(sample, creds, deps.fetchImpl)
    : { ok: false, error: "UPSTASH_REDIS_REST_URL/TOKEN not set" };

  // (b) ON the box, second, best-effort.
  let onBox: OnBoxStamp;
  try {
    onBox = await deps.stampOnBox(sample);
  } catch (err) {
    onBox = { at: null, error: err instanceof Error ? err.message : String(err) };
  }
  const onBoxOk = onBox.error === null && onBox.at !== null;

  const s = sampleSummary(sample);
  // rule 167: `at` is the DB's clock when THIS path's stamp landed, else the
  // route's, and the log says which.
  const at = onBoxOk ? `${onBox.at}(db)` : `${sample.route_at}(route)`;
  const line =
    `${tag} mem_avail_mb=${s.mem_avail_mb} mem_total_mb=${s.mem_total_mb} avail_pct=${s.avail_pct}` +
    ` swap_used_mb=${s.swap_used_mb ?? "-"} load1=${s.load1 ?? "-"}` +
    ` disk=${diskNote}` +
    ` off_box=${offBox.ok ? `ok ring=${offBox.ring_len}` : `FAILED(${offBox.error})`}` +
    ` on_box=${onBoxOk ? "ok" : `FAILED(${onBox.error ?? "no at returned"})`}` +
    (scraped.ambiguous.length > 0 ? ` ambiguous=${scraped.ambiguous.join(",")}` : "") +
    ` at=${at} scrape_ms=${sample.scrape_ms} elapsed_ms=${elapsed()}`;

  return {
    ok: offBox.ok,
    sample,
    off_box: offBox,
    on_box: { ok: onBoxOk, at: onBox.at, error: onBox.error },
    ambiguous: scraped.ambiguous,
    line,
    elapsed_ms: elapsed(),
  };
}
