/**
 * FIX-1337 (cc-243, rule 285) — withProdSession releases on SIGINT / SIGTERM /
 * SIGBREAK, once.
 *
 * Runs via:  tsx --test src/__tests__/prod-session-signals.test.ts
 *
 * Unit (no DB): releaseOnSignals() against a fake emitter — the signal runs the
 * release once and exits 130 / 143 / 149; the `finally` after it does not
 * release again; a hung release still exits at the timeout; uninstall removes
 * every handler. Behavioural (the local clone; skips without it): a child
 * holding withProdSession is SIGTERM'd and its hold rows are gone within 5 s.
 *
 * FIX-1387 (cc-265) — the same release for the pg client's `error` event. Unit:
 * a fake client emits it, onLost fires once, the rows clear on a FRESH client
 * under this claimant's name, a refused connection is retried, one line prints.
 * Behavioural (CIVITICS_CLONE_TESTS=1): pg_terminate_backend on the lock's
 * backend is a real 57P01, and the child exits 1 with no hold and no label left.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { Client } from "pg";
import {
  SESSION_HOLD_NOTE,
  SESSION_HOLD_PREFIX,
  SIGNAL_EXIT_CODES,
  clearClaimantResidue,
  lostCause,
  releaseLostSession,
  releaseOnSignals,
  sessionReleases,
  type withClient,
} from "../lib/prod-session";
import { makeHeldLock } from "../lib/session-lock";

const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

test("a signal releases once and exits 128 + signo; the finally does not release again", async () => {
  for (const [sig, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    const proc = new EventEmitter();
    let calls = 0;
    const exits: number[] = [];
    const g = releaseOnSignals(async () => { calls++; }, { proc, exit: (c) => exits.push(c) });
    proc.emit(sig);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(exits, [code], `${sig} → exit ${code}`);
    await g.release();
    assert.equal(calls, 1, `${sig}: released exactly once`);
    g.uninstall();
  }
});

test("a hung release still exits at the timeout", async () => {
  const proc = new EventEmitter();
  const exits: number[] = [];
  releaseOnSignals(() => new Promise<void>(() => {}), { proc, exit: (c) => exits.push(c), timeoutMs: 30 });
  proc.emit("SIGTERM");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(exits, [143]);
});

test("a release that throws is swallowed (best effort) and the exit still happens", async () => {
  const proc = new EventEmitter();
  const exits: number[] = [];
  releaseOnSignals(async () => { throw new Error("db gone"); }, { proc, exit: (c) => exits.push(c) });
  proc.emit("SIGINT");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [130]);
});

test("uninstall removes every handler; the normal path releases once", async () => {
  const proc = new EventEmitter();
  let calls = 0;
  const g = releaseOnSignals(async () => { calls++; }, { proc, exit: () => assert.fail("no exit on the normal path") });
  for (const sig of Object.keys(SIGNAL_EXIT_CODES)) assert.equal(proc.listenerCount(sig), 1, sig);
  g.uninstall();
  for (const sig of Object.keys(SIGNAL_EXIT_CODES)) assert.equal(proc.listenerCount(sig), 0, sig);
  await g.release();
  await g.release();
  assert.equal(calls, 1);
});

test("clone: a SIGTERM'd withProdSession child leaves no session hold rows (within 5 s)", async (t) => {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "fixtures", "prod-session-signal-child.ts"), LOCAL_DSN],
      {
        env: { ...process.env, SELF_SIGNAL: process.platform === "win32" ? "1" : "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    const held = new Promise<boolean>((resolve) => {
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("HELD")) resolve(true);
        if (out.includes("REFUSED")) resolve(false);
      });
      child.on("exit", () => resolve(out.includes("HELD")));
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    if (!(await held)) {
      t.skip(`the local claim was refused or never held: ${out.trim().slice(0, 200)}`);
      child.kill();
      return;
    }
    const t0 = Date.now();
    if (process.platform !== "win32") child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
    assert.notEqual(code, "timeout", "the child exits");
    assert.equal(code, SIGNAL_EXIT_CODES.SIGTERM);
    assert.ok(Date.now() - t0 < 5_000 + 1_000, `released and exited in ${Date.now() - t0} ms`);
    const left = await c.query(
      "SELECT count(*)::int AS n FROM public.rollup_watch_overrides WHERE hold_reason = $1",
      [SESSION_HOLD_PREFIX + "cc-243 signal test"],
    );
    assert.equal(left.rows[0]?.n, 0, "no hold row survives the signal");
    const st = await c.query("SELECT public.prod_session_state()->>'held' AS held");
    assert.equal(st.rows[0]?.held, "false");
  } finally {
    await c.end();
  }
});

// ── FIX-1387 (cc-265): the error event's path ───────────────────────────────

class FakeClient extends EventEmitter {
  queries: Array<{ sql: string; params: unknown[] }> = [];
  ended = 0;
  endThrows = false;
  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    return { rowCount: /rollup_watch_overrides/.test(sql) && /UPDATE/.test(sql) ? 6 : 1, rows: [] };
  }
  async end() {
    this.ended++;
    if (this.endThrows) throw new Error("Connection terminated");
  }
}
const heldLock = (client: FakeClient, onLost?: (err: unknown) => void) =>
  makeHeldLock(client as unknown as Client, "prod_supervised_session", {
    logTag: "prod-session",
    ref: "FIX-950",
    label: { key: "prod_session", value: {} },
    onLost,
  });

test("FIX-1387: the lock client's error event calls onLost once; pg's second event is heard and ignored", () => {
  const client = new FakeClient();
  const lost: unknown[] = [];
  heldLock(client, (err) => lost.push(err));
  const fatal = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
  client.emit("error", fatal);
  client.emit("error", new Error("Connection terminated unexpectedly"));
  assert.deepEqual(lost, [fatal]);
});

test("FIX-1387: after the error event release() never touches the dead client; a throwing end() is swallowed", async () => {
  const client = new FakeClient();
  client.endThrows = true;
  const lock = heldLock(client, () => {});
  client.emit("error", { code: "57P01" });
  await lock.release();
  await lock.release();
  assert.equal(client.queries.length, 0, "no unlock and no label delete on a dead client");
  assert.equal(client.ended, 1);
});

test("FIX-1387: an error during a normal release is not a lost session; no hook means no listener", async () => {
  const client = new FakeClient();
  const lost: unknown[] = [];
  const lock = heldLock(client, (err) => lost.push(err));
  await lock.release();
  client.emit("error", new Error("late"));
  assert.deepEqual(lost, []);
  const fec = new FakeClient();
  heldLock(fec);
  assert.equal(fec.listenerCount("error"), 0, "the FEC lock keeps crashing on the event, which is what it wants");
});

test("FIX-1387: lostCause names a class 57 SQLSTATE, and anything else as connection lost", () => {
  assert.equal(lostCause({ code: "57P01" }), "57P01");
  assert.equal(lostCause({ code: "57P02" }), "57P02");
  assert.equal(lostCause({ code: "ECONNRESET" }), "connection lost");
  assert.equal(lostCause({ code: "EPIPE" }), "connection lost");
  assert.equal(lostCause(new Error("Connection terminated unexpectedly")), "connection lost");
  assert.equal(lostCause(null), "connection lost");
});

const captureErrors = async (fn: () => Promise<void>): Promise<string[]> => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
};
const CLAIM = {
  dbUrl: "postgresql://unused",
  reason: "cc-265 lost test",
  label: { reason: "cc-265 lost test", claimed_at: "2026-11-07T06:00:00.000Z", pid: 4242 },
};
/** A clock that only moves when the code sleeps. */
const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};
/** withClient's seam: `null` is a refused connection, a throw is a query failure. */
const runner = (client: FakeClient, script: Array<"refused" | "throw" | "ok">) => {
  let i = 0;
  const run = (async (_url: string, fn: (c: never) => Promise<unknown>) => {
    const step = script[Math.min(i++, script.length - 1)];
    if (step === "refused") return null;
    if (step === "throw") throw new Error("the database system is shutting down");
    return fn(client as never);
  }) as unknown as typeof withClient;
  return { run, calls: () => i };
};

test("FIX-1387: the release runs on a fresh client, names this claimant and prints one line", async () => {
  const dead = new FakeClient();
  const fresh = new FakeClient();
  const { run } = runner(fresh, ["ok"]);
  const lines = await captureErrors(() => releaseLostSession(CLAIM, { code: "57P01" }, { run, ...fakeClock() }));
  assert.equal(dead.queries.length, 0, "the dead client is never reused");
  const update = fresh.queries.find((q) => /UPDATE public\.rollup_watch_overrides/.test(q.sql))!;
  assert.equal(update.params[0], "prod session held: cc-265 lost test", "the exact reason, not the prefix");
  assert.equal(update.params[2], JSON.stringify(CLAIM.label));
  const label = fresh.queries.find((q) => /DELETE FROM public\.pipeline_state/.test(q.sql))!;
  assert.deepEqual(label.params, ["prod_session", JSON.stringify(CLAIM.label)]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\(57P01\): cleared 6 hold\(s\) and the label through a fresh connection/);
});

test("FIX-1387: a refused connection is retried, because the event that killed the lock refuses the next one too", async () => {
  const fresh = new FakeClient();
  const r = runner(fresh, ["refused", "throw", "ok"]);
  const lines = await captureErrors(() => releaseLostSession(CLAIM, new Error("gone"), { run: r.run, ...fakeClock(), retryMs: 5_000 }));
  assert.equal(r.calls(), 3);
  assert.equal(lines.length, 1, "one line, not one per attempt");
  assert.match(lines[0]!, /\(connection lost\): cleared 6 hold/);
});

test("FIX-1387: past the budget it says so once, never throws, and leaves the rows to the next claim", async () => {
  const r = runner(new FakeClient(), ["throw"]);
  const lines = await captureErrors(() =>
    releaseLostSession(CLAIM, { code: "57P02" }, { run: r.run, ...fakeClock(), budgetMs: 20_000, retryMs: 5_000 }),
  );
  assert.equal(r.calls(), 5, "0, 5, 10, 15 and 20 s");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\(57P02\) and no fresh connection cleared this claim's holds and label within 20 s \(the database system is shutting down\)\. The next claim sweeps them/);
});

test("FIX-1387: signal + error run one release, whichever came first", async () => {
  const calls: string[] = [];
  const pair = () =>
    sessionReleases(
      async () => void calls.push("normal"),
      async (cause) => void calls.push("lost:" + String(cause)),
    );
  const a = pair();
  await a.release();
  await a.releaseLost("57P01");
  await a.release();
  const b = pair();
  await b.releaseLost("57P01");
  await b.release();
  await b.releaseLost("57P01");
  assert.deepEqual(calls, ["normal", "lost:57P01"]);
});

test("clone: a 57P01 on the lock's backend exits 1 and leaves no hold and no label", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1: this takes the real lock on the shared clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "fixtures", "prod-session-signal-child.ts"), LOCAL_DSN],
      { env: { ...process.env, SELF_SIGNAL: "0", CHILD_REASON: "cc-265 lost test" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const held = new Promise<boolean>((resolve) => {
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("HELD")) resolve(true);
        if (out.includes("REFUSED")) resolve(false);
      });
      child.on("exit", () => resolve(out.includes("HELD")));
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    if (!(await held)) {
      t.skip(`the local claim was refused or never held: ${out.trim().slice(0, 200)}`);
      child.kill();
      return;
    }
    const heldRows = await c.query(
      "SELECT count(*)::int AS n FROM public.rollup_watch_overrides WHERE hold_reason = $1",
      [SESSION_HOLD_PREFIX + "cc-265 lost test"],
    );
    assert.ok((heldRows.rows[0]?.n ?? 0) > 0, "the claim set its holds");
    const killed = await c.query(
      `SELECT pg_terminate_backend(l.pid) AS killed
         FROM pg_locks l
        WHERE l.locktype = 'advisory' AND l.granted
          AND l.objsubid = 1
          AND l.classid = ((hashtext('prod_supervised_session')::bigint >> 32) & 4294967295)::bigint::oid
          AND l.objid = (hashtext('prod_supervised_session')::bigint & 4294967295)::bigint::oid`,
    );
    assert.equal(killed.rowCount, 1, "exactly one backend holds the session lock");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]);
    assert.equal(code, 1, `the child exits 1; stderr: ${err.slice(0, 400)}`);
    assert.match(err, /the lock connection died \(57P01\): cleared \d+ hold\(s\) and the label/);
    const left = await c.query(
      "SELECT count(*)::int AS n FROM public.rollup_watch_overrides WHERE hold_reason = $1",
      [SESSION_HOLD_PREFIX + "cc-265 lost test"],
    );
    assert.equal(left.rows[0]?.n, 0, "no hold row survives the 57P01");
    const st = await c.query("SELECT public.prod_session_state() AS s");
    const s = st.rows[0]?.s as { held: boolean; label_present: boolean };
    assert.equal(s.held, false);
    assert.equal(s.label_present, false, "no label survives it");
  } finally {
    await c.end();
  }
});

test("clone: the lost clear takes this claimant's rows and no one else's", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1: this writes the shared hold rows");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  const mine = { reason: "mine", claimed_at: "2026-11-07T06:00:00.000Z", pid: 1 };
  const theirs = { reason: "mine", claimed_at: "2026-11-07T06:00:30.000Z", pid: 2 };
  const hold = (pipeline: string, reason: string) =>
    c.query(
      "INSERT INTO public.rollup_watch_overrides (pipeline, held_since, hold_reason, note) VALUES ($1, now(), $2, $3)",
      [pipeline, reason, SESSION_HOLD_NOTE],
    );
  const label = (value: unknown) =>
    c.query(
      `INSERT INTO public.pipeline_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ["prod_session", JSON.stringify(value)],
    );
  const heldBy = async () =>
    (await c.query<{ pipeline: string }>(
      "SELECT pipeline FROM public.rollup_watch_overrides WHERE pipeline LIKE 'fix1387_%' AND held_since IS NOT NULL ORDER BY 1",
    )).rows.map((r) => r.pipeline);
  try {
    await c.query("BEGIN");
    await hold("fix1387_mine", SESSION_HOLD_PREFIX + "mine");
    await hold("fix1387_other", SESSION_HOLD_PREFIX + "another reason");
    await hold("fix1387_human", "Craig paused this");

    await label(mine);
    assert.deepEqual(await clearClaimantResidue(c, "mine", mine), { holds: 1, label: true });
    assert.deepEqual(await heldBy(), ["fix1387_human", "fix1387_other"], "an exact reason: not a sweep");
    const row = await c.query("SELECT 1 FROM public.pipeline_state WHERE key = 'prod_session'");
    assert.equal(row.rowCount, 0, "this claim's label went");
    assert.deepEqual(await clearClaimantResidue(c, "mine", mine), { holds: 0, label: false }, "safe to run twice");

    await hold("fix1387_mine", SESSION_HOLD_PREFIX + "mine");
    await label(theirs);
    assert.deepEqual(await clearClaimantResidue(c, "mine", mine), { holds: 0, label: false });
    assert.ok((await heldBy()).includes("fix1387_mine"), "another claim's label: the same reason is its hold, not this one's");
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
});
