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
 *   LTRIM civitics:box_health:mem 0 719     — a 24 h ring at 2-min cadence
 * These are 2 commands against the 500k/month allotment the rate limiter
 * shares: 720 samples/day × 2 = 1,440/day, about 43k per 30-day month, 8.6 %.
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
 */

import { METRICS_URL, parsePrometheusText, type PromMatch } from "./supabase-prometheus";

export const BOX_HEALTH_RING_KEY = "civitics:box_health:mem";
/** 24 h at the route's 2-minute cadence. */
export const BOX_HEALTH_RING_LEN = 720;
/** Upstash commands each sample costs, stated so the quota share is checkable. */
export const BOX_HEALTH_COMMANDS_PER_SAMPLE = 2;

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

type RequiredField = keyof typeof BOX_HEALTH_REQUIRED;
type OptionalField = keyof typeof BOX_HEALTH_OPTIONAL;

export type BoxHealthSample = {
  /** ISO time the route scraped, by the route's clock. */
  route_at: string;
  /** Wall time of the metrics fetch. */
  scrape_ms: number;
} & Record<RequiredField, number> &
  Partial<Record<OptionalField, number>>;

export type ParsedSample =
  | { ok: true; sample: BoxHealthSample; ambiguous: string[] }
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
  return { ok: true, sample: sample as BoxHealthSample, ambiguous };
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
  | { ok: true; sample: BoxHealthSample; ambiguous: string[]; bytes: number }
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
    return { ok: true, sample: parsed.sample, ambiguous: parsed.ambiguous, bytes: body.length };
  } catch (err) {
    return { ok: false, error: `metrics fetch: ${err instanceof Error ? err.message : String(err)}`, scrape_ms: now() - t0 };
  }
}

// ── Upstash REST ─────────────────────────────────────────────────────────────

export type UpstashCreds = { url: string; token: string };

type UpstashReply = { result?: unknown; error?: string };

async function upstash(
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
  const r = await upstash(creds, "/pipeline", offBoxCommands(sample), fetchImpl, timeoutMs);
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
  const r = await upstash(creds, "", ["LRANGE", BOX_HEALTH_RING_KEY, "0", String(count - 1)], fetchImpl, timeoutMs);
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

  // (a) OFF the box, first.
  const creds = upstashCredsFromEnv(deps.env);
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
