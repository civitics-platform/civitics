#!/usr/bin/env node
// scripts/drain-ec-donations.mjs — FIX-1069 supervised drain of the windowed
// incremental EC arm, rebuilt on the FIX-1111 crawl (FIX-1110).
//
// WHY THIS EXISTS. After FIX-1069 the donations arm is 16 committed, budget-
// checked, resumable windows. That makes it safe to drive to convergence by
// hand in a quiet window, which is the point: the next scheduled firing should
// wake to a near-zero dirty set instead of the 1.96M-donor backlog that turned
// 2026-08-19 into a six-hour, zero-output run.
//
// ═══ WHAT FIX-1110 CHANGED, AND WHY ════════════════════════════════════════
// This script used to CALL rebuild_ec_donations_incr_window() directly, one
// window per statement. That made it a SECOND driver of the same work, and on
// the 2026-08-25 acceptance drain all three of its divergences from the
// scheduled path bit at once:
//
//   1. It never published pipeline_state.entity_connections_window_inflight,
//      so FIX-1101's per-window watchdog was structurally blind to it. The
//      30-minute bound that shipped the same night would have cancelled
//      window 13 at 1,800 s; instead it ran 1,902 s unbounded and took the box
//      into connection starvation (jobids 40/44 failing 01:52→01:58).
//   2. --until was checked only BETWEEN windows. Window 13 started at ~01:26,
//      legally ahead of the 01:45 stop, and overran it by 13 minutes. The flag
//      was documented as a hard stop and was a hard START gate.
//   3. Killing the client did not stop the query. The node process and its
//      psql child were killed at 01:53; pg_stat_activity still showed pid
//      162913 running at 1,902 s two minutes later, because PostgreSQL does
//      not notice a departed client mid-statement
//      (client_connection_check_interval defaults to 0). It took a manual
//      pg_cancel_backend() at 01:58:08. And the kill skipped the FIX-943
//      vacuum tail, leaving entity_connections at 418,198 dead tuples.
//
// It is now a WRAPPER: it loops
//     CALL run_entity_connections_rebuild('incremental', p_max_units := 1)
// exactly as the ec-crawl pg_cron job does, one unit per iteration, with
// --sleep-seconds between units. So it is no longer a different path — it is
// the supervised way to run the SAME crawl faster, and every unit inherits the
// in-flight publication, the per-window watchdog, the banking, the FEC
// interlock and the backoff sensor for free. (1) is fixed by construction.
//
// (2) and (3) are fixed here: the CALL runs asynchronously, a poller enforces
// the deadline MID-unit by finding the drain's own backend and calling
// pg_cancel_backend() on it, and the same path handles SIGINT/SIGTERM. The
// cancel lands in the procedure's FIX-1028 `WHEN query_canceled` handler, so
// it is an orderly early stop that banks completed work — not an error.
//
// SAFETY PROPERTIES:
//   * every unit is idempotent, range-scoped and committed, so a re-run resumes.
//   * --until is now a HARD stop, enforced mid-unit, not a start gate.
//   * Ctrl-C cancels the server-side backend before exiting, then still vacuums.
//   * the FIX-943 VACUUM (ANALYZE) tail runs on EVERY exit path that wrote
//     anything — clean finish, deadline, Ctrl-C, or error.
//   * --dry-run stages nothing and writes nothing.
//   * refuses to write to prod without --allow-prod.
//
// USAGE (from repo root):
//   node scripts/drain-ec-donations.mjs --local --dry-run
//   node scripts/drain-ec-donations.mjs --prod  --dry-run
//   node scripts/drain-ec-donations.mjs --prod  --allow-prod --until 04:45
//   node scripts/drain-ec-donations.mjs --prod  --allow-prod --max-units 2 --sleep-seconds 60
//
// --until takes HH:MM in UTC, interpreted as the next occurrence.
// --sleep-seconds defaults to 540: one donations window measures ~346 s at
//   ~2,500 IOPS against a 1,000 IOPS baseline, which is about 9 minutes of
//   burst-budget refill (FIX-1107). Sleeping that long between units is what
//   keeps a supervised drain inside the same envelope the */15 crawl respects.
//   Pass a smaller value only when you have decided to spend burst deliberately.

import { readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_REF = "xsazcoxinpgttgquwvuf";
const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SEP = "|@|";

// ── FIX-1116 — WHICH ROW HOLDS THE CYCLE, AND WHICH ONE DOES NOT ────────────
// This wrapper used to decide "is a cycle still open?" from
// pipeline_state.entity_connections_donations, like this:
//
//     SELECT value->>'last_indexed_at', (value ? 'cycle')::text
//       FROM public.pipeline_state WHERE key = 'entity_connections_donations'
//     ...
//     const cycleOpen = after[1] === "true";
//
// That row is the DONATIONS SUB-CYCLE's state, not the rebuild cycle's. Its
// `cycle` key is real — rebuild_ec_donations_incr_prepare() writes
// {since_at, staged_at, target_at, dirty_donors} — but incr_close() DELETES it
// the moment the sixteenth window lands, while the rebuild cycle carries on
// through ten more arms. So the probe answers "are donations windows still in
// flight?" and the wrapper printed it as "is the cycle still open?".
//
// The consequence measured on prod 2026-08-27 23:09 UTC: the run printed
// `CYCLE CLOSED. Residual dirty set: 0 rows / 0 donors` while the cursor held an
// open cycle with six arms banked and five pending, which the next scheduled
// firing duly resumed. The six-line CYCLE INCOMPLETE branch written to stop an
// operator drawing exactly that conclusion is unreachable in that state.
//
// Rebuild-cycle state lives in entity_connections_rebuild_cursor:
// {mode, cycle_started_at, completed_arms[]}, and the row is DELETED when the
// cycle closes. Its presence IS the answer, and completed_arms is progress an
// operator can act on where a boolean was not.
const CURSOR_SQL = `SELECT coalesce(value->>'cycle_started_at',''),
                           coalesce((value->'completed_arms')::text,'[]'),
                           coalesce(value->>'mode','')
                      FROM public.pipeline_state
                     WHERE key = 'entity_connections_rebuild_cursor'`;

/**
 * Interpret the cursor probe. Pure: takes q()'s rows, returns the cycle state.
 * No row at all = no cursor = the cycle is closed, which is the ONLY condition
 * under which this wrapper may print CYCLE CLOSED.
 */
export function readCycleState(rows) {
  if (!rows || rows.length === 0) {
    return { open: false, startedAt: null, mode: null, arms: [], armsBanked: 0 };
  }
  const [startedAt, armsJson, mode] = rows[0];
  let arms = [];
  try {
    const parsed = JSON.parse(armsJson || "[]");
    if (Array.isArray(parsed)) arms = parsed;
  } catch {
    // A cursor we cannot parse is still a cursor: the cycle is open. Failing
    // toward "open" keeps the operator warning rather than the false all-clear.
    arms = [];
  }
  return {
    open: true,
    startedAt: startedAt || null,
    mode: mode || null,
    arms,
    armsBanked: arms.length,
  };
}

/**
 * The closing lines. Pure so the resumption warning — which had never once been
 * printed before FIX-1116 — is assertable in a test instead of only reachable
 * by reproducing a mid-cycle drain against a live database.
 */
export function finalCycleLines(state, residual) {
  if (state.open) {
    const banked = state.armsBanked;
    return [
      `CYCLE INCOMPLETE — ${banked} arm(s) banked, cycle opened ${state.startedAt ?? "(unknown)"}.`,
      ...(banked ? [`  banked: ${state.arms.join(", ")}`] : []),
      "The next ec-crawl firing RESUMES it: the staging table is reused, banked",
      "units are skipped without spending a unit, and the rest is finished one",
      "unit at a time. Re-run this script to go faster.",
      "NOTE: the scalar watermark deliberately does NOT move until the last",
      "window lands, so a dirty-set-since-watermark query still reports the",
      "full backlog. That is the conservative reading, not a lack of progress.",
    ];
  }
  const r = residual ?? { rows: 0, donors: 0 };
  return [
    `CYCLE CLOSED — entity_connections_rebuild_cursor is gone, every arm banked.`,
    `Residual dirty set: ${Number(r.rows).toLocaleString()} rows / ${Number(r.donors).toLocaleString()} donors`,
    "^ this is what the next scheduled firing will find.",
  ];
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const isProd = has("--prod");
const dryRun = has("--dry-run");

// FIX-1116 — the CLI half only arms itself when this file is the entry point, so
// the test can import the pure helpers above without the module exiting on it.
const isMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain && !isProd && !has("--local")) {
  console.error("drain-ec-donations — pass --local or --prod explicitly.");
  process.exit(1);
}
if (isMain && isProd && !dryRun && !has("--allow-prod")) {
  console.error("drain-ec-donations — refusing to write to PRODUCTION without --allow-prod.");
  process.exit(1);
}

const sleepSeconds = Number(val("--sleep-seconds") ?? 540);
const maxUnits = Number(val("--max-units") ?? 64);
if (!Number.isFinite(sleepSeconds) || sleepSeconds < 0) {
  console.error("drain-ec-donations — --sleep-seconds must be a non-negative number.");
  process.exit(1);
}
if (!Number.isFinite(maxUnits) || maxUnits < 1) {
  console.error("drain-ec-donations — --max-units must be >= 1.");
  process.exit(1);
}

// ── Deadline ────────────────────────────────────────────────────────────────
let deadline;
const untilArg = val("--until");
if (untilArg) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(untilArg);
  if (!m) {
    console.error(`drain-ec-donations — --until must be HH:MM (UTC), got "${untilArg}".`);
    process.exit(1);
  }
  const now = new Date();
  deadline = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    Number(m[1]), Number(m[2]), 0, 0,
  ));
  if (deadline <= now) deadline = new Date(deadline.getTime() + 24 * 3600 * 1000);
} else {
  deadline = new Date(Date.now() + 240 * 60 * 1000);
}

// ── Connection ──────────────────────────────────────────────────────────────
function prodUrl() {
  const envFile = join(ROOT, ".env.local.prod");
  if (!existsSync(envFile)) throw new Error(".env.local.prod not found");
  const txt = readFileSync(envFile, "utf8");
  const pw = /^SUPABASE_DB_PASSWORD=(.*)$/m.exec(txt)?.[1]?.trim();
  if (!pw) throw new Error("SUPABASE_DB_PASSWORD not found in .env.local.prod");
  const poolerFile = join(ROOT, "supabase", ".temp", "pooler-url");
  const base = existsSync(poolerFile)
    ? readFileSync(poolerFile, "utf8").trim()
    : `postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres`;
  return base.replace(/^(postgresql:\/\/[^:]+):?[^@]*@/, `$1:${encodeURIComponent(pw)}@`);
}

const utc = (d) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── psql runners ────────────────────────────────────────────────────────────
// Root scripts in this repo shell out to psql rather than depend on `pg`, which
// is only installed under packages/data.
let PSQL_URL = null;

function q(sql) {
  const res = spawnSync("psql", [PSQL_URL, "-v", "ON_ERROR_STOP=1", "-At", "-F", SEP], {
    input: sql + "\n", encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`psql failed to launch: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`psql exited ${res.status}: ${(res.stderr || "").trim()}`);
  const warn = (res.stderr || "").trim();
  if (warn) {
    for (const l of warn.split("\n")) if (l.trim()) console.log(`[drain]   psql: ${l.trim()}`);
  }
  return (res.stdout || "").trim().split("\n").filter(Boolean).map((l) => l.split(SEP));
}

// FIX-1116 — ONE convention for single-row reads. The old code indexed q()'s
// result as st[0][1] in one place and after[0]/after[1] in another (the latter
// having already destructured row 0), which was right by accident twice and is
// the kind of thing that is right until it is not. q1() returns the first ROW,
// so every caller indexes columns and only columns.
function q1(sql) {
  const rows = q(sql);
  return rows.length ? rows[0] : null;
}

// The CALL runs ASYNC so the deadline and SIGINT can reach it mid-unit. This is
// FIX-1110 defects (2) and (3): a synchronous spawn cannot be interrupted, and
// killing the client would leave the server-side statement running.
function callAsync(sql) {
  return new Promise((resolve, reject) => {
    const p = spawn("psql", [PSQL_URL, "-v", "ON_ERROR_STOP=1", "-At", "-F", SEP], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.write(sql + "\n");
    p.stdin.end();
  });
}

// Find the backend running OUR rebuild and cancel it server-side. Mirrors the
// FIX-1101 watchdog's narrow probe rather than matching on pid alone: this is
// the only thing that actually stops the work, because PostgreSQL does not
// notice a departed client mid-statement.
function cancelDrainBackend(reason) {
  try {
    const rows = q(
      `SELECT pid, pg_cancel_backend(pid)
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state <> 'idle'
          AND query ILIKE '%run_entity_connections_rebuild%'`
    );
    if (rows.length) {
      for (const r of rows) console.log(`[drain] ${reason}: pg_cancel_backend(${r[0]}) -> ${r[1]}`);
      return true;
    }
    console.log(`[drain] ${reason}: no running rebuild backend found to cancel.`);
  } catch (e) {
    console.error(`[drain] ${reason}: cancel probe failed: ${e.message}`);
  }
  return false;
}

const DIRTY_SQL = `SELECT count(*), count(DISTINCT from_id)
     FROM public.financial_relationships
    WHERE relationship_type IN ('donation','ie_support','ie_oppose')
      AND updated_at > (SELECT (value->>'last_indexed_at')::timestamptz
                          FROM public.pipeline_state
                         WHERE key = 'entity_connections_donations')`;

// ── FIX-943 vacuum tail — must survive every exit path ──────────────────────
// Standing convention (CLAUDE.md): any script that bulk-rewrites a table ends
// by vacuuming what it rewrote. Measured on the first prod drain 2026-08-20:
// 5 windows rewrote 1,760,324 edges and took entity_connections from 100%
// all-visible to 77.3% with 4.21% dead tuples — a heap page loses its
// all-visible mark if ANY tuple on it is dead, so every index-only scan over EC
// silently degrades to per-row heap fetches (FIX-884). The vacuum took ~90 s and
// restored 0 dead / 100% all-visible.
//
// The 2026-08-25 drain proved the tail must not be on the happy path only: the
// kill skipped it and left 418,198 dead tuples, cleaned up only by luck (jobid
// 6 happened to be scheduled that Wednesday). Playbook C3 — put it where it can
// FIRE. Guarded so it runs at most once.
let unitsRan = 0;
let vacuumDone = false;
function vacuumTail(why) {
  if (vacuumDone || unitsRan === 0 || dryRun) return;
  vacuumDone = true;
  console.log(`[drain] VACUUM (ANALYZE) entity_connections — FIX-943 bulk-rewrite rule (${why})...`);
  const v0 = Date.now();
  try {
    q(`VACUUM (ANALYZE) public.entity_connections`);
    console.log(`[drain] vacuum done in ${((Date.now() - v0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(`[drain] VACUUM FAILED: ${e.message}`);
    console.error("[drain] entity_connections was bulk-rewritten and is NOT vacuumed — run");
    console.error("[drain]   VACUUM (ANALYZE) public.entity_connections;");
    console.error("[drain] before treating any post-drain timing regression as a query problem.");
  }
}

let stopping = false;
function onSignal(sig) {
  if (stopping) { process.exit(130); }
  stopping = true;
  console.log(`\n[drain] ${sig} — cancelling the running unit server-side, then vacuuming.`);
  console.log("[drain] (killing this process alone would NOT stop the query — FIX-1110 defect 3.)");
  cancelDrainBackend(sig);
}
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  PSQL_URL = isProd ? prodUrl() : LOCAL_URL;
  console.log(`[drain] target: ${isProd ? "PROD (Supabase Pro)" : "LOCAL"}`);
  console.log(`[drain] mode:   ${dryRun ? "DRY RUN (reads only)" : "DRAIN (wraps the FIX-1111 crawl)"}`);
  console.log(`[drain] now:    ${utc(new Date())}`);
  if (!dryRun) {
    console.log(`[drain] until:  ${utc(deadline)}  (HARD stop — enforced mid-unit via pg_cancel_backend)`);
    console.log(`[drain] pacing: ${sleepSeconds}s between units, max ${maxUnits} unit(s)`);
  }

  const st = q1(`SELECT coalesce(value->>'last_indexed_at','(none)'),
                        (SELECT count(*) FROM jsonb_each_text(value->'windows')),
                        coalesce(value->'cycle'->>'target_at','(none)')
                   FROM public.pipeline_state WHERE key = 'entity_connections_donations'`);
  if (!st) {
    console.error("[drain] no entity_connections_donations watermark row at all — this needs the");
    console.error("[drain] FULL windowed bootstrap path, not the incremental drain. Aborting.");
    process.exit(2);
  }
  console.log(`[drain] watermark (scalar): ${st[0]}`);
  console.log(`[drain] per-window keys:    ${st[1]}/16`);
  console.log(`[drain] donations target:   ${st[2]}   (the sub-cycle's staged target, absent once its 16 windows close)`);

  // FIX-1116 — the rebuild cycle, read from the row that actually holds it.
  const openState = readCycleState(q(CURSOR_SQL));
  if (openState.open) {
    console.log(`[drain] open cycle:         started ${openState.startedAt}, ` +
                `${openState.armsBanked} arm(s) banked (mode=${openState.mode})`);
  } else {
    console.log("[drain] open cycle:         none — the next unit opens a fresh one");
  }

  const d0 = q(DIRTY_SQL)[0];
  console.log(`[drain] dirty since scalar watermark: ${Number(d0[0]).toLocaleString()} rows / ${Number(d0[1]).toLocaleString()} donors`);

  if (dryRun) {
    console.log("[drain] dry run — nothing staged, nothing written.");
    return;
  }

  const t0 = Date.now();
  let stoppedEarly = false, finalStatus = null;

  for (let n = 1; n <= maxUnits && !stopping; n++) {
    if (Date.now() >= deadline.getTime()) {
      console.log(`[drain] DEADLINE reached before unit ${n} — stopping cleanly.`);
      stoppedEarly = true;
      break;
    }

    const u0 = Date.now();
    // The deadline poller: the whole point of FIX-1110 defect (2). Checked every
    // 5 s while the unit runs, so --until bounds the DRAIN and not merely the
    // moment it is allowed to start another unit.
    const poll = setInterval(() => {
      if (stopping) return;
      if (Date.now() >= deadline.getTime()) {
        stopping = true;
        stoppedEarly = true;
        console.log(`\n[drain] DEADLINE reached MID-UNIT — cancelling server-side.`);
        cancelDrainBackend("deadline");
      }
    }, 5000);

    let res;
    try {
      res = await callAsync(
        `CALL public.run_entity_connections_rebuild('incremental', p_max_units := 1);`);
    } finally {
      clearInterval(poll);
    }

    const secs = (Date.now() - u0) / 1000;
    for (const l of (res.err || "").split("\n")) {
      if (/WARNING|ERROR|DEFERRED|SKIPPED \(/.test(l) && l.trim()) console.log(`[drain]   ${l.trim()}`);
    }

    // The log row is the authority on what the unit did — never the exit code.
    const row = q(`SELECT status,
                          coalesce(metadata->>'units_run','0'),
                          coalesce(metadata->>'unit_capped','false'),
                          coalesce(metadata->>'edges_total','0'),
                          coalesce(metadata->>'next_arm','(none)'),
                          coalesce(metadata->>'skip_reason', metadata->>'defer_reason', error_message, '')
                     FROM public.data_sync_log
                    WHERE pipeline='entity_connections_rebuild'
                    ORDER BY started_at DESC LIMIT 1`)[0];
    const [status, unitsRun, , edges, nextArm, detail] = row;
    finalStatus = status;

    if (status === "skipped" || status === "deferred") {
      console.log(`[drain] unit ${String(n).padStart(2)}  ${status.toUpperCase()} — ${detail}`);
      console.log("[drain] the crawl gate or the FEC interlock is holding work off. Stopping;");
      console.log("[drain] this is the machinery working, not a failure.");
      stoppedEarly = true;
      break;
    }

    unitsRan += Number(unitsRun || 0);
    console.log(`[drain] unit ${String(n).padStart(2)}  ${secs.toFixed(1).padStart(7)}s  status=${status}  ` +
                `edges=${Number(edges).toLocaleString()}  next=${nextArm}`);

    if (status === "complete") { console.log("[drain] CYCLE COMPLETE — every arm banked, cursor cleared."); break; }
    if (status === "failed")   { console.log(`[drain] unit FAILED: ${detail}`); stoppedEarly = true; break; }
    if (stopping)              { stoppedEarly = true; break; }

    if (n < maxUnits && sleepSeconds > 0) {
      const nextAt = Date.now() + sleepSeconds * 1000;
      if (nextAt >= deadline.getTime()) {
        console.log(`[drain] next unit would start after the deadline — stopping cleanly.`);
        stoppedEarly = true;
        break;
      }
      console.log(`[drain]   pacing — sleeping ${sleepSeconds}s (≈ the burst-budget refill for one window)`);
      for (let s = 0; s < sleepSeconds && !stopping; s++) await sleep(1000);
    }
  }

  vacuumTail(stoppedEarly ? "partial drain" : "drain finished");

  const after = q1(`SELECT value->>'last_indexed_at'
                      FROM public.pipeline_state WHERE key='entity_connections_donations'`);

  // FIX-1116 — the cycle verdict comes from the CURSOR, not from the donations
  // sub-cycle key. See CURSOR_SQL at the top of this file for why.
  const state = readCycleState(q(CURSOR_SQL));

  // Intra-cycle progress. The scalar watermark is the MIN across the 16 windows,
  // so mid-cycle it does not move at all and the dirty-set-since-scalar query
  // reports the FULL original backlog no matter how many windows have banked.
  // Reporting only that would tell an operator who just drained a third of the
  // donor space that nothing happened. Count the windows instead.
  const target = q1(`SELECT coalesce(value->'cycle'->>'target_at', value->>'last_indexed_at')
                       FROM public.pipeline_state WHERE key='entity_connections_donations'`)[0];
  const prog = q1(`SELECT count(*) FILTER (WHERE (e.value)::timestamptz >= '${target}'::timestamptz),
                          count(*) FILTER (WHERE (e.value)::timestamptz <  '${target}'::timestamptz)
                     FROM public.pipeline_state ps,
                          jsonb_each_text(ps.value->'windows') AS e(key, value)
                    WHERE ps.key='entity_connections_donations'`);

  console.log("");
  console.log("[drain] ---- result ------------------------------------------");
  console.log(`[drain] units run: ${unitsRan}   final status: ${finalStatus ?? "(none)"}`);
  console.log(`[drain] total elapsed: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`[drain] donations windows at target: ${prog[0]}/16   still pending: ${prog[1]}`);
  console.log(`[drain] scalar watermark now: ${after ? after[0] : "(none)"}`);
  console.log(`[drain] rebuild cycle open:   ${state.open ? `yes — ${state.armsBanked} arm(s) banked` : "no"}`);

  // The residual dirty set is only meaningful once the cycle has closed and the
  // scalar watermark has moved; querying it mid-cycle returns the full original
  // backlog and is exactly the number the warning below exists to disclaim.
  const residual = state.open ? null : (() => { const d = q1(DIRTY_SQL); return { rows: d[0], donors: d[1] }; })();
  for (const line of finalCycleLines(state, residual)) console.log(`[drain] ${line}`);
}

if (isMain) {
  main()
    .catch((e) => { console.error("[drain] FAILED:", e.message); vacuumTail("error"); process.exit(1); })
    .finally(() => { vacuumTail("exit"); });
}
