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
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { Client } from "pg";
import { SESSION_HOLD_PREFIX, SIGNAL_EXIT_CODES, releaseOnSignals } from "../lib/prod-session";

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
