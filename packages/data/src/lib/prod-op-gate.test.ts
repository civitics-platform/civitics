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
  waitForProdOpGate,
  type ProdOpGate,
} from "./prod-op-gate";
import { childEnv, parseWaitArgs, THEN_CWD } from "../scripts/wait-for-gate";

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
    { expectedMinutes: 90, reason: null, pollSeconds: 300, maxWaitMinutes: 480, then: null });
  assert.deepEqual(parseWaitArgs(["--expected-minutes=45", "--reason", "x", "--then", "node a.js", "--poll-seconds", "5"]),
    { expectedMinutes: 45, reason: "x", pollSeconds: 5, maxWaitMinutes: 480, then: "node a.js" });
});

test("the --then child gets the claimant and keeps the rest of the env; cwd is packages/data", () => {
  const env = childEnv({ PATH: "/bin", FOO: "1" }, "FIX-1212 bootstrap");
  assert.equal(env["CIVITICS_PROD_SESSION_CLAIMANT"], "FIX-1212 bootstrap");
  assert.equal(env["FOO"], "1");
  assert.match(THEN_CWD.replace(/\\/g, "/"), /\/packages\/data$/);
});
