/**
 * FIX-1194 P1-A — box_backoff_gate() and the three rollups that call it
 * (20261003030000_fix1194_p1a_box_backoff_gates.sql, cc-183).
 *
 * Runs via:  tsx --test src/__tests__/box-backoff-gate.test.ts
 *
 * Source anchors (no DB, run in CI): the gate is INVOKER / VOLATILE with one
 * search_path SET and no transaction control; each procedure calls it with its
 * own job name and wait, reads box_is_saturated with the wall switched OFF
 * (D2 — the 1.0 s wall is not a backoff input), and takes the gate BEFORE its
 * advisory lock; contract-flow carries no SET clause (it COMMITs now — FIX-1128)
 * and a SESSION lock; no new skip_reason starts with the FIX-950 hold prefix.
 *
 * Behavioural, against the local clone, inside BEGIN … ROLLBACK: the gate's
 * three readings (stale / fork_failures / a 5.0 s wall it must IGNORE), the
 * zero-wait answer, and the civitics.box_gate_wait_max_s override. The stamp is
 * seeded at the DB clock, because the gate calls box_is_saturated() with its
 * default p_now. Skips when the DB is unreachable or the migration is not
 * applied. The procedures' own runs (partial at a chunk, resume, skip after a
 * short wait, Σ unchanged) are the cc-183 report's clone runs, not this file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { SESSION_HOLD_PREFIX } from "../lib/prod-session";

const MIGRATIONS = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const MIGRATION = path.join(MIGRATIONS, "20261003030000_fix1194_p1a_box_backoff_gates.sql");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const SRC = fs.readFileSync(MIGRATION, "utf8");

/** One routine's definition: CREATE through its closing dollar-quote. */
function definition(name: string): string {
  const i = SRC.indexOf(`CREATE OR REPLACE PROCEDURE public.${name}(`) >= 0
    ? SRC.indexOf(`CREATE OR REPLACE PROCEDURE public.${name}(`)
    : SRC.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.notEqual(i, -1, `${name} is defined in the migration`);
  const tag = /AS (\$[a-z_]*\$)\n/.exec(SRC.slice(i))!;
  const a = i + tag.index + tag[0].length;
  return SRC.slice(i, SRC.indexOf(tag[1]!, a));
}

/** The body with `--` comments removed, so an anchor never matches prose. */
const code = (name: string) => definition(name).replace(/--[^\n]*/g, "");

const PROCS = [
  { name: "donor_rollup_rebuild_bulk", job: "donor-rollup-refresh", wait: 600, units: true },
  { name: "refresh_contract_flow_rollups", job: "contract-flow-rollups-refresh", wait: 1800, units: false },
  { name: "refresh_agency_staffing_rollup", job: "agency-staffing-rollup-refresh", wait: 600, units: true },
] as const;

// ---------------------------------------------------------------------------
// Source anchors — no database.
// ---------------------------------------------------------------------------

test("FIX-1194 P1-A: box_backoff_gate is INVOKER, VOLATILE, search_path only, no txn control; grants to service_role", () => {
  const d = definition("box_backoff_gate");
  const head = d.slice(0, d.indexOf("AS $function$"));
  assert.match(head, /\bSECURITY INVOKER\b/);
  assert.match(head, /\bVOLATILE\b/);
  assert.equal((head.match(/\bSET\s+\w+/g) ?? []).length, 1);
  assert.match(head, /SET search_path TO 'public', 'pg_catalog'/);
  assert.doesNotMatch(code("box_backoff_gate"), /\bCOMMIT\b|statement_timeout/i);
  // It reads the sensor the gates are allowed to read, and nothing else.
  assert.match(code("box_backoff_gate"), /public\.box_is_saturated\(p_include_watchdog_wall := false\)/);
  assert.match(SRC, /REVOKE ALL ON FUNCTION public\.box_backoff_gate\(text, int\) FROM PUBLIC, anon, authenticated;/);
  assert.match(SRC, /GRANT EXECUTE ON FUNCTION public\.box_backoff_gate\(text, int\) TO service_role;/);
});

for (const p of PROCS) {
  test(`FIX-1194 P1-A: ${p.name} — gate('${p.job}', ${p.wait}) BEFORE the lock; the wall is never an input`, () => {
    const b = code(p.name);
    const gate = b.indexOf(`public.box_backoff_gate('${p.job}', ${p.wait})`);
    const lock = b.search(/pg_try_advisory(?:_xact)?_lock\(/);
    assert.ok(gate > 0, `${p.name} calls the gate with its own job name and wait`);
    assert.ok(lock > gate, `${p.name}: gate → lock (a waiting firing must hold nothing)`);
    // Every saturation read in the body switches the wall off (D2).
    for (const m of b.matchAll(/box_is_saturated\(([^)]*)\)/g)) {
      assert.equal(m[1], "p_include_watchdog_wall := false", `${p.name}: ${m[0]}`);
    }
    if (p.units) {
      assert.ok(
        b.match(/box_is_saturated\(p_include_watchdog_wall := false\)/g)!.length >= 1,
        `${p.name} reads the box at its chunk boundary`,
      );
    }
    // The new skip vocabulary never collides with the FIX-950 hold prefix.
    assert.match(b, /'box saturated after %s s: %s'/);
    assert.ok(!"box saturated after".startsWith(SESSION_HOLD_PREFIX.trim()));
    assert.equal(SESSION_HOLD_PREFIX, "prod session held: ");
    // Procedures that COMMIT must carry no SET clause (FIX-1128).
    const head = definition(p.name).slice(0, definition(p.name).indexOf("AS $procedure$"));
    assert.doesNotMatch(head, /\bSET\s+\w+/, `${p.name}: no proconfig on a COMMITting procedure`);
    assert.match(b, /\bCOMMIT\b/);
  });
}

test("FIX-1194 P1-A: contract-flow — session lock (an xact lock dies at the running row's COMMIT), released on every exit", () => {
  const b = code("refresh_contract_flow_rollups");
  assert.doesNotMatch(b, /pg_try_advisory_xact_lock/);
  assert.match(b, /pg_try_advisory_lock\(c_lock_key\)/);
  // Exits after the lock: the defer, the cancel/failure close, the success close.
  assert.equal((b.match(/pg_advisory_unlock\(c_lock_key\)/g) ?? []).length, 3);
  // The running row is COMMITted before the sub-block; the cancel handler is by name.
  assert.ok(b.indexOf("'running'") < b.indexOf("WHEN query_canceled THEN"));
  assert.match(b, /WHEN OTHERS THEN[\s\S]*RAISE EXCEPTION '\[contract-flow rollups\] %', v_failed USING ERRCODE = v_sqlstate;/);
});

test("FIX-1194 P1-A: donor + agency — a backoff never advances a watermark", () => {
  // donor: the backoff close RETURNs before the watermark write at the end.
  const d = code("donor_rollup_rebuild_bulk");
  const write = d.indexOf("VALUES ('donor_rollup_watermark'");
  assert.ok(write > 0, "the watermark write");
  assert.ok(d.indexOf("IF v_backoff IS NOT NULL THEN") < write);
  // agency: the watermark write is guarded on both the cancel and the backoff.
  assert.match(code("refresh_agency_staffing_rollup"), /IF v_canceled IS NULL AND v_backoff IS NULL THEN/);
});

// ---------------------------------------------------------------------------
// Behavioural — the clone, rolled back.
// ---------------------------------------------------------------------------

type Gate = {
  job: string;
  clear: boolean;
  reason: string;
  waited_s: number;
  wait_max_s: number;
  polls: number;
  readings: { thresholds: Record<string, unknown> };
};

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return null;
  }
  const fn = await c.query(
    "SELECT 1 FROM pg_proc WHERE proname = 'box_backoff_gate' AND pronamespace = 'public'::regnamespace",
  );
  if (fn.rowCount === 0) {
    await c.end();
    t.skip("20261003030000 not migrated on this DB");
    return null;
  }
  return c;
}

async function inTx(c: Client, fn: () => Promise<void>): Promise<void> {
  await c.query("BEGIN");
  try {
    await fn();
  } finally {
    await c.query("ROLLBACK");
  }
}

/** Seed box_health at the DB clock minus `ageS`, with overrides. */
async function stampAged(c: Client, ageS: number, extra: Record<string, unknown> = {}): Promise<void> {
  await c.query("DELETE FROM public.pipeline_state WHERE key = 'box_health'");
  await c.query(
    `INSERT INTO public.pipeline_state (key, value)
     VALUES ('box_health', jsonb_build_object('at', clock_timestamp() - make_interval(secs => $1::double precision)) || $2::jsonb)`,
    [ageS, JSON.stringify({
      startup_timeouts_10m: 0,
      startup_timeouts_60m: 0,
      watchdog_max_wall_10m: { budget: 0.016, unit: 0.004 },
      watchdog_runs_10m: { budget: 5, unit: 5 },
      ...extra,
    })],
  );
}

const gate = async (c: Client, wait = 0): Promise<Gate> =>
  (await c.query<{ g: Gate }>("SELECT public.box_backoff_gate('x', $1) AS g", [wait])).rows[0]!.g;

test("FIX-1194 P1-A: box_backoff_gate on the clone — stale / fork_failures / the wall ignored / clear", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    await inTx(c, async () => {
      await stampAged(c, 600);
      const g = await gate(c);
      assert.equal(g.clear, false, JSON.stringify(g));
      assert.equal(g.reason, "stale");
      assert.equal(g.waited_s, 0, "a zero wait answers at once");
      assert.equal(g.polls, 1);
      assert.equal(g.job, "x");
    });
    await inTx(c, async () => {
      await stampAged(c, 10, { startup_timeouts_10m: 3 });
      const g = await gate(c);
      assert.equal(g.clear, false);
      assert.equal(g.reason, "fork_failures");
    });
    // The wrong-but-green shape: a 5.0 s wall the DEFAULT reader calls
    // saturation. The gate must NOT stop on it.
    await inTx(c, async () => {
      await stampAged(c, 10, { watchdog_max_wall_10m: { budget: 5.0, unit: 0.004 } });
      const def = (await c.query<{ s: { reason: string } }>("SELECT public.box_is_saturated() AS s")).rows[0]!.s;
      assert.equal(def.reason, "watchdog_wall", "the default call still reads the wall");
      const g = await gate(c);
      assert.equal(g.clear, true, JSON.stringify(g));
      assert.equal(g.reason, "clear");
      assert.equal(g.readings.thresholds["watchdog_wall_considered"], false);
    });
    await inTx(c, async () => {
      await stampAged(c, 10);
      const g = await gate(c, 600);
      assert.equal(g.clear, true);
      assert.equal(g.waited_s, 0, "a clear box never waits, whatever the max");
      assert.equal(g.polls, 1);
    });
  } finally {
    await c.end();
  }
});

test("FIX-1194 P1-A: civitics.box_gate_wait_max_s overrides the argument — a saturated box waits it out, then answers", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    await inTx(c, async () => {
      await stampAged(c, 600);
      await c.query("SET LOCAL civitics.box_gate_wait_max_s = '1'");
      const t0 = Date.now();
      const g = await gate(c, 600);
      const ms = Date.now() - t0;
      assert.equal(g.clear, false);
      assert.equal(g.wait_max_s, 1, "the GUC, not the 600 s argument");
      assert.equal(g.waited_s, 1);
      assert.equal(g.polls, 2, "one poll, one sleep, one last poll");
      assert.ok(ms >= 950 && ms < 10_000, `waited ${ms} ms`);
    });
  } finally {
    await c.end();
  }
});
