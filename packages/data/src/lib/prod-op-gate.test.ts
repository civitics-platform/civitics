/**
 * FIX-1215 — waitForProdOpGate() and session:wait-for-gate's pure parts,
 * against a fake gate and a fake clock. No database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GateTimeout,
  blockToken,
  formatGateLine,
  formatPollLine,
  paceOffQuarterHour,
  waitForProdOpGate,
  type ProdOpGate,
} from "./prod-op-gate";
import { edgeVerdictFor, verdictFor } from "./cancellation-census";
import {
  censusWaitOptions,
  childEnv,
  gateCensusHalf,
  parseWaitArgs,
  resolveCensusMode,
  THEN_CWD,
} from "../scripts/wait-for-gate";

const blocked = (at: string): ProdOpGate => ({
  ok: false, checked_at: at, expected_seconds: 5400, span_end: at,
  blocked_by: [
    { check: "b", name: "ec-vacuum-analyze", detail: "ran 482 s", retry_after: "2026-09-23T06:08:00Z" },
    { check: "c", name: "blackout", detail: "open", retry_after: "2026-09-23T09:00:00Z" },
  ],
  readings: {},
});
const clear = (at: string): ProdOpGate => ({
  ok: true, checked_at: at, expected_seconds: 5400, span_end: "2026-09-23T12:05:00Z",
  blocked_by: [], readings: { watchdogs: { jobs: [{ max_wall_10m_s: 0.02 }, { max_wall_10m_s: 0.01 }] } },
});

function fakeClock(start = Date.parse("2026-09-23T05:00:00Z")) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

test("waits through blocked polls and returns the first clear reading", async () => {
  const clk = fakeClock();
  const seq = [blocked, blocked, blocked, clear];
  let i = 0;
  const lines: string[] = [];
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 5400, pollSeconds: 300, maxWaitSeconds: 3600,
    readGate: async () => seq[i++]!(new Date(clk.now()).toISOString()),
    sleep: clk.sleep, now: clk.now, log: (l) => lines.push(l),
  });
  assert.equal(r.gate.ok, true);
  assert.equal(r.polls.length, 4);
  assert.equal(r.waitedSeconds, 900);
  assert.deepEqual(r.polls[0]!.blocked, ["b:ec-vacuum-analyze", "c:blackout"]);
  assert.equal(lines.length, 4, "one line per poll");
  assert.match(lines[0]!, /^\[gate\] 05:00:00Z blocked_by=b:ec-vacuum-analyze\(→06:08\), c:blackout\(→09:00\) next_poll=05:05:00Z$/);
  assert.match(lines[3]!, /^\[gate\] 05:15:00Z OK \(expected 5400 s, span to 12:05Z\) watchdogs max 0\.02\/0\.01 s$/);
});

test("throws GateTimeout with the last reading once max wait passes", async () => {
  const clk = fakeClock();
  let n = 0;
  await assert.rejects(
    waitForProdOpGate({
      dbUrl: "x", expectedSeconds: 5400, pollSeconds: 300, maxWaitSeconds: 1000,
      readGate: async () => { n++; return blocked(new Date(clk.now()).toISOString()); },
      sleep: clk.sleep, now: clk.now, log: () => {},
    }),
    (e: unknown) => {
      assert.ok(e instanceof GateTimeout);
      assert.equal(e.last?.ok, false);
      assert.equal(e.polls.length, 4, "polls at 0, 300, 600, 900 — the next (1200) is past 1000");
      return true;
    },
  );
  assert.equal(n, 4);
});

test("a read error is BLOCKED, never ok — the wait fails closed", async () => {
  const clk = fakeClock();
  let i = 0;
  const lines: string[] = [];
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 60, pollSeconds: 60, maxWaitSeconds: 600,
    readGate: async () => {
      if (i++ === 0) throw new Error("ECONNRESET");
      return clear(new Date(clk.now()).toISOString());
    },
    sleep: clk.sleep, now: clk.now, log: (l) => lines.push(l),
  });
  assert.equal(r.polls[0]!.ok, false);
  assert.deepEqual(r.polls[0]!.blocked, ["read-error"]);
  assert.match(lines[0]!, /READ ERROR — counted as blocked: ECONNRESET/);
  assert.equal(r.polls.length, 2);
});

// ───────────── cc-151 D2: a second half (the census) inside the wait ─────────────

const census = (ok: boolean, summary: string) => ({ name: "census", ok, summary });

test("andAlso is read ONLY on polls where the gate is ok, and the window opens when both are", async () => {
  const clk = fakeClock(Date.parse("2026-09-24T08:50:00Z"));
  const gates = [blocked, blocked, clear, clear, clear];
  const halves = [
    census(false, "FAIL (7/60 min, ratio 3.54, floor 6; edge 0 of 200 request(s) = 0.00 %)"),
    census(false, "dark (exit 2 — the Logs API did not answer)"),
    census(true, "pass (2/60 min, ratio 1.01, floor 6; edge 0 of 198 request(s) = 0.00 %)"),
  ];
  let gi = 0;
  let ci = 0;
  const lines: string[] = [];
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 3600, pollSeconds: 300, maxWaitSeconds: 36_000,
    readGate: async () => gates[gi++]!(new Date(clk.now()).toISOString()),
    andAlso: { name: "census", read: async () => halves[ci++]! },
    sleep: clk.sleep, now: clk.now, log: (l) => lines.push(l),
  });
  assert.equal(gi, 5, "five gate polls");
  assert.equal(ci, 3, "the census was read on the three gate-ok polls only — a blocked gate costs no Logs read");
  assert.equal(r.also?.ok, true);
  assert.equal(r.waitedSeconds, 1200);
  assert.deepEqual(r.polls.map((p) => [p.ok, p.gate_ok, p.blocked]), [
    [false, false, ["b:ec-vacuum-analyze", "c:blackout"]],
    [false, false, ["b:ec-vacuum-analyze", "c:blackout"]],
    [false, true, ["census"]],
    [false, true, ["census"]],
    [true, true, []],
  ]);
  assert.equal(r.polls[0]!.also, undefined, "not read, not recorded");
  assert.match(r.polls[3]!.also!.summary, /^dark/);
  assert.equal(lines.length, 5, "one line per poll");
  assert.match(lines[0]!, /^\[gate\] 08:50:00Z ok=false blocked_by=\[b:ec-vacuum-analyze\(→06:08\), c:blackout\(→09:00\)\] census=skipped \(gate blocked\) next_poll=08:55:00Z$/);
  assert.match(lines[2]!, /^\[gate\] 09:00:00Z ok=false blocked_by=\[census\] census=FAIL \(7\/60 min, ratio 3\.54, floor 6; .*\) next_poll=09:05:00Z$/);
  assert.match(lines[3]!, /census=dark/);
  assert.match(lines[4]!, /^\[gate\] 09:10:00Z ok=true blocked_by=\[\] census=pass \(2\/60 min.*\) \(expected 5400 s, span to 12:05Z\)$/);
});

test("the timeout names the LAST blocking half — the census, with its reading", async () => {
  const clk = fakeClock(Date.parse("2026-09-24T09:00:00Z"));
  await assert.rejects(
    waitForProdOpGate({
      dbUrl: "x", expectedSeconds: 3600, pollSeconds: 300, maxWaitSeconds: 600,
      readGate: async () => clear(new Date(clk.now()).toISOString()),
      andAlso: { name: "census", read: async () => census(false, "FAIL (12/60 min, ratio 6.06, floor 6 — 57014 FAIL; edge …)") },
      sleep: clk.sleep, now: clk.now, log: () => {},
    }),
    (e: unknown) => {
      assert.ok(e instanceof GateTimeout);
      assert.equal(e.polls.length, 3);
      assert.match(e.lastBlockedBy, /^census: FAIL \(12\/60 min/);
      assert.match(e.message, /last: census: FAIL/);
      return true;
    },
  );
  // …and the gate's own blocks when the gate held the last poll.
  const clk2 = fakeClock();
  await assert.rejects(
    waitForProdOpGate({
      dbUrl: "x", expectedSeconds: 3600, pollSeconds: 300, maxWaitSeconds: 300,
      readGate: async () => blocked(new Date(clk2.now()).toISOString()),
      andAlso: { name: "census", read: async () => { throw new Error("never read"); } },
      sleep: clk2.sleep, now: clk2.now, log: () => {},
    }),
    (e: unknown) => e instanceof GateTimeout && /last: b:ec-vacuum-analyze\(→06:08\), c:blackout\(→09:00\)$/.test(e.message),
  );
});

test("a second half that THROWS holds the window (fail closed), and a gate read error skips it", async () => {
  const clk = fakeClock();
  const gates: Array<() => ProdOpGate> = [
    () => { throw new Error("ECONNRESET"); },
    () => clear(new Date(clk.now()).toISOString()),
    () => clear(new Date(clk.now()).toISOString()),
  ];
  let gi = 0;
  let ci = 0;
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 60, pollSeconds: 60, maxWaitSeconds: 600,
    readGate: async () => gates[gi++]!(),
    andAlso: {
      name: "census",
      read: async () => { if (ci++ === 0) throw new Error("spawn EPERM"); return census(true, "pass (0/60 min, ratio 0.00, floor 6; …)"); },
    },
    sleep: clk.sleep, now: clk.now, log: () => {},
  });
  assert.deepEqual(r.polls[0]!.blocked, ["read-error"]);
  assert.equal(r.polls[0]!.also, undefined);
  assert.deepEqual(r.polls[1]!.blocked, ["census"]);
  assert.match(r.polls[1]!.also!.summary, /error \(spawn EPERM\) — counted as blocked/);
  assert.equal(r.polls[2]!.ok, true);
});

test("without andAlso the poll rows and lines are exactly FIX-1215's", async () => {
  const clk = fakeClock();
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 5400, pollSeconds: 300, maxWaitSeconds: 3600,
    readGate: async () => clear(new Date(clk.now()).toISOString()),
    sleep: clk.sleep, now: clk.now, log: () => {},
  });
  assert.deepEqual(Object.keys(r.polls[0]!).sort(), ["at", "blocked", "ok"]);
  assert.equal(r.also, null);
});

test("formatPollLine: a read error says so and names the census as not read", () => {
  const l = formatPollLine(null, null, "census", new Date("2026-09-24T09:00:00Z"), new Date("2026-09-24T09:05:00Z"), "ECONNRESET");
  assert.equal(l, "[gate] 09:00:00Z ok=false blocked_by=[read-error] census=skipped (gate unreadable) (gate READ ERROR: ECONNRESET) next_poll=09:05:00Z");
});

test("blockToken omits the arrow when there is no retry_after", () => {
  assert.equal(blockToken({ check: "e", name: "live_writers", detail: "", retry_after: null }), "e:live_writers");
});

test("formatGateLine: no next_poll on the last chance", () => {
  const l = formatGateLine(blocked("2026-09-23T05:00:00Z"), new Date("2026-09-23T05:00:00Z"), null);
  assert.doesNotMatch(l, /next_poll/);
});

test("parseWaitArgs: --expected-minutes required; --then needs --reason; defaults", () => {
  assert.deepEqual(parseWaitArgs([]), { error: "--expected-minutes is required" });
  assert.match((parseWaitArgs(["--expected-minutes", "0"]) as { error: string }).error, /positive/);
  assert.match((parseWaitArgs(["--expected-minutes", "30", "--then", "echo"]) as { error: string }).error, /needs --reason/);
  assert.match((parseWaitArgs(["--expected-minutes", "30", "--reason", "a\nb"]) as { error: string }).error, /one line/);
  assert.deepEqual(parseWaitArgs(["--expected-minutes", "90"]),
    { expectedMinutes: 90, reason: null, pollSeconds: 300, maxWaitMinutes: 480, then: null, census: null });
  assert.deepEqual(parseWaitArgs(["--expected-minutes=45", "--reason", "x", "--then", "node a.js", "--poll-seconds", "5"]),
    { expectedMinutes: 45, reason: "x", pollSeconds: 5, maxWaitMinutes: 480, then: "node a.js", census: null });
});

test("the --then child gets the claimant and keeps the rest of the env; cwd is packages/data", () => {
  const env = childEnv({ PATH: "/bin", FOO: "1" }, "FIX-1212 bootstrap");
  assert.equal(env["CIVITICS_PROD_SESSION_CLAIMANT"], "FIX-1212 bootstrap");
  assert.equal(env["FOO"], "1");
  assert.match(THEN_CWD.replace(/\\/g, "/"), /\/packages\/data$/);
});

// ───────────── cc-159 D2: session:wait-for-gate composes the census ─────────────

test("cc-159 D2 parseWaitArgs: --census is stop|report|off, absent is null; anything else is refused", () => {
  for (const m of ["stop", "report", "off"] as const) {
    const a = parseWaitArgs(["--expected-minutes", "20", "--census", m]);
    assert.ok(!("error" in a) && a.census === m, m);
    const b = parseWaitArgs(["--expected-minutes", "20", `--census=${m}`]);
    assert.ok(!("error" in b) && b.census === m, `${m} (= form)`);
  }
  assert.match((parseWaitArgs(["--expected-minutes", "20", "--census", "Stop"]) as { error: string }).error,
    /^--census must be stop\|report\|off \(got "Stop"\)$/);
  // The cc-159 landing command parses as written.
  const cc159 = parseWaitArgs(["--expected-minutes", "20", "--max-wait-minutes", "900", "--census", "stop",
    "--reason", "cc-159 FIX-1217 spending index CIC", "--then", "node ../../scripts/fix1217-build-fr-spending-index.mjs --env-file ../../.env.local.prod"]);
  assert.ok(!("error" in cc159));
  assert.equal(cc159.census, "stop");
  assert.equal(cc159.maxWaitMinutes, 900);
});

test("cc-159 D2 resolveCensusMode: the flag wins; the default is stop on prod and off on local", () => {
  const prod = "postgresql://postgres.xsazcoxinpgttgquwvuf:***@aws-0-us-west-2.pooler.supabase.com:5432/postgres";
  const local = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  assert.equal(resolveCensusMode(null, prod), "stop");
  assert.equal(resolveCensusMode(null, local), "off");
  assert.equal(resolveCensusMode(null, "postgresql://u:p@localhost:54322/postgres"), "off");
  assert.equal(resolveCensusMode("report", prod), "report");
  assert.equal(resolveCensusMode("off", prod), "off");
  assert.equal(resolveCensusMode("stop", local), "stop");
});

test("cc-159 D2 rule 105: cc-151's 09:34:11 reading {8 in 15 min, edge 2/183} holds the window in stop mode and is a would_trip in report mode", () => {
  const v = verdictFor({ cancellations: [{ startMs: 0, timeouts: 8, userRequests: 0 }], minutes: 15, baseline: 0.033 });
  const ev = edgeVerdictFor([{ startMs: 0, requests: 183, n5xx: 2 }]);
  const code = v.pass && ev.pass ? 0 : 1;   // cancellation-census.ts exits 0 iff both halves pass
  assert.equal(code, 1);
  const summary = "FAIL (8/15 min, ratio 16.16, floor 3 — 57014 FAIL; edge 09:15 2/183 = 1.09 % — edge FAIL)";
  const stop = gateCensusHalf("stop", code, summary);
  assert.equal(stop.ok, false, "stop: a FAIL holds like a blocked gate");
  assert.equal(stop.summary, summary);
  const report = gateCensusHalf("report", code, summary);
  assert.equal(report.ok, true, "report: recorded, not held");
  assert.match(report.summary, /— would_trip \(census report mode: recorded, not held\)$/);
  // The rest of the vocabulary, both modes.
  assert.equal(gateCensusHalf("stop", 0, "pass (…)").ok, true);
  assert.equal(gateCensusHalf("stop", 2, "dark (…)").ok, false, "stop: dark holds (fail closed)");
  assert.equal(gateCensusHalf("stop", 8, "unavailable (…)").ok, true, "stop: a removed endpoint opens on the gate alone, as the runner's half does");
  assert.equal(gateCensusHalf("report", 0, "pass (…)").summary, "pass (…)");
  assert.equal(gateCensusHalf("report", 2, "dark (…)").ok, true);
  assert.match(gateCensusHalf("report", 2, "dark (…)").summary, /not held/);
});

test("cc-159 D2: --census off never reads the Logs API — there is no reader to call", async () => {
  let reads = 0;
  const readCensus = async () => { reads++; return { code: 0, summary: "pass" }; };
  assert.deepEqual(censusWaitOptions("off", readCensus), {}, "no andAlso, no pacing");
  const clk = fakeClock(Date.parse("2026-09-26T02:00:00Z"));
  const gates = [blocked, clear];
  let gi = 0;
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 1200, pollSeconds: 300, maxWaitSeconds: 3600,
    readGate: async () => gates[gi++]!(new Date(clk.now()).toISOString()),
    ...censusWaitOptions("off", readCensus),
    sleep: clk.sleep, now: clk.now, log: () => {},
  });
  assert.equal(reads, 0);
  assert.equal(r.also, null);
  assert.equal(r.polls[0]!.at, "2026-09-26T02:00:00.000Z", "no pacing: the first poll is immediate even on :00");
});

test("cc-159 D2: in stop mode a census FAIL holds the gate until a pass; the census is read only on gate-ok polls", async () => {
  // Launched at 02:03:10 — clear of :00/:15 +0-1, and so are the next two polls.
  const clk = fakeClock(Date.parse("2026-09-26T02:03:10Z"));
  const gates = [clear, blocked, clear, clear];
  const codes = [1, 0];
  let gi = 0;
  let ci = 0;
  const readAt: string[] = [];
  const lines: string[] = [];
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 1200, pollSeconds: 300, maxWaitSeconds: 7200,
    readGate: async () => gates[gi++]!(new Date(clk.now()).toISOString()),
    ...censusWaitOptions("stop", async () => {
      readAt.push(new Date(clk.now()).toISOString());
      const code = codes[ci++]!;
      return { code, summary: code === 0 ? "pass (1/60 min …)" : "FAIL (9/60 min …)" };
    }),
    sleep: clk.sleep, now: clk.now, log: (l) => lines.push(l),
  });
  assert.equal(r.also?.ok, true);
  assert.deepEqual(r.polls.map((p) => p.blocked), [["census"], ["b:ec-vacuum-analyze", "c:blackout"], []]);
  assert.deepEqual(r.polls.map((p) => p.at.slice(11, 19)), ["02:03:10", "02:08:10", "02:13:10"]);
  assert.deepEqual(readAt.map((a) => a.slice(11, 19)), ["02:03:10", "02:13:10"], "the blocked-gate poll read no census");
  assert.match(lines[0]!, /ok=false blocked_by=\[census\] census=FAIL/);
});

test("cc-159 D2 rule 190: paceOffQuarterHour moves a poll 90 s at a time until it is clear of :00/:15/:30/:45 +0-1 min", () => {
  const at = (hms: string) => Date.parse(`2026-09-26T${hms}Z`);
  const hms = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  assert.equal(hms(paceOffQuarterHour(at("02:15:00"))), "02:18:00", ":15:00 → :16:30 (still inside) → :18:00");
  assert.equal(hms(paceOffQuarterHour(at("02:15:31"))), "02:17:01");
  assert.equal(hms(paceOffQuarterHour(at("02:16:59"))), "02:18:29");
  assert.equal(hms(paceOffQuarterHour(at("02:17:00"))), "02:17:00", "+2:00 is clear");
  assert.equal(hms(paceOffQuarterHour(at("02:14:59"))), "02:14:59", "the minute BEFORE a quarter is clear");
  assert.equal(hms(paceOffQuarterHour(at("23:59:30"))), "23:59:30");
  assert.equal(hms(paceOffQuarterHour(at("00:00:00"))), "00:03:00", "midnight is a quarter too");
  for (let s = 0; s < 3600; s += 7) {
    const t = paceOffQuarterHour(at("02:00:00") + s * 1000);
    assert.ok(Math.floor(t / 1000) % 900 >= 120, `clear at +${s}s`);
    assert.ok(t >= at("02:00:00") + s * 1000, "never earlier");
  }
});

test("cc-159 D2: a paced wait launched ON a quarter-hour waits for its slot before the first read, and every later poll lands clear", async () => {
  const clk = fakeClock(Date.parse("2026-09-26T02:15:00Z"));
  const gates = [blocked, blocked, blocked, clear];
  let gi = 0;
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 1200, pollSeconds: 300, maxWaitSeconds: 7200,
    readGate: async () => gates[gi++]!(new Date(clk.now()).toISOString()),
    ...censusWaitOptions("stop", async () => ({ code: 0, summary: "pass" })),
    sleep: clk.sleep, now: clk.now, log: () => {},
  });
  // 02:15:00 → 02:18:00, then +300 each: 02:23, 02:28, 02:33 — all 3 min or more past a quarter.
  assert.deepEqual(r.polls.map((p) => p.at.slice(11, 19)), ["02:18:00", "02:23:00", "02:28:00", "02:33:00"]);
  for (const p of r.polls) assert.ok(Math.floor(Date.parse(p.at) / 1000) % 900 >= 120, p.at);
});

test("cc-159 D2: a poll whose +300 s lands inside a quarter window moves; the one after is +300 from where it landed", async () => {
  // 02:11:00 + 300 = 02:16:00 (inside :15+0-1) → 02:17:30; + 300 = 02:22:30.
  const clk = fakeClock(Date.parse("2026-09-26T02:11:00Z"));
  const gates = [blocked, blocked, clear];
  let gi = 0;
  const lines: string[] = [];
  const r = await waitForProdOpGate({
    dbUrl: "x", expectedSeconds: 1200, pollSeconds: 300, maxWaitSeconds: 7200,
    readGate: async () => gates[gi++]!(new Date(clk.now()).toISOString()),
    ...censusWaitOptions("stop", async () => ({ code: 0, summary: "pass" })),
    sleep: clk.sleep, now: clk.now, log: (l) => lines.push(l),
  });
  assert.deepEqual(r.polls.map((p) => p.at.slice(11, 19)), ["02:11:00", "02:17:30", "02:22:30"]);
  assert.match(lines[0]!, /next_poll=02:17:30Z$/, "the printed next_poll is the paced one");
});
