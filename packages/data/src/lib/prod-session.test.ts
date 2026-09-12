/**
 * FIX-950 — the claim preflight's refusal matrix, and the label round-trip.
 *
 * Two layers, mirroring pipeline-lock.test.ts:
 *   1. Pure: classifyPreflight over every shape prod_session_state() can return.
 *   2. Integration: a real claim against the LOCAL Docker DB — the label lands,
 *      the state reads back held, the release removes both. SKIPPED (not
 *      failed) when no local DB is reachable, so `pnpm test` stays green in CI.
 *
 * WHAT THE PURE LAYER HAS TO PROVE. The refusal matrix is the whole of D4 and
 * its two halves are asymmetric in a way that is easy to get wrong:
 * `writers-live` is forceable and `session-held` is not. A test that only
 * checked "refuses when something is live" would pass with --force overriding
 * both, which would make the interlock advisory in the one case it exists for.
 *
 * Runs via:  tsx --test src/lib/prod-session.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPreflight,
  describeWriters,
  formatAge,
  claimProdSession,
  readProdSessionState,
  withClient,
  ProdSessionRefused,
  PROD_SESSION_LABEL_KEY,
  type ProdSessionState,
} from "./prod-session";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function state(over: Partial<ProdSessionState> = {}): ProdSessionState {
  return {
    held: false,
    defer: false,
    label_present: false,
    label_stale: false,
    reason: null,
    claimed_by: null,
    claimed_at: null,
    age_seconds: null,
    expected_minutes: null,
    pid: null,
    live_writers: [],
    live_writer_detail: [],
    reason_text: "clear",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure — the refusal matrix
// ---------------------------------------------------------------------------

test("preflight: a clear box admits the claim", () => {
  const v = classifyPreflight(state(), { force: false });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.forced, false);
});

test("preflight: a live advisory-lock writer REFUSES, and names it", () => {
  const v = classifyPreflight(
    state({ live_writers: ["financial_entity_totals_refresh"] }),
    { force: false },
  );
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "writers-live");
  assert.deepEqual(!v.ok && v.code === "writers-live" ? v.writers : null, [
    "financial_entity_totals_refresh",
  ]);
  assert.match(v.ok ? "" : v.detail, /financial_entity_totals_refresh/);
});

test("preflight: a running nightly phase REFUSES the same way", () => {
  const v = classifyPreflight(state({ live_writers: ["nightly_cron:fec"] }), { force: false });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "writers-live");
});

test("preflight: the FEC pipeline lock REFUSES the same way", () => {
  const v = classifyPreflight(state({ live_writers: ["fec_bulk_pipeline"] }), { force: false });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "writers-live");
});

test("preflight: --force claims over live writers and records what it overrode", () => {
  const v = classifyPreflight(
    state({ live_writers: ["refresh_derived_mvs", "run_rule_taggers"] }),
    { force: true },
  );
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.forced, true);
  assert.deepEqual(v.ok && v.forced ? v.forcedOver : null, [
    "refresh_derived_mvs",
    "run_rule_taggers",
  ]);
});

test("preflight: ANOTHER supervised session refuses, and --force does NOT override it", () => {
  const held = state({
    held: true,
    defer: true,
    label_present: true,
    claimed_by: "someone@box",
    reason: "FIX-954 set 3 apply",
    age_seconds: 900,
    reason_text: "prod session held: FIX-954 set 3 apply",
  });

  const plain = classifyPreflight(held, { force: false });
  assert.equal(plain.ok, false);
  assert.equal(!plain.ok && plain.code, "session-held");

  const forced = classifyPreflight(held, { force: true });
  assert.equal(forced.ok, false, "--force must NOT admit a second supervised session");
  assert.equal(!forced.ok && forced.code, "session-held");
  assert.match(forced.ok ? "" : forced.detail, /someone@box/);
  assert.match(forced.ok ? "" : forced.detail, /FIX-954 set 3 apply/);
});

test("preflight: a held session outranks live writers in the refusal message", () => {
  // Both true at once: a supervised session that itself started a rollup. The
  // actionable fact is the other human, not the rollup.
  const v = classifyPreflight(
    state({ held: true, claimed_by: "a@b", live_writers: ["refresh_derived_mvs"] }),
    { force: true },
  );
  assert.equal(!v.ok && v.code, "session-held");
});

test("preflight: a stale LABEL with no lock does not refuse — the lock is the truth", () => {
  const v = classifyPreflight(
    state({
      held: false,
      label_present: true,
      label_stale: true,
      claimed_by: "ghost@box",
      reason: "a session that died",
      reason_text: "stale prod_session label with no lock — a dead session",
    }),
    { force: false },
  );
  assert.equal(v.ok, true, "a dead label must never block a claim");
});

test("preflight: an unreadable interlock FAILS OPEN", () => {
  const v = classifyPreflight(null, { force: false });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.forced, false);
});

// ---------------------------------------------------------------------------
// Pure — formatting the operator actually reads
// ---------------------------------------------------------------------------

test("formatAge: seconds, minutes, hours", () => {
  assert.equal(formatAge(0), "0s");
  assert.equal(formatAge(45), "45s");
  assert.equal(formatAge(137), "2m17s");
  assert.equal(formatAge(3600), "1h00m");
  assert.equal(formatAge(7845), "2h10m");
});

test("describeWriters: names the mechanism and survives a null age", () => {
  const lines = describeWriters([
    { name: "refresh_derived_mvs", pid: 4242, age_seconds: 900, source: "advisory_lock" },
    { name: "nightly_cron:fec", pid: null, age_seconds: null, source: "data_sync_log" },
  ]);
  assert.match(lines[0] ?? "", /refresh_derived_mvs — 15m00s in pid 4242 \(advisory_lock\)/);
  assert.match(lines[1] ?? "", /nightly_cron:fec — age unknown \(data_sync_log\)/);
});

// ---------------------------------------------------------------------------
// Integration — local Docker DB only
// ---------------------------------------------------------------------------

const LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function localDbReachable(): Promise<boolean> {
  try {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 15_000 });
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

test("claim: the label lands on acquire and is gone after release", async (t) => {
  if (!(await localDbReachable())) {
    t.skip("local Docker DB not reachable");
    return;
  }

  const lock = await claimProdSession({
    reason: "prod-session.test.ts",
    expectedMinutes: 5,
    dbUrl: LOCAL_DSN,
  });
  assert.equal(lock.acquired, true);

  try {
    const held = await withClient(LOCAL_DSN, readProdSessionState);
    assert.ok(held, "prod_session_state() must be readable on the clone");
    assert.equal(held.held, true, "the lock must be visible in pg_locks");
    assert.equal(held.defer, true, "defer follows held");
    assert.equal(held.label_present, true, "the label must land with the lock");
    assert.equal(held.label_stale, false);
    assert.equal(held.reason, "prod-session.test.ts");
    assert.equal(held.expected_minutes, 5);
    assert.match(held.reason_text, /^prod session held: prod-session\.test\.ts$/);
  } finally {
    await lock.release();
  }

  const after = await withClient(LOCAL_DSN, readProdSessionState);
  assert.ok(after);
  assert.equal(after.held, false, "release must free the lock");
  assert.equal(after.label_present, false, "release must drop the label");
  assert.equal(after.reason_text, "clear");
});

test("claim: a second claim while one is held is REFUSED, and --force cannot take it", async (t) => {
  if (!(await localDbReachable())) {
    t.skip("local Docker DB not reachable");
    return;
  }

  const first = await claimProdSession({
    reason: "first holder",
    expectedMinutes: 5,
    dbUrl: LOCAL_DSN,
  });
  assert.equal(first.acquired, true);

  try {
    await assert.rejects(
      () => claimProdSession({ reason: "second", dbUrl: LOCAL_DSN }),
      (err: unknown) =>
        err instanceof ProdSessionRefused && err.verdict.code === "session-held",
      "a second supervised session must be refused",
    );
    await assert.rejects(
      () => claimProdSession({ reason: "second", force: true, dbUrl: LOCAL_DSN }),
      (err: unknown) =>
        err instanceof ProdSessionRefused && err.verdict.code === "session-held",
      "--force must not admit a second supervised session",
    );
  } finally {
    await first.release();
  }
});

test("claim: a live heavy writer refuses the claim; --force takes it and logs the override", async (t) => {
  if (!(await localDbReachable())) {
    t.skip("local Docker DB not reachable");
    return;
  }
  const { Client } = await import("pg");

  // Stand in for a mid-flight `run_fe_totals_crawl` by holding its key.
  const writer = new Client({ connectionString: LOCAL_DSN });
  await writer.connect();
  await writer.query(`SELECT pg_advisory_lock(hashtext('financial_entity_totals_refresh')::bigint)`);

  try {
    await assert.rejects(
      () => claimProdSession({ reason: "over a writer", dbUrl: LOCAL_DSN }),
      (err: unknown) =>
        err instanceof ProdSessionRefused &&
        err.verdict.code === "writers-live" &&
        err.verdict.writers.includes("financial_entity_totals_refresh"),
      "a live heavy writer must refuse the claim",
    );

    const forced = await claimProdSession({
      reason: "over a writer",
      force: true,
      dbUrl: LOCAL_DSN,
    });
    assert.equal(forced.acquired, true, "--force must claim over a live writer");
    try {
      const row = await withClient(LOCAL_DSN, async (c) => {
        const r = await c.query<{ value: { forced_over?: string[] } }>(
          `SELECT value FROM public.pipeline_state WHERE key = $1`,
          [PROD_SESSION_LABEL_KEY],
        );
        return r.rows[0]?.value ?? null;
      });
      assert.deepEqual(
        row?.forced_over,
        ["financial_entity_totals_refresh"],
        "an override nobody can find afterwards is the same as no override",
      );
    } finally {
      await forced.release();
    }
  } finally {
    await writer.query(`SELECT pg_advisory_unlock(hashtext('financial_entity_totals_refresh')::bigint)`);
    await writer.end();
  }
});
