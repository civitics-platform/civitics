/**
 * FIX-1212 / FIX-1215 — the unattended donor-party bootstrap runner.
 *
 *   pnpm --filter @civitics/data data:donor-party:bootstrap:prod \
 *     --units-per-call 2 --wall-trip-s 3.0 --breather-until-wall-s 0.5 \
 *     --breather-max-s 600 --max-calls 12 --expected-minutes 60 --max-wait-minutes 600 \
 *     --renders-per-call-max 3
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
 *                AND (prod, FIX-1232) the census, read ONCE when the walls
 *                release, shows no render lost since the CALL returned; a
 *                render keeps it open, re-read no sooner than 60 s later. Or
 *                --breather-max-s elapses: with the walls still holding it
 *                PROCEEDS (`breather_timeout`); with the census still holding
 *                it (FIX-1234 D3, `breather_timeout_census`) it is a rule (3)
 *                stop in stop mode and a would_trip in report mode.
 *                cc-147 measured the recovery: 1.341 → 0.612 / 0.061 s within
 *                one minute of the probe CALL ending.
 *             b. CENSUS (prod) --minutes 15 before EVERY CALL: from CALL 2 it
 *                is the reading the breather ended on (reordered, not added —
 *                a 0-render breather costs no Logs call it did not before).
 *                The CALL just finished is judged on its own span against
 *                --renders-per-call-max (default 3) here.
 *             c. pipeline_state.donor_party_crawl ← {"max_units":
 *                --units-per-call} MERGED in before the CALL (FIX-1249: the
 *                key's other fields, e.g. full_rebuild_lag_days, survive) and
 *                restored to the full prior value (ABSENT → DELETE, never
 *                "defaults") after it — and again in `finally`.
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
 *   (3) the front door, in RENDERS (FIX-1232 — a render is a second with at
 *       least one statement timeout; one page's 4–6 fanned-out reads count
 *       once). Three readings, three jobs:
 *         - pre-CALL (15 min): a FAIL stops, in BOTH census modes. The 57014
 *           half is judged on the minutes OUTSIDE the CALL spans (FIX-1234 D2
 *           — the trailing 15 min holds ~2.5 CALLs, which the budget below
 *           already judges) and fails only above the Poisson P99 floor of the
 *           baseline in renders over those minutes. The edge half fails only
 *           above 1 % AND the binomial floor at p0 (FIX-1233).
 *         - the CALL window: every 15 min while a CALL runs (its span so far,
 *           one --renders-only read) and once it has returned (its whole
 *           span), renders against --renders-per-call-max. Over budget is a
 *           `would_trip` in the receipt; TWO CONSECUTIVE CALLs over budget
 *           stop the run (rule 117) in `stop` mode. `--census-mode report`
 *           now means only this: an over-budget CALL is recorded, never a
 *           stop. The old per-reading stop during a CALL is RETIRED — a
 *           15-min reading taken during a paced CALL fails by construction,
 *           the CALL's cost being a design constant (rule 183).
 *         - the breather (step 6a): 0 renders since the CALL returned. Still
 *           held by the census at --breather-max-s: a stop (stop mode) or a
 *           would_trip (report mode) — FIX-1234 D3.
 *       Exit 2 (Logs API dark) is logged wherever it is read, and TWO
 *       consecutive exit-2s trip in both modes — the Logs API going dark was
 *       itself a symptom on 09-22 (rule 164). Exit 8 (endpoint removed,
 *       FIX-1219) is not a reading and never trips: it neither counts toward
 *       nor resets the dark count, at the gate it opens on the gate alone,
 *       and in a breather the walls alone release;
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
import {
  CENSUS_EXIT, rendersIn, rendersLine, verdictFor, type CancellationVerdict, type RenderSecond,
} from "../lib/cancellation-census";
import { buildDbUrl } from "../lib/heavy-rebuild";
import { GateTimeout, waitForProdOpGate, type AlsoReading, type GatePoll, type ProdOpGate } from "../lib/prod-op-gate";
import { ProdSessionRefused, withProdSession, type ProdSessionState } from "../lib/prod-session";
import { errText } from "../lib/session-lock";

export const REASON = "FIX-1212 bootstrap (cc-147 runner)";
const PIPELINE = "donor_party_rollup_refresh";
const APP = "civitics_dp_bootstrap";
const CALL_SQL = "CALL public.refresh_donor_party_rollup_incremental()";

/**
 * FIX-1249 — the pacing row is MERGED into `donor_party_crawl`, never written
 * wholesale. The key also carries `full_rebuild_lag_days` (30 on prod, from
 * `docs/audits/2026-09-30-fix1249-donor-party-crawl-lag-days.sql`), which the
 * procedure reads on every CALL to pick crawl vs full; a wholesale
 * `value = EXCLUDED.value` dropped it for the length of a paced run, so the
 * procedure silently reverted to the default 14.
 */
export const PACING_UPSERT_SQL =
  `INSERT INTO public.pipeline_state (key, value) VALUES ('donor_party_crawl', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = public.pipeline_state.value || EXCLUDED.value, updated_at = clock_timestamp()`;

/**
 * The restore after every CALL and again in `finally`: the row's FULL prior
 * value (every key, not just `max_units`), or DELETE when there was no row.
 * One statement for both sites so they cannot drift.
 */
export function pacingRestoreStatement(prior: Record<string, unknown> | null): { sql: string; params: string[] } {
  return prior === null
    ? { sql: "DELETE FROM public.pipeline_state WHERE key = 'donor_party_crawl'", params: [] }
    : {
        sql: `UPDATE public.pipeline_state SET value = $1::jsonb, updated_at = clock_timestamp() WHERE key = 'donor_party_crawl'`,
        params: [JSON.stringify(prior)],
      };
}
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DATA_DIR = path.resolve(__dirname, "..", "..");

/** The floor of `elevated`: a wall at or above this and under --wall-trip-s is load, logged, never a trip. */
export const ELEVATED_FROM_S = 1.0;
/** Breather read cadence (D2): one every-2-min watchdog run lands per 120 s; 30 s sees each within a quarter-cycle. */
const BREATHER_READ_S = 30;
/**
 * FIX-1232 D3 (i): once the walls have released, the breather reads the census
 * once, and while renders are still being lost re-reads no sooner than this —
 * a census read is two Logs calls on a token four readers share (rule 190).
 */
export const BREATHER_CENSUS_REREAD_S = 60;

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

/**
 * Rule (3)'s CALL-window budget (FIX-1232): `stop` trips on two consecutive
 * CALLs over --renders-per-call-max; `report` records every over-budget CALL
 * and never stops on one. Narrowed from cc-152, where `report` also demoted a
 * failing pre-CALL reading: a pre-CALL FAIL now stops in both modes, and the
 * dark-twice trip is armed in both.
 */
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
  /** FIX-1232 D3: renders one CALL may lose before it counts as over budget. */
  rendersPerCallMax: number;
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
    "--renders-per-call-max",
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
    ["rendersPerCallMax", "--renders-per-call-max", 3, 0],
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
    rendersPerCallMax: Math.floor(out["rendersPerCallMax"]!),
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
 * Rule (3)'s record-not-stop shape: a CALL over --renders-per-call-max whose
 * predecessor was not (FIX-1232 — one observation), or any over-budget CALL
 * in report mode. Recorded and logged, never a stop.
 */
export interface WouldTrip {
  would_trip: true;
  rule: 3;
  reason: string;
  /** FIX-1232: the CALL it was observed on, its renders, and the budget. */
  call?: number;
  renders?: number;
  budget?: number;
}

export const isTrip = (v: Trip | WouldTrip | null): v is Trip => v !== null && v.would_trip !== true;

export interface StopState {
  consecutiveOver: Record<string, number>;
  /** The votes counted over, per job, since the last reading under — rule (2)'s evidence. */
  overVotes: Record<string, string[]>;
  /** The vote key last counted per job — see WatchdogReading.runs. */
  lastVote: Record<string, string>;
  consecutiveCensusDark: number;
  /** FIX-1232: the CALLs observed over --renders-per-call-max, one vote each. */
  overBudgetCalls: number[];
}

export const newStopState = (): StopState => ({
  consecutiveOver: {}, overVotes: {}, lastVote: {}, consecutiveCensusDark: 0, overBudgetCalls: [],
});

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

/** Where a census reading was taken — it decides what an exit 1 means (FIX-1232). */
export type CensusPhase = "pre_call" | "breather" | "cadence";

/**
 * The pre-CALL half of rule (3) off the exit code alone: an exit 1 before a
 * CALL stops, in both modes. Since FIX-1234 the pre-CALL step judges the
 * reading itself (preCallCensus); this is its fallback for a reading it
 * cannot parse, and evaluateCensus's for a caller that has only the code.
 */
export function preCallFail(exitCode: number): Trip | null {
  return exitCode === CENSUS_EXIT.fail ? { rule: 3, reason: "(3) the pre-CALL census failed (57014 renders or front-door 5xx)" } : null;
}

/**
 * Census exit code → trip or null. 0 pass · 1 fail · 2 Logs API dark · 8
 * unavailable. Two consecutive darks trip in both modes, wherever they were
 * read. 8 (the endpoint is gone, FIX-1219) is TRANSPARENT: the dark count is
 * neither advanced nor reset, so dark, 8, dark still trips.
 *
 * An exit 1 trips ONLY before a CALL, and in both modes (FIX-1232, design
 * §0.4: report mode is the honest demotion of the CALL-window reading only).
 * A reading DURING a CALL fails by construction — the CALL's cost is a design
 * constant (rule 183) — so the old per-reading rule (3) stop is retired and
 * the CALL is judged on its renders against --renders-per-call-max instead
 * (evaluateCallBudget). A breather reading's exit 1 is not a stop either: the
 * breather is still waiting for the box to come back.
 */
export function evaluateCensus(state: StopState, exitCode: number, phase: CensusPhase = "pre_call"): Trip | null {
  if (exitCode === CENSUS_EXIT.unavailable) return null;
  if (exitCode === 0) { state.consecutiveCensusDark = 0; return null; }
  if (exitCode === 1) {
    state.consecutiveCensusDark = 0;
    return phase === "pre_call" ? preCallFail(exitCode) : null;
  }
  state.consecutiveCensusDark += 1;
  return state.consecutiveCensusDark >= 2 ? { rule: 3, reason: "(3) the Logs API was dark on two consecutive census readings" } : null;
}

/**
 * FIX-1232 D3 (ii) — the CALL-window budget. `renders` is the renders lost
 * over one CALL's span (a partial count while it runs, the whole count once it
 * has returned). Each CALL votes ONCE, on its first observation over budget
 * (rule 117: two observations are two CALLs, never two readings of one). Over
 * budget with the previous CALL also over → a Trip in stop mode; otherwise a
 * WouldTrip, recorded in the receipt. Report mode never stops here.
 */
export function evaluateCallBudget(
  state: StopState, call: number, renders: number, budget: number, mode: CensusMode,
): Trip | WouldTrip | null {
  if (renders <= budget || state.overBudgetCalls.includes(call)) return null;
  state.overBudgetCalls.push(call);
  const reason = `(3) CALL ${call} lost ${renders} render(s) > --renders-per-call-max ${budget}`;
  if (mode === "stop" && state.overBudgetCalls.includes(call - 1)) {
    return { rule: 3, reason: `${reason}, and CALL ${call - 1} was over budget too — two consecutive CALLs (rule 117)` };
  }
  return { would_trip: true, rule: 3, reason, call, renders, budget };
}

/** The seconds of a census --json reading, from either shape (the gate's or --renders-only's). */
export function censusSeconds(j: CensusJson | null): CensusSecond[] | null {
  return j?.cancellations?.by_second ?? j?.renders?.by_second ?? null;
}

/**
 * FIX-1232 D3 (i) — the breather's census half, from ONE reading taken once
 * the watchdog walls have released. Released iff no render was lost since the
 * CALL returned. An exit 8 (no instrument) releases on the walls alone, as the
 * gate opens on the gate alone; a dark or unparsed reading holds — the breather
 * cannot confirm 0.
 */
export function breatherCensus(
  code: number, j: CensusJson | null, returnedAtMs: number,
): { released: boolean; renders: number | null; pending: string | null } {
  if (code === CENSUS_EXIT.unavailable) return { released: true, renders: null, pending: null };
  const secs = code === 0 || code === 1 ? censusSeconds(j) : null;
  if (!secs) return { released: false, renders: null, pending: `census ${code === 0 || code === 1 ? "unparsed" : "dark"} — cannot confirm 0 renders` };
  const since = rendersIn(secs, returnedAtMs, Number.POSITIVE_INFINITY);
  if (since.length === 0) return { released: true, renders: 0, pending: null };
  return {
    released: false,
    renders: since.length,
    pending: `census: ${since.length} render(s) since the CALL returned (${since.map((s) => s.page).join(", ")})`,
  };
}

/**
 * FIX-1234 D3 — a breather that reaches --breather-max-s, by cause.
 *
 * - The walls never released, so the census was never read (`census` null):
 *   `breather_timeout`, and the run PROCEEDS, as cc-148 D2 built it. Walls can
 *   "hold" at idle on the 2-minute cadence alone — release needs a watchdog run that
 *   STARTED after the CALL returned, up to 120 s away (cc-148 §5.6: five of six
 *   clone breathers timed out that way at --breather-max-s 20).
 * - The walls released and the LAST census reading held it — renders since the
 *   CALL returned, or dark/unparsed (it could not confirm 0):
 *   `breather_timeout_census`. The front door had not come back; in `stop`
 *   mode that is a rule (3) Trip, in `report` mode a WouldTrip recorded with
 *   the same numbers, and the run proceeds.
 *
 * `call` is the CALL the breather follows; `waitedS` how long it waited.
 */
export function breatherTimeout(input: {
  mode: CensusMode;
  call: number;
  waitedS: number;
  census: { released: boolean; renders: number | null; at: string } | null;
}): { by: "breather_timeout" | "breather_timeout_census"; verdict: Trip | WouldTrip | null } {
  const { census } = input;
  if (!census || census.released) return { by: "breather_timeout", verdict: null };
  const reason = `(3) the front door had not returned to baseline ${Math.round(input.waitedS)} s after CALL ${input.call} returned — ` +
    `renders since return ${census.renders ?? "unknown (the census could not confirm 0)"} (last read at ${census.at})`;
  if (input.mode === "stop") return { by: "breather_timeout_census", verdict: { rule: 3, reason } };
  return {
    by: "breather_timeout_census",
    verdict: { would_trip: true, rule: 3, reason, call: input.call, ...(census.renders !== null ? { renders: census.renders } : {}) },
  };
}

/**
 * One CALL's renders out of a reading, or null when the reading does not reach
 * back to the CALL's start (then the runner reads the CALL's span itself).
 */
export function callWindowRenders(
  j: CensusJson | null, startMs: number, endMs: number,
): { renders: number; events: number; seconds: CensusSecond[] } | null {
  const secs = censusSeconds(j);
  const from = j?.window?.start ? Date.parse(j.window.start) : NaN;
  if (!secs || !(from <= Math.floor(startMs / 1000) * 1000)) return null;
  const seconds = rendersIn(secs, startMs, endMs);
  return { renders: seconds.length, events: seconds.reduce((n, s) => n + s.events, 0), seconds };
}

/** A CALL's span on the DB clock. A CALL still running (returned_ms null) has no span and is skipped. */
export type CallSpan = Pick<CallRecord, "started_ms" | "returned_ms">;

/** FIX-1234 D2: the pre-CALL reading's 57014 half, judged on the minutes outside every CALL span. */
export interface OutsideCallsVerdict {
  verdict: CancellationVerdict;
  /** Seconds that fell inside a CALL span — the budget's to judge (evaluateCallBudget), not this reading's. */
  rendersInsideCalls: number;
  rendersOutside: number;
  /** The window less its overlap with the CALL spans, clamped >= 1. */
  minutesOutside: number;
  /** The whole window, for the line. */
  minutes: number;
}

/**
 * FIX-1234 D2 — the pre-CALL reading judges only the time OUTSIDE the paced
 * op's CALLs. A trailing 15-min reading holds the CALL that just returned and
 * its breather, about 2.5 CALLs of history, so judged whole it turned the
 * per-CALL budget of 3 into a cumulative 3 per 15 min, and one 4-render CALL
 * stopped the run before rule 117's second look (cc-162 §4.1).
 *
 * Every `by_second` row inside a `[started_ms, returned_ms]` span is dropped —
 * with rendersIn's convention, so a CALL's first second is the CALL's, as in
 * callWindowRenders — and the rest are judged by verdictFor over the window's
 * minutes less its overlap with those spans. No render goes unjudged (rule
 * 176): the dropped ones are exactly the CALLs', and every one of those is
 * judged by --renders-per-call-max. `rendersInsideCalls + rendersOutside` is
 * the reading's whole count (rule 116).
 *
 * The baselines are the reading's own (what the child gated on);
 * `baselineRenders` overrides the renders one. null when the reading carries
 * no seconds, no window or no baseline — the caller falls back to the exit code.
 */
export function outsideCallsVerdict(
  j: CensusJson | null, calls: readonly CallSpan[], baselineRenders?: number,
): OutsideCallsVerdict | null {
  const secs = censusSeconds(j);
  const start = j?.window?.start ? Date.parse(j.window.start) : NaN;
  const end = j?.window?.end ? Date.parse(j.window.end) : NaN;
  const baseline = j?.cancellations?.baseline;
  if (!secs || !(end > start) || baseline === undefined) return null;
  const spans = calls.filter((c): c is { started_ms: number; returned_ms: number } => c.returned_ms !== null);
  const inside = (s: CensusSecond) => spans.some((c) => rendersIn([s], c.started_ms, c.returned_ms).length > 0);
  const kept = secs.filter((s) => !inside(s));
  const overlapMs = spans.reduce((n, c) => n + Math.max(0, Math.min(c.returned_ms, end) - Math.max(c.started_ms, start)), 0);
  const minutes = (end - start) / 60_000;
  const minutesOutside = Math.max(1, minutes - overlapMs / 60_000);
  const verdict = verdictFor({
    renders: asRenderSeconds(kept),
    minutes: minutesOutside,
    baseline,
    baselineRenders: baselineRenders ?? j?.cancellations?.baseline_renders ?? baseline,
  });
  return { verdict, rendersInsideCalls: secs.length - kept.length, rendersOutside: kept.length, minutesOutside, minutes };
}

/** `renders outside CALLs n (inside m) · minutes outside k of w · pass|FAIL (ratio r, floor f)` — the pre-CALL line's addition. */
export function outsideCallsLine(o: OutsideCallsVerdict | NonNullable<CensusRow["outside_calls"]>): string {
  const r = "verdict" in o ? outsideCallsRow(o) : o;
  return `renders outside CALLs ${r.renders_outside} (inside ${r.renders_inside}) · minutes outside ${r.minutes_outside.toFixed(1)} of ${r.minutes.toFixed(1)} · ` +
    `${r.pass ? "pass" : "FAIL"} (ratio ${r.ratio_renders.toFixed(2)}, floor ${r.floor_renders})`;
}

/**
 * FIX-1234 D2 — the pre-CALL decision from one reading, fresh or handed on by
 * the breather. Two halves, both judged here rather than off the child's exit
 * code: the 57014 half by outsideCallsVerdict, the edge half by the child's own
 * edge verdict (FIX-1233's floor). Either failing is a rule (3) stop, in both
 * modes, and the reason names both numbers.
 *
 * `counted`: a handed reading's dark was already counted in the breather, so
 * only a fresh reading goes through evaluateCensus here — for the dark count;
 * its exit-1 trip is re-judged. A reading this cannot parse (no seconds, no
 * window, no edge verdict) falls back to the exit code, as before.
 */
export function preCallCensus(
  state: StopState, code: number, j: CensusJson | null, calls: readonly CallSpan[], counted: boolean,
): { trip: Trip | null; outside: OutsideCallsVerdict | null } {
  const dark = counted ? null : evaluateCensus(state, code, "pre_call");
  if (code !== CENSUS_EXIT.pass && code !== CENSUS_EXIT.fail) return { trip: dark, outside: null };
  const outside = outsideCallsVerdict(j, calls);
  const edgePass = j?.edge?.pass;
  if (!outside || typeof edgePass !== "boolean") return { trip: preCallFail(code), outside };
  if (outside.verdict.pass && edgePass) return { trip: null, outside };
  const failed = [!outside.verdict.pass ? "57014" : null, !edgePass ? "edge" : null].filter((x) => x !== null).join(" + ");
  return {
    trip: {
      rule: 3,
      reason: `(3) the pre-CALL census failed (${failed}) — 57014: ${outsideCallsLine(outside)}; ` +
        `edge: ${edgePass ? "pass" : "FAIL"} (${j?.edge?.note ?? "no note"})`,
    },
    outside,
  };
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

/** One second of the census's `by_second` (FIX-1232): one render lost. */
export interface CensusSecond {
  at: string;
  startMs: number;
  events: number;
  page: string;
}

/** The slice of cancellation-census.ts --json this runner reads. */
export interface CensusJson {
  window?: { start: string; end: string; minutes: number };
  cancellations?: {
    total: number; ratio: number; floor?: number; lambda?: number; pass?: boolean;
    /** FIX-1232: the gated unit, and the seconds behind it. */
    renders?: number; events?: number; ratio_renders?: number; floor_renders?: number;
    by_second?: CensusSecond[];
    /** The baselines the child gated on — outsideCallsVerdict re-judges at the same ones (FIX-1234). */
    baseline?: number; baseline_renders?: number;
  };
  /** `--renders-only` (FIX-1232 D3): the seconds and nothing else. */
  renders?: { renders: number; events: number; by_second: CensusSecond[] };
  /** FIX-1233: the note names the floor and p0; the fields ride beside it. */
  edge?: { note: string; pass?: boolean; p0?: number; floor_5xx?: number | null; over_ratio?: boolean | null; over_floor?: boolean | null };
  pass?: boolean;
  /** Exit 8's body (FIX-1219): the endpoint is gone, or a table/field it names is. */
  unavailable?: boolean;
  http_status?: number;
  /** The helper's detail; for a 200 it names what no longer exists (cc-156). */
  detail?: string;
}

/**
 * One census reading as one line —
 * `pass|FAIL|dark (R render(s) / E event(s) in M min, ratio r, floor f; edge …)`.
 * The ratio and floor are the renders' (FIX-1232); a reading from before the
 * unit changed (no `renders` field) prints its events the old way.
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
  const fail = c?.pass === false ? " — 57014 FAIL" : "";
  const cPart = !c
    ? "no 57014 reading"
    : c.renders !== undefined
      ? `${c.renders} render(s) / ${c.events ?? c.total} event(s) in ${minutes} min, ratio ${Number(c.ratio_renders).toFixed(2)}, floor ${c.floor_renders ?? "?"}${fail}`
      : `${c.total}/${minutes} min, ratio ${Number(c.ratio).toFixed(2)}, floor ${c.floor ?? "?"}${fail}`;
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

/** cancellation-census.ts as a child process: its exit code (2 on any launch failure) and its --json body. */
function spawnCensus(args: readonly string[], log: (l: string) => void): Promise<{ code: number; json: CensusJson | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      "tsx", ["src/scripts/cancellation-census.ts", ...args],
      { cwd: DATA_DIR, env: process.env, shell: process.platform === "win32" },
    );
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", () => { /* the census prints its own diagnostics; the code is the verdict */ });
    const timer = setTimeout(() => { child.kill(); }, 120_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      log(`[census] launch failed: ${e.message}`);
      resolve({ code: 2, json: null });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      let j: CensusJson | null = null;
      try { j = JSON.parse(out) as CensusJson; } catch { /* non-JSON: exit 2 paths print nothing to stdout */ }
      resolve({ code: code ?? 2, json: j });
    });
  });
}

/**
 * The census over the last `minutes` (two Logs calls). Exported for
 * session:wait-for-gate's census half (cc-159 D2), so both waits read the
 * census through one spawn. `json` carries the seconds the runner windows into
 * its CALLs and breathers (FIX-1232).
 */
export async function runCensus(minutes: number, log: (l: string) => void): Promise<{ code: number; summary: string; json: CensusJson | null }> {
  const r = await spawnCensus(["--minutes", String(minutes), "--json"], log);
  return { ...r, summary: censusSummary(r.code, r.json, minutes) };
}

/** `renders R / events E` for a --renders-only reading, or what it was instead. */
export function rendersSummary(code: number, j: CensusJson | null): string {
  if (code === CENSUS_EXIT.unavailable) return censusSummary(code, j, 0);
  if (code !== 0) return `dark (exit ${code} — the Logs API did not answer)`;
  if (!j?.renders) return "dark (exit 0; unparsed output)";
  return `renders ${j.renders.renders} / events ${j.renders.events}`;
}

/** FIX-1232 D3 — the renders over [startMs, endMs] and nothing else: ONE Logs call (`--renders-only`). */
export async function runRenders(
  startMs: number, endMs: number, log: (l: string) => void,
): Promise<{ code: number; summary: string; json: CensusJson | null }> {
  const at = (ms: number) => new Date(ms).toISOString();
  const r = await spawnCensus(["--renders-only", "--start", at(startMs), "--end", at(endMs), "--json"], log);
  // Unparsed output on an exit 0 is not a reading: count it as dark.
  const code = r.code === 0 && !r.json?.renders ? CENSUS_EXIT.dark : r.code;
  return { code, json: r.json, summary: rendersSummary(r.code, r.json) };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface CallRecord {
  n: number;
  units: number;
  pid: number;
  started_at: string;
  /** started_at as epoch ms on the DB clock — the clock postgres_logs stamps with (FIX-1232). */
  started_ms: number;
  returned_at: string | null;
  /** When the CALL returned, epoch ms on the DB clock; the breather counts renders from here. */
  returned_ms: number | null;
  wall_s: number | null;
  row: CallRow | null;
  verdict: string;
  watchdog_walls: { job: string; min: number; median: number; max: number; n: number; elevated: number }[];
  windows_done_after: number[] | null;
  error?: string;
  /**
   * FIX-1232 D3 (ii): the renders lost over this CALL's span, from the latest
   * reading that covered all of it (`final`: the next breather's reading, the
   * CALL's own --renders-only read, or the end-of-run read), else the last
   * partial one taken while it ran. null when nothing was read (local; dark).
   */
  renders: { renders: number; events: number; seconds: CensusSecond[]; final: boolean; at: string } | null;
}

export interface BreatherRecord {
  before_call: number;
  started_at: string;
  released_at: string;
  waited_s: number;
  /**
   * `walls+census` (FIX-1232): the walls released AND the census read 0 renders since the CALL returned.
   * `breather_timeout`: --breather-max-s with the walls still holding — proceeds. `breather_timeout_census`
   * (FIX-1234 D3): --breather-max-s with the census still holding — a stop in stop mode, a would_trip in report.
   */
  released_by: "walls" | "walls+census" | "breather_timeout" | "breather_timeout_census" | "stop";
  /** FIX-1234 D3: set when --breather-max-s ended it — what held it, and what that decided. */
  timeout?: {
    cause: "walls" | "census";
    /** Renders since the CALL returned at the last census read (null: not read, or it could not confirm 0). */
    renders: number | null;
    last_read_at: string | null;
    outcome: "proceed" | "trip" | "would_trip";
    reason: string | null;
  };
  readings: number;
  walls_at_release: Record<string, { wall_s: number; runid: string }>;
  pending_at_release: string[];
  /** FIX-1232 D3 (i): census reads the breather took, and the renders lost since the CALL returned at the last one. */
  census_reads: number;
  renders: number | null;
  /** FIX-1232 D5: the same window, re-counted from the end-of-run read (late-arriving log rows included). */
  renders_final?: number;
}

export interface CensusRow {
  at: string;
  minutes: number;
  code: number;
  summary: string;
  /**
   * `breather` — a reading taken once the walls released (FIX-1232); the one
   * that releases the breather is also the pre-CALL reading, so it is recorded
   * once, as `pre_call`. `renders` — a one-call --renders-only read of a CALL's
   * span, a CALL in flight (`cadence` before FIX-1232), or the whole run.
   */
  phase: "gate" | "pre_call" | "breather" | "cadence" | "renders";
  before_call: number | null;
  /**
   * cc-152 D1: true when this reading would have tripped rule (3) in stop mode
   * and report mode recorded it instead. Since FIX-1232 only the CALL-window
   * budget has a report form, so this is false on every row a reading writes;
   * the budget's would_trips are `Receipt.budget`. null on a gate row.
   */
  would_trip: boolean | null;
  /** FIX-1234 D2: on the pre-CALL row, the 57014 half as judged outside the CALL spans. */
  outside_calls?: {
    renders_outside: number; renders_inside: number; minutes_outside: number; minutes: number;
    ratio_renders: number; floor_renders: number; pass: boolean;
  };
}

/** The receipt's copy of an OutsideCallsVerdict. */
export function outsideCallsRow(o: OutsideCallsVerdict): NonNullable<CensusRow["outside_calls"]> {
  return {
    renders_outside: o.rendersOutside, renders_inside: o.rendersInsideCalls, minutes_outside: o.minutesOutside, minutes: o.minutes,
    ratio_renders: o.verdict.ratio_renders, floor_renders: o.verdict.floor_renders, pass: o.verdict.pass,
  };
}

/** A census reading the breather took, handed on as the pre-CALL reading (FIX-1232 D3: reordered, not added). */
export interface BreatherReading {
  code: number;
  summary: string;
  json: CensusJson | null;
  row: CensusRow;
}

/** FIX-1232 D3 (ii): one CALL's first over-budget observation — a WouldTrip or the Trip it became. */
export interface BudgetRow {
  at: string;
  call: number;
  renders: number;
  budget: number;
  final: boolean;
  outcome: "would_trip" | "trip";
  reason: string;
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
  /** FIX-1232 D3 (ii): every CALL observed over --renders-per-call-max. */
  budget: BudgetRow[];
  /** FIX-1232 D5: the whole run's renders, read once after the last CALL (null: local, no CALL, or dark). */
  run_renders: { from: string; to: string; code: number; renders: number; events: number; seconds: CensusSecond[] } | null;
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

/**
 * The receipt's `census mode` header row (cc-152 D1). Since FIX-1232 the mode
 * decides the CALL-window budget: a pre-CALL FAIL and the dark-twice trip stop
 * in both, and the per-reading stop during a CALL is retired. Since FIX-1234
 * it also decides a breather the census still holds at --breather-max-s.
 */
export function censusModeLine(
  mode: CensusMode, rows: readonly CensusRow[], budget: readonly BudgetRow[] = [], budgetMax = 3,
): string {
  const unavailable = rows.filter((c) => c.code === CENSUS_EXIT.unavailable).length;
  const tail = unavailable
    ? ` · ${unavailable} census call(s) unavailable (exit 8, FIX-1219) — not readings, never a trip`
    : "";
  const over = `${new Set(budget.map((b) => b.call)).size} CALL(s) over budget`;
  const common = "a pre-CALL FAIL (outside the CALL spans) stops the run in both modes; the dark-twice trip is armed; the gate wait's census half holds the window";
  if (mode === "stop") {
    return `stop — two consecutive CALLs over --renders-per-call-max ${budgetMax} stop the run (${over}), ` +
      `and so does a breather the census still holds at --breather-max-s; ${common}` + tail;
  }
  return `report — CALLs over --renders-per-call-max ${budgetMax} are recorded, never a stop (${over}), ` +
    `and so is a breather the census still holds at --breather-max-s; ${common}` + tail;
}

/** One receipt line per census reading. */
export function censusLine(c: CensusRow): string {
  const where = c.phase === "gate" ? "gate poll"
    : c.phase === "pre_call" ? `before CALL ${c.before_call}`
      : c.phase === "breather" ? `breather before CALL ${c.before_call}, held it`
        : c.phase === "renders" ? `renders read${c.before_call ? ` of CALL ${c.before_call - 1}` : " of the run"}`
          : "during a CALL";
  const minutes = Number.isInteger(c.minutes) ? String(c.minutes) : c.minutes.toFixed(1);
  const outside = c.outside_calls ? ` — ${outsideCallsLine(c.outside_calls)}` : "";
  return `- ${c.at} (${minutes} min, ${where}) exit ${c.code}: ${c.summary}${outside}${c.would_trip ? ` — **would_trip**${WOULD_TRIP_NOTE}` : ""}`;
}

const asRenderSeconds = (xs: readonly CensusSecond[]): RenderSecond[] =>
  xs.map((x) => ({ startMs: x.startMs, events: x.events, sampleQuery: x.page }));

/** FIX-1232 D5 — one receipt line per CALL: `renders_lost n · events m · budget b · pages: …`. */
export function callRendersLine(c: Pick<CallRecord, "n" | "renders">, budget: number): string {
  if (!c.renders) return `- CALL ${c.n}: not read (local, or the Logs API did not answer)`;
  const line = rendersLine(asRenderSeconds(c.renders.seconds)).replace(/^(renders_lost \d+ · events \d+)/, `$1 · budget ${budget}`);
  return `- CALL ${c.n}: ${line}${c.renders.renders > budget ? " — **over budget**" : ""}${c.renders.final ? "" : " (partial: read while it ran)"}`;
}

/**
 * FIX-1232 D5 — one receipt line per breather: `renders n · released after s (by)`.
 * FIX-1234 D3: a breather --breather-max-s ended says what held it, and — when
 * the census did — the renders still pending and what that decided.
 */
export function breatherRendersLine(
  b: Pick<BreatherRecord, "before_call" | "renders" | "renders_final" | "waited_s" | "released_by" | "census_reads" | "timeout">,
): string {
  const n = b.renders_final ?? b.renders;
  const drift = b.renders_final !== undefined && b.renders !== null && b.renders_final !== b.renders
    ? ` — ${b.renders} at release, ${b.renders_final} in the end-of-run read` : "";
  const t = b.timeout;
  const held = !t ? ""
    : t.cause === "walls" ? " — the walls held it at --breather-max-s; proceeded"
      : ` — the census held it at --breather-max-s: ${t.renders ?? "unconfirmed"} render(s) pending since the CALL returned ` +
        `(last read ${t.last_read_at ?? "—"}) — **${t.outcome === "trip" ? "stop" : t.outcome}**`;
  return `- breather before CALL ${b.before_call}: renders ${n ?? "—"} · released after ${b.waited_s.toFixed(1)} s ` +
    `(${b.released_by}${b.census_reads ? `, ${b.census_reads} census read(s)` : ""})${drift}${held}`;
}

/** FIX-1232 D5 — the run's total, from the one read after the last CALL. */
export function runRendersLine(run: Receipt["run_renders"]): string {
  if (!run) return "- run: not read (local, no CALL, or the Logs API did not answer)";
  return `- run: ${rendersLine(asRenderSeconds(run.seconds))} (${run.from} → ${run.to})`;
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
  L.push(`| census mode | ${censusModeLine(r.args.censusMode, r.census, r.budget, r.args.rendersPerCallMax)} |`);
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
  L.push("## Front door, in renders (FIX-1232)");
  L.push("");
  L.push(`A render is a second with at least one statement timeout. Budget: --renders-per-call-max ${r.args.rendersPerCallMax}; ` +
    `two consecutive CALLs over it stop the run in \`stop\` mode.`);
  L.push("");
  for (const c of r.calls) L.push(callRendersLine(c, r.args.rendersPerCallMax));
  for (const b of r.breathers) L.push(breatherRendersLine(b));
  L.push(runRendersLine(r.run_renders));
  for (const b of r.budget) L.push(`- ${b.at} CALL ${b.call} **${b.outcome}**: ${b.reason}${b.final ? "" : " (read while it ran)"}`);
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
    console.info(fs.readFileSync(__filename, "utf8").split("*/")[0]!.replace(/^\/\*\*|^ \* ?/gm, ""));
    return 0;
  }
  const parsed = parseRunnerArgs(argv);
  if ("error" in parsed) { console.error(`✗ ${parsed.error}`); return 64; }
  const args = parsed;

  const dbUrl = buildDbUrl();
  const target: "prod" | "local" = /127\.0\.0\.1|localhost/.test(dbUrl) ? "local" : "prod";
  const log = (l: string) => console.info(`${new Date().toISOString().slice(11, 19)}Z ${l}`);
  const launchedAt = new Date().toISOString();
  const paths = receiptPaths(target, launchedAt, args.receiptTag);

  const R: Receipt = {
    runner: "donor-party-bootstrap-runner", target, reason: REASON, args, pid: process.pid,
    launched_at: launchedAt, finished_at: null, outcome: null, exit_code: null, detail: null,
    gate: { polls: [], opened_at: null, opening_reading: null, opening_census: null, waited_seconds: null, last_blocked_by: null },
    census: [], claim: { claimed_at: null, released_at: null, state_after_arm: null },
    pacing: { units_per_call: args.unitsPerCall, prior_value: null, upserts: 0, restores: 0, restored: null },
    resume: null, calls: [], breathers: [], budget: [], run_renders: null, watchdog_series: [], elevated_ticks: 0, trip: null,
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
  /**
   * FIX-1232 D3 (ii) — record a CALL's renders from a reading, and judge the
   * budget on it. A final count (the reading covered the whole CALL) replaces a
   * partial one; a partial never replaces a final. Returns the Trip, if any.
   */
  const judgeCall = (
    rec: CallRecord, got: { renders: number; events: number; seconds: CensusSecond[] }, final: boolean,
  ): Trip | null => {
    if (!rec.renders?.final || final) rec.renders = { ...got, final, at: new Date().toISOString() };
    const v = evaluateCallBudget(stopState, rec.n, got.renders, args.rendersPerCallMax, args.censusMode);
    if (!v) return null;
    R.budget.push({
      at: new Date().toISOString(), call: rec.n, renders: got.renders, budget: args.rendersPerCallMax, final,
      outcome: isTrip(v) ? "trip" : "would_trip", reason: v.reason,
    });
    log(`[budget] ${v.reason}${isTrip(v) ? " — STOP" : ` — would_trip (${args.censusMode === "report" ? "census mode report" : "one observation; a second consecutive stops"})`}`);
    return isTrip(v) ? v : null;
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
      const restore = pacingRestoreStatement(R.pacing.prior_value);
      await tClient.query(restore.sql, restore.params);
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

  // ── the breather (D2; FIX-1232 D3 (i)) — between CALLs, never a trip on its own ──
  //
  // Walls first, as before. Once they release (prod), ONE census reading: the
  // pre-CALL reading, taken here instead of after the breather — reordered, not
  // added — so a 0-render breather costs no Logs call it did not cost before.
  // Released when that reading shows no render lost since the CALL returned; a
  // render keeps the breather open and the census is re-read no sooner than
  // BREATHER_CENSUS_REREAD_S later (rule 190). --breather-max-s still bounds it,
  // and what a timeout means depends on what held it (FIX-1234 D3,
  // breatherTimeout): the walls → PROCEED, as cc-148 D2 built it; the census
  // (its last reading still saw renders since the CALL returned, or could not
  // confirm 0) → a rule (3) stop in stop mode, a would_trip in report mode.
  // The reading is handed to the pre-CALL step, which judges it; its dark (if
  // any) was counted here, once.
  const breathe = async (beforeCall: number, returnedAtMs: number, stSince: string): Promise<BreatherReading | null> => {
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    let readings = 0;
    let last: CompletedRun[] = [];
    let verdict = { released: false, pending: ["(no reading yet)"] };
    let by: BreatherRecord["released_by"] = "breather_timeout";
    let census: BreatherReading | null = null;
    let censusAtMs = 0;
    let censusReads = 0;
    let censusPending: string | null = null;
    let breatherRenders: number | null = null;
    /** FIX-1234 D3: the last census reading's half — what held the breather, if it was the census. */
    let lastHalf: { released: boolean; renders: number | null; at: string } | null = null;
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
      if (verdict.released && target !== "prod") { by = "walls"; break; }
      if (verdict.released && (census === null || Date.now() - censusAtMs >= BREATHER_CENSUS_REREAD_S * 1000)) {
        const cen = await runCensus(15, log);
        censusAtMs = Date.now();
        censusReads += 1;
        const row: CensusRow = {
          at: new Date().toISOString(), minutes: 15, code: cen.code, summary: cen.summary,
          phase: "breather", before_call: beforeCall, would_trip: false,
        };
        R.census.push(row);
        census = { ...cen, row };
        const half = breatherCensus(cen.code, cen.json, returnedAtMs);
        breatherRenders = half.renders;
        censusPending = half.pending;
        lastHalf = { released: half.released, renders: half.renders, at: row.at };
        log(`[breather] before CALL ${beforeCall} census: ${cen.summary} — ${half.released
          ? half.renders === null ? "no instrument (exit 8): the walls alone release" : "0 renders since the CALL returned"
          : half.pending}`);
        const t = evaluateCensus(stopState, cen.code, "breather");   // the dark count only
        if (t && !stopping) { stopping = t; recordTrip(t, beforeCall); }
        if (stopping) { by = "stop"; break; }
        if (half.released) { by = "walls+census"; break; }
      }
      const left = args.breatherMaxS * 1000 - (Date.now() - t0);
      if (left <= 0) { by = "breather_timeout"; break; }
      await sleep(Math.min(BREATHER_READ_S * 1000, left));
    }
    const waitedS = (Date.now() - t0) / 1000;
    // FIX-1234 D3: at --breather-max-s, what held it decides what the timeout means.
    let timeout: BreatherRecord["timeout"];
    if (by === "breather_timeout") {
      const t = breatherTimeout({ mode: args.censusMode, call: beforeCall - 1, waitedS, census: lastHalf });
      by = t.by;
      timeout = {
        cause: t.by === "breather_timeout_census" ? "census" : "walls",
        renders: lastHalf?.renders ?? null,
        last_read_at: lastHalf?.at ?? null,
        outcome: !t.verdict ? "proceed" : isTrip(t.verdict) ? "trip" : "would_trip",
        reason: t.verdict?.reason ?? null,
      };
      if (!t.verdict) log(`[breather] before CALL ${beforeCall}: --breather-max-s with the walls still holding — proceeding (cc-148 D2)`);
      else log(`[breather] ${t.verdict.reason}${isTrip(t.verdict) ? " — STOP" : " — would_trip (census mode report); proceeding"}`);
      if (isTrip(t.verdict) && !stopping) { stopping = t.verdict; recordTrip(t.verdict, beforeCall); }
    }
    const halted = by === "stop" || timeout?.outcome === "trip";
    // The last reading is the pre-CALL reading, whether it released the breather or the clock ran out on it.
    if (census && !halted) census.row.phase = "pre_call";
    const rec: BreatherRecord = {
      before_call: beforeCall, started_at: startedAt, released_at: new Date().toISOString(),
      waited_s: waitedS, released_by: by, readings,
      walls_at_release: Object.fromEntries(last.map((x) => [x.jobname, { wall_s: x.wall_s, runid: x.runid }])),
      pending_at_release: [
        ...(!verdict.released ? verdict.pending : []),
        ...(by !== "walls+census" && censusPending ? [censusPending] : []),
      ],
      census_reads: censusReads,
      renders: breatherRenders,
      ...(timeout ? { timeout } : {}),
    };
    R.breathers.push(rec);
    log(`[breather] before CALL ${beforeCall}: ${by} after ${rec.waited_s.toFixed(1)} s` +
      `${censusReads ? ` (${censusReads} census read(s); ${breatherRenders ?? "?"} render(s) since the CALL returned)` : ""}`);
    return halted ? null : census;
  };

  // ── FIX-1232 D5: the run's renders, after the last CALL ─────────────────────
  // At most 60 min per read (the census's own slice). Fills every CALL whose
  // count is not already final and every breather's window, and judges the
  // budget for the RECORD only — the run is over, so nothing it finds can stop
  // anything, whatever the mode.
  const readRunRenders = async (): Promise<void> => {
    const fromMs = R.calls[0]!.started_ms;
    const toMs = Date.now();
    const seconds: CensusSecond[] = [];
    for (let s = fromMs; s < toMs; s += 60 * 60_000) {
      const e = Math.min(s + 60 * 60_000, toMs);
      const rr = await runRenders(s, e, log);
      R.census.push({ at: new Date().toISOString(), minutes: (e - s) / 60_000, code: rr.code, summary: rr.summary, phase: "renders", before_call: null, would_trip: false });
      log(`[census] the run's renders ${new Date(s).toISOString()} → ${new Date(e).toISOString()}: ${rr.summary}`);
      const got = rr.code === 0 ? censusSeconds(rr.json) : null;
      if (!got) return;   // dark or gone: the receipt says what was read, and no more
      seconds.push(...got);
    }
    const sum = (xs: readonly CensusSecond[]) => xs.reduce((n, x) => n + x.events, 0);
    R.run_renders = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), code: 0, renders: seconds.length, events: sum(seconds), seconds };
    for (const rec of R.calls) {
      if (rec.renders?.final) continue;
      const got = rendersIn(seconds, rec.started_ms, rec.returned_ms ?? toMs);
      rec.renders = { renders: got.length, events: sum(got), seconds: got, final: true, at: new Date().toISOString() };
      const v = evaluateCallBudget(stopState, rec.n, got.length, args.rendersPerCallMax, "report");
      if (v) {
        R.budget.push({ at: new Date().toISOString(), call: rec.n, renders: got.length, budget: args.rendersPerCallMax, final: true, outcome: "would_trip", reason: `${v.reason} (read after the run ended)` });
      }
    }
    for (const b of R.breathers) {
      const before = R.calls[b.before_call - 2];
      const after = R.calls[b.before_call - 1];
      if (!before?.returned_ms) continue;
      b.renders_final = rendersIn(seconds, before.returned_ms, after?.started_ms ?? Date.parse(b.released_at)).length;
    }
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
    // FIX-1232 D3 (ii): every 15 min DURING a CALL, the renders it has lost so
    // far (one --renders-only read of its own span) against the budget. A
    // failing 15-min census here is expected by construction (rule 183), so
    // that reading is retired; a dark one still counts toward dark-twice.
    const maybeCensus = (rec: CallRecord) => {
      if (target !== "prod" || censusBusy || Date.now() - lastCensusAt < 15 * 60_000) return;
      censusBusy = true;
      lastCensusAt = Date.now();
      const endMs = Date.now();
      void runRenders(rec.started_ms, endMs, log).then((cen) => {
        censusBusy = false;
        const minutes = (endMs - rec.started_ms) / 60_000;
        R.census.push({ at: new Date().toISOString(), minutes, code: cen.code, summary: cen.summary, phase: "cadence", before_call: null, would_trip: false });
        log(`[census] CALL ${rec.n} so far (${minutes.toFixed(1)} min): ${cen.summary}`);
        const dark = evaluateCensus(stopState, cen.code, "cadence");
        const secs = cen.code === 0 ? censusSeconds(cen.json) : null;
        const budget = secs && inCall
          ? judgeCall(rec, { renders: secs.length, events: secs.reduce((n, x) => n + x.events, 0), seconds: secs }, false)
          : null;
        const trip = dark ?? budget;
        if (trip && !stopping) {
          stopping = trip;
          if (inCall) {
            recordTrip(trip, rec.n);
            void signalBackend("pg_cancel_backend", trip.reason).then((ok) => { if (R.trip) R.trip.cancel_sent = ok; });
          }
        }
      });
    };

    /** FIX-1232 D3 (ii): a returned CALL's renders over its whole span — from `reading` when it reaches back far enough, else one read of its own. */
    const finalCallRenders = async (prev: CallRecord, reading: CensusJson | null) => {
      const endMs = prev.returned_ms ?? Date.now();
      const got = callWindowRenders(reading, prev.started_ms, endMs);
      if (got) return got;
      const rr = await runRenders(prev.started_ms, endMs, log);
      R.census.push({ at: new Date().toISOString(), minutes: (endMs - prev.started_ms) / 60_000, code: rr.code, summary: rr.summary, phase: "renders", before_call: prev.n + 1, would_trip: false });
      log(`[census] CALL ${prev.n}'s span, read on its own: ${rr.summary}`);
      const secs = rr.code === 0 ? censusSeconds(rr.json) : null;
      return secs ? { renders: secs.length, events: secs.reduce((n, x) => n + x.events, 0), seconds: secs } : null;
    };

    let prevSince: string | null = null;
    let returnedAtMs: number | null = null;
    let cycleTarget: string | null = R.resume?.target_before ?? null;
    for (let n = 1; n <= args.maxCalls; n++) {
      const armed = n >= args.tripFromCall;

      // a. The breather, from CALL 2. On prod it ends on a census reading.
      let handed: BreatherReading | null = null;
      if (n > 1 && returnedAtMs !== null && prevSince !== null) {
        while (censusBusy) await sleep(1000);   // the last CALL's cadence read still in flight: one Logs reader at a time
        handed = await breathe(n, returnedAtMs, prevSince);
      }
      if (stopping) {
        const t = stopping as Trip;
        recordTrip(t, n);
        finish("stopped", `stop rule before CALL ${n}: ${t.reason}`);
        return;
      }

      // b. The census before EVERY CALL (prod). From CALL 2 it is the reading the
      //    breather ended on (its dark already counted there); CALL 1, and a
      //    breather that never got past the walls, read it here. FIX-1234 D2:
      //    either way its 57014 half is judged on the minutes OUTSIDE the CALLs
      //    run so far — the CALLs are the budget's to judge.
      if (target === "prod") {
        while (censusBusy) await sleep(1000);   // a cadence read still in flight
        let reading: { code: number; summary: string; json: CensusJson | null };
        let row: CensusRow;
        if (handed) {
          reading = handed;
          row = handed.row;
        } else {
          reading = await runCensus(15, log);
          row = { at: new Date().toISOString(), minutes: 15, code: reading.code, summary: reading.summary, phase: "pre_call", before_call: n, would_trip: false };
          R.census.push(row);
        }
        const pc = preCallCensus(stopState, reading.code, reading.json, R.calls, handed !== null);
        let v: Trip | null = pc.trip;
        if (pc.outside) row.outside_calls = outsideCallsRow(pc.outside);
        lastCensusAt = Date.now();
        log(`[census] pre-CALL ${n} 15 min: ${reading.summary}${handed ? " (the breather's reading)" : ""}` +
          `${pc.outside ? ` — ${outsideCallsLine(pc.outside)}` : ""}`);
        // FIX-1232 D3 (ii): the CALL just finished, judged on its whole span.
        const prev = R.calls[R.calls.length - 1];
        if (prev && (reading.code === CENSUS_EXIT.pass || reading.code === CENSUS_EXIT.fail)) {
          const got = await finalCallRenders(prev, reading.json);
          const bt = got ? judgeCall(prev, got, true) : null;
          if (got) log(`[budget] CALL ${prev.n}: ${got.renders} render(s) / ${got.events} event(s) (budget ${args.rendersPerCallMax})`);
          v = bt ?? v;
        }
        if (v) {
          recordTrip(v, n);
          finish("stopped", `stop rule before CALL ${n}: ${v.reason}`);
          return;
        }
      }

      const clock = (await c.query<{ t: string; ms: number }>(
        "SELECT c::text AS t, (EXTRACT(epoch FROM c) * 1000)::float8 AS ms FROM (SELECT clock_timestamp() AS c) x")).rows[0]!;
      const since = clock.t;

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
      await c.query(PACING_UPSERT_SQL, [JSON.stringify({ max_units: args.unitsPerCall })]);
      crawlDirty = true;
      R.pacing.upserts += 1;
      log(`[pacing] donor_party_crawl = {"max_units": ${args.unitsPerCall}} (prior: ${JSON.stringify(R.pacing.prior_value)})`);

      const rec: CallRecord = {
        n, units: args.unitsPerCall, pid, started_at: since, started_ms: Number(clock.ms), returned_at: null, returned_ms: null,
        wall_s: null, row: null, verdict: "", watchdog_walls: [], windows_done_after: null, renders: null,
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
          maybeCensus(rec);
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
      rec.returned_ms = returnedAtMs;

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
        const restore = pacingRestoreStatement(R.pacing.prior_value);
        await snapC.query(restore.sql, restore.params);
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
    // FIX-1232 D5 — the whole run's renders, read once the claim is released:
    // the receipt's per-CALL and per-breather lines, and the run total.
    if (target === "prod" && R.calls.length > 0) {
      await readRunRenders().catch((e: unknown) => log(`[census] the run's renders read failed: ${errText(e)}`));
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
