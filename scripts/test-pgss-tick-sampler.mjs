#!/usr/bin/env node
// test-pgss-tick-sampler.mjs — FIX-1125 burst census (cc-203)
//
// Fixture suite for scripts/pgss-tick-sampler.mjs: the delta arithmetic, the
// ranking, the tick-vs-quiet split, the schedule, and the wrong-but-green shape
// (rule 105) — a counter RESET between two samples must read `reset`, never a
// huge positive. Dependency-free, no database, same shape as the other
// scripts/test-*.mjs suites.

import {
  buildReport, buildSchedule, compactPgss, counterDelta, expandSamples, ioDeltas, parseMmSs,
  pgssDeltas, rankPgss, renderReport, roleTotals, scalarDelta, PGSS_COLS,
} from "./pgss-tick-sampler.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

// role, toplevel, queryid, calls, total_exec_time, rows, shared_blks_hit,
// shared_blks_read, temp_blks_read, temp_blks_written, wal_bytes, stats_since, query
const SINCE = "2026-09-22T22:32:13+00:00";
const row = (role, qid, calls, ms, read, tempW, { hit = 0, wal = 0, since = SINCE, q = `q${qid}` } = {}) =>
  [role, true, qid, calls, ms, calls, hit, read, 0, tempW, wal, since, q];
const io = (bt, obj, ctx, reads, writes, evictions, reset = "2026-09-15T15:09:48+00:00") =>
  ({ backend_type: bt, object: obj, context: ctx, reads, read_time: 0, writes, write_time: 0, writebacks: 0, writeback_time: 0, extends: 0, extend_time: 0, hits: 0, evictions, reuses: 0, fsyncs: 0, fsync_time: 0, stats_reset: reset });
const ckpt = (timed, req, reset = "2026-09-15T15:09:48+00:00") =>
  ({ num_timed: timed, num_requested: req, restartpoints_timed: 0, restartpoints_req: 0, restartpoints_done: 0, write_time: 0, sync_time: 0, buffers_written: 0, stats_reset: reset });
const sample = (at, tick, edge, pgss, ioRows, c) => ({
  kind: "sample", tick, edge, target: at, at,
  rows: { pgss_cols: PGSS_COLS, pgss, io: ioRows, checkpointer: c, bgwriter: { buffers_clean: 0, maxwritten_clean: 0, buffers_alloc: 0, stats_reset: null }, archiver: { archived_count: 10, failed_count: 0, stats_reset: null }, database: { temp_files: 0, temp_bytes: 0, blks_read: 0, blks_hit: 0, xact_commit: 0, stats_reset: null } },
});

console.log("pgss-tick-sampler — counter deltas (rule 105)");
{
  const d = counterDelta({ a: 10, b: 2.5 }, { a: 15, b: 4 }, ["a", "b"]);
  check("b − a per counter", d && d.a === 5 && d.b === 1.5, JSON.stringify(d));
}
{
  // The wrong-but-green shape: pg_stat_statements_reset() between samples,
  // then the counter climbs again — 1,000,000 → 40. A naive b − a reports a
  // fall; a naive |b − a| or an unsigned subtraction reports a huge positive.
  const d = counterDelta({ calls: 1_000_000, ms: 5_000_000 }, { calls: 40, ms: 120 }, ["calls", "ms"]);
  check("a counter that went DOWN is a reset (null), never a delta", d === null, JSON.stringify(d));
}

console.log("pgss-tick-sampler — pgss deltas, status and ranking");
{
  const a = sample("2026-10-09T01:05:00Z", 0, "open", [
    row("service_role", "1", 100, 1000, 50, 0),
    row("postgres", "2", 10, 500, 10, 5),
    row("authenticator", "3", 7, 70, 0, 0),
    row("postgres", "4", 1_000_000, 9_000_000, 900, 900),
  ], [], ckpt(1, 0));
  const b = sample("2026-10-09T01:11:00Z", 0, "close", [
    row("service_role", "1", 104, 9000, 30_050, 12_000),        // the tick's statement
    row("postgres", "2", 12, 700, 10, 5),                         // background
    row("authenticator", "3", 7, 70, 0, 0),                       // unchanged
    row("postgres", "4", 40, 120, 1, 1),                          // RESET between samples
    row("postgres", "5", 3, 30, 400, 0, { since: "2026-10-09T01:07:30Z" }), // new inside
    row("postgres", "6", 2, 20, 900, 0, { since: "2026-10-01T00:00:00Z" }), // absent in a, OLD → evicted/reset
  ], [], ckpt(2, 1));
  const ds = pgssDeltas(a, b);
  const by = Object.fromEntries(ds.map((d) => [d.queryid, d]));
  check("delta arithmetic on a live entry", by["1"]?.status === "ok" && by["1"].calls === 4 && by["1"].total_exec_time === 8000 && by["1"].shared_blks_read === 30_000 && by["1"].temp_blks_written === 12_000, JSON.stringify(by["1"]));
  check("an unchanged entry is omitted", !("3" in by));
  check("a counter fall reads `reset` with no numbers", by["4"]?.status === "reset" && by["4"].calls === undefined, JSON.stringify(by["4"]));
  check("an entry created inside the interval is `new`, whole counters", by["5"]?.status === "new" && by["5"].shared_blks_read === 400, JSON.stringify(by["5"]));
  check("an entry absent before but older than the first sample is `reset`", by["6"]?.status === "reset", JSON.stringify(by["6"]));
  const ranked = rankPgss(ds, 25);
  check("ranked by Δtemp_blks_written first", ranked[0]?.queryid === "1", JSON.stringify(ranked.map((d) => d.queryid)));
  check("then by Δshared_blks_read (new 400 beats live 0 temp / 0 read)", ranked[1]?.queryid === "5" && ranked[2]?.queryid === "2",JSON.stringify(ranked.map((d) => [d.queryid, d.temp_blks_written, d.shared_blks_read])));
  check("a reset NEVER ranks", !ranked.some((d) => d.status === "reset"), JSON.stringify(ranked.map((d) => d.queryid)));
  check("top-N truncates", rankPgss(ds, 1).length === 1);
  const roles = roleTotals(ds);
  check("per-role totals exclude resets (postgres = q2 + q5 only)", roles.find((r) => r.role === "postgres")?.calls === 5, JSON.stringify(roles));
}
{
  const a = sample("2026-10-09T01:05:00Z", 0, "open", [row("postgres", "9", 5, 50, 5, 0)], [], ckpt(1, 0));
  const b = sample("2026-10-09T01:11:00Z", 0, "close", [row("postgres", "9", 9, 90, 9, 0, { since: "2026-10-09T01:08:00Z" })], [], ckpt(1, 0));
  const d = pgssDeltas(a, b)[0];
  check("a moved stats_since is a reset even when counters rose", d?.status === "reset", JSON.stringify(d));
}

console.log("pgss-tick-sampler — pg_stat_io and single-row views");
{
  const a = { rows: { io: [io("client backend", "relation", "normal", 100, 5, 10), io("checkpointer", "relation", "normal", 0, 50, 0)] } };
  const b = { rows: { io: [io("client backend", "relation", "normal", 4100, 5, 2010), io("checkpointer", "relation", "normal", 0, 30, 0)] } };
  const d = ioDeltas(a, b);
  const cb = d.find((r) => r.backend_type === "client backend");
  const ck = d.find((r) => r.backend_type === "checkpointer");
  check("io delta per (backend_type, object, context)", cb?.status === "ok" && cb.reads === 4000 && cb.evictions === 2000, JSON.stringify(cb));
  check("an io counter that fell is `reset`", ck?.status === "reset", JSON.stringify(ck));
  const moved = ioDeltas(a, { rows: { io: [io("client backend", "relation", "normal", 9e9, 5, 10, "2026-10-09T01:06:00Z")] } });
  check("a moved io stats_reset is `reset`, not 9e9 reads", moved[0]?.status === "reset", JSON.stringify(moved[0]));
  const c = scalarDelta(ckpt(10, 3), ckpt(11, 4), ["num_timed", "num_requested"]);
  check("checkpointer num_requested increment is visible", c.status === "ok" && c.num_requested === 1 && c.num_timed === 1, JSON.stringify(c));
  check("checkpointer stats_reset moved → reset", scalarDelta(ckpt(10, 3), ckpt(0, 0, "2026-10-09T01:06:00Z"), ["num_timed"]).status === "reset");
  check("checkpointer counter fell, same epoch → reset", scalarDelta(ckpt(10, 3), ckpt(2, 0), ["num_timed", "num_requested"]).status === "reset");
}

console.log("pgss-tick-sampler — tick vs quiet split");
{
  const lines = [
    sample("2026-10-09T01:05:00Z", 0, "open", [row("service_role", "1", 0, 0, 0, 0), row("postgres", "2", 0, 0, 0, 0)], [], ckpt(0, 0)),
    { kind: "activity", tick: 0, target: "2026-10-09T01:07:30Z", at: "2026-10-09T01:07:30Z", rows: [{ pid: 1, backend_type: "client backend", state: "active", query: "select 1" }] },
    sample("2026-10-09T01:11:00Z", 0, "close", [row("service_role", "1", 1, 100, 1000, 500), row("postgres", "2", 0, 0, 0, 0)], [], ckpt(0, 1)),
    sample("2026-10-09T01:35:00Z", 1, "open", [row("service_role", "1", 1, 100, 1000, 500), row("postgres", "2", 50, 5000, 20, 0)], [], ckpt(5, 1)),
    sample("2026-10-09T01:41:00Z", 1, "close", [row("service_role", "1", 2, 200, 2000, 1000), row("postgres", "2", 50, 5000, 20, 0)], [], ckpt(6, 2)),
  ];
  const r = buildReport(lines);
  check("two ticks", r.ticks.length === 2);
  const t0 = r.ticks[0];
  check("tick 0 = open → close (01:05 → 01:11)", t0.tick_delta?.from === "2026-10-09T01:05:00Z" && t0.tick_delta.to === "2026-10-09T01:11:00Z");
  check("tick 0's quiet = close → next open (01:11 → 01:35, 24 min)", t0.quiet_delta?.from === "2026-10-09T01:11:00Z" && t0.quiet_delta.to === "2026-10-09T01:35:00Z" && t0.quiet_delta.minutes === 24);
  const tq = t0.tick_delta.pgss.find((d) => d.queryid === "1");
  const qq = t0.quiet_delta.pgss.find((d) => d.queryid === "2");
  check("the tick's statement is in the TICK delta", tq?.temp_blks_written === 500, JSON.stringify(tq));
  check("the quiet's statement is in the QUIET delta, not the tick", qq?.calls === 50 && !t0.tick_delta.pgss.some((d) => d.queryid === "2"), JSON.stringify(qq));
  check("a requested checkpoint per tick shows in each tick delta", t0.tick_delta.checkpointer.num_requested === 1 && r.ticks[1].tick_delta.checkpointer.num_requested === 1);
  check("the last tick has no quiet", r.ticks[1].quiet_delta === null);
  check("activity is attached to its tick", t0.activity.length === 1 && r.ticks[1].activity.length === 0);
  const md = renderReport(r);
  check("the report renders a top table per tick", (md.match(/\*\*pgss top 25\*\*/g) ?? []).length === 2);
}
{
  // A tick whose close read failed (57014) has no tick delta and no quiet before it.
  const lines = [
    sample("2026-10-09T01:05:00Z", 0, "open", [row("postgres", "2", 0, 0, 0, 0)], [], ckpt(0, 0)),
    { kind: "sample", tick: 0, edge: "close", target: "2026-10-09T01:11:00Z", error: "canceling statement due to statement timeout" },
  ];
  const r = buildReport(lines);
  check("a failed bracket read leaves the tick without a delta, not a wrong one", r.ticks[0].tick_delta === null && r.ticks[0].errors.length === 1);
}

console.log("pgss-tick-sampler — change-only storage is lossless");
{
  const p1 = [row("postgres", "2", 1, 1, 1, 0, { q: null }), row("postgres", "7", 5, 5, 5, 0, { q: null }), row("anon", "8", 9, 9, 9, 0, { q: null })];
  const p2 = [row("postgres", "2", 3, 3, 3, 0, { q: null }), row("anon", "8", 9, 9, 9, 0, { q: null }), row("postgres", "9", 1, 1, 1, 0, { q: null, since: "2026-10-09T01:08:00Z" })];
  const c1 = compactPgss({ pgss_cols: PGSS_COLS, pgss: p1 }, null);
  const c2 = compactPgss({ pgss_cols: PGSS_COLS, pgss: p2 }, c1.full);
  check("the first sample is full", c1.rows.pgss_mode === "full" && c1.rows.pgss.length === 3);
  check("a later sample carries only changed + new entries", c2.rows.pgss_mode === "changed" && c2.rows.pgss.map((a) => a[2]).sort().join(",") === "2,9", JSON.stringify(c2.rows.pgss.map((a) => a[2])));
  check("…and the keys that vanished", JSON.stringify(c2.rows.pgss_gone) === JSON.stringify(["postgres|true|7"]), JSON.stringify(c2.rows.pgss_gone));
  const lines = [
    { kind: "sample", tick: 0, edge: "open", at: "2026-10-09T01:05:00Z", rows: c1.rows },
    { kind: "sample", tick: 0, edge: "close", at: "2026-10-09T01:11:00Z", rows: c2.rows },
    { kind: "texts", at: "2026-10-09T01:12:00Z", rows: { texts: [["postgres", true, "2", "select a"], ["postgres", true, "9", "select b"]] } },
  ];
  const ex = expandSamples(lines);
  check("replay restores the full second sample (unchanged anon entry included, gone entry dropped)",
    ex[1].rows.pgss.map((a) => a[2]).sort().join(",") === "2,8,9", JSON.stringify(ex[1].rows.pgss.map((a) => a[2])));
  const r = buildReport(lines);
  const d2 = r.ticks[0].tick_delta.pgss.find((d) => d.queryid === "2");
  check("deltas over the replay match deltas over full samples", d2?.calls === 2 && !r.ticks[0].tick_delta.pgss.some((d) => d.queryid === "8"), JSON.stringify(r.ticks[0].tick_delta.pgss));
  check("texts come from the one texts read", d2?.query === "select a" && r.ticks[0].tick_delta.pgss.find((d) => d.queryid === "9")?.query === "select b");
  let threw = null;
  try { expandSamples([lines[1]]); } catch (e) { threw = e; }
  check("a change-set with no full sample before it is refused, not guessed", threw instanceof Error);
}

console.log("pgss-tick-sampler — schedule");
{
  check("mm:ss parses", parseMmSs("7:30") === 450 && parseMmSs("38:30") === 2310);
  const nb = Date.parse("2026-10-09T00:20:00Z");
  const s = buildSchedule({ minutes: [5, 11, 35, 41], activityAt: ["7:30", "8:30", "9:30", "37:30", "38:30", "39:30"], ticks: 4, notBefore: nb });
  const iso = (t) => new Date(t).toISOString().slice(11, 16);
  check("ticks open at or after not-before: 00:35, 01:05, 01:35, 02:05", s.ticks.map((t) => iso(t.open)).join(",") === "00:35,01:05,01:35,02:05", s.ticks.map((t) => iso(t.open)).join(","));
  check("brackets close 6 min later", s.ticks.every((t) => t.close - t.open === 6 * 60_000));
  check("8 samples + 12 activity reads", s.events.filter((e) => e.kind === "sample").length === 8 && s.events.filter((e) => e.kind === "activity").length === 12);
  check("activity reads land only inside their own tick", s.events.filter((e) => e.kind === "activity").every((e) => { const t = s.ticks[e.tick]; return e.target > t.open && e.target < t.close; }));
  check("events are in time order", s.events.every((e, i, a) => i === 0 || a[i - 1].target <= e.target));
  const w = buildSchedule({ minutes: [58, 3, 28, 33], activityAt: ["0:30", "1:30", "30:30", "31:30"], ticks: 2, notBefore: Date.parse("2026-10-09T00:50:00Z") });
  check("a bracket that wraps the hour (58 → 3) closes 5 min later", w.ticks[0] && iso(w.ticks[0].open) === "00:58" && iso(w.ticks[0].close) === "01:03", w.ticks.map((t) => `${iso(t.open)}-${iso(t.close)}`).join(","));
  check("…and takes the next hour's :00:30 / :01:30 activity reads", w.events.filter((e) => e.kind === "activity" && e.tick === 0).map((e) => iso(e.target)).join(",") === "01:00,01:01");
  let threw = null;
  try { buildSchedule({ minutes: [5, 11, 35], ticks: 1, notBefore: nb }); } catch (e) { threw = e; }
  check("an odd --minutes list is refused (brackets are pairs)", threw instanceof Error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
