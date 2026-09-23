/**
 * FIX-1212 / FIX-1215 — the unattended donor-party bootstrap runner.
 *
 *   pnpm --filter @civitics/data data:donor-party:bootstrap:prod \
 *     --probe-units 2 --max-wait-minutes 480 --max-calls 8
 *
 * Launched once, from the PRIMARY checkout (its .env.local.prod is the real
 * one; a worktree's is a stub), as a background process. It needs nobody:
 *
 *   1. WAIT   waitForProdOpGate(5400 s) — the prod-op window as a CONDITION
 *             read every --poll-seconds from public.prod_op_gate() (FIX-1215),
 *             not a clock anybody computed. The wait is BEFORE the claim: a
 *             claim held through a four-hour wait would hold every guarded
 *             pipeline for nothing (rule 102).
 *   2. CENSUS cancellation-census.ts --minutes 60 --json must PASS, else exit 3
 *             without claiming. (Logs API; prod only — skipped on the clone,
 *             which has no Logs API.)
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
 *   5. PROBE  pipeline_state.donor_party_crawl = {"max_units": --probe-units}
 *             for the FIRST CALL only, then DELETED — restoring "absent", never
 *             writing "defaults" (prod has no row). Its windows' stage/apply
 *             seconds are the first prod measurement of a window's wall — the
 *             projection nobody had (rule 132).
 *   6. LOOP   CALL public.refresh_donor_party_rollup_incremental(); read its
 *             terminal data_sync_log row: caught_up → done; partial with "unit
 *             cap reached" / "wall-clock budget reached" → again; skipped →
 *             exit 5; failed / canceled → exit 4; --max-calls → exit 6.
 *   7. RELEASE, then the after-reads and the receipt (written in `finally`,
 *             whatever the outcome — rule 48).
 *
 * ── THE STOP RULE, IN CODE (rule 65/66) ─────────────────────────────────────
 * Read on connection T once before each CALL and every --tick-seconds (120)
 * while one is in flight:
 *   (1) any `job startup timeout` failure on ANY job since the CALL began;
 *   (2) either every-2-min watchdog's latest wall > 1.0 s on two consecutive readings
 *       (0.003–0.13 s healthy; 1–4 s the pre-failure signature, cc-145 §1);
 *   (3) every 15 min the census (child process) with pass=false; exit 2 (the
 *       Logs API dark) is logged, and TWO consecutive exit-2s trip — the Logs
 *       API going dark was itself a symptom on 09-22 (rule 164);
 *   (4) the CALL's backend gone from pg_stat_activity (the box, not the
 *       procedure).
 * On trip: pg_cancel_backend(<CALL pid>) from T; wait for the CALL to return
 * (the procedure's query_canceled handler records `partial` + cancel_detail and
 * stops — rule 114; the window in flight rolls back whole; committed windows
 * and the cursor stay); close C and verify the backend is GONE (rule 66);
 * release; receipt `outcome: stopped`; exit 4. No retry without Craig.
 *
 * EXIT CODES
 *   0 caught_up · 1 error · 3 census_fail (pre-launch) · 4 stopped ·
 *   5 skipped · 6 max_calls · 7 gate_timeout
 * `pnpm --filter … <key>` and plain `pnpm <key>` pass the code through; `pnpm -s
 * <key>` collapses every non-zero code to 1 (pnpm 9, Windows — measured cc-147).
 * The receipt's `exit_code` is authoritative either way.
 *
 * TEST-ONLY FLAGS (the clone rehearsals, rule 118): --trip-on-wall-ms N makes a
 * watchdog reading of >= N ms count as over (0: every reading), and
 * --trip-from-call K arms it from the K-th CALL, so the rehearsal's cancel
 * lands after windows have committed. --tick-seconds shortens the ticker.
 * --receipt-tag names a second local receipt. A local target always writes a
 * `-local` receipt — never over a prod one (the FIX-1209 shape).
 *
 * KNOWN MISLABEL (out of scope): the procedure stamps `source: 'pg_cron'` on
 * its data_sync_log row even when a supervised CALL ran it.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { buildDbUrl } from "../lib/heavy-rebuild";
import { GateTimeout, waitForProdOpGate, type GatePoll, type ProdOpGate } from "../lib/prod-op-gate";
import { ProdSessionRefused, withProdSession, type ProdSessionState } from "../lib/prod-session";
import { errText } from "../lib/session-lock";

export const REASON = "FIX-1212 bootstrap (cc-147 runner)";
const PIPELINE = "donor_party_rollup_refresh";
const APP = "civitics_dp_bootstrap";
const CALL_SQL = "CALL public.refresh_donor_party_rollup_incremental()";
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DATA_DIR = path.resolve(__dirname, "..", "..");

export type Outcome =
  | "caught_up" | "stopped" | "skipped" | "gate_timeout" | "census_fail" | "max_calls" | "error";

export const EXIT: Record<Outcome, number> = {
  caught_up: 0, error: 1, census_fail: 3, stopped: 4, skipped: 5, max_calls: 6, gate_timeout: 7,
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface RunnerArgs {
  probeUnits: number;
  maxWaitMinutes: number;
  pollSeconds: number;
  maxCalls: number;
  expectedMinutes: number;
  tickSeconds: number;
  tripOnWallMs: number | null;
  tripFromCall: number;
  receiptTag: string | null;
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
  const known = new Set([
    "--probe-units", "--max-wait-minutes", "--poll-seconds", "--max-calls", "--expected-minutes",
    "--tick-seconds", "--trip-on-wall-ms", "--trip-from-call", "--receipt-tag",
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
    ["probeUnits", "--probe-units", 2, 1],
    ["maxWaitMinutes", "--max-wait-minutes", 480, 1],
    ["pollSeconds", "--poll-seconds", 300, 1],
    ["maxCalls", "--max-calls", 8, 1],
    ["expectedMinutes", "--expected-minutes", 90, 1],
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
  return {
    probeUnits: Math.floor(out["probeUnits"]!),
    maxWaitMinutes: out["maxWaitMinutes"]!,
    pollSeconds: out["pollSeconds"]!,
    maxCalls: Math.floor(out["maxCalls"]!),
    expectedMinutes: out["expectedMinutes"]!,
    tickSeconds: out["tickSeconds"]!,
    tripOnWallMs,
    tripFromCall: Math.floor(out["tripFromCall"]!),
    receiptTag: tag,
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

export interface StopState {
  consecutiveOver: Record<string, number>;
  /** The vote key last counted per job — see WatchdogReading.runs. */
  lastVote: Record<string, string>;
  consecutiveCensusDark: number;
}

export const newStopState = (): StopState => ({ consecutiveOver: {}, lastVote: {}, consecutiveCensusDark: 0 });

export function evaluateWatchdogs(
  state: StopState,
  r: WatchdogReading,
  opts: { thresholdS: number; tripOnWallMs: number | null; armed: boolean },
): string | null {
  if (r.startupTimeouts > 0) return `(1) ${r.startupTimeouts} job startup timeout failure(s) since the CALL began`;
  if (r.callBackendPresent === false) return "(4) the CALL's backend is gone from pg_stat_activity";
  for (const [job, wall] of Object.entries(r.walls)) {
    const run = r.runs?.[job];
    if (run) {
      const vote = run.running ? `${run.runid}@${r.at}` : run.runid;
      if (state.lastVote[job] === vote) continue;   // the same completed run, read again
      state.lastVote[job] = vote;
    }
    const over = opts.armed && opts.tripOnWallMs !== null
      ? wall * 1000 >= opts.tripOnWallMs
      : wall > opts.thresholdS;
    state.consecutiveOver[job] = over ? (state.consecutiveOver[job] ?? 0) + 1 : 0;
    if (state.consecutiveOver[job]! >= 2) {
      return `(2) ${job} latest wall ${wall.toFixed(3)} s over ${opts.armed && opts.tripOnWallMs !== null
        ? `${opts.tripOnWallMs} ms (test trip)` : `${opts.thresholdS} s`} on two consecutive readings`;
    }
  }
  return null;
}

/** Census exit code → trip reason or null. 0 pass · 1 fail · 2 Logs API dark. */
export function evaluateCensus(state: StopState, exitCode: number): string | null {
  if (exitCode === 0) { state.consecutiveCensusDark = 0; return null; }
  if (exitCode === 1) { state.consecutiveCensusDark = 0; return "(3) census pass=false (57014 rate or front-door 5xx)"; }
  state.consecutiveCensusDark += 1;
  return state.consecutiveCensusDark >= 2 ? "(3) the Logs API was dark on two consecutive census readings" : null;
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
    child.on("error", (e) => { clearTimeout(timer); log(`[census] launch failed: ${e.message}`); resolve({ code: 2, summary: "launch failed" }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      let summary = `exit ${code}`;
      try {
        const j = JSON.parse(out) as { cancellations?: { total: number; rate: number; ratio: number }; edge?: { note: string }; pass?: boolean };
        summary = `pass=${j.pass} 57014=${j.cancellations?.total} (${j.cancellations?.rate}/min, ratio ${j.cancellations?.ratio}) edge ${j.edge?.note}`;
      } catch { /* non-JSON: exit 2 paths print nothing to stdout */ }
      resolve({ code: code ?? 2, summary });
    });
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface CallRecord {
  n: number;
  probe: boolean;
  pid: number;
  started_at: string;
  returned_at: string | null;
  wall_s: number | null;
  row: CallRow | null;
  verdict: string;
  watchdog_walls: { job: string; min: number; median: number; max: number; n: number }[];
  error?: string;
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
  gate: { polls: GatePoll[]; opened_at: string | null; opening_reading: ProdOpGate | null; waited_seconds: number | null };
  census: { at: string; minutes: number; code: number; summary: string }[];
  claim: { claimed_at: string | null; released_at: string | null; state_after_arm: Partial<ProdSessionState> | null };
  probe: { units: number; prior_value: Record<string, unknown> | null; restored: boolean | null };
  calls: CallRecord[];
  watchdog_series: WatchdogReading[];
  trip: { at: string; reason: string; call: number; cancel_sent: boolean; backend_gone_verified: boolean | null } | null;
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

function summarizeWalls(series: WatchdogReading[]) {
  const by: Record<string, number[]> = {};
  for (const r of series) for (const [j, w] of Object.entries(r.walls)) (by[j] ??= []).push(w);
  return Object.entries(by).map(([job, ws]) => ({
    job, n: ws.length, min: Math.min(...ws), median: median(ws), max: Math.max(...ws),
  }));
}

function receiptPaths(target: "prod" | "local", launchedAt: string, tag: string | null): { md: string; json: string } {
  const day = launchedAt.slice(0, 10);
  const base = `${day}-fix1212-bootstrap-runner${target === "local" ? "-local" : ""}${tag ? `-${tag}` : ""}`;
  const dir = path.join(REPO_ROOT, "docs", "audits");
  return { md: path.join(dir, `${base}.md`), json: path.join(dir, `${base}.json`) };
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
  L.push(`| detail | ${r.detail ?? "—"} |`);
  L.push(`| launched / finished | ${r.launched_at} / ${r.finished_at ?? "—"} |`);
  L.push(`| pid | ${r.pid} |`);
  L.push(`| args | \`${JSON.stringify(r.args)}\` |`);
  L.push(`| gate | ${r.gate.polls.length} poll(s); opened ${r.gate.opened_at ?? "never"} after ${f(r.gate.waited_seconds != null ? r.gate.waited_seconds / 60 : null)} min |`);
  L.push(`| claim | ${r.claim.claimed_at ?? "—"} → released ${r.claim.released_at ?? "—"} |`);
  L.push(`| probe | max_units ${r.probe.units}; prior value ${JSON.stringify(r.probe.prior_value)}; restored to prior: ${r.probe.restored ?? "—"} |`);
  L.push(`| before | watermark ${r.before?.watermark ?? "—"} · cursor ${r.before?.cursor ? "present" : "absent"} · MV ${r.before?.mv_rows ?? "—"} rows / SUM ${r.before?.mv_sum_cents ?? "—"} |`);
  L.push(`| after | watermark ${r.after?.watermark ?? "—"} · cursor ${r.after?.cursor ? JSON.stringify(r.after.cursor) : "absent"} · MV ${r.after?.mv_rows ?? "—"} rows / SUM ${r.after?.mv_sum_cents ?? "—"} |`);
  L.push(`| SUM after / before | ${r.sum_ratio_after_over_before == null ? "—" : r.sum_ratio_after_over_before.toFixed(6)} |`);
  L.push(`| trip | ${r.trip ? `${r.trip.at} call ${r.trip.call}: ${r.trip.reason}; cancel sent ${r.trip.cancel_sent}; backend gone verified ${r.trip.backend_gone_verified}` : "none"} |`);
  L.push("");
  L.push("## Gate polls");
  L.push("");
  for (const p of r.gate.polls) L.push(`- ${p.at} ${p.ok ? "**OK**" : `blocked: ${p.blocked.join(", ")}`}${p.error ? ` (${p.error})` : ""}`);
  L.push("");
  L.push("## CALLs");
  L.push("");
  L.push("| # | probe | pid | started | wall s | status | mode | windows_run | stage_seconds | apply_seconds | error / cancel | data_sync_log id |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of r.calls) {
    const md = c.row?.metadata ?? {};
    L.push(`| ${c.n} | ${c.probe ? "yes" : ""} | ${c.pid} | ${c.started_at} | ${f(c.wall_s)} | ${c.row?.status ?? "—"} | ${String(md["mode"] ?? "—")} | ` +
      `${JSON.stringify(md["windows_run"] ?? null)} | ${JSON.stringify(md["stage_seconds"] ?? null)} | ${JSON.stringify(md["apply_seconds"] ?? null)} | ` +
      `${String(md["cancel_detail"] ?? c.row?.error_message ?? c.error ?? "")} | ${c.row?.id ?? "—"} |`);
  }
  L.push("");
  L.push("## Watchdog walls per CALL (s)");
  L.push("");
  for (const c of r.calls) {
    L.push(`- CALL ${c.n}: ${c.watchdog_walls.map((w) => `${w.job} n=${w.n} min ${w.min.toFixed(3)} / median ${w.median.toFixed(3)} / max ${w.max.toFixed(3)}`).join("; ") || "(no readings)"}`);
  }
  L.push("");
  L.push("## Census");
  L.push("");
  for (const c of r.census) L.push(`- ${c.at} (${c.minutes} min) exit ${c.code}: ${c.summary}`);
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
    gate: { polls: [], opened_at: null, opening_reading: null, waited_seconds: null },
    census: [], claim: { claimed_at: null, released_at: null, state_after_arm: null },
    probe: { units: args.probeUnits, prior_value: null, restored: null },
    calls: [], watchdog_series: [], trip: null, before: null, after: null,
    sum_ratio_after_over_before: null, cursor_last: null,
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

  log(`[runner] target ${target} (${dbUrl.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@")}) · pid ${process.pid}`);
  log(`[runner] receipt → ${paths.md}`);
  log(`[runner] args ${JSON.stringify(args)}`);

  // Shared with the signal path.
  let callClient: Client | null = null;
  let callPid: number | null = null;
  let inCall = false;
  let stopping: string | null = null;
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

  let signalled = false;
  const onSignal = (sig: string) => {
    if (signalled) return;
    signalled = true;
    stopping = `${sig} received`;
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
    R.probe.prior_value = R.before.crawl_config;

    let lastCensusAt = Date.now();   // the pre-launch census counts as the first
    let censusBusy = false;
    const maybeCensus = () => {
      if (target !== "prod" || censusBusy || Date.now() - lastCensusAt < 15 * 60_000) return;
      censusBusy = true;
      lastCensusAt = Date.now();
      void runCensus(15, log).then((cen) => {
        censusBusy = false;
        R.census.push({ at: new Date().toISOString(), minutes: 15, code: cen.code, summary: cen.summary });
        log(`[census] 15 min: ${cen.summary}`);
        const trip = evaluateCensus(stopState, cen.code);
        if (trip && !stopping) {
          stopping = trip;
          if (inCall) {
            R.trip = { at: new Date().toISOString(), reason: trip, call: R.calls.length, cancel_sent: false, backend_gone_verified: null };
            void signalBackend("pg_cancel_backend", trip).then((ok) => { if (R.trip) R.trip.cancel_sent = ok; });
          }
        }
      });
    };

    for (let n = 1; n <= args.maxCalls; n++) {
      const probe = n === 1;
      const armed = n >= args.tripFromCall;
      const since = (await c.query<{ t: string }>("SELECT clock_timestamp()::text AS t")).rows[0]!.t;

      // The stop rule once BEFORE each CALL.
      const pre = await readWatchdogs(tClient, since, null);
      R.watchdog_series.push(pre);
      const preTrip = evaluateWatchdogs(stopState, pre, { thresholdS: 1.0, tripOnWallMs: args.tripOnWallMs, armed });
      log(`[tick] pre-CALL ${n}: ${Object.entries(pre.walls).map(([j, w]) => `${j}=${w.toFixed(3)}s`).join(" ")} startup_timeouts=${pre.startupTimeouts}`);
      maybeCensus();
      if (preTrip || stopping) {
        const why = preTrip ?? stopping ?? "";
        R.trip ??= { at: new Date().toISOString(), reason: why, call: n, cancel_sent: false, backend_gone_verified: null };
        finish("stopped", `stop rule before CALL ${n}: ${why}`);
        return;
      }

      if (probe) {
        await c.query(
          `INSERT INTO public.pipeline_state (key, value) VALUES ('donor_party_crawl', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
          [JSON.stringify({ max_units: args.probeUnits })]);
        log(`[probe] donor_party_crawl = {"max_units": ${args.probeUnits}} (prior: ${JSON.stringify(R.probe.prior_value)})`);
      }

      const rec: CallRecord = {
        n, probe, pid, started_at: since, returned_at: null, wall_s: null, row: null,
        verdict: "", watchdog_walls: [],
      };
      R.calls.push(rec);
      const callSeries: WatchdogReading[] = [pre];
      log(`[call ${n}] ${CALL_SQL}${probe ? ` (probe, max_units ${args.probeUnits})` : ""} on pid ${pid}`);
      const t0 = Date.now();
      inCall = true;
      let callErr: unknown = null;
      let done = false;
      const callP = c.query(CALL_SQL).then(
        () => { done = true; },
        (e: unknown) => { callErr = e; done = true; },
      );

      // The ticker, while the CALL is in flight.
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
          const trip = evaluateWatchdogs(stopState, r, { thresholdS: 1.0, tripOnWallMs: args.tripOnWallMs, armed });
          log(`[tick] CALL ${n} +${Math.round((Date.now() - t0) / 1000)}s: ${Object.entries(r.walls).map(([j, w]) => `${j}=${w.toFixed(3)}s`).join(" ")} startup_timeouts=${r.startupTimeouts} backend=${r.backend ?? "GONE"}`);
          maybeCensus();
          const why = trip ?? stopping;
          if (why && cancelAt === null) {
            stopping = why;
            R.trip = { at: new Date().toISOString(), reason: why, call: n, cancel_sent: false, backend_gone_verified: null };
            R.trip.cancel_sent = await signalBackend("pg_cancel_backend", why);
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
      rec.watchdog_walls = summarizeWalls(callSeries);
      if (callErr) rec.error = errText(callErr);

      if (probe) {
        // Restore "absent" (or exactly the prior value) — never "defaults".
        // On the ticker connection: C may be the thing that just died.
        try {
          if (R.probe.prior_value === null) {
            await tClient.query("DELETE FROM public.pipeline_state WHERE key = 'donor_party_crawl'");
          } else {
            await tClient.query(
              `UPDATE public.pipeline_state SET value = $1::jsonb, updated_at = clock_timestamp() WHERE key = 'donor_party_crawl'`,
              [JSON.stringify(R.probe.prior_value)]);
          }
          R.probe.restored = true;
          log(`[probe] donor_party_crawl restored to ${JSON.stringify(R.probe.prior_value)}`);
        } catch (e) {
          R.probe.restored = false;
          log(`[probe] RESTORE FAILED: ${errText(e)}`);
        }
      }

      if (callErr) {
        log(`[call ${n}] ERROR after ${rec.wall_s.toFixed(1)} s: ${rec.error}`);
        rec.row = await readCallRow(tClient, since).catch(() => null);
        rec.verdict = `error: ${rec.error}`;
        finish("stopped", `CALL ${n} raised: ${rec.error}${stopping ? ` (after trip: ${stopping})` : ""}`);
        return;
      }

      const row = await readCallRow(c, since);
      rec.row = row;
      const md = row?.metadata ?? {};
      log(`[call ${n}] returned in ${rec.wall_s.toFixed(1)} s: status=${row?.status} mode=${md["mode"]} windows_run=${JSON.stringify(md["windows_run"])} ` +
        `windows_done=${JSON.stringify(md["windows_done"])} stage_s=${JSON.stringify(md["stage_seconds"])} apply_s=${JSON.stringify(md["apply_seconds"])} ` +
        `caught_up=${md["caught_up"]} err="${row?.error_message ?? ""}" id=${row?.id}`);
      const v = classifyCallRow(row, n, args.maxCalls);
      rec.verdict = v.action === "continue" ? `continue: ${v.detail}` : `${v.outcome}: ${v.detail}`;
      if (stopping && v.action !== "done") {
        finish("stopped", `stop rule during CALL ${n}: ${stopping}; the CALL closed ${row?.status} (${String(md["cancel_detail"] ?? row?.error_message ?? "")})`);
        return;
      }
      if (v.action === "done") { finish("caught_up", `${v.detail} after ${n} CALL(s)`); return; }
      if (v.action === "stop") { finish(v.outcome, v.detail); return; }
    }
    finish("max_calls", `--max-calls ${args.maxCalls} exhausted`);
  };

  const run = async (): Promise<void> => {
    await tClient.connect();
    await tClient.query("SET statement_timeout = '30s'");
    const deadline = Date.now() + args.maxWaitMinutes * 60_000;
    for (;;) {
      // ── 1. wait for the window ─────────────────────────────────────────────
      let opened;
      try {
        opened = await waitForProdOpGate({
          dbUrl, expectedSeconds: args.expectedMinutes * 60, pollSeconds: args.pollSeconds,
          maxWaitSeconds: Math.max(1, (deadline - Date.now()) / 1000), log,
        });
      } catch (e) {
        if (e instanceof GateTimeout) {
          R.gate.polls.push(...e.polls);
          finish("gate_timeout", e.message);
          return;
        }
        throw e;
      }
      R.gate.polls.push(...opened.polls);
      R.gate.opened_at = opened.gate.checked_at;
      R.gate.opening_reading = opened.gate;
      R.gate.waited_seconds = (Date.now() - Date.parse(launchedAt)) / 1000;

      // ── 2. pre-launch census ─────────────────────────────────────────────
      if (target === "prod") {
        const cen = await runCensus(60, log);
        R.census.push({ at: new Date().toISOString(), minutes: 60, code: cen.code, summary: cen.summary });
        log(`[census] pre-launch 60 min: ${cen.summary}`);
        if (cen.code !== 0) {
          finish("census_fail", `pre-launch census exit ${cen.code}: ${cen.summary} — not claiming`);
          return;
        }
      } else {
        log("[census] skipped — local target has no Logs API");
      }

      // ── 3. claim; 4-6 under it; release in withProdSession's finally ─────
      try {
        await withProdSession({ reason: REASON, expectedMinutes: args.expectedMinutes, dbUrl }, async () => {
          R.claim.claimed_at = new Date().toISOString();
          log(`[claim] held — reason "${REASON}"`);
          try {
            await underClaim();
          } finally {
            // Close C and verify the CALL's backend is GONE (rule 66) BEFORE
            // the release, so the session never ends with our CALL still live.
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
                if (!gone) await new Promise((res) => setTimeout(res, 1000));
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
