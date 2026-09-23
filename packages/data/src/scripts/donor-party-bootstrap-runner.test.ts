/**
 * FIX-1212 / FIX-1215 — the bootstrap runner's decisions, without a database:
 * the loop verdict over a fake data_sync_log row (the whole outcome
 * vocabulary, rule 48), the stop rule over fake readings, and the args.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT,
  classifyCallRow,
  evaluateCensus,
  evaluateWatchdogs,
  newStopState,
  parseRunnerArgs,
  type CallRow,
} from "./donor-party-bootstrap-runner";

const row = (status: string, extra: Partial<CallRow> = {}, md: Record<string, unknown> = {}): CallRow => ({
  id: "x", status, started_at: "t", completed_at: "t", error_message: null, metadata: md, ...extra,
});

test("caught_up → done, exit 0", () => {
  const v = classifyCallRow(row("complete", {}, { mode: "full", caught_up: true }), 3, 8);
  assert.equal(v.action, "done");
  assert.equal(EXIT.caught_up, 0);
});

test("partial + unit cap → continue; partial + wall-clock budget → continue", () => {
  assert.equal(classifyCallRow(row("partial", { error_message: "unit cap reached — 2 unit(s) run, resumable" },
    { caught_up: false }), 1, 8).action, "continue");
  assert.equal(classifyCallRow(row("partial", { error_message: "wall-clock budget reached — 9 unit(s) run, resumable" },
    { caught_up: false }), 2, 8).action, "continue");
});

test("skipped → stop skipped, exit 5 — the claimant was not honoured, or another holder", () => {
  const v = classifyCallRow(row("skipped", {}, { skip_reason: "prod session held: x" }), 1, 8);
  assert.equal(v.action, "stop");
  assert.equal(v.action === "stop" && v.outcome, "skipped");
  assert.match(v.detail, /prod session held: x/);
  assert.equal(EXIT.skipped, 5);
});

test("failed → stopped, exit 4; a canceled partial → stopped with the cancel_detail", () => {
  const f = classifyCallRow(row("failed", { error_message: "window 3: boom" }), 1, 8);
  assert.equal(f.action === "stop" && f.outcome, "stopped");
  const c = classifyCallRow(row("partial", { error_message: "canceled — window 4: …" },
    { canceled: true, cancel_detail: "window 4: canceling statement due to user request" }), 2, 8);
  assert.equal(c.action === "stop" && c.outcome, "stopped");
  assert.match(c.detail, /window 4: canceling statement due to user request/);
  assert.equal(EXIT.stopped, 4);
});

test("max-calls → stop max_calls, exit 6 — only when the row would otherwise continue", () => {
  const v = classifyCallRow(row("partial", { error_message: "unit cap reached — 40 unit(s) run, resumable" }), 8, 8);
  assert.equal(v.action === "stop" && v.outcome, "max_calls");
  assert.equal(EXIT.max_calls, 6);
  // caught up on the last allowed call is still caught up
  assert.equal(classifyCallRow(row("complete", {}, { caught_up: true }), 8, 8).action, "done");
});

test("no row, a row left running, or an unrecognised partial → stopped", () => {
  for (const r of [null, row("running"), row("partial", { error_message: "something else" })]) {
    const v = classifyCallRow(r, 1, 8);
    assert.equal(v.action === "stop" && v.outcome, "stopped", JSON.stringify(r));
  }
});

test("stop rule (2): one slow watchdog reading is noise; two consecutive trip", () => {
  const s = newStopState();
  const opts = { thresholdS: 1.0, tripOnWallMs: null, armed: true };
  const r = (w: number) => ({ at: "t", walls: { "cron-job-budget-watchdog": w, "derived-mvs-unit-watchdog": 0.01 }, startupTimeouts: 0, callBackendPresent: true });
  assert.equal(evaluateWatchdogs(s, r(1.3), opts), null);
  assert.equal(evaluateWatchdogs(s, r(0.02), opts), null, "a healthy reading resets the count");
  assert.equal(evaluateWatchdogs(s, r(1.3), opts), null);
  assert.match(evaluateWatchdogs(s, r(2.1), opts) ?? "", /^\(2\) cron-job-budget-watchdog/);
});

test("stop rule (1) and (4) trip on a single reading", () => {
  const opts = { thresholdS: 1.0, tripOnWallMs: null, armed: true };
  assert.match(evaluateWatchdogs(newStopState(), { at: "t", walls: {}, startupTimeouts: 1, callBackendPresent: true }, opts) ?? "", /^\(1\)/);
  assert.match(evaluateWatchdogs(newStopState(), { at: "t", walls: {}, startupTimeouts: 0, callBackendPresent: false }, opts) ?? "", /^\(4\)/);
  assert.equal(evaluateWatchdogs(newStopState(), { at: "t", walls: {}, startupTimeouts: 0, callBackendPresent: null }, opts), null,
    "null = no CALL in flight, not a gone backend");
});

test("test-only --trip-on-wall-ms 0 trips every reading, but only once armed", () => {
  const r = { at: "t", walls: { a: 0.001 }, startupTimeouts: 0, callBackendPresent: true };
  const unarmed = newStopState();
  assert.equal(evaluateWatchdogs(unarmed, r, { thresholdS: 1, tripOnWallMs: 0, armed: false }), null);
  assert.equal(evaluateWatchdogs(unarmed, r, { thresholdS: 1, tripOnWallMs: 0, armed: false }), null);
  const armed = newStopState();
  assert.equal(evaluateWatchdogs(armed, r, { thresholdS: 1, tripOnWallMs: 0, armed: true }), null);
  assert.match(evaluateWatchdogs(armed, r, { thresholdS: 1, tripOnWallMs: 0, armed: true }) ?? "", /test trip/);
});

test("stop rule (3): census fail trips at once; Logs API dark trips on the second consecutive", () => {
  const s = newStopState();
  assert.equal(evaluateCensus(s, 0), null);
  assert.equal(evaluateCensus(s, 2), null);
  assert.equal(evaluateCensus(s, 0), null, "a pass resets the dark count");
  assert.equal(evaluateCensus(s, 2), null);
  assert.match(evaluateCensus(s, 2) ?? "", /dark on two consecutive/);
  assert.match(evaluateCensus(newStopState(), 1) ?? "", /pass=false/);
});

test("args: defaults, overrides, and refusals", () => {
  assert.deepEqual(parseRunnerArgs([]), {
    probeUnits: 2, maxWaitMinutes: 480, pollSeconds: 300, maxCalls: 8, expectedMinutes: 90,
    tickSeconds: 120, tripOnWallMs: null, tripFromCall: 1, receiptTag: null,
  });
  const a = parseRunnerArgs(["--probe-units", "3", "--max-calls=4", "--trip-on-wall-ms", "0", "--receipt-tag", "trip"]);
  assert.ok(!("error" in a));
  assert.equal(a.probeUnits, 3);
  assert.equal(a.maxCalls, 4);
  assert.equal(a.tripOnWallMs, 0);
  assert.equal(a.receiptTag, "trip");
  assert.ok("error" in parseRunnerArgs(["--force"]), "no --force, ever");
  const dd = parseRunnerArgs(["--", "--probe-units", "2", "--max-calls", "8"]);
  assert.ok(!("error" in dd), "pnpm 9 forwards a bare -- ; the prompt-shaped command must launch");
  assert.equal(dd.maxCalls, 8);
  assert.ok("error" in parseRunnerArgs(["--max-calls", "0"]));
  assert.ok("error" in parseRunnerArgs(["--receipt-tag", "../x"]));
});
