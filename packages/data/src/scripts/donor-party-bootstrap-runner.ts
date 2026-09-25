/**
 * FIX-1212 / FIX-1215 — the unattended donor-party bootstrap runner.
 *
 *   pnpm --filter @civitics/data data:donor-party:bootstrap:prod \
 *     --units-per-call 2 --wall-trip-s 3.0 --breather-until-wall-s 0.5 \
 *     --breather-max-s 600 --max-calls 12 --expected-minutes 60 --max-wait-minutes 600
 *
 * Launched once, from the PRIMARY checkout (its .env.local.prod is the real
 * one; a worktree's is a stub), as a background process. It needs nobody:
 *
 *   1. WAIT   waitForProdOpGate(--expected-minutes) — the prod-op window as a
 *             CONDITION read every --poll-seconds from public.prod_op_gate()
 *             (FIX-1215), not a clock anybody computed — AND, on every poll
 *             where the gate reads ok, the census
 *             (cancellation-census.ts --minutes 60 --json) must PASS on the
 *             same poll (cc-151 D2). A census FAIL, or the Logs API dark, is
 *             "not open yet": keep polling. --max-wait-minutes bounds the whole
 *             wait → gate_timeout, naming the half that held the last poll.
 *             The census is read only when the gate is open, so a blocked gate
 *             costs no Logs API read; on the clone (no Logs API) the census
 *             half reads `skipped — local`, and on a census exit 8 (the
 *             endpoint is gone, FIX-1219) it reads `unavailable` — both open
 *             on the gate alone. The wait is BEFORE the claim: a
 *             claim held through a four-hour wait would hold every guarded
 *             pipeline for nothing (rule 102).
 *   2. (retired, cc-151) the one-shot pre-launch census and its exit 3
 *             `census_fail`. cc-148 polled it by hand for 30 min; the wait
 *             belongs in code (rule 170).
 *   3. CLAIM  withProdSession({reason}) — every guarded pg_cron job now defers.
 *   4. ARM    connection C (application_name civitics_dp_bootstrap):
 *             SET statement_timeout = '40min' · SET lock_timeout = '60s' ·
 *             SET civitics.prod_session_claimant = '<reason>' — each its OWN
 *             statement (FIX-1128; rule 109) — then ASSERT prod_session_state()
 *             reads defer=false, claimant_bypass=true AND the label is this
 *             process's. Otherwise exit 5 without a CALL (FIX-1213 did not land
 *             the way its test said, or the claim is not ours).
 *             40 min: above the procedure's 1,500 s unit budget plus its
 *             longest window with slack, and under the role's 3 h ceiling —
 *             1,500 < 2,400 < 10,800 (rule 126).
 *   5. RESUME The cursor (pipeline_state.donor_party_full_rebuild) is read
 *             before the first CALL and logged as "resuming at window N". The
 *             runner never edits or deletes it — the procedure owns it (cc-148
 *             D3).
 *   6. LOOP   PACED (cc-148 D2; project_background_crawl_design — bounded units
 *             with breathers, never one long writer):
 *             a. BREATHER (from CALL 2): wait until BOTH every-2-min watchdogs have a
 *                completed run that STARTED after the previous CALL returned
 *                with a wall under --breather-until-wall-s — read every 30 s —
 *                or --breather-max-s elapses (then proceed, `breather_timeout`).
 *                cc-147 measured the recovery: 1.341 → 0.612 / 0.061 s within
 *                one minute of the probe CALL ending.
 *             b. CENSUS (prod) --minutes 15 before EVERY CALL, after the
 *                breather so it reads the recovered box.
 *             c. pipeline_state.donor_party_crawl = {"max_units":
 *                --units-per-call} upserted before the CALL and restored to the
 *                prior value (prod: ABSENT → DELETE, never "defaults") after it
 *                — and again in `finally`.
 *             d. CALL public.refresh_donor_party_rollup_incremental(); read its
 *                terminal data_sync_log row: caught_up → done; partial with
 *                "unit cap reached" / "wall-clock budget reached" → again;
 *                skipped → exit 5; failed / canceled → exit 4; --max-calls →
 *                exit 6.
 *             caught_up is ASSERTED, not read off the row: the cursor is gone
 *             AND the watermark equals the cycle's target; a mismatch is
 *             `error` (exit 1).
 *   7. RELEASE, then the after-reads and the receipt (written in `finally`,
 *             whatever the outcome — rule 48).
 *
 * ── THE STOP RULE, IN CODE (rule 65/66) ─────────────────────────────────────
 * Read on connection T before each CALL, every --tick-seconds (120) while one
 * is in flight, and every 30 s during a breather:
 *   (1) any `job startup timeout` failure on ANY job — the forker; the Tuesday
 *       signature's actual failure (cc-145 §1);
 *   (2) either every-2-min watchdog's wall >= --wall-trip-s (3.0) on two DISTINCT
 *       consecutive runs (one completed run is one vote, 3a8eff87). Walls in
 *       [1.0, wall-trip-s) are this op's LOAD, not a precursor: cc-147's probe
 *       drove the budget watchdog 0.014 → 1.341 s with 0 startup timeouts and
 *       a census pass, and the healthy 06:30 stack puts both over 1 s daily.
 *       They are logged `elevated` and counted (`elevated_ticks`), never a
 *       trip. >= 3 s is above anything the healthy stacks produce and inside
 *       the Tuesday 1–4 s band — a stop worth losing one window for;
 *   (3) the census (child process, --minutes 15) before every CALL and every
 *       15 min during one: pass=false trips (the front door — rule 65, the
 *       load-bearing stop); exit 2 (Logs API dark) is logged, and TWO
 *       consecutive exit-2s trip — the Logs API going dark was itself a symptom
 *       on 09-22 (rule 164). Since cc-151 D1 the 57014 half fails only above
 *       the Poisson P99 floor of the baseline (3 in 15 min at 0.033/min), so a
 *       burst of 4 trips and a single stray timeout does not. With
 *       --census-mode report (cc-152; default stop) a pass=false reading is
 *       recorded — `would_trip` on its receipt row — and logged, and does not
 *       stop the run: the op's front-door cost is measured, not guarded. The
 *       dark-twice trip stays armed in both modes, and the gate wait's census
 *       half (step 1) holds the window in both; report demotes only this
 *       pass=false stop. Exit 8 (endpoint removed, FIX-1219) is not a reading
 *       and never trips: it neither counts toward nor resets the dark count,
 *       and at the gate it opens on the gate alone. Exit 2 (dark) still trips
 *       on two consecutive;
 *   (4) the CALL's backend gone from pg_stat_activity (the box, not the
 *       procedure).
 * On trip: pg_cancel_backend(<CALL pid>) from T; wait for the CALL to return
 * (the procedure's query_canceled handler records `partial` + cancel_detail and
 * stops — rule 114; the window in flight rolls back whole; committed windows
 * and the cursor stay); close C and verify the CALL is no longer running
 * (rule 66); release; receipt `outcome: stopped` with the rule number and the
 * run ids it counted; exit 4. No retry without Craig.
 *
 * EXIT CODES
 *   0 caught_up · 1 error · 4 stopped · 5 skipped · 6 max_calls · 7 gate_timeout
 *   3 is RETIRED (was census_fail, pre-launch — cc-151 D2 made it unreachable:
 *   the census is waited on inside the gate wait). Never reused, so an old log
 *   still reads unambiguously.
 * `pnpm --filter … <key>` and plain `pnpm <key>` pass the code through; `pnpm -s
 * <key>` collapses every non-zero code to 1 (pnpm 9, Windows — measured cc-147).
 * The receipt's `exit_code` is authoritative either way.
 *
 * TEST-ONLY FLAGS (the clone rehearsals, rule 118): --trip-on-wall-ms N makes
 * EVERY watchdog reading of >= N ms a vote (0: every reading; the distinct-run
 * dedupe is off, so a cancel can land inside a short clone CALL), and
 * --trip-from-call K arms it from the K-th CALL's pre-CALL reading, so the
 * rehearsal's cancel lands after windows have committed. It never fires during
 * a breather. --tick-seconds shortens the ticker. --receipt-tag names a second
 * receipt. A local target always writes a `-local` receipt — never over a prod
 * one (the FIX-1209 shape) — and no receipt ever overwrites an existing file:
 * a second launch on the same UTC day gets a `-HHMMSSZ` suffix (cc-148: the
 * relaunch would otherwise have clobbered cc-147's).
 *
 * KNOWN MISLABEL (out of scope): the procedure stamps `source: 'pg_cron'` on
 * its data_sync_log row even when a supervised CALL ran it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { isLogsEndpointGone } from "@civitics/db";
import { CENSUS_EXIT } from "../lib/cancellation-census";
import { buildDbUrl } from "../lib/heavy-rebuild";
import { GateTimeout, waitForProdOpGate, type AlsoReading, type GatePoll, type ProdOpGate } from "../lib/prod-op-gate";
import { ProdSessionRefused, withProdSession, type ProdSessionState } from "../lib/prod-session";
import { errText } from "../lib/session-lock";

export const REASON = "FIX-1212 bootstrap (cc-147 runner)";
const PIPELINE = "donor_party_rollup_refresh";
const APP = "civitics_dp_bootstrap";
const CALL_SQL = "CALL public.refresh_donor_party_rollup_incremental()";
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DATA_DIR = path.resolve(__dirname, "..", "..");

/** The floor of `elevated`: a wall at or above this and under --wall-trip-s is load, logged, never a trip. */
export const ELEVATED_FROM_S = 1.0;
/** Breather read cadence (D2): one every-2-min watchdog run lands per 120 s; 30 s sees each within a quarter-cycle. */
const BREATHER_READ_S = 30;

export type Outcome =
  | "caught_up" | "stopped" | "skipped" | "gate_timeout" | "max_calls" | "error";

/** 3 is retired (census_fail, cc-151 D2) and never reused. */
export const EXIT: Record<Outcome, number> = {
  caught_up: 0, error: 1, stopped: 4, skipped: 5, max_calls: 6, gate_timeout: 7,
};

/** The vocabulary line every receipt carries (rule 48: the receipt's vocabulary IS the code's). */
export function vocabularyLine(): string {
  return `${Object.entries(EXIT).sort((a, b) => a[1] - b[1]).map(([o, c]) => `${o} ${c}`).join(" · ")}` +
    " · (3 retired: census_fail — the census is waited on inside the gate, cc-151)";
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

/** Rule (3)'s pass=false: `stop` trips it; `report` records it (cc-152 D1). */
export type CensusMode = "stop" | "report";

export interface RunnerArgs {
  unitsPerCall: number;
  wallTripS: number;
  breatherUntilWallS: number;
  breatherMaxS: number;
  maxWaitMinutes: number;
  pollSeconds: number;
  maxCalls: number;
  expectedMinutes: number;
  tickSeconds: number;
  tripOnWallMs: number | null;
  tripFromCall: number;
  receiptTag: string | null;
  censusMode: CensusMode;
}

function argValue(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1] ?? null;
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

export function parseRunnerArgs(rawArgv: readonly string[]): RunnerArgs | { error: string } {
  // `pnpm run <key> -- --flag` forwards the `--` itself on pnpm 9 (measured
  // cc-147: cancellation-census.ts died on it). The prompt-shaped launch
  // command carries one, so tolerate it rather than refuse the launch.
  const argv = rawArgv.filter((a) => a !== "--");
  // --probe-units is gone (cc-148 D2): --units-per-call applies to EVERY CALL.
  // Passing the old flag is refused as unknown rather than silently re-read.
  const known = new Set([
    "--units-per-call", "--wall-trip-s", "--breather-until-wall-s", "--breather-max-s",
    "--max-wait-minutes", "--poll-seconds", "--max-calls", "--expected-minutes",
    "--tick-seconds", "--trip-on-wall-ms", "--trip-from-call", "--receipt-tag", "--census-mode",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (!known.has(flag)) return { error: `unknown argument ${a}` };
    if (!a.includes("=")) i++;
  }
  const num = (flag: string, dflt: number, min: number): number | { error: string } => {
    const raw = argValue(argv, flag);
    if (raw == null) return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : { error: `${flag} must be a number >= ${min} (got ${JSON.stringify(raw)})` };
  };
  const out: Record<string, number> = {};
  for (const [k, flag, d, min] of [
    ["unitsPerCall", "--units-per-call", 2, 1],
    ["wallTripS", "--wall-trip-s", 3.0, 0.001],
    ["breatherUntilWallS", "--breather-until-wall-s", 0.5, 0.001],
    ["breatherMaxS", "--breather-max-s", 600, 0],
    ["maxWaitMinutes", "--max-wait-minutes", 480, 1],
    ["pollSeconds", "--poll-seconds", 300, 1],
    ["maxCalls", "--max-calls", 12, 1],
    ["expectedMinutes", "--expected-minutes", 60, 1],
    ["tickSeconds", "--tick-seconds", 120, 1],
    ["tripFromCall", "--trip-from-call", 1, 1],
  ] as const) {
    const v = num(flag, d, min);
    if (typeof v === "object") return v;
    out[k] = v;
  }
  const tripRaw = argValue(argv, "--trip-on-wall-ms");
  let tripOnWallMs: number | null = null;
  if (tripRaw != null) {
    const n = Number(tripRaw);
    if (!Number.isFinite(n) || n < 0) return { error: `--trip-on-wall-ms must be >= 0 (got ${JSON.stringify(tripRaw)})` };
    tripOnWallMs = n;
  }
  const tag = argValue(argv, "--receipt-tag");
  if (tag != null && !/^[a-z0-9-]+$/.test(tag)) return { error: "--receipt-tag must be [a-z0-9-]+" };
  const mode = argValue(argv, "--census-mode");
  if (mode != null && mode !== "stop" && mode !== "report") {
    return { error: `--census-mode must be stop|report (got ${JSON.stringify(mode)})` };
  }
  return {
    unitsPerCall: Math.floor(out["unitsPerCall"]!),
    wallTripS: out["wallTripS"]!,
    breatherUntilWallS: out["breatherUntilWallS"]!,
    breatherMaxS: out["breatherMaxS"]!,
    maxWaitMinutes: out["maxWaitMinutes"]!,
    pollSeconds: out["pollSeconds"]!,
    maxCalls: Math.floor(out["maxCalls"]!),
    expectedMinutes: out["expectedMinutes"]!,
    tickSeconds: out["tickSeconds"]!,
    tripOnWallMs,
    tripFromCall: Math.floor(out["tripFromCall"]!),
    receiptTag: tag,
    censusMode: mode === "report" ? "report" : "stop",
  };
}

// ---------------------------------------------------------------------------
// The loop decision — pure, so the whole vocabulary is testable
// ---------------------------------------------------------------------------

export interface CallRow {
  id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
}

export type CallVerdict =
  | { action: "done"; outcome: "caught_up"; detail: string }
  | { action: "continue"; detail: string }
  | { action: "stop"; outcome: Exclude<Outcome, "caught_up">; detail: string };

export function classifyCallRow(row: CallRow | null, callNo: number, maxCalls: number): CallVerdict {
  if (!row) return { action: "stop", outcome: "stopped", detail: "no data_sync_log row for this CALL" };
  const md = row.metadata ?? {};
  if (row.status === "skipped") {
    return { action: "stop", outcome: "skipped", detail: `skipped: ${String(md["skip_reason"] ?? "(no skip_reason)")}` };
  }
  if (md["caught_up"] === true && (row.status === "complete" || row.status === "partial")) {
    return { action: "done", outcome: "caught_up", detail: `caught_up (${row.status})` };
  }
  if (row.status === "running") {
    return { action: "stop", outcome: "stopped", detail: "the row was left 'running' — the CALL did not close it" };
  }
  if (row.status === "failed" || md["canceled"] === true || md["cancel_detail"]) {
    return {
      action: "stop", outcome: "stopped",
      detail: `${row.status}: ${String(md["cancel_detail"] ?? row.error_message ?? "(no detail)")}`,
    };
  }
  const resumable = row.status === "complete" ||
    (row.status === "partial" && /unit cap reached|wall-clock budget reached/.test(row.error_message ?? ""));
  if (!resumable) {
    return { action: "stop", outcome: "stopped", detail: `${row.status}: ${row.error_message ?? "(no message)"}` };
  }
  if (callNo >= maxCalls) {
    return { action: "stop", outcome: "max_calls", detail: `--max-calls ${maxCalls} reached; ${row.error_message ?? row.status}` };
  }
  return { action: "continue", detail: `${row.status}: ${row.error_message ?? "not caught up"}` };
}

/** D3 — the first window the procedure will run: the lowest of 1..16 not in windows_done. */
export function resumeWindow(cursor: Record<string, unknown> | null): number | null {
  if (!cursor) return null;
  const done = new Set(
    (Array.isArray(cursor["windows_done"]) ? (cursor["windows_done"] as unknown[]) : []).map((x) => Number(x)));
  for (let i = 1; i <= 16; i++) if (!done.has(i)) return i;
  return null;
}

/**
 * D3 — caught_up is ASSERTED: the cursor is gone and the watermark equals the
 * cycle's target. `equal` comes from Postgres (timestamptz =), so microseconds
 * survive; JS Date would round both to the millisecond.
 */
export function caughtUpMismatch(c: { cursor_gone: boolean; target: string | null; equal: boolean | null }): string | null {
  const bad: string[] = [];
  if (!c.cursor_gone) bad.push("the cursor is still present");
  if (c.target === null) bad.push("no cycle target known to compare the watermark against");
  else if (c.equal !== true) bad.push(`the watermark does not equal the cycle target ${c.target}`);
  return bad.length ? bad.join("; ") : null;
}

// ---------------------------------------------------------------------------
// The stop rule — pure over readings
// ---------------------------------------------------------------------------

export interface WatchdogReading {
  at: string;
  /** jobname → latest wall, seconds (a running run counts its elapsed). */
  walls: Record<string, number>;
  /**
   * jobname → the cron run that wall belongs to. cc-147: without it, a tick and
   * the pre-CALL reading 16 s later read ONE run (09:06, 1.341 s) twice and
   * tripped "two consecutive". One completed run is one vote; a run still
   * RUNNING votes at every reading (a hung watchdog must still trip).
   */
  runs?: Record<string, { runid: string; running: boolean }>;
  /** `job startup timeout` failures on any job since the CALL began. */
  startupTimeouts: number;
  /** false when the CALL's backend is not in pg_stat_activity. null = no CALL in flight. */
  callBackendPresent: boolean | null;
}

export interface Trip {
  /** Which stop rule fired: (1) forker, (2) watchdog wall, (3) front door, (4) backend gone. */
  rule: 1 | 2 | 3 | 4;
  reason: string;
  job?: string;
  /** Rule (2): the two votes it counted — cron runids (a running run is `<runid>@<reading time>`). */
  run_ids?: string[];
  /** Never set on a Trip, so a WouldTrip cannot be passed as one. */
  would_trip?: never;
}

/**
 * cc-152 D1 — evaluateCensus's third shape: what rule (3) WOULD have returned
 * in stop mode, on a pass=false reading in report mode. Recorded and logged,
 * never a stop.
 */
export interface WouldTrip {
  would_trip: true;
  rule: 3;
  reason: string;
}

export const isTrip = (v: Trip | WouldTrip | null): v is Trip => v !== null && v.would_trip !== true;

export interface StopState {
  consecutiveOver: Record<string, number>;
  /** The votes counted over, per job, since the last reading under — rule (2)'s evidence. */
  overVotes: Record<string, string[]>;
  /** The vote key last counted per job — see WatchdogReading.runs. */
  lastVote: Record<string, string>;
  consecutiveCensusDark: number;
}

export const newStopState = (): StopState => ({ consecutiveOver: {}, overVotes: {}, lastVote: {}, consecutiveCensusDark: 0 });

/** D1 — jobs whose wall is this op's load: in [ELEVATED_FROM_S, wallTripS). */
export function elevatedJobs(walls: Record<string, number>, wallTripS: number): string[] {
  return Object.entries(walls).filter(([, w]) => w >= ELEVATED_FROM_S && w < wallTripS).map(([j]) => j);
}

export function evaluateWatchdogs(
  state: StopState,
  r: WatchdogReading,
  opts: { wallTripS: number; tripOnWallMs: number | null; armed: boolean },
): Trip | null {
  if (r.startupTimeouts > 0) {
    return { rule: 1, reason: `(1) ${r.startupTimeouts} job startup timeout failure(s) since the CALL began` };
  }
  if (r.callBackendPresent === false) return { rule: 4, reason: "(4) the CALL's backend is gone from pg_stat_activity" };
  const testTrip = opts.armed && opts.tripOnWallMs !== null;
  for (const [job, wall] of Object.entries(r.walls)) {
    const run = r.runs?.[job];
    let vote = `?@${r.at}`;
    if (run) {
      vote = run.running ? `${run.runid}@${r.at}` : run.runid;
      // The test trip counts every reading (its documented meaning); the real
      // rule counts one completed run once.
      if (!testTrip) {
        if (state.lastVote[job] === vote) continue;   // the same completed run, read again
        state.lastVote[job] = vote;
      } else {
        vote = `${vote}#${r.at}`;
      }
    }
    const over = testTrip ? wall * 1000 >= opts.tripOnWallMs! : wall >= opts.wallTripS;
    if (over) {
      state.consecutiveOver[job] = (state.consecutiveOver[job] ?? 0) + 1;
      (state.overVotes[job] ??= []).push(vote);
    } else {
      state.consecutiveOver[job] = 0;
      state.overVotes[job] = [];
    }
    if (state.consecutiveOver[job]! >= 2) {
      const ids = state.overVotes[job]!.slice(-2);
      return {
        rule: 2, job, run_ids: ids,
        reason: `(2) ${job} wall ${wall.toFixed(3)} s >= ${testTrip
          ? `${opts.tripOnWallMs} ms (test trip)` : `${opts.wallTripS} s`} on two ${testTrip ? "consecutive readings" : "distinct runs"} (${ids.join(", ")})`,
      };
    }
  }
  return null;
}

/**
 * Census exit code → trip, would-trip, or null. 0 pass · 1 fail · 2 Logs API
 * dark · 8 unavailable. A fail is a Trip in stop mode and a WouldTrip in
 * report mode; the dark count and its trip are the same in both. 8 (the
 * endpoint is gone, FIX-1219) is TRANSPARENT: null in both modes, and the dark
 * count is neither advanced nor reset, so dark, 8, dark still trips.
 */
export function evaluateCensus(state: StopState, exitCode: number, mode: CensusMode = "stop"): Trip | WouldTrip | null {
  if (exitCode === CENSUS_EXIT.unavailable) return null;
  if (exitCode === 0) { state.consecutiveCensusDark = 0; return null; }
  if (exitCode === 1) {
    state.consecutiveCensusDark = 0;
    const reason = "(3) census pass=false (57014 rate or front-door 5xx)";
    return mode === "report" ? { would_trip: true, rule: 3, reason } : { rule: 3, reason };
  }
  state.consecutiveCensusDark += 1;
  return state.consecutiveCensusDark >= 2 ? { rule: 3, reason: "(3) the Logs API was dark on two consecutive census readings" } : null;
}

// ---------------------------------------------------------------------------
// The breather — pure over the watchdogs' latest completed runs (D2)
// ---------------------------------------------------------------------------

export interface CompletedRun {
  jobname: string;
  runid: string;
  /** start_time as epoch ms, DB clock. */
  start_ms: number;
  wall_s: number;
}

/**
 * Released when EVERY watchdog's latest completed run STARTED at or after the
 * previous CALL returned (a run under the recovered box — never one that
 * straddled the CALL, never one already counted during it) and its wall is
 * under the threshold. `pending` names what is still being waited on.
 */
export function breatherRelease(
  runs: readonly CompletedRun[],
  returnedAtMs: number,
  thresholdS: number,
): { released: boolean; pending: string[] } {
  const pending: string[] = [];
  for (const r of runs) {
    if (r.start_ms < returnedAtMs) pending.push(`${r.jobname}: no run since the CALL returned`);
    else if (r.wall_s >= thresholdS) pending.push(`${r.jobname}: ${r.wall_s.toFixed(3)} s >= ${thresholdS} s`);
  }
  return { released: pending.length === 0, pending };
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

const Q_WATCHDOGS = `
SELECT j.jobname, x.runid::text AS runid, x.running, x.wall_s::float8 AS wall_s
  FROM cron.job j
  CROSS JOIN LATERAL (
    SELECT u.runid, u.running, u.wall_s FROM (
      (SELECT d.runid, false AS running, EXTRACT(epoch FROM (d.end_time - d.start_time)) AS wall_s
         FROM cron.job_run_details d
        WHERE d.jobid = j.jobid AND d.end_time IS NOT NULL
        ORDER BY d.start_time DESC LIMIT 1)
      UNION ALL
      (SELECT d.runid, true, EXTRACT(epoch FROM (clock_timestamp() - d.start_time))
         FROM cron.job_run_details d
        WHERE d.jobid = j.jobid AND d.end_time IS NULL
          AND d.status IN ('starting', 'running', 'sending', 'connecting')
          AND d.start_time > clock_timestamp() - interval '1 hour'
        ORDER BY d.start_time DESC LIMIT 1)
    ) u
    ORDER BY u.wall_s DESC LIMIT 1
  ) x
 WHERE j.schedule = '*/2 * * * *' AND j.active
 ORDER BY j.jobname`;

/** The breather's reading: each every-2-min watchdog's latest COMPLETED run, with its start on the DB clock. */
const Q_WATCHDOGS_COMPLETED = `
SELECT j.jobname, x.runid::text AS runid,
       (EXTRACT(epoch FROM x.start_time) * 1000)::float8 AS start_ms,
       EXTRACT(epoch FROM (x.end_time - x.start_time))::float8 AS wall_s
  FROM cron.job j
  CROSS JOIN LATERAL (
    SELECT d.runid, d.start_time, d.end_time
      FROM cron.job_run_details d
     WHERE d.jobid = j.jobid AND d.end_time IS NOT NULL
     ORDER BY d.start_time DESC LIMIT 1
  ) x
 WHERE j.schedule = '*/2 * * * *' AND j.active
 ORDER BY j.jobname`;

const Q_STARTUP_TIMEOUTS = `
SELECT count(*)::int AS n
  FROM cron.job_run_details d
 WHERE d.start_time >= $1::timestamptz
   AND d.status = 'failed'
   AND d.return_message ILIKE '%startup timeout%'`;

async function readWatchdogs(t: Client, since: string, callPid: number | null): Promise<WatchdogReading & { backend?: string }> {
  const at = new Date().toISOString();
  const wd = await t.query<{ jobname: string; runid: string; running: boolean; wall_s: number }>(Q_WATCHDOGS);
  const st = await t.query<{ n: number }>(Q_STARTUP_TIMEOUTS, [since]);
  let callBackendPresent: boolean | null = null;
  let backend: string | undefined;
  if (callPid !== null) {
    const a = await t.query<{ state: string; wait_event_type: string | null; wait_event: string | null; q: string }>(
      `SELECT state, wait_event_type, wait_event, left(query, 60) AS q FROM pg_stat_activity WHERE pid = $1`, [callPid]);
    callBackendPresent = a.rowCount! > 0;
    const r = a.rows[0];
    if (r) backend = `${r.state}/${r.wait_event_type ?? "-"}:${r.wait_event ?? "-"} "${r.q.replace(/\s+/g, " ")}"`;
  }
  return {
    at,
    walls: Object.fromEntries(wd.rows.map((r) => [r.jobname, Number(r.wall_s)])),
    runs: Object.fromEntries(wd.rows.map((r) => [r.jobname, { runid: r.runid, running: r.running }])),
    startupTimeouts: st.rows[0]?.n ?? 0,
    callBackendPresent,
    backend,
  };
}

/**
 * Rule 66, under the SESSION POOLER. cc-147: after C closed, Supavisor kept
 * the server backend (application_name Supavisor, state idle, last query
 * DISCARD ALL) — so "absent from pg_stat_activity" read STILL PRESENT for a
 * backend that was running nothing. What rule 66 asks is whether the CALL is
 * still running there. DISCARD ALL also resets the claimant GUC, so the pooled
 * backend cannot carry it to the next client.
 */
export function callNoLongerRunning(row: { state: string | null; query: string | null } | undefined): boolean {
  if (!row) return true;
  return row.state !== "active" && !/refresh_donor_party_rollup_incremental/i.test(row.query ?? "");
}

interface Snapshot {
  at: string;
  watermark: string | null;
  cursor: Record<string, unknown> | null;
  crawl_config: Record<string, unknown> | null;
  mv_rows: number | null;
  mv_sum_cents: string | null;
}

async function snapshot(c: Client, withMv: boolean): Promise<Snapshot> {
  const at = new Date().toISOString();
  const k = await c.query<{ key: string; value: Record<string, unknown> }>(
    `SELECT key, value FROM public.pipeline_state
      WHERE key IN ('donor_party_rollup_watermark', 'donor_party_full_rebuild', 'donor_party_crawl')`);
  const by = Object.fromEntries(k.rows.map((r) => [r.key, r.value]));
  let mv_rows: number | null = null;
  let mv_sum_cents: string | null = null;
  if (withMv) {
    const m = await c.query<{ n: string; s: string | null }>(
      "SELECT count(*)::text AS n, SUM(total_cents)::text AS s FROM public.donor_party_rollup_mv");
    mv_rows = Number(m.rows[0]!.n);
    mv_sum_cents = m.rows[0]!.s;
  }
  return {
    at,
    watermark: (by["donor_party_rollup_watermark"]?.["last_indexed_at"] as string | undefined) ?? null,
    cursor: by["donor_party_full_rebuild"] ?? null,
    crawl_config: by["donor_party_crawl"] ?? null,
    mv_rows,
    mv_sum_cents,
  };
}

async function readCallRow(c: Client, since: string): Promise<CallRow | null> {
  const r = await c.query<CallRow>(
    `SELECT id::text, status, started_at::text, completed_at::text, error_message, metadata
       FROM public.data_sync_log
      WHERE pipeline = $1 AND started_at >= $2::timestamptz
      ORDER BY started_at DESC LIMIT 1`, [PIPELINE, since]);
  return r.rows[0] ?? null;
}

/** The slice of cancellation-census.ts --json this runner reads. */
export interface CensusJson {
  cancellations?: { total: number; ratio: number; floor?: number; lambda?: number; pass?: boolean };
  edge?: { note: string; pass?: boolean };
  pass?: boolean;
  /** Exit 8's body (FIX-1219): the endpoint is gone, or a table/field it names is. */
  unavailable?: boolean;
  http_status?: number;
  /** The helper's detail; for a 200 it names what no longer exists (cc-156). */
  detail?: string;
}

/**
 * One census reading as one line — `pass|FAIL|dark (N/M min, ratio r, floor f; edge …)`.
 * Exit 0 pass · 1 FAIL · 8 unavailable (the endpoint is gone, FIX-1219) ·
 * anything else dark (the Logs API did not answer, or the child did not run),
 * which is what evaluateCensus counts as dark too.
 */
export function censusSummary(code: number, j: CensusJson | null, minutes: number): string {
  if (code === CENSUS_EXIT.unavailable) {
    // A removed path reads by its status (cc-154's wording, kept); a removed
    // table or field — a 200 — reads by the detail that names it (cc-156).
    if (j?.detail && j.http_status !== undefined && !isLogsEndpointGone(j.http_status)) {
      return `unavailable (FIX-1219 — ${j.detail})`;
    }
    return `unavailable (FIX-1219 — Logs API endpoint removed${j?.http_status ? `, HTTP ${j.http_status}` : ""})`;
  }
  if (code !== 0 && code !== 1) return `dark (exit ${code} — the Logs API did not answer)`;
  const head = code === 0 ? "pass" : "FAIL";
  if (!j) return `${head} (exit ${code}; unparsed output)`;
  const c = j.cancellations;
  const cPart = c
    ? `${c.total}/${minutes} min, ratio ${Number(c.ratio).toFixed(2)}, floor ${c.floor ?? "?"}${c.pass === false ? " — 57014 FAIL" : ""}`
    : "no 57014 reading";
  const ePart = j.edge ? `edge ${j.edge.note}${j.edge.pass === false ? " — edge FAIL" : ""}` : "no edge reading";
  return `${head} (${cPart}; ${ePart})`;
}

/**
 * The gate wait's census half from one reading (cc-151 D2; cc-154 D2). A pass
 * opens; a FAIL or dark holds. Exit 8 (the endpoint is gone, FIX-1219) opens
 * on the gate alone, as `skipped — local` does: there is no instrument to wait
 * on, and a removed endpoint is not a symptom of the box.
 */
export function censusHalfReading(code: number, summary: string): AlsoReading {
  return { name: "census", ok: code === 0 || code === CENSUS_EXIT.unavailable, summary };
}

/** cancellation-census.ts as a child process; resolves its exit code (2 on any launch failure). */
function runCensus(minutes: number, log: (l: string) => void): Promise<{ code: number; summary: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "tsx", ["src/scripts/cancellation-census.ts", "--minutes", String(minutes), "--json"],
      { cwd: DATA_DIR, env: process.env, shell: process.platform === "win32" },
    );
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", () => { /* the census prints its own diagnostics; the code is the verdict */ });
    const timer = setTimeout(() => { child.kill(); }, 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      log(`[census] launch failed: ${e.message}`);
      resolve({ code: 2, summary: censusSummary(2, null, minutes) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      let j: CensusJson | null = null;
      try { j = JSON.parse(out) as CensusJson; } catch { /* non-JSON: exit 2 paths print nothing to stdout */ }
      resolve({ code: code ?? 2, summary: censusSummary(code ?? 2, j, minutes) });
    });
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface CallRecord {
  n: number;
  units: number;
  pid: number;
  started_at: string;
  returned_at: string | null;
  wall_s: number | null;
  row: CallRow | null;
  verdict: string;
  watchdog_walls: { job: string; min: number; median: number; max: number; n: number; elevated: number }[];
  windows_done_after: number[] | null;
  error?: string;
}

interface BreatherRecord {
  before_call: number;
  started_at: string;
  released_at: string;
  waited_s: number;
  released_by: "walls" | "breather_timeout" | "stop";
  readings: number;
  walls_at_release: Record<string, { wall_s: number; runid: string }>;
  pending_at_release: string[];
}

export interface CensusRow {
  at: string;
  minutes: number;
  code: number;
  summary: string;
  phase: "gate" | "pre_call" | "cadence";
  before_call: number | null;
  /**
   * cc-152 D1: true when this reading would have tripped rule (3) in stop mode
   * and report mode recorded it instead. null on a gate row — the gate wait's
   * census half holds the window; it is not rule (3).
   */
  would_trip: boolean | null;
}

interface Receipt {
  runner: string;
  target: "prod" | "local";
  reason: string;
  args: RunnerArgs;
  pid: number;
  launched_at: string;
  finished_at: string | null;
  outcome: Outcome | null;
  exit_code: number | null;
  detail: string | null;
  gate: {
    polls: GatePoll[]; opened_at: string | null; opening_reading: ProdOpGate | null;
    /** The census half of the opening poll (cc-151 D2). */
    opening_census: AlsoReading | null;
    waited_seconds: number | null;
    /** On gate_timeout: the half that held the last poll. */
    last_blocked_by: string | null;
  };
  census: CensusRow[];
  claim: { claimed_at: string | null; released_at: string | null; state_after_arm: Partial<ProdSessionState> | null };
  pacing: { units_per_call: number; prior_value: Record<string, unknown> | null; upserts: number; restores: number; restored: boolean | null };
  resume: { windows_done_before: number[] | null; resuming_at: number | null; target_before: string | null } | null;
  calls: CallRecord[];
  breathers: BreatherRecord[];
  watchdog_series: WatchdogReading[];
  elevated_ticks: number;
  trip: {
    at: string; rule: Trip["rule"]; reason: string; call: number; job: string | null; run_ids: string[];
    cancel_sent: boolean; backend_gone_verified: boolean | null;
  } | null;
  caught_up_check: { cursor_gone: boolean; watermark: string | null; target: string | null; equal: boolean | null } | null;
  before: Snapshot | null;
  after: Snapshot | null;
  sum_ratio_after_over_before: number | null;
  cursor_last: Record<string, unknown> | null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function summarizeWalls(series: WatchdogReading[], wallTripS: number) {
  const by: Record<string, number[]> = {};
  for (const r of series) for (const [j, w] of Object.entries(r.walls)) (by[j] ??= []).push(w);
  return Object.entries(by).map(([job, ws]) => ({
    job, n: ws.length, min: Math.min(...ws), median: median(ws), max: Math.max(...ws),
    elevated: ws.filter((w) => w >= ELEVATED_FROM_S && w < wallTripS).length,
  }));
}

/**
 * A receipt never overwrites an existing file. cc-148: tonight's relaunch is
 * the same UTC day as cc-147's probe, and `${day}-fix1212-bootstrap-runner.md`
 * would have replaced its receipt — the record the relaunch's premise rests on.
 */
export function receiptPaths(
  target: "prod" | "local", launchedAt: string, tag: string | null,
  exists: (p: string) => boolean = fs.existsSync,
): { md: string; json: string } {
  const day = launchedAt.slice(0, 10);
  const base = `${day}-fix1212-bootstrap-runner${target === "local" ? "-local" : ""}${tag ? `-${tag}` : ""}`;
  const dir = path.join(REPO_ROOT, "docs", "audits");
  const at = (b: string) => ({ md: path.join(dir, `${b}.md`), json: path.join(dir, `${b}.json`) });
  const first = at(base);
  if (!exists(first.md) && !exists(first.json)) return first;
  const hms = launchedAt.slice(11, 19).replace(/:/g, "");
  return at(`${base}-${hms}Z`);
}

/** `N poll(s): G held by the gate, C by the census (D dark)` — which half held how often. */
export function gateTally(polls: readonly GatePoll[]): string {
  const byGate = polls.filter((p) => !p.ok && !(p.gate_ok ?? false)).length;
  const byCensus = polls.filter((p) => !p.ok && p.gate_ok === true).length;
  const dark = polls.filter((p) => p.also && /^dark/.test(p.also.summary)).length;
  const unavailable = polls.filter((p) => p.also && /^unavailable/.test(p.also.summary)).length;
  return `${polls.length} poll(s): ${byGate} held by the gate, ${byCensus} by the census (${dark} dark)` +
    (unavailable ? `; ${unavailable} read the census unavailable (FIX-1219) and opened on the gate alone` : "");
}

/** One receipt row per poll, naming the half that held it. */
export function pollLine(p: GatePoll): string {
  const census = p.also ? ` · census ${p.also.summary}`
    : p.gate_ok === undefined ? "" : " · census not read (gate blocked)";
  if (p.ok) return `- ${p.at} **OK**${census}`;
  if (p.gate_ok) return `- ${p.at} gate ok · **held by the census**${census}`;
  return `- ${p.at} held by the gate: ${p.blocked.join(", ")}${p.error ? ` (${p.error})` : ""}${census}`;
}

/** The log/receipt suffix of a reading report mode recorded instead of stopping on. */
export const WOULD_TRIP_NOTE = " — would have tripped rule (3); census mode report";

/** The receipt's `census mode` header row (cc-152 D1). */
export function censusModeLine(mode: CensusMode, rows: readonly CensusRow[]): string {
  const unavailable = rows.filter((c) => c.code === CENSUS_EXIT.unavailable).length;
  const rule3 = rows.filter((c) => c.phase !== "gate" && c.code !== CENSUS_EXIT.unavailable);
  const tail = unavailable
    ? ` · ${unavailable} census call(s) unavailable (exit 8, FIX-1219) — not readings, never a trip`
    : "";
  if (mode === "stop") {
    return "stop — rule (3) pass=false stops the run; the dark-twice trip is armed; the gate wait's census half holds the window" + tail;
  }
  return "report — rule (3) pass=false is recorded, not a stop " +
    `(${rule3.filter((c) => c.would_trip === true).length} of ${rule3.length} rule (3) reading(s) would have tripped); ` +
    "the dark-twice trip stays armed; the gate wait's census half still holds the window" + tail;
}

/** One receipt line per census reading. */
export function censusLine(c: CensusRow): string {
  const where = c.phase === "gate" ? "gate poll" : c.phase === "pre_call" ? `before CALL ${c.before_call}` : "cadence";
  return `- ${c.at} (${c.minutes} min, ${where}) exit ${c.code}: ${c.summary}${c.would_trip ? ` — **would_trip**${WOULD_TRIP_NOTE}` : ""}`;
}

function renderReceipt(r: Receipt): string {
  const L: string[] = [];
  const f = (x: number | null | undefined, d = 1) => (x == null || Number.isNaN(x) ? "—" : x.toFixed(d));
  L.push(`# FIX-1212 bootstrap runner — ${r.outcome ?? "(unfinished)"} (${r.target})`);
  L.push("");
  L.push(`Written by \`packages/data/src/scripts/donor-party-bootstrap-runner.ts\` in its \`finally\`. Machine copy: the \`.json\` beside this file.`);
  L.push("");
  L.push("| | |");
  L.push("|---|---|");
  L.push(`| outcome | **${r.outcome ?? "—"}** (exit ${r.exit_code ?? "—"}) |`);
  L.push(`| vocabulary | ${vocabularyLine()} |`);
  L.push(`| detail | ${r.detail ?? "—"} |`);
  L.push(`| launched / finished | ${r.launched_at} / ${r.finished_at ?? "—"} |`);
  L.push(`| pid | ${r.pid} |`);
  L.push(`| args | \`${JSON.stringify(r.args)}\` |`);
  L.push(`| census mode | ${censusModeLine(r.args.censusMode, r.census)} |`);
  L.push(`| gate | ${gateTally(r.gate.polls)}; opened ${r.gate.opened_at ?? "never"} after ${f(r.gate.waited_seconds != null ? r.gate.waited_seconds / 60 : null)} min` +
    `${r.gate.opening_census ? ` · census at opening: ${r.gate.opening_census.summary}` : ""}` +
    `${r.gate.last_blocked_by ? ` · last poll held by ${r.gate.last_blocked_by}` : ""} |`);
  L.push(`| claim | ${r.claim.claimed_at ?? "—"} → released ${r.claim.released_at ?? "—"} |`);
  L.push(`| pacing | max_units ${r.pacing.units_per_call} per CALL; prior value ${JSON.stringify(r.pacing.prior_value)}; ${r.pacing.upserts} upsert(s), ${r.pacing.restores} restore(s); restored to prior: ${r.pacing.restored ?? "—"} |`);
  L.push(`| resume | ${r.resume ? `windows_done before ${JSON.stringify(r.resume.windows_done_before)} · resuming at window ${r.resume.resuming_at ?? "—"} · target ${r.resume.target_before ?? "—"}` : "no cursor (a fresh cycle, or crawl)"} |`);
  L.push(`| before | watermark ${r.before?.watermark ?? "—"} · cursor ${r.before?.cursor ? "present" : "absent"} · MV ${r.before?.mv_rows ?? "—"} rows / SUM ${r.before?.mv_sum_cents ?? "—"} |`);
  L.push(`| after | watermark ${r.after?.watermark ?? "—"} · cursor ${r.after?.cursor ? JSON.stringify(r.after.cursor) : "absent"} · crawl row ${r.after?.crawl_config ? JSON.stringify(r.after.crawl_config) : "absent"} · MV ${r.after?.mv_rows ?? "—"} rows / SUM ${r.after?.mv_sum_cents ?? "—"} |`);
  L.push(`| SUM after / before | ${r.sum_ratio_after_over_before == null ? "—" : r.sum_ratio_after_over_before.toFixed(6)} |`);
  L.push(`| caught_up check | ${r.caught_up_check ? `cursor gone ${r.caught_up_check.cursor_gone} · watermark ${r.caught_up_check.watermark} = target ${r.caught_up_check.target}: ${r.caught_up_check.equal}` : "—"} |`);
  L.push(`| elevated ticks | ${r.elevated_ticks} reading(s) with a watchdog wall in [${ELEVATED_FROM_S}, ${r.args.wallTripS}) s |`);
  L.push(`| trip | ${r.trip ? `${r.trip.at} call ${r.trip.call}: rule (${r.trip.rule}) ${r.trip.reason}${r.trip.run_ids.length ? `; runs ${r.trip.run_ids.join(", ")}` : ""}; cancel sent ${r.trip.cancel_sent}; backend gone verified ${r.trip.backend_gone_verified}` : "none"} |`);
  L.push("");
  L.push("## Gate polls (both halves — cc-151 D2)");
  L.push("");
  for (const p of r.gate.polls) L.push(pollLine(p));
  L.push("");
  L.push("## CALLs");
  L.push("");
  L.push("| # | max_units | pid | started | wall s | status | mode | windows_run | windows_done after | stage_seconds | apply_seconds | error / cancel | data_sync_log id |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of r.calls) {
    const md = c.row?.metadata ?? {};
    L.push(`| ${c.n} | ${c.units} | ${c.pid} | ${c.started_at} | ${f(c.wall_s)} | ${c.row?.status ?? "—"} | ${String(md["mode"] ?? "—")} | ` +
      `${JSON.stringify(md["windows_run"] ?? null)} | ${JSON.stringify(c.windows_done_after)} | ${JSON.stringify(md["stage_seconds"] ?? null)} | ${JSON.stringify(md["apply_seconds"] ?? null)} | ` +
      `${String(md["cancel_detail"] ?? c.row?.error_message ?? c.error ?? "")} | ${c.row?.id ?? "—"} |`);
  }
  L.push("");
  L.push("## Watchdog walls per CALL (s)");
  L.push("");
  for (const c of r.calls) {
    L.push(`- CALL ${c.n}: ${c.watchdog_walls.map((w) => `${w.job} n=${w.n} min ${w.min.toFixed(3)} / median ${w.median.toFixed(3)} / max ${w.max.toFixed(3)} (elevated ${w.elevated})`).join("; ") || "(no readings)"}`);
  }
  L.push("");
  L.push("## Breathers");
  L.push("");
  L.push("| before CALL | started | released | waited s | released by | readings | walls at release | pending at release |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const b of r.breathers) {
    L.push(`| ${b.before_call} | ${b.started_at} | ${b.released_at} | ${f(b.waited_s)} | ${b.released_by} | ${b.readings} | ` +
      `${Object.entries(b.walls_at_release).map(([j, w]) => `${j} ${w.wall_s.toFixed(3)} (run ${w.runid})`).join("; ")} | ${b.pending_at_release.join("; ")} |`);
  }
  if (r.breathers.length === 0) L.push("| — | | | | | | | |");
  L.push("");
  L.push("## Census");
  L.push("");
  for (const c of r.census) L.push(censusLine(c));
  if (r.census.length === 0) L.push("- (none)");
  L.push("");
  L.push("## Cursor at the end");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(r.cursor_last, null, 2));
  L.push("```");
  L.push("");
  return L.join("\n");
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]!.replace(/^\/\*\*|^ \* ?/gm, ""));
    return 0;
  }
  const parsed = parseRunnerArgs(argv);
  if ("error" in parsed) { console.error(`✗ ${parsed.error}`); return 64; }
  const args = parsed;

  const dbUrl = buildDbUrl();
  const target: "prod" | "local" = /127\.0\.0\.1|localhost/.test(dbUrl) ? "local" : "prod";
  const log = (l: string) => console.log(`${new Date().toISOString().slice(11, 19)}Z ${l}`);
  const launchedAt = new Date().toISOString();
  const paths = receiptPaths(target, launchedAt, args.receiptTag);

  const R: Receipt = {
    runner: "donor-party-bootstrap-runner", target, reason: REASON, args, pid: process.pid,
    launched_at: launchedAt, finished_at: null, outcome: null, exit_code: null, detail: null,
    gate: { polls: [], opened_at: null, opening_reading: null, opening_census: null, waited_seconds: null, last_blocked_by: null },
    census: [], claim: { claimed_at: null, released_at: null, state_after_arm: null },
    pacing: { units_per_call: args.unitsPerCall, prior_value: null, upserts: 0, restores: 0, restored: null },
    resume: null, calls: [], breathers: [], watchdog_series: [], elevated_ticks: 0, trip: null,
    caught_up_check: null, before: null, after: null, sum_ratio_after_over_before: null, cursor_last: null,
  };
  const finish = (o: Outcome, detail: string): void => {
    if (R.outcome !== null) return;   // the first verdict stands
    R.outcome = o; R.detail = detail; R.exit_code = EXIT[o];
  };
  const writeReceipt = (): void => {
    try {
      fs.mkdirSync(path.dirname(paths.md), { recursive: true });
      fs.writeFileSync(paths.json, JSON.stringify(R, null, 2) + "\n");
      fs.writeFileSync(paths.md, renderReceipt(R));
      log(`[runner] receipt written: ${paths.md}`);
    } catch (e) {
      log(`[runner] RECEIPT WRITE FAILED: ${errText(e)}\n${JSON.stringify(R)}`);
    }
  };
  const recordTrip = (t: Trip, call: number): void => {
    R.trip ??= {
      at: new Date().toISOString(), rule: t.rule, reason: t.reason, call, job: t.job ?? null,
      run_ids: t.run_ids ?? [], cancel_sent: false, backend_gone_verified: null,
    };
  };
  const wallsLine = (w: Record<string, number>): string =>
    Object.entries(w).map(([j, s]) => `${j}=${s.toFixed(3)}s${s >= ELEVATED_FROM_S && s < args.wallTripS ? "(elevated)" : ""}`).join(" ");
  const noteReading = (r: WatchdogReading): void => {
    if (elevatedJobs(r.walls, args.wallTripS).length > 0) R.elevated_ticks += 1;
  };

  log(`[runner] target ${target} (${dbUrl.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@")}) · pid ${process.pid}`);
  log(`[runner] receipt → ${paths.md}`);
  log(`[runner] args ${JSON.stringify(args)}`);

  // Shared with the signal path.
  let callClient: Client | null = null;
  let callPid: number | null = null;
  let inCall = false;
  let stopping: Trip | null = null;
  const tClient = new Client({ connectionString: dbUrl, application_name: `${APP}_ticker` });
  const stopState = newStopState();

  const signalBackend = async (fn: "pg_cancel_backend" | "pg_terminate_backend", why: string): Promise<boolean> => {
    if (callPid === null || !inCall) return false;
    log(`[stop] ${why} — ${fn}(${callPid}) from the ticker connection`);
    try {
      const r = await tClient.query<{ ok: boolean }>(`SELECT ${fn}($1) AS ok`, [callPid]);
      return r.rows[0]?.ok === true;
    } catch (e) {
      log(`[stop] ${fn} failed: ${errText(e)}`);
      return false;
    }
  };

  // D2 — the crawl row is restored to exactly its prior value after EVERY
  // CALL and again in `finally`; idempotent. On the ticker connection: C may
  // be the thing that just died.
  let crawlDirty = false;
  const restoreCrawl = async (): Promise<void> => {
    if (!crawlDirty) return;
    try {
      if (R.pacing.prior_value === null) {
        await tClient.query("DELETE FROM public.pipeline_state WHERE key = 'donor_party_crawl'");
      } else {
        await tClient.query(
          `UPDATE public.pipeline_state SET value = $1::jsonb, updated_at = clock_timestamp() WHERE key = 'donor_party_crawl'`,
          [JSON.stringify(R.pacing.prior_value)]);
      }
      crawlDirty = false;
      R.pacing.restores += 1;
      R.pacing.restored = true;
      log(`[pacing] donor_party_crawl restored to ${JSON.stringify(R.pacing.prior_value)}`);
    } catch (e) {
      R.pacing.restored = false;
      log(`[pacing] RESTORE FAILED: ${errText(e)}`);
    }
  };

  let signalled = false;
  const onSignal = (sig: string) => {
    if (signalled) return;
    signalled = true;
    stopping = { rule: 4, reason: `${sig} received` };
    if (R.claim.claimed_at === null) {
      // Nothing held and nothing running: the gate wait cannot be interrupted
      // from here, so record and leave. The session lock, if the claim were
      // mid-flight, goes with the process's backend.
      log(`[runner] ${sig} before the claim — receipt and exit`);
      finish("stopped", `${sig} during the gate wait; nothing claimed, nothing CALLed`);
      R.finished_at = new Date().toISOString();
      writeReceipt();
      process.exit(EXIT.stopped);
    }
    log(`[runner] ${sig} — cancelling any CALL in flight; no further CALL; the receipt follows`);
    void signalBackend("pg_cancel_backend", sig);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // ── the breather (D2) — between CALLs, never a trip on its own ────────────
  const breathe = async (beforeCall: number, returnedAtMs: number, stSince: string): Promise<void> => {
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    let readings = 0;
    let last: CompletedRun[] = [];
    let verdict = { released: false, pending: ["(no reading yet)"] };
    let by: BreatherRecord["released_by"] = "breather_timeout";
    for (;;) {
      try {
        const q = await tClient.query<CompletedRun>(Q_WATCHDOGS_COMPLETED);
        last = q.rows.map((x) => ({ ...x, start_ms: Number(x.start_ms), wall_s: Number(x.wall_s) }));
        verdict = breatherRelease(last, returnedAtMs, args.breatherUntilWallS);
        // The stop rule still reads during a breather — a startup timeout or a
        // >= wall-trip-s wall on two distinct runs stops before the next CALL.
        // The test-only trip never fires here (armed: false): it exists to land
        // a cancel INSIDE a CALL.
        const r = await readWatchdogs(tClient, stSince, null);
        noteReading(r);
        readings += 1;
        const trip = evaluateWatchdogs(stopState, r, { wallTripS: args.wallTripS, tripOnWallMs: args.tripOnWallMs, armed: false });
        log(`[breather] before CALL ${beforeCall} +${Math.round((Date.now() - t0) / 1000)}s: ${wallsLine(r.walls)} ` +
          `startup_timeouts=${r.startupTimeouts} ${verdict.released ? "RELEASED" : `waiting: ${verdict.pending.join("; ")}`}`);
        if (trip && !stopping) { stopping = trip; recordTrip(trip, beforeCall); }
      } catch (e) {
        log(`[breather] reading failed: ${errText(e)}`);
      }
      if (stopping) { by = "stop"; break; }
      if (verdict.released) { by = "walls"; break; }
      const left = args.breatherMaxS * 1000 - (Date.now() - t0);
      if (left <= 0) { by = "breather_timeout"; break; }
      await sleep(Math.min(BREATHER_READ_S * 1000, left));
    }
    const rec: BreatherRecord = {
      before_call: beforeCall, started_at: startedAt, released_at: new Date().toISOString(),
      waited_s: (Date.now() - t0) / 1000, released_by: by, readings,
      walls_at_release: Object.fromEntries(last.map((x) => [x.jobname, { wall_s: x.wall_s, runid: x.runid }])),
      pending_at_release: verdict.released ? [] : verdict.pending,
    };
    R.breathers.push(rec);
    log(`[breather] before CALL ${beforeCall}: ${by} after ${rec.waited_s.toFixed(1)} s`);
  };

  // ── everything that runs under the claim (steps 4-6) ───────────────────────
  const underClaim = async (): Promise<void> => {
    const c = new Client({ connectionString: dbUrl, application_name: APP });
    callClient = c;
    await c.connect();
    await c.query("SET statement_timeout = '40min'");
    await c.query("SET lock_timeout = '60s'");
    await c.query(`SET civitics.prod_session_claimant = '${REASON.replace(/'/g, "''")}'`);
    const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    callPid = pid;
    const s = (await c.query<{ s: ProdSessionState & { claimant: string | null; claimant_bypass: boolean } }>(
      "SELECT public.prod_session_state() AS s")).rows[0]!.s;
    R.claim.state_after_arm = s;
    log(`[arm] C pid ${pid}: held=${s.held} defer=${s.defer} claimant_bypass=${s.claimant_bypass} label_pid=${s.pid} reason_text="${s.reason_text}"`);
    if (!(s.held === true && s.defer === false && s.claimant_bypass === true && s.pid === process.pid)) {
      finish("skipped", `FIX-1213 assertion failed before any CALL: ${JSON.stringify(s)}`);
      return;
    }

    R.before = await snapshot(c, true);
    log(`[before] watermark ${R.before.watermark} · cursor ${R.before.cursor ? JSON.stringify(R.before.cursor) : "absent"} · crawl_config ${JSON.stringify(R.before.crawl_config)} · MV ${R.before.mv_rows} / SUM ${R.before.mv_sum_cents}`);
    R.pacing.prior_value = R.before.crawl_config;
    // D3 — resume is the normal case. Read, log, never touch.
    if (R.before.cursor) {
      const wd = Array.isArray(R.before.cursor["windows_done"]) ? (R.before.cursor["windows_done"] as unknown[]).map(Number) : [];
      R.resume = {
        windows_done_before: wd,
        resuming_at: resumeWindow(R.before.cursor),
        target_before: (R.before.cursor["target"] as string | undefined) ?? null,
      };
      log(`[resume] resuming at window ${R.resume.resuming_at} (windows_done ${JSON.stringify(wd)}, target ${R.resume.target_before}, cycle started ${String(R.before.cursor["started_at"])})`);
    } else {
      log("[resume] no cursor — the procedure decides the mode afresh");
    }

    let lastCensusAt = Date.now();
    let censusBusy = false;
    const maybeCensus = () => {
      if (target !== "prod" || censusBusy || Date.now() - lastCensusAt < 15 * 60_000) return;
      censusBusy = true;
      lastCensusAt = Date.now();
      void runCensus(15, log).then((cen) => {
        censusBusy = false;
        const v = evaluateCensus(stopState, cen.code, args.censusMode);
        const wouldTrip = v !== null && !isTrip(v);
        R.census.push({ at: new Date().toISOString(), minutes: 15, code: cen.code, summary: cen.summary, phase: "cadence", before_call: null, would_trip: wouldTrip });
        log(`[census] 15 min: ${cen.summary}${wouldTrip ? WOULD_TRIP_NOTE : ""}`);
        const trip = isTrip(v) ? v : null;
        if (trip && !stopping) {
          stopping = trip;
          if (inCall) {
            recordTrip(trip, R.calls.length);
            void signalBackend("pg_cancel_backend", trip.reason).then((ok) => { if (R.trip) R.trip.cancel_sent = ok; });
          }
        }
      });
    };

    let prevSince: string | null = null;
    let returnedAtMs: number | null = null;
    let cycleTarget: string | null = R.resume?.target_before ?? null;
    for (let n = 1; n <= args.maxCalls; n++) {
      const armed = n >= args.tripFromCall;

      // a. The breather, from CALL 2.
      if (n > 1 && returnedAtMs !== null && prevSince !== null) {
        await breathe(n, returnedAtMs, prevSince);
      }
      if (stopping) {
        const t = stopping as Trip;
        recordTrip(t, n);
        finish("stopped", `stop rule before CALL ${n}: ${t.reason}`);
        return;
      }

      // b. The census before EVERY CALL (prod), after the breather.
      if (target === "prod") {
        while (censusBusy) await sleep(1000);   // a cadence census still in flight
        const cen = await runCensus(15, log);
        lastCensusAt = Date.now();
        const v = evaluateCensus(stopState, cen.code, args.censusMode);
        const wouldTrip = v !== null && !isTrip(v);
        R.census.push({ at: new Date().toISOString(), minutes: 15, code: cen.code, summary: cen.summary, phase: "pre_call", before_call: n, would_trip: wouldTrip });
        log(`[census] pre-CALL ${n} 15 min: ${cen.summary}${wouldTrip ? WOULD_TRIP_NOTE : ""}`);
        if (isTrip(v)) {
          recordTrip(v, n);
          finish("stopped", `stop rule before CALL ${n}: ${v.reason}`);
          return;
        }
      }

      const since = (await c.query<{ t: string }>("SELECT clock_timestamp()::text AS t")).rows[0]!.t;

      // The stop rule once BEFORE each CALL. Startup timeouts are counted from
      // the previous CALL's start, so one during a breather is not missed.
      const pre = await readWatchdogs(tClient, prevSince ?? since, null);
      R.watchdog_series.push(pre);
      noteReading(pre);
      const preTrip = evaluateWatchdogs(stopState, pre, { wallTripS: args.wallTripS, tripOnWallMs: args.tripOnWallMs, armed });
      log(`[tick] pre-CALL ${n}: ${wallsLine(pre.walls)} startup_timeouts=${pre.startupTimeouts}`);
      if (preTrip || stopping) {
        const t = (preTrip ?? stopping)!;
        recordTrip(t, n);
        finish("stopped", `stop rule before CALL ${n}: ${t.reason}`);
        return;
      }

      // c. The pacing row, before every CALL.
      await c.query(
        `INSERT INTO public.pipeline_state (key, value) VALUES ('donor_party_crawl', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
        [JSON.stringify({ max_units: args.unitsPerCall })]);
      crawlDirty = true;
      R.pacing.upserts += 1;
      log(`[pacing] donor_party_crawl = {"max_units": ${args.unitsPerCall}} (prior: ${JSON.stringify(R.pacing.prior_value)})`);

      const rec: CallRecord = {
        n, units: args.unitsPerCall, pid, started_at: since, returned_at: null, wall_s: null, row: null,
        verdict: "", watchdog_walls: [], windows_done_after: null,
      };
      R.calls.push(rec);
      const callSeries: WatchdogReading[] = [pre];
      log(`[call ${n}] ${CALL_SQL} (max_units ${args.unitsPerCall}) on pid ${pid}`);
      const t0 = Date.now();
      inCall = true;
      let callErr: unknown = null;
      let done = false;
      const callP = c.query(CALL_SQL).then(
        () => { done = true; },
        (e: unknown) => { callErr = e; done = true; },
      );

      // d. The ticker, while the CALL is in flight.
      let cancelAt: number | null = null;
      let recancelled = false;
      let terminated = false;
      while (!done) {
        const woke = await Promise.race([
          callP.then(() => "done" as const),
          new Promise<"tick">((res) => setTimeout(() => res("tick"), args.tickSeconds * 1000)),
        ]);
        if (woke === "done" || done) break;
        try {
          const r = await readWatchdogs(tClient, since, pid);
          R.watchdog_series.push(r);
          callSeries.push(r);
          noteReading(r);
          const trip = evaluateWatchdogs(stopState, r, { wallTripS: args.wallTripS, tripOnWallMs: args.tripOnWallMs, armed });
          log(`[tick] CALL ${n} +${Math.round((Date.now() - t0) / 1000)}s: ${wallsLine(r.walls)} startup_timeouts=${r.startupTimeouts} backend=${r.backend ?? "GONE"}`);
          maybeCensus();
          const why: Trip | null = trip ?? stopping;
          if (why && cancelAt === null) {
            stopping = why;
            recordTrip(why, n);
            const ok = await signalBackend("pg_cancel_backend", why.reason);
            if (R.trip) R.trip.cancel_sent = ok;
            cancelAt = Date.now();
          } else if (cancelAt !== null && !recancelled && Date.now() - cancelAt > 5 * 60_000) {
            recancelled = true;
            await signalBackend("pg_cancel_backend", "the first cancel has not landed after 5 min");
          } else if (cancelAt !== null && !terminated && Date.now() - cancelAt > 10 * 60_000) {
            terminated = true;
            await signalBackend("pg_terminate_backend", "no cancel has landed after 10 min");
          }
        } catch (e) {
          log(`[tick] reading failed: ${errText(e)}`);
        }
      }
      await callP;
      inCall = false;
      rec.returned_at = new Date().toISOString();
      rec.wall_s = (Date.now() - t0) / 1000;
      rec.watchdog_walls = summarizeWalls(callSeries, args.wallTripS);
      if (callErr) rec.error = errText(callErr);
      prevSince = since;
      returnedAtMs = await tClient.query<{ ms: number }>("SELECT (EXTRACT(epoch FROM clock_timestamp()) * 1000)::float8 AS ms")
        .then((q) => Number(q.rows[0]!.ms), () => Date.now());

      await restoreCrawl();

      if (callErr) {
        log(`[call ${n}] ERROR after ${rec.wall_s.toFixed(1)} s: ${rec.error}`);
        rec.row = await readCallRow(tClient, since).catch(() => null);
        rec.verdict = `error: ${rec.error}`;
        finish("stopped", `CALL ${n} raised: ${rec.error}${stopping ? ` (after trip: ${(stopping as Trip).reason})` : ""}`);
        return;
      }

      const row = await readCallRow(c, since);
      rec.row = row;
      const md = row?.metadata ?? {};
      if (Array.isArray(md["windows_done"])) rec.windows_done_after = (md["windows_done"] as unknown[]).map(Number);
      if (typeof md["cycle_target"] === "string") cycleTarget ??= md["cycle_target"] as string;
      log(`[call ${n}] returned in ${rec.wall_s.toFixed(1)} s: status=${row?.status} mode=${md["mode"]} windows_run=${JSON.stringify(md["windows_run"])} ` +
        `windows_done=${JSON.stringify(md["windows_done"])} stage_s=${JSON.stringify(md["stage_seconds"])} apply_s=${JSON.stringify(md["apply_seconds"])} ` +
        `caught_up=${md["caught_up"]} err="${row?.error_message ?? ""}" id=${row?.id}`);
      const v = classifyCallRow(row, n, args.maxCalls);
      rec.verdict = v.action === "continue" ? `continue: ${v.detail}` : `${v.outcome}: ${v.detail}`;
      if (stopping && v.action !== "done") {
        finish("stopped", `stop rule during CALL ${n}: ${(stopping as Trip).reason}; the CALL closed ${row?.status} (${String(md["cancel_detail"] ?? row?.error_message ?? "")})`);
        return;
      }
      if (v.action === "done") {
        // D3 — assert, don't trust: the cursor is gone and the watermark IS the target.
        const q = await c.query<{ cursor_gone: boolean; watermark: string | null; equal: boolean | null }>(
          `SELECT NOT EXISTS (SELECT 1 FROM public.pipeline_state WHERE key = 'donor_party_full_rebuild') AS cursor_gone,
                  (SELECT value->>'last_indexed_at' FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark') AS watermark,
                  (SELECT (value->>'last_indexed_at')::timestamptz = $1::timestamptz
                     FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark') AS equal`, [cycleTarget]);
        const chk = { ...q.rows[0]!, target: cycleTarget };
        R.caught_up_check = chk;
        const bad = caughtUpMismatch(chk);
        log(`[caught_up] cursor_gone=${chk.cursor_gone} watermark ${chk.watermark} target ${chk.target} equal=${chk.equal}${bad ? ` — MISMATCH: ${bad}` : ""}`);
        if (bad) { finish("error", `the CALL reported caught_up but ${bad}`); return; }
        finish("caught_up", `${v.detail} after ${n} CALL(s)`);
        return;
      }
      if (v.action === "stop") { finish(v.outcome, v.detail); return; }
    }
    finish("max_calls", `--max-calls ${args.maxCalls} exhausted`);
  };

  const run = async (): Promise<void> => {
    await tClient.connect();
    await tClient.query("SET statement_timeout = '30s'");
    const deadline = Date.now() + args.maxWaitMinutes * 60_000;
    // cc-151 D2 — the census half of every poll, read only when the gate is
    // open. It never throws: the Logs API dark is exit 2 → `dark` → not open.
    const censusHalf = async (): Promise<AlsoReading> => {
      if (target !== "prod") return { name: "census", ok: true, summary: "skipped — local (no Logs API)" };
      const cen = await runCensus(60, log);
      R.census.push({ at: new Date().toISOString(), minutes: 60, code: cen.code, summary: cen.summary, phase: "gate", before_call: null, would_trip: null });
      return censusHalfReading(cen.code, cen.summary);
    };
    for (;;) {
      // ── 1. wait for the window: the gate AND the census on the same poll ──
      let opened;
      try {
        opened = await waitForProdOpGate({
          dbUrl, expectedSeconds: args.expectedMinutes * 60, pollSeconds: args.pollSeconds,
          maxWaitSeconds: Math.max(1, (deadline - Date.now()) / 1000), log,
          andAlso: { name: "census", read: censusHalf },
        });
      } catch (e) {
        if (e instanceof GateTimeout) {
          R.gate.polls.push(...e.polls);
          R.gate.last_blocked_by = e.lastBlockedBy;
          finish("gate_timeout", e.message);
          return;
        }
        throw e;
      }
      R.gate.polls.push(...opened.polls);
      R.gate.opened_at = opened.gate.checked_at;
      R.gate.opening_reading = opened.gate;
      R.gate.opening_census = opened.also;
      R.gate.waited_seconds = (Date.now() - Date.parse(launchedAt)) / 1000;
      log(`[gate] open: gate ok at ${opened.gate.checked_at}; census ${opened.also?.summary ?? "—"}`);

      // ── 3. claim; 4-6 under it; release in withProdSession's finally ─────
      try {
        await withProdSession({ reason: REASON, expectedMinutes: args.expectedMinutes, dbUrl }, async () => {
          R.claim.claimed_at = new Date().toISOString();
          log(`[claim] held — reason "${REASON}"`);
          try {
            await underClaim();
          } finally {
            await restoreCrawl();
            // Close C and verify the CALL is no longer running (rule 66)
            // BEFORE the release, so the session never ends with our CALL live.
            const cc = callClient;
            if (cc) await cc.end().catch(() => { /* best effort */ });
            if (callPid !== null) {
              let gone = false;
              let seen = "absent";
              for (let i = 0; i < 30 && !gone; i++) {
                const r = await tClient.query<{ state: string | null; query: string | null; application_name: string | null }>(
                  "SELECT state, query, application_name FROM pg_stat_activity WHERE pid = $1", [callPid]).catch(() => null);
                const row = r?.rows[0];
                seen = row ? `${row.application_name}/${row.state} "${(row.query ?? "").slice(0, 40)}"` : "absent";
                gone = r !== null && callNoLongerRunning(row);
                if (!gone) await sleep(1000);
              }
              log(`[runner] CALL backend ${callPid}: ${gone ? "no longer running the CALL" : "STILL RUNNING it after 30 s"} (${seen})`);
              if (R.trip) R.trip.backend_gone_verified = gone;
            }
          }
        });
      } catch (e) {
        if (e instanceof ProdSessionRefused) {
          log(`[claim] REFUSED (${e.verdict.code}): ${e.verdict.detail} — back to waiting`);
          if (Date.now() >= deadline) {
            finish("gate_timeout", `the claim was refused and the wait is over: ${e.verdict.detail}`);
            return;
          }
          continue;
        }
        throw e;
      }
      R.claim.released_at = new Date().toISOString();
      log("[claim] released");
      return;
    }
  };

  try {
    await run();
  } catch (e) {
    finish("error", errText(e));
    log(`[runner] ERROR: ${errText(e)}`);
  } finally {
    if (R.claim.claimed_at && !R.claim.released_at) R.claim.released_at = new Date().toISOString();
    try {
      const snapC = new Client({ connectionString: dbUrl, application_name: `${APP}_after` });
      await snapC.connect();
      await snapC.query("SET statement_timeout = '5min'");
      if (crawlDirty) {
        // The last resort: tClient may be the thing that died.
        if (R.pacing.prior_value === null) {
          await snapC.query("DELETE FROM public.pipeline_state WHERE key = 'donor_party_crawl'");
        } else {
          await snapC.query(`UPDATE public.pipeline_state SET value = $1::jsonb, updated_at = clock_timestamp() WHERE key = 'donor_party_crawl'`,
            [JSON.stringify(R.pacing.prior_value)]);
        }
        crawlDirty = false;
        R.pacing.restores += 1;
        R.pacing.restored = true;
        log(`[pacing] donor_party_crawl restored in finally to ${JSON.stringify(R.pacing.prior_value)}`);
      }
      R.after = await snapshot(snapC, R.calls.length > 0);
      const pss = (await snapC.query<{ s: ProdSessionState }>("SELECT public.prod_session_state() AS s")).rows[0]!.s;
      const lingering = await snapC.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", [APP]);
      log(`[after] watermark ${R.after.watermark} · cursor ${R.after.cursor ? JSON.stringify(R.after.cursor) : "absent"} · crawl_config ${JSON.stringify(R.after.crawl_config)} · MV ${R.after.mv_rows} / SUM ${R.after.mv_sum_cents} · session held=${pss.held} label_present=${pss.label_present} · ${APP} backends=${lingering.rows[0]?.n}`);
      await snapC.end();
    } catch (e) {
      log(`[after] reads failed: ${errText(e)}`);
    }
    await tClient.end().catch(() => { /* best effort */ });
    R.cursor_last = R.after?.cursor ?? null;
    if (R.before?.mv_sum_cents && R.after?.mv_sum_cents) {
      R.sum_ratio_after_over_before = Number(R.after.mv_sum_cents) / Number(R.before.mv_sum_cents);
    }
    finish("error", "the runner ended without an outcome");
    R.finished_at = new Date().toISOString();
    writeReceipt();
    log(`[runner] outcome ${R.outcome} — exit ${R.exit_code}: ${R.detail}`);
  }
  return R.exit_code ?? 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => { console.error(err); process.exit(1); },
  );
}
