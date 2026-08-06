/**
 * FIX-968 — anchors for the break-glass sweep's statement_timeout gate.
 *
 * Runs via:  tsx --test src/lib/statement-timeout-probe.test.ts
 *
 * WHY THESE HIT A REAL SERVER
 * The bug being pinned is a COLUMN-NAMING bug: `SHOW statement_timeout` returns
 * `{ statement_timeout: "0" }`, so reading `.st` off it yields `undefined` and
 * the gate refuses forever. No amount of asserting on the SQL string or on a
 * mocked row can catch that — only Postgres knows what it names the column. The
 * pure-unit half of this file would have passed against the broken code.
 *
 * So the load-bearing test connects to local Docker Postgres, actually disarms
 * the timeout, and asserts the gate PASSES. That direction matters: the broken
 * form always refused, so a test that only exercises the refusal path proves
 * nothing (FIX-968 decision 6).
 *
 * DB-dependent tests SKIP when 127.0.0.1:54322 is unreachable rather than
 * failing, because .github/workflows/tests.yml runs the suite with no Postgres.
 * The skip is announced, not silent — a green run that skipped everything must
 * not read as coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  ARMED_PROBE_SQL,
  isTimeoutDisarmed,
  type ArmedProbeRow,
} from "./statement-timeout-probe";

const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function connectOrNull(): Promise<Client | null> {
  const client = new Client({
    connectionString: LOCAL_DB_URL,
    application_name: "civitics_statement_timeout_probe_test",
    connectionTimeoutMillis: 3000,
  });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

// ── Pure ──────────────────────────────────────────────────────────────────────
// Necessary but NOT sufficient — see the header. These pin the comparison only.

test("isTimeoutDisarmed: exact '0' passes", () => {
  assert.equal(isTimeoutDisarmed({ st: "0" }), true);
});

test("isTimeoutDisarmed: a live timeout refuses", () => {
  assert.equal(isTimeoutDisarmed({ st: "6h" }), false);
  assert.equal(isTimeoutDisarmed({ st: "8s" }), false);
  assert.equal(isTimeoutDisarmed({ st: "21600000" }), false);
});

test("isTimeoutDisarmed: undefined row fails CLOSED", () => {
  // This is the shape the broken `SHOW` form produced. Refusing on it is
  // correct — the bug was never the comparison, it was the query.
  assert.equal(isTimeoutDisarmed(undefined), false);
  assert.equal(isTimeoutDisarmed({} as ArmedProbeRow), false);
});

// ── Against a real server ─────────────────────────────────────────────────────

test("probe SQL binds to `st` and the gate PASSES on a disarmed session", async (t) => {
  const client = await connectOrNull();
  if (!client) {
    t.skip("local Postgres (127.0.0.1:54322) unreachable — skipping live probe");
    return;
  }
  try {
    await client.query("SET statement_timeout = 0");

    const res = await client.query<ArmedProbeRow>(ARMED_PROBE_SQL);
    const row = res.rows[0];

    // The whole point: the alias lands where the caller reads it...
    assert.equal(row?.st, "0", "ARMED_PROBE_SQL must expose the value as `st`");
    // ...and the gate therefore lets a legitimate sweep through.
    assert.equal(
      isTimeoutDisarmed(row),
      true,
      "gate must PASS on a genuinely disarmed session — the broken form always refused",
    );
  } finally {
    await client.end().catch(() => {});
  }
});

test("probe SQL refuses while a timeout is armed", async (t) => {
  const client = await connectOrNull();
  if (!client) {
    t.skip("local Postgres (127.0.0.1:54322) unreachable — skipping live probe");
    return;
  }
  try {
    await client.query("SET statement_timeout = '6h'");
    const res = await client.query<ArmedProbeRow>(ARMED_PROBE_SQL);
    assert.equal(res.rows[0]?.st, "6h");
    assert.equal(isTimeoutDisarmed(res.rows[0]), false);
  } finally {
    await client.end().catch(() => {});
  }
});

test("regression: `SHOW statement_timeout` does NOT expose `st` (the FIX-968 bug)", async (t) => {
  const client = await connectOrNull();
  if (!client) {
    t.skip("local Postgres (127.0.0.1:54322) unreachable — skipping live probe");
    return;
  }
  try {
    await client.query("SET statement_timeout = 0");

    const broken = await client.query<Record<string, string>>("SHOW statement_timeout");
    const row = broken.rows[0];

    // SHOW names the column after the SETTING. This is the entire bug.
    assert.equal(row?.["statement_timeout"], "0");
    assert.equal(
      row?.["st"],
      undefined,
      "if this ever becomes defined, the shared probe can be simplified",
    );
    // …and so the old gate refused a session that was correctly disarmed.
    assert.equal(isTimeoutDisarmed(row as unknown as ArmedProbeRow), false);
  } finally {
    await client.end().catch(() => {});
  }
});
