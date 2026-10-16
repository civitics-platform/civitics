/**
 * FIX-1316 — M1: donor-rollup-refresh RETURNED as `stale_after 12 hours`, the
 * dispatcher's runid floor (I2) and re-arm cooldown (I6), and the 13:00Z start
 * window retired for the dispatched path (`*_fix1316_return_donor_rollup_refresh.sql`,
 * cc-234).
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-m1.test.ts
 *
 * dispatcher.test.ts reads only `*_fix1308_dispatcher.sql`, so it never sees a
 * later CREATE OR REPLACE and would keep passing vacuously. This file re-points
 * the design invariants at the M1 bodies and adds M1's own anchors (no DB, run
 * in CI; rule 105):
 *   - the invariants: SECURITY DEFINER + the cron search_path, no EXECUTE, the
 *     budget row before cron.schedule, paused → box → schedule, odd minutes not
 *     :15/:45, the reap's budget-row DELETEs, `at` rows never dispatched;
 *   - nothing else moved: an LCS line diff of each body against 20261015230000
 *     removes exactly the lines the hunks touch;
 *   - I2: the floor read at ARM, written on the row, bounding the reap CTE and
 *     the status LATERAL;
 *   - I6: the cooldown is the first exclusion, exponential, capped at 24 h,
 *     counts `reaped` rows only, and the dial is in the status JSON;
 *   - D-d as built: a wrapper procedure (no SET clause, not SECURITY DEFINER)
 *     sets the GUC session-scoped then CALLs the bulk; NO ALTER ROLE (it is not
 *     settable on Supabase — cc-234 read);
 *   - the row move, the hold-row conversion, the one-owner assertion, and the
 *     revert payload.
 * Behavioural, against the local clone when the migration is applied there:
 * get_dispatcher_status() carries the dial. Skips when unreachable or unmigrated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";
import { RE_PIPELINE_FROM_LOCAL, sqlRegexToJs } from "../lib/cron-job-pipelines";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Exactly one file per suffix. Lazy, so a missing file fails each test, not the load. */
function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const M1 = () => one("_fix1316_return_donor_rollup_refresh.sql");
const R2 = () => one("_fix1308_dispatcher.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1316-revert-donor-rollup-return.sql"));
/** dispatch_one_unit's added lines vs 20261015230000 (the hunks, nothing else). */
const ADDED_DISPATCH_LINES = 50;

/** One routine's definition: CREATE through its closing dollar-quote. */
function definition(src: string, name: string): string {
  const fn = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const i = fn >= 0 ? fn : src.indexOf(`CREATE OR REPLACE PROCEDURE public.${name}(`);
  assert.notEqual(i, -1, `${name} is defined`);
  const tag = /AS (\$[a-z_]*\$)\n/.exec(src.slice(i))!;
  const a = i + tag.index + tag[0].length;
  return src.slice(i, src.indexOf(tag[1]!, a));
}
const headerOf = (src: string, name: string) => definition(src, name).split(/\nAS \$/)[0] as string;
const rawBody = (src: string, name: string) => definition(src, name).split(/\nAS \$[a-z_]*\$\n/)[1] as string;
const bodyOf = (src: string, name: string) => stripComments(rawBody(src, name));

/** The old lines an LCS line diff removes, and the new lines it adds. */
function lineDiff(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) removed.push(a[i++] as string);
    else added.push(b[j++] as string);
  }
  while (i < n) removed.push(a[i++] as string);
  while (j < m) added.push(b[j++] as string);
  return { removed, added };
}

// ---------------------------------------------------------------------------
// The design invariants, re-pointed at the M1 bodies
// ---------------------------------------------------------------------------

test("invariant: both functions keep SECURITY DEFINER, the cron search_path, one SET clause, postgres ownership and the grants", () => {
  const src = M1();
  const code = stripComments(src);
  for (const name of ["dispatch_one_unit", "get_dispatcher_status"]) {
    const h = headerOf(src, name);
    assert.match(h, /\bSECURITY DEFINER\b/, name);
    assert.match(h, /SET search_path TO 'public', 'pg_catalog', 'cron'/, name);
    assert.equal((h.match(/^\s*SET /gm) ?? []).length, 1, `${name}: one SET clause, never statement_timeout`);
  }
  assert.match(headerOf(src, "dispatch_one_unit"), /CREATE OR REPLACE FUNCTION public\.dispatch_one_unit\(p_source text DEFAULT 'pg_cron'\)/);
  assert.match(headerOf(src, "dispatch_one_unit"), /\bVOLATILE\b/);
  assert.match(headerOf(src, "get_dispatcher_status"), /\bSTABLE\b/);
  assert.match(code, /ALTER FUNCTION public\.dispatch_one_unit\(text\) OWNER TO postgres;/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.dispatch_one_unit\(text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.dispatch_one_unit\(text\) TO service_role;/);
  assert.match(code, /ALTER FUNCTION public\.get_dispatcher_status\(\) OWNER TO postgres;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.get_dispatcher_status\(\) TO service_role;/);
  assert.doesNotMatch(code, /statement_timeout/, "check:proconfig — the migration carries no statement_timeout");
});

test("invariant: never EXECUTE inline; the budget row before cron.schedule; paused → box → schedule; odd minutes not :15/:45", () => {
  const b = bodyOf(M1(), "dispatch_one_unit");
  assert.doesNotMatch(b, /\bEXECUTE\b/, "the dispatcher never EXECUTEs a unit inline (C1)");
  const ins = b.indexOf("INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)");
  const sched = b.indexOf("v_armed_id := cron.schedule(v_armed_name, v_sched, v_pick_call);");
  assert.ok(ins > 0 && sched > ins, "budget INSERT precedes cron.schedule");
  const pause = b.indexOf("v_decision := 'paused';");
  const box = b.indexOf("public.box_is_saturated(p_include_watchdog_wall := false)");
  assert.ok(pause > 0 && box > pause && sched > box, "paused, then the box, then the arm");
  assert.match(b, /% 2 = 1/);
  assert.match(b, /NOT IN \(15, 45\)/);
  assert.match(b, /WHERE j\.runner = 'pg_cron'\s+AND j\.deadline_rule NOT LIKE 'at %'\s+AND j\.job <> c_tick_job/);
});

test("invariant: the terminal reap and the missed path DELETE the one-shot's budget row", () => {
  const b = bodyOf(M1(), "dispatch_one_unit");
  const reaped = b.indexOf("(v_source, r.job, 'reaped',");
  const missed = b.indexOf("(v_source, r.job, 'missed',");
  assert.ok(reaped > 0 && missed > reaped);
  const del = "DELETE FROM public.cron_job_budget WHERE jobname = r.armed_jobname;";
  const first = b.indexOf(del);
  assert.ok(first > 0 && first < reaped, "the terminal reap deletes the budget row before it logs");
  assert.ok(b.lastIndexOf(del, missed) > reaped, "the missed path deletes it too");
});

test("nothing else moved: each body's LCS diff against 20261015230000 removes only the hunk-touched lines", () => {
  const m1 = M1();
  const r2 = R2();
  const d = lineDiff(rawBody(r2, "dispatch_one_unit"), rawBody(m1, "dispatch_one_unit"));
  assert.deepEqual(d.removed.map((l) => l.trim()).sort(), [
    "IF r.job = ANY (v_live_jobs) THEN",
    "SELECT a.id, a.job, a.armed_jobid, a.armed_jobname, a.armed_for",
    "armed_jobid, armed_jobname, armed_for)",
    "v_armed_id, v_armed_name, v_armed_for)",
  ].sort());
  // The added side, pinned: the two declarations, the floor (read + error + row),
  // the reap's two lines, the four re-written lines and the cooldown block. A
  // change anywhere else in the body moves this number.
  assert.equal(d.added.length, ADDED_DISPATCH_LINES, d.added.join("\n"));
  assert.equal(d.added.filter((l) => /v_floor/.test(l)).length, 4, "the floor: declare, read, error, the row's value — nowhere else");
  // get_dispatcher_status: the live[] read moves its WHERE + NOT EXISTS into the
  // live CTE above the LATERAL (Craig, cc-234), and gains the floor + the dial.
  const g = lineDiff(rawBody(r2, "get_dispatcher_status"), rawBody(m1, "get_dispatcher_status"));
  assert.deepEqual(g.removed.map((l) => l.trim()), [
    "FROM public.dispatch_log a",
    "ORDER BY d.runid DESC LIMIT 1) rd ON true",
    "WHERE a.armed_jobid IS NOT NULL AND a.decision = 'armed'",
    "AND NOT EXISTS (SELECT 1 FROM public.dispatch_log x",
    "WHERE x.armed_jobid = a.armed_jobid",
    "AND x.decision IN ('reaped', 'missed'));",
  ]);
  assert.equal(g.added.length, 13, g.added.join("\n"));
});

test("I2: status live[] filters to the un-reaped armed rows BEFORE the LATERAL (it used to run for every armed row)", () => {
  const b = bodyOf(M1(), "get_dispatcher_status");
  const cte = b.indexOf("WITH live AS MATERIALIZED (");
  const lateral = b.indexOf("LEFT JOIN LATERAL (SELECT d.status FROM cron.job_run_details d");
  assert.ok(cte > 0 && lateral > cte);
  const live = b.slice(cte, b.indexOf("\n    )\n", cte));
  assert.match(live, /WHERE a\.armed_jobid IS NOT NULL AND a\.decision = 'armed'\s+AND NOT EXISTS \(SELECT 1 FROM public\.dispatch_log x\s+WHERE x\.armed_jobid = a\.armed_jobid\s+AND x\.decision IN \('reaped', 'missed'\)\)/);
  assert.match(live, /a\.runid_floor/);
  assert.match(b, /FROM live a\s+LEFT JOIN LATERAL/);
});

// ---------------------------------------------------------------------------
// I2 — the runid floor
// ---------------------------------------------------------------------------

test("I2: the arm reads max(runid) before cron.schedule and writes it on the row; an error writes none", () => {
  const b = bodyOf(M1(), "dispatch_one_unit");
  const floor = b.indexOf("v_floor := (SELECT COALESCE(max(runid), 0) FROM cron.job_run_details);");
  const sched = b.indexOf("v_armed_id := cron.schedule(v_armed_name, v_sched, v_pick_call);");
  assert.ok(floor > 0 && sched > floor, "the floor is read before the one-shot exists");
  assert.match(b, /armed_jobid, armed_jobname, armed_for, runid_floor\)\s+VALUES\s+\([^;]*v_armed_id, v_armed_name, v_armed_for, v_floor\)/);
  assert.match(b, /v_armed_for  := NULL;\s+v_floor      := NULL;/, "the error path logs no floor");
});

test("I2: the reap's runs CTE and the status LATERAL read above the floor", () => {
  const src = M1();
  const b = bodyOf(src, "dispatch_one_unit");
  assert.match(b, /SELECT a\.id, a\.job, a\.armed_jobid, a\.armed_jobname, a\.armed_for, a\.runid_floor\n/);
  assert.match(b, /WHERE d\.jobid = ANY \(ARRAY\(SELECT armed_jobid FROM armed\)\)\s+AND d\.runid > \(SELECT min\(COALESCE\(a\.runid_floor, 0\)\) FROM armed a\)/);
  assert.match(b, /ORDER BY d\.jobid, d\.runid DESC/, "DISTINCT ON (jobid) … runid DESC unchanged");
  assert.match(bodyOf(src, "get_dispatcher_status"), /WHERE d\.jobid = a\.armed_jobid\s+AND d\.runid > COALESCE\(a\.runid_floor, 0\)\s+ORDER BY d\.runid DESC LIMIT 1/);
});

test("I2/I6: the columns — runid_floor bigint; rearm_cooldown_seconds DEFAULT 1800, 0..86400; platform_dials altered first", () => {
  const code = stripComments(M1());
  assert.match(code, /ALTER TABLE public\.dispatch_log\s+ADD COLUMN IF NOT EXISTS runid_floor bigint;/);
  assert.match(code, /ALTER TABLE public\.platform_dials\s+ADD COLUMN IF NOT EXISTS rearm_cooldown_seconds int NOT NULL DEFAULT 1800\s+CHECK \(rearm_cooldown_seconds BETWEEN 0 AND 86400\);/);
  assert.ok(code.indexOf("ALTER TABLE public.platform_dials") < code.indexOf("ALTER TABLE public.dispatch_log"),
    "platform_dials before dispatch_log — the tick's lock order");
});

// ---------------------------------------------------------------------------
// I6 — the re-arm cooldown
// ---------------------------------------------------------------------------

test("I6: the cooldown is the first exclusion of a due row, before 'live', and names itself", () => {
  const b = bodyOf(M1(), "dispatch_one_unit");
  const due = b.indexOf("v_why := NULL;");
  const cd = b.indexOf("'cooldown: %s (%s non-advancing reap(s), last %L at %s; re-arm at %s)'");
  const live = b.indexOf("v_why := 'live';");
  assert.ok(due > 0 && cd > due && live > cd, "v_why := NULL → cooldown → 'live'");
  assert.match(b, /IF v_why IS NOT NULL THEN\s+NULL;\s+ELSIF r\.job = ANY \(v_live_jobs\) THEN\s+v_why := 'live';/,
    "a cooldown reason is never overwritten by the chain below it");
});

test("I6: exponential from the dial, capped at 24 h, off at 0; counts `reaped` rows after the last advancing completion only", () => {
  const b = bodyOf(M1(), "dispatch_one_unit");
  assert.match(b, /IF v_dials\.rearm_cooldown_seconds > 0 THEN/);
  assert.match(b, /LEAST\(v_dials\.rearm_cooldown_seconds \* 2 \^ LEAST\(v_cd_n - 1, 30\), 86400\)/);
  assert.match(b, /x\.decision = 'reaped'/);
  assert.doesNotMatch(b.slice(b.indexOf("IF v_dials.rearm_cooldown_seconds > 0 THEN"), b.indexOf("v_why := 'live';")), /'missed'/,
    "a missed row never counts");
  assert.match(b, /AND \(v_adv IS NULL OR x\.armed_for > v_adv\)/);
  assert.match(b, /AND \(r\.pipeline IS NOT NULL OR x\.reason NOT LIKE 'succeeded%'\)/, "a bare row's succeeded reap is its completion");
  assert.match(b, /l\.status IN \('complete', 'partial'\)/, "a pipeline's advance is the deadline's own v_last source");
});

test("I6: get_dispatcher_status() carries the dial", () => {
  assert.match(bodyOf(M1(), "get_dispatcher_status"), /'rearm_cooldown_seconds', v_dials\.rearm_cooldown_seconds,/);
});

// ---------------------------------------------------------------------------
// D-d as built — the wrapper, not a role GUC
// ---------------------------------------------------------------------------

test("D-d: the dispatched path is a non-atomic wrapper that sets the GUC session-scoped, then CALLs the bulk", () => {
  const src = M1();
  const h = headerOf(src, "donor_rollup_rebuild_bulk_dispatched");
  assert.match(h, /CREATE OR REPLACE PROCEDURE public\.donor_rollup_rebuild_bulk_dispatched\(\)/);
  assert.doesNotMatch(h, /\bSET\b/, "a SET clause would make the nested CALL atomic");
  assert.doesNotMatch(h, /SECURITY DEFINER/, "a DEFINER procedure cannot COMMIT");
  const b = bodyOf(src, "donor_rollup_rebuild_bulk_dispatched");
  const set = b.indexOf("PERFORM set_config('civitics.donor_rollup_latest_start_hour', '24', false);");
  const call = b.indexOf("CALL public.donor_rollup_rebuild_bulk();");
  assert.ok(set > 0 && call > set, "the GUC before the CALL, session-scoped (is_local false)");
  assert.match(b.slice(call), /PERFORM set_config\('civitics\.donor_rollup_latest_start_hour', COALESCE\(v_prev, ''\), false\);/);
  assert.match(stripComments(src), /ALTER PROCEDURE public\.donor_rollup_rebuild_bulk_dispatched\(\) OWNER TO postgres;/);
});

test("D-d: the one-level cron-job-pipelines reader maps the wrapper to its pipeline and reads it guarded", () => {
  const raw = rawBody(M1(), "donor_rollup_rebuild_bulk_dispatched");
  assert.equal(sqlRegexToJs(RE_PIPELINE_FROM_LOCAL).exec(stripComments(raw))?.[1], "donor_rollup_refresh");
  assert.match(raw, /prod_session_state/i);
});

test("D-d: no ALTER ROLE / ALTER DATABASE SET civitics.* — not settable by postgres on Supabase", () => {
  for (const code of [stripComments(M1()), stripComments(REVERT())]) {
    assert.doesNotMatch(code, /ALTER\s+(ROLE|DATABASE)\b[^;]*civitics\./i);
  }
});

// ---------------------------------------------------------------------------
// The row move, the hold row, one owner, the read-back
// ---------------------------------------------------------------------------

test("the row move: `at 0 9,12 * * *` → `stale_after 12 hours` + the wrapper's unit_call, guarded on the old rule", () => {
  const code = stripComments(M1());
  assert.match(code, /UPDATE public\.job_registry\s+SET deadline_rule = 'stale_after 12 hours',\s+unit_call\s+= 'CALL public\.donor_rollup_rebuild_bulk_dispatched\(\);',/);
  assert.match(code, /WHERE job = 'donor-rollup-refresh'\s+AND deadline_rule = 'at 0 9,12 \* \* \*';/);
  assert.match(code, /IF v_rule = 'stale_after 12 hours' THEN\s+RAISE NOTICE '\[fix1316\] job_registry donor-rollup-refresh already returned/);
});

test("the hold row is CONVERTED to a cadence_hours 12 declaration, only from the cutover hold", () => {
  const code = stripComments(M1());
  assert.match(code, /UPDATE public\.rollup_watch_overrides\s+SET held_since\s+= NULL,\s+hold_reason\s+= NULL,\s+cadence_hours = 12,/);
  assert.match(code, /AND hold_reason LIKE 'parked for the dispatcher cutover \(cc-232%';/);
  assert.match(code, /a human hold is resolved by a human/);
  assert.doesNotMatch(code, /DELETE FROM public\.rollup_watch_overrides/, "converted, never deleted");
});

test("one owner: the parked cron row is asserted inactive by NAME", () => {
  const code = stripComments(M1());
  assert.match(code, /SELECT jobid, active INTO v_jobid, v_active FROM cron\.job WHERE jobname = 'donor-rollup-refresh';/);
  assert.match(code, /IF v_active IS DISTINCT FROM false THEN\s+RAISE EXCEPTION/);
  assert.doesNotMatch(code, /cron\.alter_job|cron\.unschedule\('donor-rollup-refresh'\)/, "the migration never touches the cron row");
});

test("the read-back DO block RAISEs on a miss and knows the 20261015230000 md5s", () => {
  const code = stripComments(M1());
  assert.match(code, /RAISE EXCEPTION '\[fix1316\] read-back failed: %'/);
  assert.match(code, /'c253e5eeb65f1e1d269417e154fe5f16'/);
  assert.match(code, /'5e441fac0528b97d3aff84976cc34546'/);
});

test("the revert payload: the row back to `at`, the bulk's unit_call, the cutover hold — and no pause, no ALTER ROLE", () => {
  const code = stripComments(REVERT());
  assert.match(code, /SET deadline_rule = 'at 0 9,12 \* \* \*',\s+unit_call\s+= 'CALL public\.donor_rollup_rebuild_bulk\(\);',/);
  assert.match(code, /AND deadline_rule = 'stale_after 12 hours';/);
  assert.match(code, /SET held_since\s+= now\(\),\s+hold_reason\s+= 'parked for the dispatcher cutover \(cc-232, FIX-1311\); returns via job_registry',\s+cadence_hours = NULL,/);
  assert.doesNotMatch(code, /platform_dials/, "pause is set by hand, never by the payload");
  assert.match(read(path.join(ROOT, "scripts", "fix1311-unpark-derived-layer-crons.sql")),
    /valid ONLY after scripts\/fix1316-revert-donor-rollup-return\.sql has run/);
});

// ---------------------------------------------------------------------------
// Behavioural — the clone, when migrated
// ---------------------------------------------------------------------------

test("clone: get_dispatcher_status() carries dials.rearm_cooldown_seconds and the wrapper exists", async (t) => {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const col = await c.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_dials' AND column_name = 'rearm_cooldown_seconds'",
    );
    if (col.rowCount === 0) {
      t.skip("FIX-1316 not applied on this DB");
      return;
    }
    const s = (await c.query("SELECT public.get_dispatcher_status() AS s")).rows[0].s;
    assert.equal(typeof s.dials.rearm_cooldown_seconds, "number");
    const p = await c.query(
      "SELECT prokind, proconfig, prosecdef FROM pg_proc WHERE proname = 'donor_rollup_rebuild_bulk_dispatched' AND pronamespace = 'public'::regnamespace",
    );
    assert.equal(p.rowCount, 1);
    assert.equal(p.rows[0].prokind, "p");
    assert.equal(p.rows[0].proconfig, null);
    assert.equal(p.rows[0].prosecdef, false);
  } finally {
    await c.end();
  }
});
