/**
 * FIX-1212 / FIX-1215 — the bootstrap runner's decisions, without a database:
 * the loop verdict over a fake data_sync_log row (the whole outcome
 * vocabulary, rule 48), the stop rule over fake readings, the breather, the
 * resume and caught_up checks, the receipt path, and the args.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sampleQueryName } from "@civitics/db";
import { edgeVerdictFor, verdictFor } from "../lib/cancellation-census";
import type { GatePoll } from "../lib/prod-op-gate";
import {
  BREATHER_CENSUS_REREAD_S,
  EXIT,
  WOULD_TRIP_NOTE,
  breatherCensus,
  breatherRelease,
  breatherRendersLine,
  breatherTimeout,
  callNoLongerRunning,
  callRendersLine,
  callWindowRenders,
  caughtUpMismatch,
  censusHalfReading,
  censusLine,
  censusModeLine,
  censusSeconds,
  censusSummary,
  classifyCallRow,
  elevatedJobs,
  evaluateCallBudget,
  evaluateCensus,
  evaluateWatchdogs,
  gateTally,
  isTrip,
  newStopState,
  outsideCallsLine,
  outsideCallsRow,
  outsideCallsVerdict,
  parseRunnerArgs,
  pollLine,
  preCallCensus,
  preCallFail,
  receiptPaths,
  rendersSummary,
  resumeWindow,
  runRendersLine,
  vocabularyLine,
  type BudgetRow,
  type CallRow,
  type CensusJson,
  type CensusRow,
  type CensusSecond,
} from "./donor-party-bootstrap-runner";

const row = (status: string, extra: Partial<CallRow> = {}, md: Record<string, unknown> = {}): CallRow => ({
  id: "x", status, started_at: "t", completed_at: "t", error_message: null, metadata: md, ...extra,
});

const OPTS = { wallTripS: 3.0, tripOnWallMs: null, armed: true };

const sec3 = (startMs: number, events: number, sampleQuery = "get_official_page") => ({ startMs, events, sampleQuery });

// ── FIX-1234 fixtures: the rows cc-162 pulled, and the CALLs and breathers the prod receipts recorded ──

const FIXTURES = path.join(__dirname, "..", "..", "..", "db", "src", "__fixtures__", "census-renders");
const AUDITS = path.join(__dirname, "..", "..", "..", "..", "docs", "audits");

/** A renders fixture's rows as the census's --json `by_second` carries them. */
const fixtureSeconds = (win: string): CensusSecond[] => {
  const f = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${win}.renders.json`), "utf8")) as { answer: { rows: { s: number; n: number; q: string }[] } };
  return f.answer.rows.map((r) => ({ at: new Date(r.s * 1000).toISOString(), startMs: r.s * 1000, events: r.n, page: sampleQueryName(r.q) }));
};

/** A committed prod receipt's CALL spans and breathers. started_at is the DB clock's text form. */
const receipt = (file: string) => {
  const r = JSON.parse(fs.readFileSync(path.join(AUDITS, file), "utf8")) as {
    calls: { n: number; started_at: string; returned_at: string }[];
    breathers: { before_call: number; started_at: string; released_at: string; waited_s: number; released_by: string }[];
    census: { at: string; minutes: number; phase: string; before_call: number | null; code: number }[];
    args: { breatherMaxS: number };
  };
  const calls = r.calls.map((c) => ({
    n: c.n, started_ms: Date.parse(c.started_at.replace(" ", "T").replace(/\+00$/, "Z")), returned_ms: Date.parse(c.returned_at),
  }));
  return { ...r, spans: calls };
};

/** A gate-shaped --json reading over [end − minutes, end]: the fixture's seconds in it, both verdicts as the child computes them. */
const gateReading = (endMs: number, all: readonly CensusSecond[], edge: { requests: number; n5xx: number } | null, minutes = 15): CensusJson => {
  const startMs = endMs - minutes * 60_000;
  const secs = all.filter((s) => s.startMs >= startMs && s.startMs < endMs);
  const v = verdictFor({ renders: secs.map((s) => ({ startMs: s.startMs, events: s.events, sampleQuery: s.page })), minutes, baseline: 0.033 });
  const ev = edge ? edgeVerdictFor([{ startMs: 0, ...edge }], 0.0023) : null;
  return {
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), minutes },
    cancellations: { ...v, by_second: secs },
    ...(ev ? { edge: { note: ev.note, pass: ev.pass } } : {}),
    pass: v.pass && (ev?.pass ?? true),
  };
};

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

test("stop rule (3): a pre-CALL census fail trips at once; Logs API dark trips on the second consecutive", () => {
  const s = newStopState();
  assert.equal(evaluateCensus(s, 0), null);
  assert.equal(evaluateCensus(s, 2), null);
  assert.equal(evaluateCensus(s, 0), null, "a pass resets the dark count");
  assert.equal(evaluateCensus(s, 2), null);
  assert.equal(evaluateCensus(s, 2)?.rule, 3);
  assert.match(evaluateCensus(newStopState(), 1)?.reason ?? "", /pre-CALL census failed/);
  assert.deepEqual(evaluateCensus(newStopState(), 1), evaluateCensus(newStopState(), 1, "pre_call"), "pre_call is the default");
});

test("FIX-1232 rule 183: an exit 1 stops only BEFORE a CALL — a reading in a breather or during a CALL fails by construction and is not a stop", () => {
  for (const phase of ["breather", "cadence"] as const) {
    assert.equal(evaluateCensus(newStopState(), 1, phase), null, phase);
  }
  assert.equal(isTrip(evaluateCensus(newStopState(), 1, "pre_call")), true);
  assert.equal(preCallFail(1)?.rule, 3);
  for (const code of [0, 2, 8, 127]) assert.equal(preCallFail(code), null, `preCallFail(${code})`);
  assert.equal(isTrip(null), false);
});

test("FIX-1232: the dark-twice trip is armed wherever the census is read — two darks in a row trip across a breather and a CALL, and a FAIL still resets the count", () => {
  for (const [a, b] of [["pre_call", "pre_call"], ["breather", "breather"], ["breather", "cadence"], ["cadence", "pre_call"]] as const) {
    const s = newStopState();
    assert.equal(evaluateCensus(s, 2, a), null, `${a}: one dark is logged`);
    const t = evaluateCensus(s, 2, b);
    assert.equal(isTrip(t), true, `${a} → ${b}: two consecutive darks trip`);
    assert.match(t?.reason ?? "", /Logs API was dark on two consecutive/);
  }
  const u = newStopState();
  evaluateCensus(u, 2, "breather");
  evaluateCensus(u, 1, "breather");   // the Logs API answered
  assert.equal(evaluateCensus(u, 2, "breather"), null, "a FAIL answered, so the next dark is the first");
});

test("FIX-1232/FIX-1233 rule 105: cc-151's stop before CALL 6 — 4 renders across 5 CALLs is under budget 3 on every CALL, and the stopping reading flips to PASS on both halves", () => {
  // Per CALL, from the fixture windows (packages/db/src/__fixtures__/census-renders/cc151.renders.json):
  // CALL 1 09:07:53, CALL 3 09:19:59, CALL 4 09:24:21, CALL 5 09:30:26 (×6 events).
  for (const mode of ["stop", "report"] as const) {
    const s = newStopState();
    [1, 0, 1, 1, 1].forEach((renders, i) => {
      assert.equal(evaluateCallBudget(s, i + 1, renders, 3, mode), null, `${mode}: CALL ${i + 1} (${renders} render(s)) is under budget 3`);
    });
    assert.deepEqual(s.overBudgetCalls, []);
  }
  // The stopping reading, 09:19:11–09:34:11: 8 events are 3 renders.
  const v = verdictFor({ renders: [sec3(0, 1), sec3(1000, 1), sec3(2000, 6)], minutes: 15, baseline: 0.033 });
  assert.equal(v.pass, true, "3 renders <= P99 floor 3 (8 events > 3 stopped the run)");
  assert.equal(v.floor_renders, 3);
  assert.equal(v.events, 8);
  // FIX-1233 flipped the edge half: 2/183 = 1.09 % is over 1 % but not over the
  // binomial floor 2 at p0 = 0.23 %. The whole reading exits 0 — cc-151 would
  // have gone on to CALL 6.
  const ev = edgeVerdictFor([{ startMs: 0, requests: 183, n5xx: 2 }], 0.0023);
  assert.equal(ev.pass, true, "2/183 = 1.09 % > 1 % but <= floor 2");
  const code = v.pass && ev.pass ? 0 : 1;   // cancellation-census.ts exits 0 iff both halves pass
  assert.equal(code, 0);
  assert.equal(preCallFail(code), null);
});

test("FIX-1232 rule 105: cc-148's ~97 %-trip shape — an ordinary night read every 15 min during CALLs — is no stop at all", () => {
  // cc-148 §5.3: seven 15-min readings on a healthy night tripped with P ≈ 97 %
  // under the per-reading rule. During a CALL that reading is now retired, and
  // every CALL here is inside budget.
  const s = newStopState();
  for (let i = 0; i < 7; i++) {
    assert.equal(evaluateCensus(s, 1, "cadence"), null, `reading ${i + 1}: a FAIL during a CALL is not a stop`);
    assert.equal(evaluateCallBudget(s, i + 1, [1, 0, 2, 1, 0, 1, 3][i]!, 3, "stop"), null);
  }
});

test("FIX-1232 rule 105/117: a 6-render CALL is a would_trip once; the second consecutive stops (stop mode); report mode never stops", () => {
  const s = newStopState();
  const first = evaluateCallBudget(s, 1, 6, 3, "stop");
  assert.equal(isTrip(first), false);
  assert.deepEqual(first, { would_trip: true, rule: 3, reason: "(3) CALL 1 lost 6 render(s) > --renders-per-call-max 3", call: 1, renders: 6, budget: 3 });
  const second = evaluateCallBudget(s, 2, 6, 3, "stop");
  assert.equal(isTrip(second), true);
  assert.equal(second?.reason, "(3) CALL 2 lost 6 render(s) > --renders-per-call-max 3, and CALL 1 was over budget too — two consecutive CALLs (rule 117)");
  // Report mode: both recorded, neither stops.
  const r = newStopState();
  assert.equal(isTrip(evaluateCallBudget(r, 1, 6, 3, "report")), false);
  const r2 = evaluateCallBudget(r, 2, 6, 3, "report");
  assert.equal(r2?.would_trip, true);
  assert.equal(isTrip(r2), false);
});

test("FIX-1232 rule 117: one CALL is one vote — a partial and a final reading of the same CALL count once; a CALL under budget breaks the chain", () => {
  const s = newStopState();
  assert.equal(evaluateCallBudget(s, 1, 4, 3, "stop")?.would_trip, true, "CALL 1, read while it ran");
  assert.equal(evaluateCallBudget(s, 1, 6, 3, "stop"), null, "CALL 1 again, once it returned: already counted");
  assert.equal(evaluateCallBudget(s, 2, 3, 3, "stop"), null, "exactly the budget is inside it");
  assert.equal(isTrip(evaluateCallBudget(s, 3, 5, 3, "stop")), false, "CALL 3 over, but CALL 2 was not: a would_trip");
  assert.deepEqual(s.overBudgetCalls, [1, 3]);
  assert.equal(evaluateCallBudget(newStopState(), 1, 1, 0, "stop")?.would_trip, true, "--renders-per-call-max 0: any render is over");
});

test("FIX-1232 D3 (i): a breather with a render since the CALL returned is held; the next reading with none releases it; exit 8 releases on the walls; dark holds", () => {
  const returned = Date.parse("2026-09-25T00:49:37.060Z");
  const reading = (seconds: string[]) => ({
    window: { start: "2026-09-25T00:35:00Z", end: "2026-09-25T00:50:00Z", minutes: 15 },
    cancellations: {
      total: seconds.length, ratio: 0, pass: true, renders: seconds.length, events: seconds.length,
      by_second: seconds.map((at) => ({ at, startMs: Date.parse(at), events: 1, page: "get_official_page" })),
    },
  });
  // cc-154's CALL 1 render (00:46:37) is before the CALL returned: it is the CALL's, not the breather's.
  assert.deepEqual(breatherCensus(0, reading(["2026-09-25T00:46:37Z"]), returned), { released: true, renders: 0, pending: null });
  const held = breatherCensus(0, reading(["2026-09-25T00:46:37Z", "2026-09-25T00:49:50Z"]), returned);
  assert.deepEqual(held, { released: false, renders: 1, pending: "census: 1 render(s) since the CALL returned (get_official_page)" });
  assert.equal(breatherCensus(1, reading(["2026-09-25T00:49:50Z"]), returned).released, false, "a FAILing reading with a breather render still holds");
  assert.deepEqual(breatherCensus(8, null, returned), { released: true, renders: null, pending: null });
  assert.deepEqual(breatherCensus(2, null, returned), { released: false, renders: null, pending: "census dark — cannot confirm 0 renders" });
  assert.equal(breatherCensus(0, null, returned).pending, "census unparsed — cannot confirm 0 renders");
  // The render in the returning second counts for the breather.
  assert.equal(breatherCensus(0, reading(["2026-09-25T00:49:37Z"]), returned).renders, 1);
  assert.equal(BREATHER_CENSUS_REREAD_S, 60);
});

test("FIX-1232 D3 (ii): a CALL's renders come out of a reading that reaches back to its start; otherwise the runner reads the span itself", () => {
  const j = {
    window: { start: "2026-09-24T09:19:11.098Z", end: "2026-09-24T09:34:11.098Z", minutes: 15 },
    cancellations: {
      total: 8, ratio: 16.16, renders: 3, events: 8,
      by_second: [
        { at: "2026-09-24T09:19:59Z", startMs: Date.parse("2026-09-24T09:19:59Z"), events: 1, page: "get_official_page" },
        { at: "2026-09-24T09:24:21Z", startMs: Date.parse("2026-09-24T09:24:21Z"), events: 1, page: "officials" },
        { at: "2026-09-24T09:30:26Z", startMs: Date.parse("2026-09-24T09:30:26Z"), events: 6, page: "entity_tags" },
      ],
    },
  };
  const call5 = callWindowRenders(j, Date.parse("2026-09-24T09:28:20.064Z"), Date.parse("2026-09-24T09:32:36.625Z"));
  assert.deepEqual([call5?.renders, call5?.events, call5?.seconds.map((x) => x.page)], [1, 6, ["entity_tags"]]);
  assert.equal(callWindowRenders(j, Date.parse("2026-09-24T09:16:16.933Z"), Date.parse("2026-09-24T09:20:24.289Z")), null,
    "CALL 3 began before the reading's window: not answerable from it");
  assert.equal(callWindowRenders(null, 0, 1), null);
  // --renders-only's shape reads the same way.
  const only = { window: j.window, renders: { renders: 3, events: 8, by_second: j.cancellations.by_second } };
  assert.equal(callWindowRenders(only, Date.parse("2026-09-24T09:22:28.972Z"), Date.parse("2026-09-24T09:26:45.360Z"))?.renders, 1);
  assert.equal(censusSeconds(only)?.length, 3);
});

// ── FIX-1234 D2: the pre-CALL reading judges the time OUTSIDE the paced op's CALLs ──

test("FIX-1234 D2 rule 105: cc-151's pre-CALL 6 reading (09:19:11–09:34:11) has all 3 renders inside CALLs 3–5 — 0 outside, PASS on both halves; cc-151 would have gone on to CALL 6", () => {
  const r = receipt("2026-09-24-fix1212-bootstrap-runner.json");
  const end = Date.parse(r.census.find((c) => c.phase === "pre_call" && c.before_call === 6)!.at);
  const j = gateReading(end, fixtureSeconds("cc151"), { requests: 183, n5xx: 2 });
  // Before: the whole window, 3 renders / 8 events.
  assert.deepEqual([j.cancellations?.renders, j.cancellations?.events], [3, 8]);
  const o = outsideCallsVerdict(j, r.spans)!;
  assert.deepEqual([o.rendersInsideCalls, o.rendersOutside, o.verdict.renders, o.verdict.pass], [3, 0, 0, true]);
  // CALL 3's tail (73.3 s), CALL 4 (256.4 s) and CALL 5 (256.6 s) overlap the window: 9.8 of its 15 min.
  assert.ok(Math.abs(o.minutesOutside - 5.23) < 0.01, `minutes outside ${o.minutesOutside}`);
  assert.equal(outsideCallsLine(o), "renders outside CALLs 0 (inside 3) · minutes outside 5.2 of 15.0 · pass (ratio 0.00, floor 2)");
  // The whole reading, handed or fresh: no trip. (Before FIX-1233 + FIX-1234 its exit 1 stopped the run.)
  for (const counted of [true, false]) {
    const pc = preCallCensus(newStopState(), 0, j, r.spans, counted);
    assert.equal(pc.trip, null, counted ? "handed" : "fresh");
  }
  // Even the pre-FIX-1233 exit code, 1, is re-judged on the reading, not believed.
  assert.equal(preCallCensus(newStopState(), 1, j, r.spans, true).trip, null);
});

test("FIX-1234 D2 rule 105: the same three renders moved into cc-151's breathers are 3 renders OUTSIDE the CALLs in 5.2 min — FAIL, and the reason names both halves", () => {
  const r = receipt("2026-09-24-fix1212-bootstrap-runner.json");
  const end = Date.parse(r.census.find((c) => c.phase === "pre_call" && c.before_call === 6)!.at);
  // One second in each breather the window reaches: before CALLs 4, 5 and 6.
  const moved = ["2026-09-24T09:21:00Z", "2026-09-24T09:27:00Z", "2026-09-24T09:33:00Z"]
    .map((at) => ({ at, startMs: Date.parse(at), events: 1, page: "get_official_page" }));
  const j = gateReading(end, moved, { requests: 183, n5xx: 2 });
  assert.equal(j.cancellations?.pass, true, "judged whole, 3 renders in 15 min is at the floor 3 and passes");
  const o = outsideCallsVerdict(j, r.spans)!;
  assert.deepEqual([o.rendersInsideCalls, o.rendersOutside, o.verdict.floor_renders, o.verdict.pass], [0, 3, 2, false]);
  const pc = preCallCensus(newStopState(), 0, j, r.spans, true);
  assert.equal(pc.trip?.rule, 3);
  assert.equal(pc.trip?.reason,
    "(3) the pre-CALL census failed (57014) — 57014: renders outside CALLs 3 (inside 0) · minutes outside 5.2 of 15.0 · FAIL (ratio 17.38, floor 2); " +
    "edge: pass (2 of 183 request(s) = 1.09 % > 1 % but <= P99 floor 2 at p0 0.23 %)");
  // An edge FAIL on a clean 57014 half stops too, and says which half.
  const edgeFail = gateReading(end, fixtureSeconds("cc151"), { requests: 183, n5xx: 6 });
  assert.match(preCallCensus(newStopState(), 1, edgeFail, r.spans, true).trip?.reason ?? "",
    /^\(3\) the pre-CALL census failed \(edge\) — 57014: renders outside CALLs 0 \(inside 3\) .* pass .*; edge: FAIL \(6 of 183/);
});

test("FIX-1234 D2: with no CALL yet the reading is judged as before — cc-154's pre-claim enrichment_queue second, unchanged", () => {
  const all = fixtureSeconds("cc154");
  const end = Date.parse("2026-09-25T00:45:32.225Z");   // cc-154's pre-CALL 1
  const j = gateReading(end, all, { requests: 300, n5xx: 0 });
  assert.deepEqual(j.cancellations?.by_second?.map((s) => s.page), ["enrichment_queue"]);
  const o = outsideCallsVerdict(j, [])!;
  assert.deepEqual([o.rendersInsideCalls, o.rendersOutside, o.minutesOutside], [0, 1, 15]);
  const whole = verdictFor({ renders: [{ startMs: all[0]!.startMs, events: 1, sampleQuery: "enrichment_queue" }], minutes: 15, baseline: 0.033 });
  assert.deepEqual(o.verdict, whole, "no span: the outside verdict IS the whole-window verdict");
  assert.equal(preCallCensus(newStopState(), 0, j, [], false).trip, null);
});

test("FIX-1234 D2: a window wholly inside a CALL clamps to 1 minute outside, 0 renders, PASS; a CALL still running has no span", () => {
  const j = gateReading(Date.parse("2026-09-24T09:30:00Z"), [{ at: "x", startMs: Date.parse("2026-09-24T09:25:00Z"), events: 6, page: "entity_tags" }], { requests: 200, n5xx: 0 });
  const o = outsideCallsVerdict(j, [{ started_ms: Date.parse("2026-09-24T09:10:00Z"), returned_ms: Date.parse("2026-09-24T09:40:00Z") }])!;
  assert.deepEqual([o.minutesOutside, o.rendersOutside, o.rendersInsideCalls, o.verdict.pass], [1, 0, 1, true]);
  const running = outsideCallsVerdict(j, [{ started_ms: Date.parse("2026-09-24T09:10:00Z"), returned_ms: null }])!;
  assert.deepEqual([running.minutesOutside, running.rendersOutside], [15, 1]);
});

test("FIX-1234 D2 rule 116: on every pre-CALL window of cc-151's run, outside ⊂ the whole reading by second and inside + outside = renders", () => {
  const r = receipt("2026-09-24-fix1212-bootstrap-runner.json");
  const all = fixtureSeconds("cc151");
  const pre = r.census.filter((c) => c.phase === "pre_call");
  assert.equal(pre.length, 6);
  for (const c of pre) {
    const end = Date.parse(c.at);
    const j = gateReading(end, all, { requests: 183, n5xx: 2 });
    const before = r.spans.filter((s) => s.n < c.before_call!);   // the CALLs run by then
    const o = outsideCallsVerdict(j, before)!;
    const whole = j.cancellations!.by_second!;
    assert.equal(o.rendersInsideCalls + o.rendersOutside, whole.length, `pre-CALL ${c.before_call}`);
    assert.ok(o.verdict.renders <= whole.length);
    assert.equal(preCallCensus(newStopState(), 0, j, before, true).trip, null, `pre-CALL ${c.before_call}: every render was a CALL's`);
  }
});

test("FIX-1234 D2 rule 117: the cumulative-budget shape — two 2-render CALLs, or one 4-render CALL, no longer end the run at the pre-CALL reading", () => {
  const calls = [
    { started_ms: Date.parse("2026-09-24T09:10:00Z"), returned_ms: Date.parse("2026-09-24T09:14:00Z") },
    { started_ms: Date.parse("2026-09-24T09:16:00Z"), returned_ms: Date.parse("2026-09-24T09:20:00Z") },
  ];
  const s = (at: string) => ({ at, startMs: Date.parse(at), events: 1, page: "get_official_page" });
  const end = Date.parse("2026-09-24T09:21:30Z");
  // Two CALLs of 2: under budget each, 4 in the trailing 15 min.
  const two = gateReading(end, ["09:11:00", "09:12:00", "09:17:00", "09:18:00"].map((t) => s(`2026-09-24T${t}Z`)), { requests: 200, n5xx: 0 });
  assert.equal(two.cancellations?.pass, false, "judged whole: 4 renders in 15 min > floor 3 — the old stop");
  assert.equal(preCallCensus(newStopState(), 1, two, calls, true).trip, null, "judged outside the CALLs: 0 renders");
  // One CALL of 4: a would_trip on the budget (one observation), and the run goes on to the second look.
  const st = newStopState();
  const four = gateReading(end, ["09:16:10", "09:17:10", "09:18:10", "09:19:10"].map((t) => s(`2026-09-24T${t}Z`)), { requests: 200, n5xx: 0 });
  assert.equal(isTrip(evaluateCallBudget(st, 2, 4, 3, "stop")), false);
  assert.equal(preCallCensus(st, 1, four, calls, true).trip, null);
  assert.equal(isTrip(evaluateCallBudget(st, 3, 4, 3, "stop")), true, "the second consecutive CALL over budget is what stops (rule 117)");
});

test("FIX-1234 D2: a reading the judge cannot parse falls back to the exit code; a fresh dark is counted, a handed one is not; exit 8 never trips", () => {
  const spans = [{ started_ms: 0, returned_ms: 1000 }];
  assert.equal(preCallCensus(newStopState(), 1, null, spans, true).trip?.reason, preCallFail(1)?.reason, "unparsed exit 1: the old stop");
  assert.equal(preCallCensus(newStopState(), 0, null, spans, true).trip, null);
  const noEdge: CensusJson = { window: { start: "2026-09-24T09:00:00Z", end: "2026-09-24T09:15:00Z", minutes: 15 }, cancellations: { total: 0, ratio: 0, baseline: 0.033, by_second: [] } };
  assert.equal(preCallCensus(newStopState(), 1, noEdge, spans, true).trip?.rule, 3, "no edge verdict to read: the exit code decides");
  assert.equal(outsideCallsVerdict({ ...noEdge, cancellations: { total: 0, ratio: 0, by_second: [] } }, spans), null, "no baseline in the reading: not re-judged");
  const fresh = newStopState();
  assert.equal(preCallCensus(fresh, 2, null, spans, false).trip, null);
  assert.equal(fresh.consecutiveCensusDark, 1, "a fresh dark counts");
  assert.equal(preCallCensus(fresh, 2, null, spans, false).trip?.rule, 3, "two fresh darks trip, as before");
  const handed = newStopState();
  assert.equal(preCallCensus(handed, 2, null, spans, true).trip, null);
  assert.equal(handed.consecutiveCensusDark, 0, "the breather counted it; the pre-CALL step does not count it again");
  for (const counted of [true, false]) assert.equal(preCallCensus(newStopState(), 8, null, spans, counted).trip, null);
});

test("FIX-1234 D2: the receipt's pre-CALL line prints renders outside CALLs, inside, and the minutes outside", () => {
  const r = receipt("2026-09-24-fix1212-bootstrap-runner.json");
  const end = Date.parse(r.census.find((c) => c.phase === "pre_call" && c.before_call === 6)!.at);
  const o = outsideCallsVerdict(gateReading(end, fixtureSeconds("cc151"), { requests: 183, n5xx: 2 }), r.spans)!;
  const row: CensusRow = { at: "t", minutes: 15, code: 0, summary: "pass (…)", phase: "pre_call", before_call: 6, would_trip: false, outside_calls: outsideCallsRow(o) };
  assert.equal(censusLine(row),
    "- t (15 min, before CALL 6) exit 0: pass (…) — renders outside CALLs 0 (inside 3) · minutes outside 5.2 of 15.0 · pass (ratio 0.00, floor 2)");
  assert.equal(outsideCallsLine(row.outside_calls!), outsideCallsLine(o), "one format, from the verdict or from the receipt row");
  assert.equal(censusLine({ ...row, outside_calls: undefined }), "- t (15 min, before CALL 6) exit 0: pass (…)", "a row without it reads as before");
});

// ── FIX-1234 D3: a breather at --breather-max-s, by cause ──

test("FIX-1234 D3: a walls-held timeout proceeds in both modes, as cc-148 D2 built it (the census was never read)", () => {
  for (const mode of ["stop", "report"] as const) {
    assert.deepEqual(breatherTimeout({ mode, call: 3, waitedS: 600, census: null }), { by: "breather_timeout", verdict: null }, mode);
  }
});

test("FIX-1234 D3: a census-held timeout is a Trip in stop mode and a WouldTrip in report mode, with the same numbers; a dark last reading holds too", () => {
  const census = { released: false, renders: 2, at: "2026-09-24T09:31:40.000Z" };
  const reason = "(3) the front door had not returned to baseline 600 s after CALL 3 returned — renders since return 2 (last read at 2026-09-24T09:31:40.000Z)";
  const stop = breatherTimeout({ mode: "stop", call: 3, waitedS: 600.2, census });
  assert.equal(stop.by, "breather_timeout_census");
  assert.deepEqual(stop.verdict, { rule: 3, reason });
  assert.equal(isTrip(stop.verdict), true);
  const report = breatherTimeout({ mode: "report", call: 3, waitedS: 600.2, census });
  assert.equal(report.by, "breather_timeout_census");
  assert.deepEqual(report.verdict, { would_trip: true, rule: 3, reason, call: 3, renders: 2 });
  assert.equal(isTrip(report.verdict), false);
  const dark = breatherTimeout({ mode: "stop", call: 1, waitedS: 600, census: { released: false, renders: null, at: "t" } });
  assert.equal(dark.verdict?.reason, "(3) the front door had not returned to baseline 600 s after CALL 1 returned — renders since return unknown (the census could not confirm 0) (last read at t)");
  assert.equal(isTrip(dark.verdict), true);
  assert.equal(breatherTimeout({ mode: "report", call: 1, waitedS: 600, census: { released: false, renders: null, at: "t" } }).verdict?.would_trip, true);
});

test("FIX-1234 D3: the receipt's breather line says what held it at --breather-max-s, the renders pending, and what that decided; a released breather reads as before", () => {
  const base = { before_call: 4, renders: 0, waited_s: 90.9, census_reads: 1 };
  assert.equal(breatherRendersLine({ ...base, released_by: "walls+census" }),
    "- breather before CALL 4: renders 0 · released after 90.9 s (walls+census, 1 census read(s))");
  assert.equal(breatherRendersLine({ ...base, renders: null, census_reads: 0, waited_s: 600, released_by: "breather_timeout",
    timeout: { cause: "walls", renders: null, last_read_at: null, outcome: "proceed", reason: null } }),
  "- breather before CALL 4: renders — · released after 600.0 s (breather_timeout) — the walls held it at --breather-max-s; proceeded");
  const held = { ...base, renders: 2, census_reads: 10, waited_s: 600, released_by: "breather_timeout_census" as const };
  assert.equal(breatherRendersLine({ ...held, timeout: { cause: "census", renders: 2, last_read_at: "09:31:40Z", outcome: "trip", reason: "(3) …" } }),
    "- breather before CALL 4: renders 2 · released after 600.0 s (breather_timeout_census, 10 census read(s)) — the census held it at --breather-max-s: 2 render(s) pending since the CALL returned (last read 09:31:40Z) — **stop**");
  assert.match(breatherRendersLine({ ...held, timeout: { cause: "census", renders: 2, last_read_at: "09:31:40Z", outcome: "would_trip", reason: "(3) …" } }),
    / — \*\*would_trip\*\*$/);
});

test("FIX-1234 D3 rule 137: every measured prod breather (cc-151 60.8–120.9 s, cc-154 30.4 s) releases on walls+census before --breather-max-s — the census-held stop is unreachable on them", () => {
  const measured: number[] = [];
  for (const [file, win] of [["2026-09-24-fix1212-bootstrap-runner.json", "cc151"], ["2026-09-25-fix1212-bootstrap-runner.json", "cc154"]] as const) {
    const r = receipt(file);
    const all = fixtureSeconds(win);
    for (const b of r.breathers) {
      const prev = r.spans.find((s) => s.n === b.before_call - 1)!;
      // The census reading the new rule takes once the walls release — at the moment they did.
      const reading = gateReading(Date.parse(b.released_at), all, { requests: 183, n5xx: 0 });
      const half = breatherCensus(0, reading, prev.returned_ms);
      assert.deepEqual([half.released, half.renders], [true, 0], `${win} breather before CALL ${b.before_call}: 0 renders since CALL ${prev.n} returned`);
      assert.equal(b.released_by, "walls", "each released on the walls, and the census would have released it at the same read");
      assert.ok(b.waited_s < r.args.breatherMaxS, `${b.waited_s} s < --breather-max-s ${r.args.breatherMaxS}`);
      // Were the timeout consulted anyway, this census half would not hold it.
      assert.equal(breatherTimeout({ mode: "stop", call: prev.n, waitedS: b.waited_s, census: { ...half, at: b.released_at } }).verdict, null);
      measured.push(Math.round(b.waited_s * 10) / 10);
    }
  }
  assert.deepEqual(measured, [60.8, 90.8, 120.9, 90.9, 90.8, 30.4], "the six breathers the prompt names");
});

test("FIX-1234 D3: the breather consults breatherTimeout at --breather-max-s with the census mode, and a census-held stop hands no reading on", () => {
  const src = fs.readFileSync(path.join(__dirname, "donor-party-bootstrap-runner.ts"), "utf8");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const body = code.slice(code.indexOf("const breathe = async"), code.indexOf("const readRunRenders = async"));
  assert.match(body, /if \(left <= 0\) \{ by = "breather_timeout"; break; \}/, "the loop still ends on the clock");
  assert.match(body, /breatherTimeout\(\{ mode: args\.censusMode, call: beforeCall - 1, waitedS, census: lastHalf \}\)/);
  assert.match(body, /if \(isTrip\(t\.verdict\) && !stopping\) \{ stopping = t\.verdict; recordTrip\(t\.verdict, beforeCall\); \}/);
  assert.match(body, /const halted = by === "stop" \|\| timeout\?\.outcome === "trip";/);
  assert.match(body, /return halted \? null : census;/);
  assert.match(body, /if \(half\.released\) \{ by = "walls\+census"; break; \}/, "a released breather is unchanged");
});

test("FIX-1232: the receipt's census-mode row says what each mode now decides, and counts the CALLs over budget", () => {
  const row = (phase: CensusRow["phase"], code = 0): CensusRow => ({
    at: "t", minutes: phase === "gate" ? 60 : 15, code, summary: "pass (…)", phase, before_call: phase === "gate" ? null : 2, would_trip: phase === "gate" ? null : false,
  });
  const budget: BudgetRow[] = [
    { at: "t", call: 2, renders: 4, budget: 3, final: false, outcome: "would_trip", reason: "(3) …" },
    { at: "t", call: 2, renders: 5, budget: 3, final: true, outcome: "would_trip", reason: "(3) …" },
  ];
  const rows = [row("gate"), row("pre_call"), row("breather", 1), row("cadence")];
  assert.equal(censusModeLine("stop", rows, budget, 3),
    "stop — two consecutive CALLs over --renders-per-call-max 3 stop the run (1 CALL(s) over budget), and so does a breather the census still holds at --breather-max-s; " +
    "a pre-CALL FAIL (outside the CALL spans) stops the run in both modes; the dark-twice trip is armed; the gate wait's census half holds the window");
  assert.equal(censusModeLine("report", rows, [], 5),
    "report — CALLs over --renders-per-call-max 5 are recorded, never a stop (0 CALL(s) over budget), and so is a breather the census still holds at --breather-max-s; " +
    "a pre-CALL FAIL (outside the CALL spans) stops the run in both modes; the dark-twice trip is armed; the gate wait's census half holds the window");
  assert.equal(censusLine(rows[2]!), "- t (15 min, breather before CALL 2, held it) exit 1: pass (…)");
  assert.equal(censusLine({ ...row("renders"), minutes: 4.276 }), "- t (4.3 min, renders read of CALL 1) exit 0: pass (…)");
  assert.equal(censusLine({ ...row("renders"), before_call: null }), "- t (15 min, renders read of the run) exit 0: pass (…)");
  assert.equal(censusLine(row("cadence")), "- t (15 min, during a CALL) exit 0: pass (…)");
  assert.equal(censusLine(row("gate")), "- t (60 min, gate poll) exit 0: pass (…)");
  // A row written before FIX-1232 with would_trip set still says so.
  assert.equal(censusLine({ ...row("pre_call", 1), would_trip: true }), `- t (15 min, before CALL 2) exit 1: pass (…) — **would_trip**${WOULD_TRIP_NOTE}`);
});

test("FIX-1232 D5: the receipt's renders lines — per CALL with its budget, per breather, and the run — on cc-151's numbers", () => {
  const s = (at: string, events: number, page: string) => ({ at, startMs: Date.parse(at), events, page });
  const call5 = { n: 5, renders: { renders: 1, events: 6, seconds: [s("2026-09-24T09:30:26Z", 6, "entity_tags")], final: true, at: "t" } };
  assert.equal(callRendersLine(call5, 3), "- CALL 5: renders_lost 1 · events 6 · budget 3 · pages: entity_tags");
  assert.equal(callRendersLine({ n: 2, renders: { renders: 0, events: 0, seconds: [], final: true, at: "t" } }, 3),
    "- CALL 2: renders_lost 0 · events 0 · budget 3");
  const six = { renders: 6, events: 6, seconds: Array.from({ length: 6 }, (_, i) => s(`2026-09-24T09:30:2${i}Z`, 1, "get_official_page")), final: false, at: "t" };
  assert.equal(callRendersLine({ n: 7, renders: six }, 3),
    "- CALL 7: renders_lost 6 · events 6 · budget 3 · pages: get_official_page ×6 — **over budget** (partial: read while it ran)");
  assert.equal(callRendersLine({ n: 1, renders: null }, 3), "- CALL 1: not read (local, or the Logs API did not answer)");
  assert.equal(breatherRendersLine({ before_call: 2, renders: 0, waited_s: 60.78, released_by: "walls+census", census_reads: 1 }),
    "- breather before CALL 2: renders 0 · released after 60.8 s (walls+census, 1 census read(s))");
  assert.equal(breatherRendersLine({ before_call: 3, renders: 0, renders_final: 1, waited_s: 90.76, released_by: "walls+census", census_reads: 1 }),
    "- breather before CALL 3: renders 1 · released after 90.8 s (walls+census, 1 census read(s)) — 0 at release, 1 in the end-of-run read");
  assert.equal(breatherRendersLine({ before_call: 2, renders: null, waited_s: 20, released_by: "walls", census_reads: 0 }),
    "- breather before CALL 2: renders — · released after 20.0 s (walls)");
  const run = {
    from: "2026-09-24T09:04:58.789Z", to: "2026-09-24T09:34:30.000Z", code: 0, renders: 4, events: 9,
    seconds: [s("2026-09-24T09:07:53Z", 1, "proposals"), s("2026-09-24T09:19:59Z", 1, "get_official_page"),
      s("2026-09-24T09:24:21Z", 1, "officials"), s("2026-09-24T09:30:26Z", 6, "entity_tags")],
  };
  assert.equal(runRendersLine(run),
    "- run: renders_lost 4 · events 9 · pages: entity_tags, get_official_page, officials (2026-09-24T09:04:58.789Z → 2026-09-24T09:34:30.000Z)");
  assert.equal(runRendersLine(null), "- run: not read (local, no CALL, or the Logs API did not answer)");
});

test("FIX-1232: rendersSummary names a --renders-only reading, or what it was instead", () => {
  assert.equal(rendersSummary(0, { renders: { renders: 1, events: 6, by_second: [] } }), "renders 1 / events 6");
  assert.equal(rendersSummary(2, null), "dark (exit 2 — the Logs API did not answer)");
  assert.equal(rendersSummary(0, null), "dark (exit 0; unparsed output)");
  assert.equal(rendersSummary(8, { unavailable: true, http_status: 410 }), "unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)");
});

test("cc-152 D1: --census-mode is stop|report, default stop; anything else is refused; the cc-152 launch command parses", () => {
  const d = parseRunnerArgs([]);
  assert.ok(!("error" in d));
  assert.equal(d.censusMode, "stop");
  for (const m of ["stop", "report"] as const) {
    const a = parseRunnerArgs(["--census-mode", m]);
    assert.ok(!("error" in a) && a.censusMode === m, m);
    const b = parseRunnerArgs([`--census-mode=${m}`]);
    assert.ok(!("error" in b) && b.censusMode === m, `${m} (= form)`);
  }
  const bad = parseRunnerArgs(["--census-mode", "foo"]);
  assert.ok("error" in bad);
  assert.match(bad.error, /^--census-mode must be stop\|report \(got "foo"\)$/);
  assert.ok("error" in parseRunnerArgs(["--census-mode", "Report"]), "case matters");
  const cc152 = parseRunnerArgs(["--units-per-call", "2", "--wall-trip-s", "3.0", "--breather-until-wall-s", "0.5",
    "--breather-max-s", "600", "--max-calls", "3", "--expected-minutes", "20", "--max-wait-minutes", "720", "--census-mode", "report"]);
  assert.ok(!("error" in cc152), "the cc-152 launch command parses");
  assert.equal(cc152.censusMode, "report");
  assert.equal(cc152.maxCalls, 3);
  assert.equal(cc152.maxWaitMinutes, 720);
});

test("FIX-1232: every census call site names its phase; the budget is the only thing the mode reaches; the gate half is not rule (3)", () => {
  const src = fs.readFileSync(path.join(__dirname, "donor-party-bootstrap-runner.ts"), "utf8");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const sites = (code.match(/evaluateCensus\((stopState|state), [a-z.]*code, "(pre_call|breather|cadence)"\)/g) ?? [])
    .map((m) => /"(\w+)"/.exec(m)![1]);
  assert.deepEqual(sites.sort(), ["breather", "cadence", "pre_call"]);
  assert.doesNotMatch(code, /evaluateCensus\([^)]*args\.censusMode/, "the mode no longer reaches a census reading");
  assert.match(code, /evaluateCallBudget\(stopState, rec\.n, got\.renders, args\.rendersPerCallMax, args\.censusMode\)/);
  // FIX-1234 D2: handed or fresh, one judge — and a handed reading's dark is not re-counted.
  assert.match(code, /const pc = preCallCensus\(stopState, reading\.code, reading\.json, R\.calls, handed !== null\);/);
  assert.doesNotMatch(code, /v = preCallFail\(handed\.code\);/, "the exit code no longer decides the pre-CALL reading");
  assert.equal((code.match(/phase: "gate", before_call: null, would_trip: null/g) ?? []).length, 1);
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

test("cc-151 D2: census_fail is retired — the vocabulary is six outcomes, exit 3 unused, and the receipt line says so", () => {
  assert.deepEqual(Object.keys(EXIT).sort(), ["caught_up", "error", "gate_timeout", "max_calls", "skipped", "stopped"]);
  assert.ok(!Object.values(EXIT).includes(3), "3 is never reused");
  assert.equal(new Set(Object.values(EXIT)).size, 6, "one code per outcome");
  assert.equal(vocabularyLine(),
    "caught_up 0 · error 1 · stopped 4 · skipped 5 · max_calls 6 · gate_timeout 7 · (3 retired: census_fail — the census is waited on inside the gate, cc-151)");
});

test("cc-151 D2: the census summary carries the floor — cc-148's three prod readings, and dark", () => {
  const j = (total: number, ratio: number, pass: boolean, edgePass = true) => ({
    cancellations: { total, ratio, floor: 6, lambda: 1.98, pass },
    edge: { note: edgePass ? "0 of 192 request(s) = 0.00 %" : "6 of 583 request(s) = 1.03 %", pass: edgePass },
    pass: pass && edgePass,
  });
  assert.equal(censusSummary(0, j(6, 3.0303, true), 60),
    "pass (6/60 min, ratio 3.03, floor 6; edge 0 of 192 request(s) = 0.00 %)");
  assert.equal(censusSummary(1, j(12, 6.0606, false), 60),
    "FAIL (12/60 min, ratio 6.06, floor 6 — 57014 FAIL; edge 0 of 192 request(s) = 0.00 %)");
  // cc-151 read 6: under the floor, but the edge half held it
  assert.equal(censusSummary(1, j(6, 3.0303, true, false), 60),
    "FAIL (6/60 min, ratio 3.03, floor 6; edge 6 of 583 request(s) = 1.03 % — edge FAIL)");
  assert.equal(censusSummary(2, null, 60), "dark (exit 2 — the Logs API did not answer)");
  assert.match(censusSummary(127, null, 60), /^dark \(exit 127/, "anything but 0/1 is dark, as evaluateCensus counts it");
  assert.equal(censusSummary(1, null, 15), "FAIL (exit 1; unparsed output)");
});

test("FIX-1232 D4: the census summary prints renders AND events, with the renders' ratio and floor — cc-151's 09:34:11 reading", () => {
  const j = {
    cancellations: { total: 8, ratio: 16.1616, floor: 3, pass: true, renders: 3, events: 8, ratio_renders: 6.0606, floor_renders: 3 },
    edge: { note: "2 of 183 request(s) = 1.09 %", pass: false },
    pass: false,
  };
  assert.equal(censusSummary(1, j, 15),
    "FAIL (3 render(s) / 8 event(s) in 15 min, ratio 6.06, floor 3; edge 2 of 183 request(s) = 1.09 % — edge FAIL)");
  const fail = { ...j, cancellations: { ...j.cancellations, renders: 4, ratio_renders: 8.08, pass: false } };
  assert.match(censusSummary(1, fail, 15), /^FAIL \(4 render\(s\) \/ 8 event\(s\) in 15 min, ratio 8\.08, floor 3 — 57014 FAIL;/);
});

test("cc-151 D2: every receipt poll row names the half that held it; the tally counts both halves", () => {
  const polls: GatePoll[] = [
    { at: "08:55", ok: false, blocked: ["c:blackout"], gate_ok: false },
    { at: "09:00", ok: false, blocked: ["census"], gate_ok: true, also: { name: "census", ok: false, summary: "FAIL (7/60 min, ratio 3.54, floor 6 — 57014 FAIL; edge …)" } },
    { at: "09:05", ok: false, blocked: ["census"], gate_ok: true, also: { name: "census", ok: false, summary: "dark (exit 2 — the Logs API did not answer)" } },
    { at: "09:08", ok: false, blocked: ["read-error"], gate_ok: false, error: "ECONNRESET" },
    { at: "09:10", ok: true, blocked: [], gate_ok: true, also: { name: "census", ok: true, summary: "pass (2/60 min, ratio 1.01, floor 6; edge …)" } },
  ];
  assert.equal(gateTally(polls), "5 poll(s): 2 held by the gate, 2 by the census (1 dark)");
  assert.equal(pollLine(polls[0]!), "- 08:55 held by the gate: c:blackout · census not read (gate blocked)");
  assert.equal(pollLine(polls[1]!), "- 09:00 gate ok · **held by the census** · census FAIL (7/60 min, ratio 3.54, floor 6 — 57014 FAIL; edge …)");
  assert.equal(pollLine(polls[3]!), "- 09:08 held by the gate: read-error (ECONNRESET) · census not read (gate blocked)");
  assert.equal(pollLine(polls[4]!), "- 09:10 **OK** · census pass (2/60 min, ratio 1.01, floor 6; edge …)");
  // the clone's poll row
  assert.equal(pollLine({ at: "t", ok: true, blocked: [], gate_ok: true, also: { name: "census", ok: true, summary: "skipped — local (no Logs API)" } }),
    "- t **OK** · census skipped — local (no Logs API)");
});

test("the runner no longer carries a one-shot pre-launch census or a census_fail path", () => {
  const src = fs.readFileSync(path.join(__dirname, "donor-party-bootstrap-runner.ts"), "utf8");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /"census_fail"/);
  assert.doesNotMatch(code, /pre-launch 60 min/);
  assert.match(code, /andAlso: \{ name: "census", read: censusHalf \}/);
});

test("args: defaults, overrides, and refusals", () => {
  assert.deepEqual(parseRunnerArgs([]), {
    unitsPerCall: 2, wallTripS: 3.0, breatherUntilWallS: 0.5, breatherMaxS: 600,
    maxWaitMinutes: 480, pollSeconds: 300, maxCalls: 12, expectedMinutes: 60,
    tickSeconds: 120, tripOnWallMs: null, tripFromCall: 1, receiptTag: null, censusMode: "stop", rendersPerCallMax: 3,
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
  const cc151 = parseRunnerArgs(["--units-per-call", "2", "--wall-trip-s", "3.0", "--breather-until-wall-s", "0.5",
    "--breather-max-s", "600", "--max-calls", "12", "--expected-minutes", "60", "--max-wait-minutes", "600"]);
  assert.ok(!("error" in cc151), "the cc-151 launch command parses");
  assert.equal(cc151.maxWaitMinutes, 600, "--max-wait-minutes has a floor of 1 and no ceiling below 600");
  const dd = parseRunnerArgs(["--", "--units-per-call", "2", "--max-calls", "8"]);
  assert.ok(!("error" in dd), "pnpm 9 forwards a bare -- ; the prompt-shaped command must launch");
  assert.equal(dd.maxCalls, 8);
  assert.ok("error" in parseRunnerArgs(["--max-calls", "0"]));
  assert.ok("error" in parseRunnerArgs(["--wall-trip-s", "0"]));
  assert.ok("error" in parseRunnerArgs(["--receipt-tag", "../x"]));
});

// ── cc-154 D2: exit 8 (the Logs API endpoint is gone, FIX-1219) is "no instrument", not dark ──

test("cc-154 D2 rule 105: {8, 8, 8} is no trip and a dark count of 0, wherever it is read", () => {
  for (const mode of ["pre_call", "breather", "cadence"] as const) {
    const s = newStopState();
    for (let i = 0; i < 3; i++) assert.equal(evaluateCensus(s, 8, mode), null, `${mode}: 8 #${i + 1}`);
    assert.equal(s.consecutiveCensusDark, 0, `${mode}: the dark count never moved`);
  }
});

test("cc-154 D2 rule 105: {2, 8, 2} trips — 8 is transparent, it neither advances nor resets the dark count", () => {
  for (const mode of ["pre_call", "breather", "cadence"] as const) {
    const s = newStopState();
    assert.equal(evaluateCensus(s, 2, mode), null);
    assert.equal(evaluateCensus(s, 8, mode), null);
    assert.equal(s.consecutiveCensusDark, 1, `${mode}: the 8 left the count at 1`);
    const t = evaluateCensus(s, 2, mode);
    assert.equal(isTrip(t), true, `${mode}: the second dark trips`);
    assert.match(t?.reason ?? "", /Logs API was dark on two consecutive/);
    // contrast: a PASS between the darks does reset it
    const u = newStopState();
    evaluateCensus(u, 2, mode); evaluateCensus(u, 0, mode);
    assert.equal(evaluateCensus(u, 2, mode), null, `${mode}: a pass resets, an 8 does not`);
  }
});

test("cc-154 D2 rule 105: the gate half opens on {8} alone; a FAIL, a dark and a crashed child still hold", () => {
  const u = "unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)";
  assert.deepEqual(censusHalfReading(8, u), { name: "census", ok: true, summary: u });
  assert.equal(censusHalfReading(0, "pass (…)").ok, true);
  assert.equal(censusHalfReading(1, "FAIL (…)").ok, false);
  assert.equal(censusHalfReading(2, "dark (…)").ok, false);
  assert.equal(censusHalfReading(127, "dark (exit 127 …)").ok, false, "the Windows crash code is dark, not unavailable");
});

test("cc-154 D2: censusSummary names exit 8 unavailable, with the HTTP status when the JSON carries it", () => {
  assert.equal(censusSummary(8, { unavailable: true, http_status: 410 }, 60), "unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)");
  assert.equal(censusSummary(8, null, 15), "unavailable (FIX-1219 — Logs API endpoint removed)");
  assert.match(censusSummary(2, null, 15), /^dark/, "2 is still dark");
});

test("cc-156: censusSummary names a removed table or field from the detail, not 'endpoint removed, HTTP 200'", () => {
  const detail = 'Logs API schema changed: Table "edge_logs" does not exist.';
  const s = censusSummary(8, { unavailable: true, http_status: 200, detail }, 60);
  assert.equal(s, `unavailable (FIX-1219 — ${detail})`);
  assert.equal(censusHalfReading(8, s).ok, true, "still exit 8: the gate opens on the gate alone, as for a 410");
  assert.equal(
    censusSummary(8, { unavailable: true, http_status: 410, detail: "Logs API 410 Gone" }, 60),
    "unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)",
    "a removed path keeps cc-154's wording",
  );
});

test("cc-154 D2: an unavailable opening poll is counted as opened on the gate, not as dark; the poll line says unavailable", () => {
  const u = "unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)";
  const polls: GatePoll[] = [
    { at: "00:50", ok: false, blocked: ["b:fr-vacuum-analyze"], gate_ok: false },
    { at: "00:55", ok: true, blocked: [], gate_ok: true, also: { name: "census", ok: true, summary: u } },
  ];
  assert.equal(gateTally(polls),
    "2 poll(s): 1 held by the gate, 0 by the census (0 dark); 1 read the census unavailable (FIX-1219) and opened on the gate alone");
  assert.equal(pollLine(polls[1]!), `- 00:55 **OK** · census ${u}`);
  assert.equal(gateTally(polls.slice(0, 1)), "1 poll(s): 1 held by the gate, 0 by the census (0 dark)", "no unavailable poll, the cc-151 line");
});

test("cc-154 D2: the census-mode row counts unavailable calls apart, in both modes", () => {
  const row = (phase: CensusRow["phase"], code: number, would_trip: boolean | null): CensusRow => ({
    at: "t", minutes: phase === "gate" ? 60 : 15, code, summary: code === 8 ? "unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)" : "pass (…)",
    phase, before_call: phase === "pre_call" ? 1 : null, would_trip,
  });
  const rows = [row("gate", 8, null), row("pre_call", 8, false), row("pre_call", 8, false)];
  assert.equal(censusModeLine("report", rows),
    "report — CALLs over --renders-per-call-max 3 are recorded, never a stop (0 CALL(s) over budget), and so is a breather the census still holds at --breather-max-s; " +
    "a pre-CALL FAIL (outside the CALL spans) stops the run in both modes; the dark-twice trip is armed; the gate wait's census half holds the window" +
    " · 3 census call(s) unavailable (exit 8, FIX-1219) — not readings, never a trip");
  assert.match(censusModeLine("stop", rows), /^stop — .* · 3 census call\(s\) unavailable \(exit 8, FIX-1219\)/);
  assert.equal(censusLine(rows[1]!), "- t (15 min, before CALL 1) exit 8: unavailable (FIX-1219 — Logs API endpoint removed, HTTP 410)");
});

test("cc-154 D2: the gate half goes through censusHalfReading, and evaluateCensus sees 8 before anything touches the dark count", () => {
  const src = fs.readFileSync(path.join(__dirname, "donor-party-bootstrap-runner.ts"), "utf8");
  const code = src.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.match(code, /return censusHalfReading\(cen\.code, cen\.summary\);/);
  assert.doesNotMatch(code, /ok: cen\.code === 0/, "the old gate-half verdict is gone");
  assert.match(code, /phase: CensusPhase = "pre_call"\): Trip \| null \{\s*\n\s*if \(exitCode === CENSUS_EXIT\.unavailable\) return null;/);
});
