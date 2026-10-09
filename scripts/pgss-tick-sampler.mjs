#!/usr/bin/env node
// pgss-tick-sampler.mjs — FIX-1125 burst census (cc-203)
//
// Brackets a cron minute with two reads of the cumulative statistics views and
// reports the DELTAS between them, beside the same deltas over the quiet
// interval that follows. The off-box memory ring says WHEN the box swaps; this
// says WHICH statement (pg_stat_statements), WHICH backend class
// (pg_stat_io), and whether the checkpointer / archiver moved at the tick.
//
// USAGE
//   node scripts/pgss-tick-sampler.mjs --prod --minutes 5,11,35,41 \
//        --activity-at 7:30,8:30,9:30,37:30,38:30,39:30 --ticks 4 \
//        --out docs/audits/<date>-burst-census-samples.jsonl
//        [--not-before <ISO>] [--db-query <path>] [--dry-run]
//   node scripts/pgss-tick-sampler.mjs --report <jsonl> [--top 25]
//
// --minutes is a list of PAIRS: (open, close) of each tick's bracket, in server
// wall-clock minutes. `58,3` wraps the hour. --ticks N runs the first N brackets
// that open at or after --not-before (default: now). The QUIET interval is the
// close of tick k to the open of tick k+1, so every delta is taken between two
// consecutive samples. --activity-at mm:ss reads pg_stat_activity at each listed
// instant that falls inside a tick.
//
// EVERY READ GOES THROUGH scripts/db-query.mjs (--prod --raw --file): the same
// DSN resolution and the same read-only prelude (SET LOCAL
// max_parallel_workers_per_gather = 0; SET TRANSACTION READ ONLY), not a copy of
// them. A sample is ONE statement in that one transaction, so every view in it
// is read under stats_fetch_consistency's snapshot. --db-query points at another
// checkout's db-query.mjs (a worktree's .env.local.prod is a stub).
//
// OUTPUT. One JSON line per read, {kind, tick, edge, target, at, skew_ms,
// read_ms, wall_ms, rows}; kind is sample | activity | texts. Samples read pgss
// WITHOUT text (in memory only); the first sample carries every entry and each
// later one only the entries that changed (compactPgss — lossless, replayed by
// expandSamples). The texts are one read after the last bracket.
//
// TIMING. The schedule is in the DATABASE SERVER's clock — the pg_cron clock,
// and NTP-synced like Vercel's — not this machine's (cc-203 measured this one
// ~1.6 s ahead). A calibration read measures lead = server statement_timestamp
// − local spawn instant, and each read is spawned at target − lead; lead is
// re-measured on every read. skew_ms = server `at` − target is logged per read.
//
// DELTAS (rule 105). A counter that went DOWN between two samples, or whose
// stats_since / stats_reset moved, was reset inside the interval: it is
// reported as status `reset` with no numbers and never ranked — never as a huge
// positive. A pgss entry absent from the first sample and created after it is
// `new`; its whole counters accrued inside the interval, so it is ranked.
//
// STOPS. A read whose server-side elapsed exceeds 2 s stops the sampler (these
// are statistics views; something is wrong). A failed read (57014 or any other)
// is logged as {kind, error} and skipped — never retried inside the minute.
//
// pgss is attributed by userid::regrole + queryid, never by text alone: text is
// contaminated by PostgREST's pgrst_source wrapper. pg_stat_statements.track is
// `top` on prod, so a procedure's inner statements are invisible (rule 111) and
// a cancelled statement leaves no row (rule 112).

import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAX_READ_MS = 2000;

// ── the reads ───────────────────────────────────────────────────────────────

export const PGSS_COLS = [
  "role", "toplevel", "queryid", "calls", "total_exec_time", "rows",
  "shared_blks_hit", "shared_blks_read", "temp_blks_read", "temp_blks_written",
  "wal_bytes", "stats_since", "query",
];
const PGSS_COUNTERS = ["calls", "total_exec_time", "rows", "shared_blks_hit", "shared_blks_read", "temp_blks_read", "temp_blks_written", "wal_bytes"];
const IO_COUNTERS = ["reads", "read_time", "writes", "write_time", "writebacks", "writeback_time", "extends", "extend_time", "hits", "evictions", "reuses", "fsyncs", "fsync_time"];
const CHECKPOINTER_COUNTERS = ["num_timed", "num_requested", "restartpoints_timed", "restartpoints_req", "restartpoints_done", "write_time", "sync_time", "buffers_written"];
const BGWRITER_COUNTERS = ["buffers_clean", "maxwritten_clean", "buffers_alloc"];
const ARCHIVER_COUNTERS = ["archived_count", "failed_count"];
const DATABASE_COUNTERS = ["temp_files", "temp_bytes", "blks_read", "blks_hit", "xact_commit"];

// One statement; the MATERIALIZED CTE makes read_ms the time the views took.
// showtext := false keeps the sample in shared memory: reading the query-text
// file is a disk read, and on prod (cc-203, 00:17Z 10-09) it took the sample
// from 108 ms to 864 ms — on a box that swaps at the very tick being bracketed.
// The texts are read ONCE, after the last bracket (TEXTS_SQL).
export const SAMPLE_SQL = `WITH x AS MATERIALIZED (
  SELECT json_build_object(
    'pgss_cols', json_build_array(${PGSS_COLS.map((c) => `'${c}'`).join(", ")}),
    'pgss', (SELECT json_agg(json_build_array(s.userid::regrole::text, s.toplevel, s.queryid::text, s.calls,
                     round(s.total_exec_time::numeric, 3), s.rows, s.shared_blks_hit, s.shared_blks_read,
                     s.temp_blks_read, s.temp_blks_written, s.wal_bytes, s.stats_since, NULL::text))
               FROM extensions.pg_stat_statements(false) s
              WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())),
    'io', (SELECT json_agg(to_json(i)) FROM pg_stat_io i),
    'checkpointer', (SELECT to_json(c) FROM pg_stat_checkpointer c),
    'bgwriter', (SELECT to_json(b) FROM pg_stat_bgwriter b),
    'archiver', (SELECT to_json(a) FROM pg_stat_archiver a),
    'database', (SELECT json_build_object('temp_files', d.temp_files, 'temp_bytes', d.temp_bytes,
                     'blks_read', d.blks_read, 'blks_hit', d.blks_hit, 'xact_commit', d.xact_commit,
                     'stats_reset', d.stats_reset)
               FROM pg_stat_database d WHERE d.datname = current_database()),
    'clock', clock_timestamp()
  ) AS j
)
SELECT json_build_object('at', statement_timestamp(),
  'read_ms', round((EXTRACT(epoch FROM clock_timestamp() - statement_timestamp()) * 1000)::numeric, 1),
  'rows', x.j)
  FROM x;
`;

export const ACTIVITY_SQL = `WITH x AS MATERIALIZED (
  SELECT json_agg(json_build_object('pid', a.pid, 'backend_type', a.backend_type,
           'application_name', a.application_name, 'usename', a.usename, 'state', a.state,
           'wait_event_type', a.wait_event_type, 'wait_event', a.wait_event,
           'xact_start', a.xact_start, 'query_start', a.query_start, 'query', left(a.query, 120))
           ORDER BY a.state = 'active' DESC, a.query_start) AS j
    FROM pg_stat_activity a
   WHERE a.pid <> pg_backend_pid()
)
SELECT json_build_object('at', statement_timestamp(),
  'read_ms', round((EXTRACT(epoch FROM clock_timestamp() - statement_timestamp()) * 1000)::numeric, 1),
  'rows', COALESCE(x.j, '[]'::json))
  FROM x;
`;

export const TEXTS_SQL = `WITH x AS MATERIALIZED (
  SELECT json_build_object('texts', json_agg(json_build_array(s.userid::regrole::text, s.toplevel, s.queryid::text, left(s.query, 160)))) AS j
    FROM extensions.pg_stat_statements(true) s
   WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
)
SELECT json_build_object('at', statement_timestamp(),
  'read_ms', round((EXTRACT(epoch FROM clock_timestamp() - statement_timestamp()) * 1000)::numeric, 1),
  'rows', x.j)
  FROM x;
`;

const CALIBRATE_SQL ="SELECT json_build_object('at', statement_timestamp(), 'read_ms', 0, 'rows', null);\n";

// ── the schedule ────────────────────────────────────────────────────────────

/** "7:30" → seconds past the hour. */
export function parseMmSs(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 59) throw new Error(`bad mm:ss ${JSON.stringify(s)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The brackets and activity reads, in server-clock ms, in time order.
 * @returns {{ticks: {tick:number, open:number, close:number}[], events: {kind:'sample'|'activity', edge?:'open'|'close', tick:number, target:number}[]}}
 */
export function buildSchedule({ minutes, activityAt = [], ticks, notBefore }) {
  if (minutes.length === 0 || minutes.length % 2 !== 0) throw new Error("--minutes must be (open, close) PAIRS");
  for (const m of minutes) if (!Number.isInteger(m) || m < 0 || m > 59) throw new Error(`bad minute ${m}`);
  const pairs = [];
  for (let i = 0; i < minutes.length; i += 2) pairs.push([minutes[i], minutes[i + 1]]);
  const HOUR = 3_600_000;
  const out = [];
  for (let h = Math.floor(notBefore / HOUR) * HOUR; out.length < ticks; h += HOUR) {
    for (const [o, c] of pairs) {
      const open = h + o * 60_000;
      const close = open + (((c - o + 60) % 60) || 60) * 60_000;
      if (open >= notBefore && out.length < ticks) out.push({ tick: out.length, open, close });
    }
  }
  const events = [];
  for (const t of out) {
    events.push({ kind: "sample", edge: "open", tick: t.tick, target: t.open });
    events.push({ kind: "sample", edge: "close", tick: t.tick, target: t.close });
    for (const spec of activityAt) {
      const sec = parseMmSs(spec);
      for (const base of [Math.floor(t.open / HOUR) * HOUR, Math.floor(t.open / HOUR) * HOUR + HOUR]) {
        const at = base + sec * 1000;
        if (at > t.open && at < t.close) events.push({ kind: "activity", tick: t.tick, target: at });
      }
    }
  }
  events.sort((a, b) => a.target - b.target);
  return { ticks: out, events };
}

// ── deltas ──────────────────────────────────────────────────────────────────

/**
 * b − a for each counter, or null when any counter went DOWN (a reset inside
 * the interval — rule 105: never report that as a huge positive).
 */
export function counterDelta(a, b, fields) {
  const d = {};
  for (const f of fields) {
    const x = Number(a?.[f] ?? 0);
    const y = Number(b?.[f] ?? 0);
    if (y < x) return null;
    d[f] = Math.round((y - x) * 1000) / 1000;
  }
  return d;
}

const anyPositive = (d, fields) => fields.some((f) => d[f] > 0);

/** pgss rows (array form + cols) → Map key → object. Key = role|toplevel|queryid. */
export function pgssMap(sampleRows) {
  const cols = sampleRows?.pgss_cols ?? PGSS_COLS;
  const m = new Map();
  for (const arr of sampleRows?.pgss ?? []) {
    const o = Object.fromEntries(cols.map((c, i) => [c, arr[i]]));
    m.set(`${o.role}|${o.toplevel}|${o.queryid}`, o);
  }
  return m;
}

/**
 * Per-entry deltas between two samples.
 * status: ok | new (absent in a, created after a.at) | reset (a counter went
 * down, or stats_since moved, or absent in a but older than a.at).
 */
export function pgssDeltas(a, b, texts = new Map()) {
  const ma = pgssMap(a.rows);
  const mb = pgssMap(b.rows);
  const aAt = Date.parse(a.at);
  const out = [];
  for (const [key, y] of mb) {
    const x = ma.get(key);
    const text = y.query ?? x?.query ?? texts.get(key) ?? null;
    const base = { key, role: y.role, toplevel: y.toplevel, queryid: y.queryid, query: text };
    if (!x) {
      const born = Date.parse(y.stats_since);
      if (Number.isFinite(born) && born >= aAt) {
        const d = counterDelta({}, y, PGSS_COUNTERS);
        out.push({ ...base, status: "new", ...d });
      } else out.push({ ...base, status: "reset" });
      continue;
    }
    if (x.stats_since !== y.stats_since) { out.push({ ...base, status: "reset" }); continue; }
    const d = counterDelta(x, y, PGSS_COUNTERS);
    if (d === null) { out.push({ ...base, status: "reset" }); continue; }
    if (anyPositive(d, PGSS_COUNTERS)) out.push({ ...base, status: "ok", ...d });
  }
  return out;
}

/** Ranked by Δtemp_blks_written, then Δshared_blks_read, then Δexec ms. Resets never rank. */
export function rankPgss(deltas, top = 25) {
  return deltas
    .filter((d) => d.status !== "reset")
    .sort((p, q) => (q.temp_blks_written - p.temp_blks_written)
      || (q.shared_blks_read - p.shared_blks_read)
      || (q.total_exec_time - p.total_exec_time))
    .slice(0, top);
}

/** Σ per role (attribution by userid::regrole). */
export function roleTotals(deltas) {
  const m = new Map();
  for (const d of deltas) {
    if (d.status === "reset") continue;
    const t = m.get(d.role) ?? { role: d.role, entries: 0, calls: 0, total_exec_time: 0, shared_blks_read: 0, temp_blks_written: 0, wal_bytes: 0 };
    t.entries++;
    for (const f of ["calls", "total_exec_time", "shared_blks_read", "temp_blks_written", "wal_bytes"]) t[f] += d[f];
    m.set(d.role, t);
  }
  return [...m.values()].map((t) => ({ ...t, total_exec_time: Math.round(t.total_exec_time) })).sort((p, q) => q.total_exec_time - p.total_exec_time);
}

/** pg_stat_io per (backend_type, object, context); a moved stats_reset or a fall is `reset`. */
export function ioDeltas(a, b) {
  const key = (r) => `${r.backend_type}|${r.object}|${r.context}`;
  const ma = new Map((a.rows?.io ?? []).map((r) => [key(r), r]));
  const out = [];
  for (const y of b.rows?.io ?? []) {
    const x = ma.get(key(y));
    const base = { backend_type: y.backend_type, object: y.object, context: y.context };
    if (!x || x.stats_reset !== y.stats_reset) { out.push({ ...base, status: "reset" }); continue; }
    const d = counterDelta(x, y, IO_COUNTERS);
    if (d === null) { out.push({ ...base, status: "reset" }); continue; }
    if (anyPositive(d, IO_COUNTERS)) out.push({ ...base, status: "ok", ...d });
  }
  return out.sort((p, q) => ((q.reads ?? 0) + (q.writes ?? 0) + (q.extends ?? 0)) - ((p.reads ?? 0) + (p.writes ?? 0) + (p.extends ?? 0)));
}

/** A single-row view's deltas; `reset` when stats_reset moved or a counter fell. */
export function scalarDelta(a, b, fields) {
  if (!a || !b) return { status: "missing" };
  if ((a.stats_reset ?? null) !== (b.stats_reset ?? null)) return { status: "reset" };
  const d = counterDelta(a, b, fields);
  return d === null ? { status: "reset" } : { status: "ok", ...d };
}

/** Every delta between two samples. */
export function intervalDeltas(a, b, texts) {
  const pgss = pgssDeltas(a, b, texts);
  return {
    from: a.at, to: b.at,
    minutes: Math.round(((Date.parse(b.at) - Date.parse(a.at)) / 60_000) * 100) / 100,
    pgss,
    pgss_resets: pgss.filter((d) => d.status === "reset").length,
    roles: roleTotals(pgss),
    io: ioDeltas(a, b),
    checkpointer: scalarDelta(a.rows?.checkpointer, b.rows?.checkpointer, CHECKPOINTER_COUNTERS),
    bgwriter: scalarDelta(a.rows?.bgwriter, b.rows?.bgwriter, BGWRITER_COUNTERS),
    archiver: scalarDelta(a.rows?.archiver, b.rows?.archiver, ARCHIVER_COUNTERS),
    database: scalarDelta(a.rows?.database, b.rows?.database, DATABASE_COUNTERS),
  };
}

/**
 * The JSONL lines → per tick {tick, quiet, activity}. A tick's delta is its own
 * open → close; its quiet is close → the next tick's open (absent for the last).
 */
export function buildReport(rawLines) {
  const lines = expandSamples(rawLines);
  const texts = new Map();
  for (const l of lines) {
    if (l.kind === "texts") for (const [role, top, qid, q] of l.rows?.texts ?? []) texts.set(`${role}|${top}|${qid}`, q);
  }
  const samples = lines.filter((l) => l.kind === "sample" && l.rows && !l.error);
  const find = (tick, edge) => samples.find((s) => s.tick === tick && s.edge === edge);
  const tickIds = [...new Set(lines.filter((l) => l.kind === "sample").map((l) => l.tick))].sort((p, q) => p - q);
  const out = [];
  for (const t of tickIds) {
    const open = find(t, "open");
    const close = find(t, "close");
    const nextOpen = find(t + 1, "open");
    out.push({
      tick: t,
      open_at: open?.at ?? null,
      close_at: close?.at ?? null,
      tick_delta: open && close ? intervalDeltas(open, close, texts) : null,
      quiet_delta: close && nextOpen ? intervalDeltas(close, nextOpen, texts) : null,
      activity: lines.filter((l) => l.kind === "activity" && l.tick === t),
      errors: lines.filter((l) => l.tick === t && l.error),
    });
  }
  return { reads: lines.filter((l) => ["sample", "activity", "texts"].includes(l.kind)).map((l) => ({ kind: l.kind, edge: l.edge ?? null, tick: l.tick ?? null, target: l.target ?? null, at: l.at ?? null, skew_ms: l.skew_ms ?? null, read_ms: l.read_ms ?? null, error: l.error ?? null })), ticks: out };
}

// ── rendering ───────────────────────────────────────────────────────────────

const fmt = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 1 })) : String(v));
const cell = (s) => String(s ?? "—").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const hhmmss = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) + "Z" : "—");

export function renderReport(report, { top = 25 } = {}) {
  const L = [];
  L.push("### Reads", "", "| kind | tick | edge | target | at (server) | skew ms | read ms | error |", "|---|---|---|---|---|---|---|---|");
  for (const r of report.reads) L.push(`| ${r.kind} | ${r.tick ?? ""} | ${r.edge ?? ""} | ${r.target ? hhmmss(r.target) : "—"} | ${r.at ?? "—"} | ${fmt(r.skew_ms)} | ${fmt(r.read_ms)} | ${cell(r.error ?? "")} |`);
  for (const t of report.ticks) {
    L.push("", `### Tick ${t.tick} — ${hhmmss(t.open_at)} → ${hhmmss(t.close_at)}`);
    if (!t.tick_delta) { L.push("", "_no tick delta (a bracket read is missing)_"); continue; }
    const td = t.tick_delta;
    const qd = t.quiet_delta;
    const qMap = new Map((qd?.pgss ?? []).map((d) => [d.key, d]));
    L.push("", `Tick interval ${td.minutes} min; quiet interval ${qd ? `${hhmmss(qd.from)} → ${hhmmss(qd.to)}, ${qd.minutes} min` : "— (last tick)"}. pgss entries reset inside the tick: ${td.pgss_resets}.`);
    L.push("", `**pgss top ${top}** (ranked by Δtemp_blks_written, then Δshared_blks_read; blocks are 8 kB; ms = total_exec_time) — tick vs the quiet interval after it`, "",
      "| # | role | queryid | status | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written | query |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    rankPgss(td.pgss, top).forEach((d, i) => {
      const q = qMap.get(d.key);
      L.push(`| ${i + 1} | ${d.role} | ${d.queryid} | ${d.status} | ${fmt(d.calls)} | ${fmt(d.total_exec_time)} | ${fmt(d.shared_blks_read)} | ${fmt(d.temp_blks_written)} | ${fmt(d.wal_bytes)} | ${fmt(q?.calls ?? 0)} | ${fmt(q?.total_exec_time ?? 0)} | ${fmt(q?.shared_blks_read ?? 0)} | ${fmt(q?.temp_blks_written ?? 0)} | \`${cell(d.query).slice(0, 110)}\` |`);
    });
    L.push("", "**Per role** (Σ over pgss entries; tick | quiet)", "", "| role | Δcalls | Δexec ms | Δshared_read | Δtemp_written | Δwal bytes | quiet Δcalls | quiet Δexec ms | quiet Δshared_read | quiet Δtemp_written |", "|---|---|---|---|---|---|---|---|---|---|");
    const qRoles = new Map((qd?.roles ?? []).map((r) => [r.role, r]));
    for (const r of td.roles) {
      const q = qRoles.get(r.role);
      L.push(`| ${r.role} | ${fmt(r.calls)} | ${fmt(r.total_exec_time)} | ${fmt(r.shared_blks_read)} | ${fmt(r.temp_blks_written)} | ${fmt(r.wal_bytes)} | ${fmt(q?.calls)} | ${fmt(q?.total_exec_time)} | ${fmt(q?.shared_blks_read)} | ${fmt(q?.temp_blks_written)} |`);
    }
    L.push("", "**pg_stat_io** (per backend_type / object / context; reads/writes/extends in op_bytes units = 8 kB blocks)", "", "| backend_type | object | context | reads | writes | extends | hits | evictions | reuses | writebacks | fsyncs | quiet reads | quiet writes | quiet evictions |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    const qIo = new Map((qd?.io ?? []).map((r) => [`${r.backend_type}|${r.object}|${r.context}`, r]));
    for (const r of td.io) {
      if (r.status === "reset") { L.push(`| ${r.backend_type} | ${r.object} | ${r.context} | reset | | | | | | | | | | |`); continue; }
      const q = qIo.get(`${r.backend_type}|${r.object}|${r.context}`);
      L.push(`| ${r.backend_type} | ${r.object} | ${r.context} | ${fmt(r.reads)} | ${fmt(r.writes)} | ${fmt(r.extends)} | ${fmt(r.hits)} | ${fmt(r.evictions)} | ${fmt(r.reuses)} | ${fmt(r.writebacks)} | ${fmt(r.fsyncs)} | ${fmt(q?.reads)} | ${fmt(q?.writes)} | ${fmt(q?.evictions)} |`);
    }
    L.push("", "**checkpointer / bgwriter / archiver / database** (tick → quiet)", "");
    for (const name of ["checkpointer", "bgwriter", "archiver", "database"]) {
      const show = (o) => (o.status !== "ok" ? o.status : Object.entries(o).filter(([k]) => k !== "status").map(([k, v]) => `${k} ${fmt(v)}`).join(", "));
      L.push(`- ${name}: tick { ${show(td[name])} } — quiet { ${qd ? show(qd[name]) : "—"} }`);
    }
    for (const a of t.activity) {
      const rows = Array.isArray(a.rows) ? a.rows : [];
      L.push("", `**pg_stat_activity at ${a.at ?? hhmmss(a.target)}** (${rows.length} rows${rows.length > 20 ? ", first 20" : ""}; active first)${a.error ? ` — ERROR ${cell(a.error)}` : ""}`, "",
        "| pid | backend_type | application_name | usename | state | wait | xact_start | query_start | query |", "|---|---|---|---|---|---|---|---|---|");
      for (const r of rows.slice(0, 20)) {
        L.push(`| ${r.pid} | ${cell(r.backend_type)} | ${cell(r.application_name)} | ${cell(r.usename)} | ${cell(r.state)} | ${cell([r.wait_event_type, r.wait_event].filter(Boolean).join(":"))} | ${hhmmss(r.xact_start)} | ${hhmmss(r.query_start)} | \`${cell(r.query).slice(0, 100)}\` |`);
      }
    }
  }
  return L.join("\n") + "\n";
}

export function readJsonl(file) {
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const pgssKey = (arr) => `${arr[0]}|${arr[1]}|${arr[2]}`;

/**
 * Lossless compaction for the JSONL. The first sample carries every pgss entry
 * (`pgss_mode: "full"`); each later one carries only the entries whose array
 * changed since the previous sample, plus `pgss_gone` (keys that vanished —
 * deallocated). `prev` is the previous FULL list; returns the compacted rows
 * and the new full list. expandSamples() replays them.
 */
export function compactPgss(rows, prev) {
  if (!rows?.pgss) return { rows, full: prev };
  const full = rows.pgss;
  if (prev === null) return { rows: { ...rows, pgss_mode: "full" }, full };
  const before = new Map(prev.map((a) => [pgssKey(a), JSON.stringify(a)]));
  const now = new Set(full.map(pgssKey));
  return {
    rows: {
      ...rows,
      pgss_mode: "changed",
      pgss: full.filter((a) => before.get(pgssKey(a)) !== JSON.stringify(a)),
      pgss_gone: [...before.keys()].filter((k) => !now.has(k)),
    },
    full,
  };
}

/** Replays compacted samples into full ones, in file order. */
export function expandSamples(lines) {
  let state = null;
  return lines.map((l) => {
    if (l.kind !== "sample" || !l.rows?.pgss) return l;
    if (l.rows.pgss_mode !== "changed") {
      state = new Map(l.rows.pgss.map((a) => [pgssKey(a), a]));
    } else {
      if (state === null) throw new Error(`sample at ${l.at} is a change-set with no full sample before it`);
      for (const k of l.rows.pgss_gone ?? []) state.delete(k);
      for (const a of l.rows.pgss) state.set(pgssKey(a), a);
    }
    return { ...l, rows: { ...l.rows, pgss_mode: "full", pgss: [...state.values()], pgss_gone: undefined } };
  });
}

// ── the run ─────────────────────────────────────────────────────────────────

function runRead(dbQuery, sqlFile, target) {
  const spawned = Date.now();
  const res = spawnSync(process.execPath, [dbQuery, target, "--raw", "--file", sqlFile], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const wall_ms = Date.now() - spawned;
  const line = (res.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("{"));
  if (res.status !== 0 || !line) {
    const err = (res.stderr ?? "").split(/\r?\n/).filter((l) => l && !l.startsWith("[db-query] PROD") && !l.startsWith("[db-query] LOCAL")).slice(-3).join(" / ");
    return { spawned, wall_ms, error: err || `exit ${res.status}` };
  }
  const j = JSON.parse(line);
  return { spawned, wall_ms, at: j.at, read_ms: Number(j.read_ms), rows: j.rows };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
async function sleepUntilLocal(t) {
  for (;;) {
    const left = t - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(left, 30_000));
  }
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const reportFile = argValue(args, "--report");
  if (reportFile) {
    const top = Number(argValue(args, "--top") ?? 25);
    process.stdout.write(renderReport(buildReport(readJsonl(reportFile)), { top }));
    return;
  }
  const target = args.includes("--prod") ? "--prod" : args.includes("--local") ? "--local" : null;
  const minutes = String(argValue(args, "--minutes") ?? "").split(",").filter(Boolean).map(Number);
  const activityAt = String(argValue(args, "--activity-at") ?? "").split(",").filter(Boolean);
  const ticks = Number(argValue(args, "--ticks") ?? 4);
  const out = argValue(args, "--out");
  const dbQuery = argValue(args, "--db-query") ?? join(HERE, "db-query.mjs");
  const nb = argValue(args, "--not-before");
  if (!target || minutes.length === 0 || !out || !Number.isInteger(ticks) || ticks < 1) {
    console.error("usage: node scripts/pgss-tick-sampler.mjs --prod|--local --minutes o,c[,o,c…] [--activity-at mm:ss,…] --ticks N --out <jsonl> [--not-before ISO] [--db-query path] [--dry-run]\n       node scripts/pgss-tick-sampler.mjs --report <jsonl> [--top 25]");
    process.exit(2);
  }
  if (!existsSync(dbQuery)) { console.error(`[sampler] no db-query at ${dbQuery}`); process.exit(2); }

  const dir = mkdtempSync(join(tmpdir(), "pgss-tick-"));
  const files = { sample: join(dir, "sample.sql"), activity: join(dir, "activity.sql"), texts: join(dir, "texts.sql"), calibrate: join(dir, "calibrate.sql") };
  writeFileSync(files.sample, SAMPLE_SQL);
  writeFileSync(files.activity, ACTIVITY_SQL);
  writeFileSync(files.texts, TEXTS_SQL);
  writeFileSync(files.calibrate, CALIBRATE_SQL);

  // lead = server statement_timestamp − local spawn instant (clock offset + launch + connect).
  const cal = runRead(dbQuery, files.calibrate, target);
  if (cal.error) { console.error(`[sampler] calibration read failed: ${cal.error}`); process.exit(1); }
  let lead = Date.parse(cal.at) - cal.spawned;
  const serverNow = Date.now() + lead;
  const notBefore = nb ? Date.parse(nb) : serverNow;
  const { ticks: plan, events } = buildSchedule({ minutes, activityAt, ticks, notBefore: Math.max(notBefore, serverNow + 5_000) });
  console.error(`[sampler] lead ${lead} ms (server − local spawn); ${plan.length} tick(s), ${events.length} read(s):`);
  for (const e of events) console.error(`[sampler]   ${new Date(e.target).toISOString()}  ${e.kind}${e.edge ? `:${e.edge}` : ""}  tick ${e.tick}`);
  if (args.includes("--dry-run")) return;

  let full = null;
  for (const e of events) {
    await sleepUntilLocal(e.target - lead);
    const r = runRead(dbQuery, e.kind === "sample" ? files.sample : files.activity, target);
    const base = { kind: e.kind, ...(e.edge ? { edge: e.edge } : {}), tick: e.tick, target: new Date(e.target).toISOString() };
    if (r.error) {
      appendFileSync(out, JSON.stringify({ ...base, error: r.error, wall_ms: r.wall_ms }) + "\n");
      console.error(`[sampler] ${base.target} ${e.kind} FAILED — logged, skipped, not retried: ${r.error}`);
      continue;
    }
    const measured = Date.parse(r.at) - r.spawned;
    const skew_ms = Date.parse(r.at) - e.target;
    lead = measured;
    let rows = r.rows;
    if (e.kind === "sample") ({ rows, full } = compactPgss(r.rows, full));
    appendFileSync(out, JSON.stringify({ ...base, at: r.at, skew_ms, read_ms: r.read_ms, wall_ms: r.wall_ms, rows }) + "\n");
    console.error(`[sampler] ${base.target} ${e.kind}${e.edge ? `:${e.edge}` : ""} at ${r.at} skew ${skew_ms} ms read ${r.read_ms} ms wall ${r.wall_ms} ms`);
    if (r.read_ms > MAX_READ_MS) {
      console.error(`[sampler] STOP — read took ${r.read_ms} ms > ${MAX_READ_MS} ms on statistics views; something is wrong.`);
      process.exit(3);
    }
  }
  // The texts, once, after the last bracket (the only read that touches the
  // query-text file). An entry deallocated mid-run has no text; its queryid stands.
  const t = runRead(dbQuery, files.texts, target);
  appendFileSync(out, JSON.stringify(t.error ? { kind: "texts", error: t.error } : { kind: "texts", at: t.at, read_ms: t.read_ms, wall_ms: t.wall_ms, rows: t.rows }) + "\n");
  console.error(`[sampler] texts ${t.error ? `FAILED: ${t.error}` : `at ${t.at} read ${t.read_ms} ms`}`);
  console.error(`[sampler] done — ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`[sampler] ${err instanceof Error ? err.stack : String(err)}`); process.exit(1); });
}
