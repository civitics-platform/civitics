/**
 * FIX-1358 (cc-252) — `*_fix1358_fe_vacuum_phase_lock_false.sql` and its revert
 * `scripts/fix1358-revert-fe-phase-lock.sql`: fe-vacuum-analyze's floor is a
 * fallback behind the fec phase's vacuum-tail, never a locked slot.
 *
 * Runs via:  tsx --test src/__tests__/fix1358-felock.test.ts
 *
 * Source anchors (no DB, run in CI):
 *   - the file touches exactly one row, by name, matched on phase_lock = true,
 *     and writes only phase_lock / note / updated_at — never phase_due_at,
 *     never deadline_rule;
 *   - the read-back: fe false, ec still true, both deadline_rules unchanged;
 *   - the premise the header states about phase_due_at holds in the live pick
 *     (20261027000000): it is read only under `r.phase_lock AND …`, v_locked
 *     resets per row, and an unlocked row's arm writes it NULL;
 *   - the revert sets the one row back to true, matched on false.
 * Behavioural (CIVITICS_CLONE_TESTS=1): the clone's row reads false.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const SUFFIX = "_fix1358_fe_vacuum_phase_lock_false.sql";
const PICK = "20261027000000_fix1354_box_gate_memory_rules.sql";
const REVERT = path.join(ROOT, "scripts", "fix1358-revert-fe-phase-lock.sql");
const LOCAL_URL =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const FILE = () => {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(SUFFIX));
  assert.equal(hits.length, 1, `expected exactly one *${SUFFIX}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
};

test("the file touches exactly one row by name, matched on phase_lock = true", () => {
  const sql = stripComments(FILE());
  assert.equal((sql.match(/\bUPDATE public\./g) ?? []).length, 1);
  // The note literal carries a `;`, so the statement is matched whole, quote-aware.
  const m = sql.match(/UPDATE public\.job_registry\s+SET phase_lock = false,\s+note\s+= note \|\| '(?:[^']|'')*',\s+updated_at = now\(\)\s+WHERE job = 'fe-vacuum-analyze'\s+AND phase_lock = true;/);
  assert.ok(m, "the one UPDATE, as written");
  const u = (m[0] as string).replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(u, /phase_due_at|deadline_rule|gates|cap_mb/, "one column moves");
  assert.ok(sql.includes("IF v_n = 1 THEN"));
  assert.ok(sql.includes("IF v_lock IS FALSE THEN"), "a re-apply NOTICEs");
  assert.match(sql, /RAISE EXCEPTION '\[fix1358\] fe-vacuum-analyze phase_lock reads %/);
  assert.doesNotMatch(sql, /\b(DELETE|INSERT)\b|cron\.(schedule|alter_job|unschedule)/);
});

test("the read-back: fe false, ec still true, both deadline_rules unchanged", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes("IF v_fe.phase_lock IS DISTINCT FROM false"));
  assert.ok(sql.includes("IF v_ec.phase_lock IS DISTINCT FROM true"));
  assert.equal((sql.match(/deadline_rule IS DISTINCT FROM 'dead_tuples > 60% of trigger \+ floor 24 hours'/g) ?? []).length, 2);
  assert.equal((sql.match(/RAISE EXCEPTION '\[fix1358\] read-back failed/g) ?? []).length, 2);
});

test("the live pick ignores phase_due_at when phase_lock is false, and an unlocked arm NULLs it", () => {
  const pick = read(path.join(MIGRATIONS, PICK));
  assert.ok(pick.includes("v_locked := false;"), "reset per row");
  assert.ok(pick.includes("IF r.phase_lock AND r.phase_due_at IS NOT NULL THEN"), "read only under the lock");
  assert.match(pick, /SET phase_due_at = CASE WHEN v_pick_lock AND v_pick_term IN \('stale_after', 'floor'\)\s+THEN v_now \+ v_pick_ttd END/);
  assert.match(pick, /v_pick_lock\s+:= r\.phase_lock;/);
});

test("the revert sets the one row back to true, matched on false", () => {
  const rv = read(REVERT);
  const code = stripComments(rv);
  assert.match(code, /UPDATE public\.job_registry\s+SET phase_lock = true, updated_at = now\(\)\s+WHERE job = 'fe-vacuum-analyze' AND phase_lock = false;/);
  assert.doesNotMatch(code, /phase_due_at\s*=/);
  assert.ok(rv.includes("--prod --call --yes-i-mean-prod --file scripts/fix1358-revert-fe-phase-lock.sql"));
});

test("clone: fe-vacuum-analyze reads phase_lock false, ec-vacuum-analyze true", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_URL });
  try {
    await c.connect();
  } catch {
    t.skip("local clone unreachable");
    return;
  }
  try {
    const rows = (await c.query<{ job: string; phase_lock: boolean; note: string }>(
      "SELECT job, phase_lock, note FROM public.job_registry WHERE job IN ('fe-vacuum-analyze', 'ec-vacuum-analyze')",
    )).rows;
    const fe = rows.find((r) => r.job === "fe-vacuum-analyze");
    if (!fe || !/FIX-1358/.test(fe.note)) {
      t.skip("FIX-1358 not applied on the clone");
      return;
    }
    assert.equal(fe.phase_lock, false);
    assert.equal(rows.find((r) => r.job === "ec-vacuum-analyze")?.phase_lock, true);
  } finally {
    await c.end();
  }
});
