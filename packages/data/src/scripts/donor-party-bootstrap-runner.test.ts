/**
 * FIX-1212 / FIX-1215 — the bootstrap runner's decisions, without a database:
 * the loop verdict over a fake data_sync_log row (the whole outcome
 * vocabulary, rule 48), the stop rule over fake readings, the breather, the
 * resume and caught_up checks, the receipt path, and the args.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  EXIT,
  breatherRelease,
  callNoLongerRunning,
  caughtUpMismatch,
  classifyCallRow,
  elevatedJobs,
  evaluateCensus,
  evaluateWatchdogs,
  newStopState,
  parseRunnerArgs,
  receiptPaths,
  resumeWindow,
  type CallRow,
} from "./donor-party-bootstrap-runner";

const row = (status: string, extra: Partial<CallRow> = {}, md: Record<string, unknown> = {}): CallRow => ({
  id: "x", status, started_at: "t", completed_at: "t", error_message: null, metadata: md, ...extra,
});

const OPTS = { wallTripS: 3.0, tripOnWallMs: null, armed: true };

test("caught_up → done, exit 0", () => {
  const v = classifyCallRow(row("complete", {}, { mode: "full", caught_up: true }), 3, 12);
  assert.equal(v.action, "done");
  assert.equal(EXIT.caught_up, 0);
});

test("partial + unit cap → continue; partial + wall-clock budget → continue", () => {
  assert.equal(classifyCallRow(row("partial", { error_message: "unit cap reached — 2 unit(s) run, resumable" },
    { caught_up: false }), 1, 12).action, "continue");
  assert.equal(classifyCallRow(row("partial", { error_message: "wall-clock budget reached — 9 unit(s) run, resumable" },
    { caught_up: false }), 2, 12).action, "continue");
});

test("skipped → stop skipped, exit 5 — the claimant was not honoured, or another holder", () => {
  const v = classifyCallRow(row("skipped", {}, { skip_reason: "prod session held: x" }), 1, 12);
  assert.equal(v.action, "stop");
  assert.equal(v.action === "stop" && v.outcome, "skipped");
  assert.match(v.detail, /prod session held: x/);
  assert.equal(EXIT.skipped, 5);
});

test("failed → stopped, exit 4; a canceled partial → stopped with the cancel_detail", () => {
  const f = classifyCallRow(row("failed", { error_message: "window 3: boom" }), 1, 12);
  assert.equal(f.action === "stop" && f.outcome, "stopped");
  const c = classifyCallRow(row("partial", { error_message: "canceled — window 4: …" },
    { canceled: true, cancel_detail: "window 4: canceling statement due to user request" }), 2, 12);
  assert.equal(c.action === "stop" && c.outcome, "stopped");
  assert.match(c.detail, /window 4: canceling statement due to user request/);
  assert.equal(EXIT.stopped, 4);
});

test("max-calls → stop max_calls, exit 6 — only when the row would otherwise continue", () => {
  const v = classifyCallRow(row("partial", { error_message: "unit cap reached — 2 unit(s) run, resumable" }), 12, 12);
  assert.equal(v.action === "stop" && v.outcome, "max_calls");
  assert.equal(EXIT.max_calls, 6);
  // caught up on the last allowed call is still caught up
  assert.equal(classifyCallRow(row("complete", {}, { caught_up: true }), 12, 12).action, "done");
});

test("no row, a row left running, or an unrecognised partial → stopped", () => {
  for (const r of [null, row("running"), row("partial", { error_message: "something else" })]) {
    const v = classifyCallRow(r, 1, 12);
    assert.equal(v.action === "stop" && v.outcome, "stopped", JSON.stringify(r));
  }
});

test("stop rule (2): one slow watchdog reading is noise; two consecutive at >= wall-trip-s trip", () => {
  const s = newStopState();
  const r = (w: number) => ({ at: "t", walls: { "cron-job-budget-watchdog": w, "derived-mvs-unit-watchdog": 0.01 }, startupTimeouts: 0, callBackendPresent: true });
  assert.equal(evaluateWatchdogs(s, r(3.3), OPTS), null);
  assert.equal(evaluateWatchdogs(s, r(0.02), OPTS), null, "a healthy reading resets the count");
  assert.equal(evaluateWatchdogs(s, r(3.3), OPTS), null);
  const t = evaluateWatchdogs(s, r(4.1), OPTS);
  assert.equal(t?.rule, 2);
  assert.match(t?.reason ?? "", /^\(2\) cron-job-budget-watchdog/);
});

test("cc-148 D1: 2.9 s on two distinct runs is ELEVATED, never a trip; 3.0 s on two distinct runs trips and names both runs", () => {
  const r = (runid: string, wall: number) => ({
    at: runid, walls: { w: wall }, runs: { w: { runid, running: false } }, startupTimeouts: 0, callBackendPresent: true,
  });
  const s = newStopState();
  for (const id of ["R1", "R2", "R3", "R4"]) {
    assert.equal(evaluateWatchdogs(s, r(id, 2.9), OPTS), null, `2.9 s on ${id}`);
    assert.deepEqual(elevatedJobs({ w: 2.9 }, 3.0), ["w"]);
  }
  const t = newStopState();
  assert.equal(evaluateWatchdogs(t, r("R10", 3.0), OPTS), null);
  const trip = evaluateWatchdogs(t, r("R12", 3.0), OPTS);
  assert.equal(trip?.rule, 2);
  assert.equal(trip?.job, "w");
  assert.deepEqual(trip?.run_ids, ["R10", "R12"]);
  // the cc-147 probe profile — 0.874, 1.341 on distinct runs — is load now
  const p = newStopState();
  assert.equal(evaluateWatchdogs(p, r("P1", 0.874), OPTS), null);
  assert.equal(evaluateWatchdogs(p, r("P2", 1.341), OPTS), null);
  assert.equal(evaluateWatchdogs(p, r("P3", 1.341), OPTS), null);
});

test("elevated band is [1.0, wall-trip-s): 0.999 is not load, 1.0 is, the trip value is not", () => {
  assert.deepEqual(elevatedJobs({ a: 0.999, b: 1.0, c: 2.999, d: 3.0 }, 3.0), ["b", "c"]);
});

test("stop rule (2), cc-147: ONE completed run read twice is one vote, not two", () => {
  // Prod 09:06:49 tick and 09:07:05 pre-CALL both read the 09:06 run.
  const s = newStopState();
  const r = (at: string, runid: string, wall: number, running = false) => ({
    at, walls: { w: wall }, runs: { w: { runid, running } }, startupTimeouts: 0, callBackendPresent: true,
  });
  assert.equal(evaluateWatchdogs(s, r("09:06:49", "R906", 3.341), OPTS), null);
  assert.equal(evaluateWatchdogs(s, r("09:07:05", "R906", 3.341), OPTS), null, "same run: no second vote");
  assert.match(evaluateWatchdogs(s, r("09:08:49", "R908", 3.2), OPTS)?.reason ?? "", /two distinct runs \(R906, R908\)/, "the next run over trips");
  // a hung watchdog run votes at every reading
  const h = newStopState();
  assert.equal(evaluateWatchdogs(h, r("a", "R1", 5, true), OPTS), null);
  assert.match(evaluateWatchdogs(h, r("b", "R1", 125, true), OPTS)?.reason ?? "", /two distinct runs/);
});

test("rule 66 under the session pooler: an idle DISCARD ALL backend is not running the CALL", () => {
  assert.equal(callNoLongerRunning(undefined), true);
  assert.equal(callNoLongerRunning({ state: "idle", query: "DISCARD ALL" }), true, "the cc-147 prod reading");
  assert.equal(callNoLongerRunning({ state: "active", query: "CALL public.refresh_donor_party_rollup_incremental()" }), false);
  assert.equal(callNoLongerRunning({ state: "idle", query: "CALL public.refresh_donor_party_rollup_incremental()" }), false,
    "idle with the CALL as its last query: not proven finished — keep waiting");
});

test("stop rule (1) and (4) trip on a single reading, and name their rule", () => {
  assert.equal(evaluateWatchdogs(newStopState(), { at: "t", walls: {}, startupTimeouts: 1, callBackendPresent: true }, OPTS)?.rule, 1);
  assert.equal(evaluateWatchdogs(newStopState(), { at: "t", walls: {}, startupTimeouts: 0, callBackendPresent: false }, OPTS)?.rule, 4);
  assert.equal(evaluateWatchdogs(newStopState(), { at: "t", walls: {}, startupTimeouts: 0, callBackendPresent: null }, OPTS), null,
    "null = no CALL in flight, not a gone backend");
  // (1) wins even while the walls are only elevated
  assert.equal(evaluateWatchdogs(newStopState(), { at: "t", walls: { w: 1.5 }, startupTimeouts: 2, callBackendPresent: true }, OPTS)?.rule, 1);
});

test("test-only --trip-on-wall-ms 0 trips every reading — the same run included — but only once armed", () => {
  const r = { at: "t", walls: { a: 0.001 }, runs: { a: { runid: "R1", running: false } }, startupTimeouts: 0, callBackendPresent: true };
  const unarmed = newStopState();
  assert.equal(evaluateWatchdogs(unarmed, r, { wallTripS: 3, tripOnWallMs: 0, armed: false }), null);
  assert.equal(evaluateWatchdogs(unarmed, r, { wallTripS: 3, tripOnWallMs: 0, armed: false }), null);
  const armed = newStopState();
  assert.equal(evaluateWatchdogs(armed, r, { wallTripS: 3, tripOnWallMs: 0, armed: true }), null);
  assert.match(evaluateWatchdogs(armed, { ...r, at: "t2" }, { wallTripS: 3, tripOnWallMs: 0, armed: true })?.reason ?? "", /test trip/);
});

test("stop rule (3): census fail trips at once; Logs API dark trips on the second consecutive", () => {
  const s = newStopState();
  assert.equal(evaluateCensus(s, 0), null);
  assert.equal(evaluateCensus(s, 2), null);
  assert.equal(evaluateCensus(s, 0), null, "a pass resets the dark count");
  assert.equal(evaluateCensus(s, 2), null);
  assert.equal(evaluateCensus(s, 2)?.rule, 3);
  assert.match(evaluateCensus(newStopState(), 1)?.reason ?? "", /pass=false/);
});

test("cc-148 D2 breather: released only by a run that STARTED after the CALL returned, under the threshold, for BOTH watchdogs", () => {
  const ret = 1_000_000;
  const run = (jobname: string, start_ms: number, wall_s: number) => ({ jobname, runid: `${jobname}@${start_ms}`, start_ms, wall_s });
  // the run that straddled the CALL does not count, however fast it was
  const a = breatherRelease([run("budget", ret - 30_000, 0.02), run("derived", ret + 60_000, 0.01)], ret, 0.5);
  assert.equal(a.released, false);
  assert.match(a.pending.join(), /budget: no run since the CALL returned/);
  // a post-CALL run still over the threshold keeps it waiting
  const b = breatherRelease([run("budget", ret + 60_000, 0.612), run("derived", ret + 60_000, 0.061)], ret, 0.5);
  assert.equal(b.released, false);
  assert.match(b.pending.join(), /budget: 0\.612 s >= 0\.5 s/);
  // both recovered
  const c = breatherRelease([run("budget", ret + 180_000, 0.02), run("derived", ret + 180_000, 0.004)], ret, 0.5);
  assert.deepEqual(c, { released: true, pending: [] });
});

test("cc-148 D3 resume: the first window not in windows_done", () => {
  assert.equal(resumeWindow({ mode: "full", windows_done: [1, 2] }), 3);
  assert.equal(resumeWindow({ mode: "full", windows_done: [1, 2, 4] }), 3);
  assert.equal(resumeWindow({ mode: "full", windows_done: [] }), 1);
  assert.equal(resumeWindow(null), null);
  assert.equal(resumeWindow({ windows_done: Array.from({ length: 16 }, (_, i) => i + 1) }), null);
});

test("cc-148 D3 caught_up is asserted: cursor gone AND watermark = target, else a named mismatch", () => {
  const T = "2026-09-21T00:18:25.831727+00:00";
  assert.equal(caughtUpMismatch({ cursor_gone: true, target: T, equal: true }), null);
  assert.match(caughtUpMismatch({ cursor_gone: false, target: T, equal: true }) ?? "", /cursor is still present/);
  assert.match(caughtUpMismatch({ cursor_gone: true, target: T, equal: false }) ?? "", /does not equal the cycle target/);
  assert.match(caughtUpMismatch({ cursor_gone: true, target: null, equal: null }) ?? "", /no cycle target/);
});

test("receipt paths never overwrite: a second launch on the same UTC day gets a time suffix", () => {
  const at = "2026-09-23T23:45:12.345Z";
  const none = receiptPaths("prod", at, null, () => false);
  assert.equal(path.basename(none.md), "2026-09-23-fix1212-bootstrap-runner.md");
  const taken = receiptPaths("prod", at, null, (p) => p.endsWith("2026-09-23-fix1212-bootstrap-runner.md"));
  assert.equal(path.basename(taken.md), "2026-09-23-fix1212-bootstrap-runner-234512Z.md");
  assert.equal(path.basename(taken.json), "2026-09-23-fix1212-bootstrap-runner-234512Z.json");
  assert.equal(path.basename(receiptPaths("local", at, "trip", () => false).md), "2026-09-23-fix1212-bootstrap-runner-local-trip.md");
});

test("args: defaults, overrides, and refusals", () => {
  assert.deepEqual(parseRunnerArgs([]), {
    unitsPerCall: 2, wallTripS: 3.0, breatherUntilWallS: 0.5, breatherMaxS: 600,
    maxWaitMinutes: 480, pollSeconds: 300, maxCalls: 12, expectedMinutes: 60,
    tickSeconds: 120, tripOnWallMs: null, tripFromCall: 1, receiptTag: null,
  });
  const a = parseRunnerArgs(["--units-per-call", "3", "--max-calls=4", "--trip-on-wall-ms", "0", "--receipt-tag", "trip",
    "--wall-trip-s", "2.5", "--breather-until-wall-s=0.25", "--breather-max-s", "20"]);
  assert.ok(!("error" in a));
  assert.equal(a.unitsPerCall, 3);
  assert.equal(a.maxCalls, 4);
  assert.equal(a.tripOnWallMs, 0);
  assert.equal(a.receiptTag, "trip");
  assert.equal(a.wallTripS, 2.5);
  assert.equal(a.breatherUntilWallS, 0.25);
  assert.equal(a.breatherMaxS, 20);
  assert.ok("error" in parseRunnerArgs(["--force"]), "no --force, ever");
  assert.ok("error" in parseRunnerArgs(["--probe-units", "2"]), "--probe-units is replaced by --units-per-call");
  const cmd = parseRunnerArgs(["--units-per-call", "2", "--wall-trip-s", "3.0", "--breather-until-wall-s", "0.5",
    "--breather-max-s", "600", "--max-calls", "12", "--expected-minutes", "60", "--max-wait-minutes", "180"]);
  assert.ok(!("error" in cmd), "the cc-148 launch command parses");
  const dd = parseRunnerArgs(["--", "--units-per-call", "2", "--max-calls", "8"]);
  assert.ok(!("error" in dd), "pnpm 9 forwards a bare -- ; the prompt-shaped command must launch");
  assert.equal(dd.maxCalls, 8);
  assert.ok("error" in parseRunnerArgs(["--max-calls", "0"]));
  assert.ok("error" in parseRunnerArgs(["--wall-trip-s", "0"]));
  assert.ok("error" in parseRunnerArgs(["--receipt-tag", "../x"]));
});
