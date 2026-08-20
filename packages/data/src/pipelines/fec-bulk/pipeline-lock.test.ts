/**
 * FIX-1067 — cross-run interlock tests.
 *
 * Two layers:
 *   1. Pure: the `FEC_PIPELINE_LOCK=off` bypass parser.
 *   2. Integration: two concurrent `acquireFecPipelineLock()` calls against the
 *      LOCAL Docker DB — the second must be refused, and must succeed again once
 *      the first releases. SKIPPED (not failed) when no local DB is reachable so
 *      `pnpm test` stays green on a machine with Docker down / in CI.
 *
 * The integration case is the two-invocation proof the FIX-1067 bullet asks for,
 * reduced to the interlock itself so it does not need two 2.5-hour pipeline runs
 * to demonstrate.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/pipeline-lock.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquireFecPipelineLock,
  pipelineLockDisabled,
  FEC_PIPELINE_LOCK_NAME,
} from "./pipeline-lock";

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

test("pipelineLockDisabled: only the explicit sentinel bypasses", () => {
  assert.equal(pipelineLockDisabled("off"), true);
  assert.equal(pipelineLockDisabled("OFF"), true);
  assert.equal(pipelineLockDisabled("  off  "), true);
});

test("pipelineLockDisabled: everything else keeps the interlock on", () => {
  assert.equal(pipelineLockDisabled(undefined), false);
  assert.equal(pipelineLockDisabled(""), false);
  assert.equal(pipelineLockDisabled("on"), false);
  assert.equal(pipelineLockDisabled("false"), false); // not a bypass spelling
  assert.equal(pipelineLockDisabled("0"), false);
});

// ---------------------------------------------------------------------------
// Integration — local Docker DB only
// ---------------------------------------------------------------------------

const LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Pin the interlock at the local DB whatever `.env.local` says — this test must
 * never be able to take a lock on prod — and report whether it is reachable.
 */
async function localDbReachable(): Promise<boolean> {
  process.env.SUPABASE_DB_URL = LOCAL_DSN;
  delete process.env.FEC_PIPELINE_LOCK;
  try {
    const { Client } = await import("pg");
    // Generous: the whole suite runs its files in parallel, so a 2s budget was
    // enough to make this skip spuriously on a loaded box.
    const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 15_000 });
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

test("interlock: a second concurrent invocation is refused, and admitted after release", async (t) => {
  if (!(await localDbReachable())) {
    t.skip("local Docker DB not reachable");
    return;
  }

  // First invocation — takes the lock.
  const first = await acquireFecPipelineLock();
  assert.equal(first.acquired, true, "first invocation should hold the interlock");

  // Second, while the first is live — must be refused, with a reason.
  const second = await acquireFecPipelineLock();
  assert.equal(second.acquired, false, "second concurrent invocation must be refused");
  assert.ok(second.blockedBy, "a refusal must name what blocked it");

  // A refused lock's release() is a no-op: it must not throw, and must not free
  // the holder's lock. (A loser releasing the winner's lock is exactly the
  // interleave this guards against.)
  await second.release();
  const third = await acquireFecPipelineLock();
  assert.equal(third.acquired, false, "the holder's lock must survive a loser's release()");
  await third.release();

  // Once the holder releases, the next invocation gets in.
  await first.release();
  const fourth = await acquireFecPipelineLock();
  assert.equal(fourth.acquired, true, "the interlock must be re-acquirable after release");
  await fourth.release();
});

test("interlock: FEC_PIPELINE_LOCK=off bypasses cleanly", async (t) => {
  if (!(await localDbReachable())) {
    t.skip("local Docker DB not reachable");
    return;
  }
  const held = await acquireFecPipelineLock();
  assert.equal(held.acquired, true);
  try {
    process.env.FEC_PIPELINE_LOCK = "off";
    const bypassed = await acquireFecPipelineLock();
    assert.equal(bypassed.acquired, true, "the documented override must not be a refusal");
    await bypassed.release();
  } finally {
    delete process.env.FEC_PIPELINE_LOCK;
    await held.release();
  }
});

test("interlock: session scope means a dead holder strands nothing", async (t) => {
  if (!(await localDbReachable())) {
    t.skip("local Docker DB not reachable");
    return;
  }
  const { Client } = await import("pg");

  // Simulate a crashed pipeline: take the lock on a connection, then drop the
  // connection without ever unlocking.
  const ghost = new Client({ connectionString: LOCAL_DSN });
  await ghost.connect();
  await ghost.query(`SELECT pg_advisory_lock(hashtext($1)::bigint)`, [FEC_PIPELINE_LOCK_NAME]);
  await ghost.end();

  const after = await acquireFecPipelineLock();
  assert.equal(after.acquired, true, "a session-scoped lock dies with its backend");
  await after.release();
});
