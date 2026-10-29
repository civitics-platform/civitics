/**
 * FIX-1363 — RETURN refresh-derived-mvs-weekly as `by 47 0 * * 2` behind the
 * memory gate, on FIX-1361's per-cadence anchor. cc-253,
 * `*_fix1363_return_refresh_derived_mvs_weekly.sql`.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r6.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the file touches exactly the weekly's registry row, by name, matched on
 *     the exact old text; the pick's `by` parse reads it as a weekly slot;
 *   - the shared hold row is asserted, never converted or deleted: only its
 *     note is appended to, keeping the prefix FIX-1355's revert keys on;
 *   - one owner: both crons by NAME, no un-park;
 *   - the asserted dispatch_one_unit pin = md5 of FIX-1361's body (the
 *     rehearsal's), the other two unchanged;
 *   - the revert matches the new text and leaves the hold row alone.
 * The clone test (CIVITICS_CLONE_TESTS=1) reads the RETURNed row, the hold row
 * and jobid 10 after apply.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const WEEKLY = () => one("_fix1363_return_refresh_derived_mvs_weekly.sql");
const ANCHOR = () => one("_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1363-revert-return-refresh-derived-mvs-weekly.sql"));

function anchorPin(): string {
  const src = ANCHOR();
  const start = src.indexOf("CREATE OR REPLACE FUNCTION public.dispatch_one_unit(");
  const open = src.indexOf("AS $function$", start) + "AS $function$".length;
  const close = src.indexOf("$function$", open);
  return crypto.createHash("md5").update(src.slice(open, close), "utf8").digest("hex");
}

test("RETURN: exactly one rule write, the weekly's row by name, matched on at 47 0 * * 2", () => {
  const sql = stripComments(WEEKLY());
  const sets = [...sql.matchAll(/SET deadline_rule = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sets, ["by 47 0 * * 2"]);
  assert.match(sql, /WHERE job = 'refresh-derived-mvs-weekly'\s+AND deadline_rule = 'at 47 0 \* \* 2';/);
  assert.equal([...sql.matchAll(/UPDATE public\.job_registry/g)].length, 1, "one registry write");
  assert.ok(sql.includes("note || '; RETURNED 2026-10-28 (FIX-1363, cc-253): by 47 0 * * 2 = its cron slot'"));
  assert.ok(sql.includes("IF v_rule = 'by 47 0 * * 2' THEN"), "already returned → NOTICE");
  assert.doesNotMatch(sql, /anchor_cadence\s*=\s*'weekly',|SET anchor_cadence/, "FIX-1361 set the anchor; this file only asserts it");
  // The pick's parse (N2, 20261023000000): substring FROM '^by\s+(.+)$' → cron_prev_slot's weekly form M H * * D.
  const slot = /^by\s+(.+)$/.exec("by 47 0 * * 2")?.[1];
  assert.equal(slot, "47 0 * * 2");
  assert.match(slot!, /^\d+ \d+ \* \* \d$/, "a weekly M H * * D slot (D-d, FIX-1329)");
});

test("the hold row: asserted as FIX-1355's cadence row; only the note appended; never converted or deleted", () => {
  const sql = stripComments(WEEKLY());
  assert.doesNotMatch(sql, /SET\s+held_since|cadence_hours\s*=\s*\d+,|hold_reason\s*=\s*(NULL|')/, "no hold conversion");
  assert.doesNotMatch(sql, /DELETE FROM/i, "rule 289: never DELETE");
  assert.match(sql, /UPDATE public\.rollup_watch_overrides\s+SET note\s+= note \|\| '; weekly RETURNED 2026-10-28 \(FIX-1363\)',/);
  assert.match(sql, /AND note LIKE 'FIX-1355 \(cc-251\)%'\s+AND note NOT LIKE '%weekly RETURNED 2026-10-28 \(FIX-1363\)%';/, "idempotent");
  assert.ok(sql.includes("v_row.cadence_hours IS DISTINCT FROM 24"), "the cadence row asserted");
  assert.ok(sql.includes("a human hold is resolved by a human"));
});

test("the hold row's guard admits the gated push's OWN session hold, spelled as prod-session.ts writes it", async () => {
  // cc-253's first push refused here: setGuardedHolds() holds every guarded pipeline
  // for the claim (held_since now(), hold_reason SESSION_HOLD_PREFIX + reason), so a
  // "held_since IS NULL" assertion can never pass inside session:wait-for-gate.
  const { SESSION_HOLD_PREFIX } = await import("../lib/prod-session");
  assert.equal(SESSION_HOLD_PREFIX, "prod session held: ");
  const sql = stripComments(WEEKLY());
  const accepts = `hold_reason LIKE '${SESSION_HOLD_PREFIX}%'`;
  assert.equal(sql.split(accepts).length - 1, 2, "the guard and the read-back both accept it");
  assert.match(sql, /ELSIF NOT \(\(v_row\.held_since IS NULL AND v_row\.hold_reason IS NULL\)\s+OR v_row\.hold_reason LIKE 'prod session held: %'\)/);
  assert.doesNotMatch(sql, /held_since IS NOT NULL OR v_row\.hold_reason IS NOT NULL/, "the refusing form is gone");
});

test("clone: the file applies UNDER a session hold (the gate's shape), from the un-RETURNed row, inside a rolled-back transaction", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  try {
    await c.query("BEGIN");
    try {
      await c.query(read(path.join(ROOT, "scripts", "fix1363-revert-return-refresh-derived-mvs-weekly.sql")));
      await c.query(
        `UPDATE public.rollup_watch_overrides SET held_since = now(), hold_reason = 'prod session held: cc-253 clone test'
          WHERE pipeline = 'refresh_derived_mvs' AND held_since IS NULL`,
      );
      await c.query(WEEKLY());
      const reg = (await c.query("SELECT deadline_rule FROM public.job_registry WHERE job = 'refresh-derived-mvs-weekly'")).rows[0];
      assert.equal(reg.deadline_rule, "by 47 0 * * 2");
      const hold = (await c.query("SELECT hold_reason FROM public.rollup_watch_overrides WHERE pipeline = 'refresh_derived_mvs'")).rows[0];
      assert.equal(hold.hold_reason, "prod session held: cc-253 clone test", "the file never touches the session's hold");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("one owner: both crons by NAME, inactive; no un-park, no dial", () => {
  const sql = stripComments(WEEKLY());
  assert.ok(sql.includes("SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'refresh-derived-mvs-weekly';"));
  assert.ok(sql.includes("IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-derived-mvs-daily' AND active) THEN"));
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/);
  assert.doesNotMatch(sql, /UPDATE public\.platform_dials/);
  assert.doesNotMatch(sql, /jobid\s*=\s*10\b/, "by name, never by jobid (FIX-946)");
});

test("the read-back: every other column unchanged (cap 128, anchor weekly) and the pins = the rehearsal's", () => {
  const sql = stripComments(WEEKLY());
  assert.ok(sql.includes("AND priority = 3 AND cost_class = 'mixed' AND cap_mb = 128 AND exclusion_group = 'mvs'"));
  assert.ok(sql.includes("AND budget_seconds = 5400 AND gates = '{prod_session}' AND NOT phase_lock"));
  assert.ok(sql.includes("AND by_window_minutes IS NULL AND yield_to = '{}' AND NOT idempotent_refire"));
  assert.ok(sql.includes("AND anchor_cadence = 'weekly';"));
  assert.ok(sql.includes("unit_call = 'CALL public.refresh_derived_mvs(''weekly'');'"));
  assert.ok(WEEKLY().includes(`c_pin_d CONSTANT text := '${anchorPin()}'`), "the asserted pin is FIX-1361's body");
  assert.ok(sql.includes("'ac8dbcddf71978e73d28c999433156b7'") && sql.includes("'4c30523742e280a4b48ea2ec390654d6'"));
  assert.match(sql, /RAISE EXCEPTION '\[fix1363\] read-back failed: %'/);
  assert.ok(sql.includes("v_prev := public.cron_prev_slot('47 0 * * 2', now());"), "the pick's arithmetic, printed");
  assert.ok(sql.includes("AND metadata->>'cadence' = 'weekly'"), "the NOTICE reads the anchor the way step 6 now does");
  assert.ok(sql.includes("WHEN v_avail - 128 < v_head THEN"), "the 128-cap headroom reading");
});

test("the revert matches the new text, touches only the rule, and leaves the hold row and the cron alone", () => {
  const sql = stripComments(REVERT());
  assert.match(sql, /SET deadline_rule = 'at 47 0 \* \* 2'/);
  assert.match(sql, /WHERE job = 'refresh-derived-mvs-weekly'\s+AND deadline_rule = 'by 47 0 \* \* 2';/);
  assert.doesNotMatch(sql, /rollup_watch_overrides/, "the hold row is the daily's cadence row");
  assert.doesNotMatch(sql, /anchor_cadence/);
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/);
  assert.doesNotMatch(sql, /platform_dials/);
});

test("clone: the RETURNed row, the hold row's note, jobid 10 parked", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  try {
    const reg = (await c.query(
      "SELECT deadline_rule, anchor_cadence, cap_mb, priority, exclusion_group, gates FROM public.job_registry WHERE job = 'refresh-derived-mvs-weekly'",
    )).rows[0];
    assert.equal(reg.deadline_rule, "by 47 0 * * 2");
    assert.equal(reg.anchor_cadence, "weekly");
    assert.equal(reg.cap_mb, 128);
    assert.equal(reg.priority, 3);
    assert.equal(reg.exclusion_group, "mvs");
    assert.deepEqual(reg.gates, ["prod_session"]);
    const hold = (await c.query(
      "SELECT held_since, cadence_hours, note FROM public.rollup_watch_overrides WHERE pipeline = 'refresh_derived_mvs'",
    )).rows[0];
    assert.equal(hold.held_since, null);
    assert.equal(Number(hold.cadence_hours), 24);
    assert.match(hold.note, /^FIX-1355 \(cc-251\)/);
    assert.match(hold.note, /weekly RETURNED 2026-10-28 \(FIX-1363\)$/);
    const cron = (await c.query("SELECT active FROM cron.job WHERE jobname = 'refresh-derived-mvs-weekly'")).rows;
    assert.equal(cron.length, 1);
    assert.equal(cron[0].active, false);
  } finally {
    await c.end();
  }
});
