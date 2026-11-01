/**
 * FIX-1371 — contract-flow-rollups-refresh RETURNed as `by 0 14 * * 4`, the
 * last parked weekly. cc-257, `20261101000000_fix1371_…`.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r10.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the file touches exactly its one registry row, by name, matched on the
 *     exact old text; the RETURN note carries the UTC date of the apply;
 *   - it writes no pipeline_state, defines no routine, touches no cron write,
 *     no dial, and leaves by_window_minutes alone;
 *   - the FIX-1311 hold row is asserted, never converted or deleted: only its
 *     note is appended to; the guard admits the gated push's own hold;
 *   - the read-back pins every other column, one row on the pipeline, and the
 *     current four bodies (dispatch_one_unit = the md5 of FIX-1361's body);
 *   - the body (FIX-1295 M3, the md5 prod runs, cc-257 read 4): the START gate,
 *     the 64MB SET, ONE query_canceled sub-block whose cancel path RETURNs (so
 *     the reap reads `succeeded`) and whose error path RAISEs;
 *   - the I6 ladder counts every reap of a pipeline row after its last
 *     complete|partial, whatever the reap's text;
 *   - the revert matches the new text and touches only the rule.
 * Clone tests (CIVITICS_CLONE_TESTS=1): the file applies from the un-RETURNed
 * row (and under a session hold), twice; RAISEs on a human hold, a second
 * registry row on the pipeline; the live body pins the same md5 and carries
 * its constants; one manual tick at MemAvailable 450 arms contract-flow, and a
 * second with refresh-derived-mvs-daily DUE reads `group busy: mvs` beside
 * `live`; a seeded non-advancing reap puts the row in the I6 cooldown at
 * reap + 1800 s, and two at the newest + 3600 s.
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

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
function prosrc(src: string, sig: string, quote: string): string {
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `not found: ${sig}`);
  const open = src.indexOf(`AS ${quote}`, start) + `AS ${quote}`.length;
  return src.slice(open, src.indexOf(quote, open));
}
const ANCHOR = () => one("_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql");
const anchorBody = () => prosrc(ANCHOR(), "CREATE OR REPLACE FUNCTION public.dispatch_one_unit(", "$function$");

const JOB = "contract-flow-rollups-refresh";
const PIPELINE = "contract_flow_rollups_rebuild";
const SLOT = "0 14 * * 4";
const FILE = () => one("_fix1371_return_contract_flow_rollups_refresh.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1371-revert-return-contract-flow-rollups-refresh.sql"));

/** The live body (cc-257 read 4: prod = clone), last CREATEd by FIX-1295 M3. */
const BODY = {
  md5: "c699dc7d6acf1cf35a3164b71ec0a3aa",
  src: () => prosrc(one("_fix1295_work_mem_m3.sql"), "CREATE OR REPLACE PROCEDURE public.refresh_contract_flow_rollups()", "$procedure$"),
  name: "refresh_contract_flow_rollups",
} as const;

const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("FIX-1371 RETURN: exactly one rule write, contract-flow-rollups-refresh by name, matched on at 0 14 * * 4", () => {
  const sql = stripComments(FILE());
  const sets = [...sql.matchAll(/SET deadline_rule = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sets, [`by ${SLOT}`]);
  assert.match(sql, new RegExp(`WHERE job = '${re(JOB)}'\\s+AND deadline_rule = 'at ${re(SLOT)}';`));
  assert.equal([...sql.matchAll(/UPDATE public\.job_registry/g)].length, 1, "one registry write");
  assert.ok(sql.includes("v_day     text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');"), "the UTC date, not a literal (cc-256 contradiction 5)");
  assert.ok(sql.includes(`note || '; RETURNED ' || v_day || ' (FIX-1371, cc-257): by ${SLOT} = its cron slot'`));
  assert.doesNotMatch(sql, /RETURNED 20\d\d-\d\d-\d\d/, "no literal date anywhere");
  assert.ok(sql.includes(`IF v_rule = 'by ${SLOT}' THEN`), "already returned → NOTICE");
  assert.doesNotMatch(sql, /SET anchor_cadence|anchor_cadence\s*=\s*'/, "its own pipeline: no anchor_cadence (rule 378)");
  for (const other of ["refresh-derived-mvs-daily", "refresh-derived-mvs-weekly"]) {
    assert.ok(!sql.includes(`'${other}'`), `never names ${other}`);
  }
});

test("FIX-1371: no pipeline_state write, no routine, no cron write, no dial, by_window_minutes untouched", () => {
  const sql = stripComments(FILE());
  assert.doesNotMatch(sql, /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.pipeline_state/i, "no pipeline_state write");
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i, "no routine");
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/);
  assert.doesNotMatch(sql, /UPDATE public\.platform_dials/);
  assert.doesNotMatch(sql, /jobid\s*=\s*\d+/, "by name, never by jobid (FIX-946)");
  assert.doesNotMatch(sql, /SET\s+[^;]*by_window_minutes\s*=/, "by_window_minutes is Craig's dial, not written (rule 391)");
  assert.ok(sql.includes("AND by_window_minutes IS NULL"), "the read-back asserts it stays NULL");
});

test("FIX-1371: the hold row is asserted as FIX-1311's takeover hold (or the push's own); only the note appended", async () => {
  const { SESSION_HOLD_PREFIX } = await import("../lib/prod-session");
  assert.equal(SESSION_HOLD_PREFIX, "prod session held: ");
  const sql = stripComments(FILE());
  assert.doesNotMatch(sql, /SET\s+held_since|cadence_hours\s*=\s*\d+|hold_reason\s*=\s*(NULL|')|retired_at\s*=/, "no hold conversion");
  assert.doesNotMatch(sql, /DELETE FROM/i, "rule 289: never DELETE");
  assert.ok(sql.includes(`FROM public.rollup_watch_overrides WHERE pipeline = '${PIPELINE}';`));
  assert.match(sql, /v_row\.hold_reason LIKE 'parked for the dispatcher cutover%'/);
  assert.match(sql, /v_row\.cadence_hours IS NULL/);
  assert.match(sql, /v_row\.note LIKE 'FIX-1311 \(cc-232\)%'/);
  assert.ok(sql.includes(`OR v_row.hold_reason LIKE '${SESSION_HOLD_PREFIX}%'`), "the gate's own hold is admitted, not refused");
  assert.ok(
    sql.includes(`SET note       = note || '; ${JOB} RETURNED ' || v_day || ' (FIX-1371) — hold kept, conversion to cadence_hours 168 owed after the Thu 11-05 slot'`),
    "the note, appended",
  );
  assert.ok(sql.includes(`AND note NOT LIKE '%${JOB} RETURNED % (FIX-1371)%';`), "idempotent across a UTC midnight");
  assert.ok(sql.includes("a human hold is resolved by a human"));
});

test("FIX-1371: one owner — cron contract-flow-rollups-refresh by NAME, inactive, exactly one row", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes(`SELECT count(*) INTO v_n FROM cron.job WHERE jobname = '${JOB}';`));
  assert.ok(sql.includes(`SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = '${JOB}';`));
});

test("FIX-1371 read-back: every other column unchanged, one row on the pipeline, the four pins current", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes(`WHERE job = '${JOB}' AND runner = 'pg_cron' AND pipeline = '${PIPELINE}'`));
  assert.ok(sql.includes("AND unit_shape = 'atomic' AND unit_call = 'CALL public.refresh_contract_flow_rollups();'"));
  assert.ok(sql.includes("AND priority = 3 AND cost_class = 'memory' AND cap_mb = 64 AND exclusion_group = 'mvs'"));
  assert.ok(sql.includes("AND budget_seconds = 9000 AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL"));
  assert.ok(sql.includes("AND by_window_minutes IS NULL AND yield_to = '{}' AND yield_lead_seconds = 0 AND NOT idempotent_refire"));
  assert.ok(sql.includes("AND anchor_cadence IS NULL"));
  assert.ok(sql.includes(`SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = '${PIPELINE}';`), "rule 378");
  assert.ok(FILE().includes(`c_pin_d CONSTANT text := '${md5(anchorBody())}'`), "the asserted pin is FIX-1361's body");
  assert.equal(md5(anchorBody()), "d6a9073bcc4d9084b9d7994324a89b18");
  for (const pin of ["ac8dbcddf71978e73d28c999433156b7", "4c30523742e280a4b48ea2ec390654d6", "1d3507cd4b71439f0cfff51cde49b9d8"]) {
    assert.ok(sql.includes(`'${pin}'`), pin);
  }
  assert.ok(sql.includes("RAISE EXCEPTION '[fix1371] read-back failed: %'"));
  assert.ok(sql.includes(`v_prev := public.cron_prev_slot('${SLOT}', now());`), "the pick's arithmetic, printed");
  assert.ok(sql.includes("WHEN v_avail - 64 < v_head THEN"), "the 64-cap headroom reading");
  assert.ok(sql.includes("to_regclass('public.financial_relationships_contract_grant_updated_at')"), "the FIX-1118 index, by name");
  assert.ok(sql.includes("v_cool, v_cool, v_cool * 2, v_cool * 4"), "the ladder's first three offsets, from the dial");
});

test("the body (c699dc7d, FIX-1295 M3): the START gate, 64MB, ONE query_canceled sub-block; a cancel RETURNs, an error RAISEs", () => {
  const b = BODY.src();
  assert.equal(md5(b), BODY.md5, "the last CREATE of the body is the one prod runs");
  assert.ok(b.includes("v_gate := public.box_backoff_gate('contract-flow-rollups-refresh', 1800);"), "its own START gate, before the lock");
  assert.ok(b.indexOf("box_backoff_gate(") < b.indexOf("pg_try_advisory_lock(c_lock_key)"));
  assert.ok(b.includes("SET work_mem = '64MB';") && b.includes("SET max_parallel_workers_per_gather = 0;"), "= cap_mb 64");
  assert.equal(b.split("WHEN query_canceled THEN").length - 1, 1, "ONE sub-block");
  assert.ok(b.indexOf("COMMIT;") < b.indexOf("v_stage := 'contract_recipient_rollup';"), "the running row COMMITs first (FIX-1194 P1-A)");
  assert.ok(b.includes("DELETE FROM public.contract_recipient_rollup;") && b.includes("DELETE FROM public.contract_agency_sector_rollup;"));
  assert.ok(b.indexOf("DELETE FROM public.contract_agency_sector_rollup;") < b.indexOf("WHEN query_canceled THEN"), "both tables inside the sub-block");
  assert.match(b, /'canceled', v_canceled IS NOT NULL,\s+'cancel_detail', v_canceled,\s+'stage_in_flight', v_stage,\s+'elapsed_seconds'/);
  // cc-257: a budget cancel is CAUGHT — the row closes `failed`, the CALL returns, the one-shot reads `succeeded`.
  assert.match(
    b,
    /IF v_failed IS NOT NULL THEN\s+-- An error still fails the job in cron\.job_run_details, as it did before\.\s+RAISE EXCEPTION '\[contract-flow rollups\] %', v_failed USING ERRCODE = v_sqlstate;\s+END IF;\s+RETURN;/,
    "only an error RAISEs; a cancel RETURNs",
  );
  const file = stripComments(FILE());
  assert.ok(file.includes(`c_body  CONSTANT text := '${BODY.md5}';`), "the NOTICE says whether the body is still the one its premise reads");
  assert.ok(file.includes("box_backoff_gate(''contract-flow-rollups-refresh'', 1800)"));
  assert.ok(file.includes("SET work_mem = ''64MB'';"));
});

test("I6 (FIX-1316): a pipeline row's ladder counts EVERY reap armed after its last complete|partial — a cancel's `succeeded` too", () => {
  const b = anchorBody();
  assert.match(
    b,
    /v_adv := CASE WHEN r\.pipeline IS NOT NULL\s+THEN COALESCE\(v_last,\s+\(SELECT max\(l\.completed_at\) FROM public\.data_sync_log l\s+WHERE l\.pipeline = r\.pipeline AND l\.status IN \('complete', 'partial'\)\)\)/,
  );
  assert.ok(b.includes("AND (v_adv IS NULL OR x.armed_for > v_adv)"));
  assert.ok(b.includes("AND (r.pipeline IS NOT NULL OR x.reason NOT LIKE 'succeeded%');"), "a pipeline row counts a succeeded reap");
  assert.ok(b.includes("LEAST(v_dials.rearm_cooldown_seconds * 2 ^ LEAST(v_cd_n - 1, 30), 86400)"), "1800 × 2^(n−1), 24 h cap");
});

test("FIX-1371 revert: matches the new text, touches only the rule, never un-parks", () => {
  const sql = stripComments(REVERT());
  assert.ok(sql.includes(`SET deadline_rule = 'at ${SLOT}'`));
  assert.match(sql, new RegExp(`WHERE job = '${re(JOB)}'\\s+AND deadline_rule = 'by ${re(SLOT)}';`));
  assert.doesNotMatch(sql, /pipeline_state/, "no dial was written");
  assert.doesNotMatch(sql, /UPDATE public\.rollup_watch_overrides/, "the hold note stays");
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/, "the cron stays parked");
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});

test("the file sorts after the rollups chain's, nothing between", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = all.indexOf("20261101000000_fix1371_return_contract_flow_rollups_refresh.sql");
  assert.ok(at > 0);
  assert.equal(all[at - 1], "20261031002000_fix1370_return_group_donor_rollup_refresh.sql");
});

// ---------------------------------------------------------------------------
// Behavioural — the clone (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  return c;
}

/** BEGIN, then the registry's table lock FIRST (r9's lesson, cc-256 contradiction 8: 40P01 on job_registry). */
async function begin(c: Client): Promise<void> {
  await c.query("BEGIN");
  await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
}

/** Apply the file inside the caller's transaction, from the un-RETURNed row. */
async function applyFresh(c: Client): Promise<void> {
  await c.query(REVERT());
  await c.query(FILE());
}

test("clone: the file applies from the un-RETURNed row, twice; the hold stays a hold, its note appended once", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await applyFresh(c);
      await c.query(FILE()); // idempotent: a second run NOTICEs and changes nothing
      const reg: { deadline_rule: string; by_window_minutes: number | null; note: string } = (await c.query(
        "SELECT deadline_rule, by_window_minutes, note FROM public.job_registry WHERE job = $1",
        [JOB],
      )).rows[0];
      assert.equal(reg.deadline_rule, `by ${SLOT}`);
      assert.equal(reg.by_window_minutes, null, "by_window_minutes stays NULL");
      assert.match(reg.note, /; RETURNED \d{4}-\d{2}-\d{2} \(FIX-1371, cc-257\): by 0 14 \* \* 4 = its cron slot/);
      const hold: { held_since: Date | null; cadence_hours: number | null; retired_at: Date | null; note: string } = (await c.query(
        "SELECT held_since, cadence_hours, retired_at, note FROM public.rollup_watch_overrides WHERE pipeline = $1",
        [PIPELINE],
      )).rows[0];
      assert.notEqual(hold.held_since, null, "still a hold");
      assert.equal(hold.cadence_hours, null, "not converted");
      assert.equal(hold.retired_at, null);
      assert.match(hold.note, /^FIX-1311 \(cc-232\)/);
      assert.equal(hold.note.split("(FIX-1371)").length - 1, 1, "the hold note is appended once");
      const cron: { active: boolean }[] = (await c.query("SELECT active FROM cron.job WHERE jobname = $1", [JOB])).rows;
      assert.deepEqual(cron, [{ active: false }], "parked, by name");
      const state: { n: number } = (await c.query(
        "SELECT count(*)::int AS n FROM public.pipeline_state WHERE key = 'contract_flow_rollups_state' AND updated_at >= now()",
      )).rows[0];
      assert.equal(state.n, 0, "no pipeline_state write");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the file applies under the gate's own session hold; RAISEs on a human hold or a second row on its pipeline", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const attempt = async (setup: string, params: unknown[] = []): Promise<string | null> => {
    await begin(c);
    try {
      await c.query(REVERT());
      await c.query(setup, params);
      await c.query(FILE());
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await c.query("ROLLBACK");
    }
  };
  try {
    assert.equal(
      await attempt(
        `UPDATE public.rollup_watch_overrides SET hold_reason = 'prod session held: cc-257 clone test', held_since = now()
          WHERE pipeline = $1`,
        [PIPELINE],
      ),
      null,
      "the session's own hold is admitted",
    );
    assert.match(
      (await attempt("UPDATE public.rollup_watch_overrides SET hold_reason = 'Craig: hands off' WHERE pipeline = $1", [PIPELINE])) ?? "",
      /\[fix1371\] contract_flow_rollups_rebuild override is not FIX-1311's takeover hold/,
    );
    assert.match(
      (await attempt(
        `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, note)
         SELECT job || '-sibling', runner, pipeline, unit_shape, unit_call, priority, 'at 0 0 1 1 *', cost_class, cap_mb, exclusion_group, budget_seconds, gates, 'cc-257 clone test'
           FROM public.job_registry WHERE job = $1`,
        [JOB],
      )) ?? "",
      /\[fix1371\] read-back failed: .*2 registry rows on contract_flow_rollups_rebuild/,
    );
  } finally {
    await c.end();
  }
});

test("clone: the live body is prod's, with its constants in text", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    const live: { m: string; src: string; cfg: string[] | null } = (await c.query(
      "SELECT md5(prosrc) AS m, prosrc AS src, proconfig AS cfg FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace",
      [BODY.name],
    )).rows[0];
    assert.equal(live.m, BODY.md5, "the clone runs prod's body (text tests pin its lines)");
    assert.equal(live.cfg, null, "proconfig NULL: the 64MB is in-body");
    assert.ok(live.src.includes("box_backoff_gate('contract-flow-rollups-refresh', 1800)"));
    assert.ok(live.src.includes("SET work_mem = '64MB';"));
    assert.equal(live.src.split("WHEN query_canceled THEN").length - 1, 1, "ONE query_canceled sub-block");
  } finally {
    await c.end();
  }
});

const MB = 1048576;
const SWAP_TOTAL = 1073737728;

/** The tick fixture: every other dispatched row parked, the box fresh at MemAvailable 450, contract-flow DUE. */
async function tickFixture(c: Client, cooldownSeconds: number): Promise<void> {
  await applyFresh(c);
  await c.query("UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job <> $1", [JOB]);
  await c.query(
    "UPDATE public.platform_dials SET pause = false, max_concurrent_units = 10, max_live_caps_mb = 100000, rearm_cooldown_seconds = $1",
    [cooldownSeconds],
  );
  await c.query("DELETE FROM public.pipeline_state WHERE key = 'prod_session'");
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', 0,
                                              'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  );
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health_mem', jsonb_build_object('at', clock_timestamp(),
                                                  'mem_total_bytes', 948191232, 'mem_available_bytes', $1::bigint,
                                                  'swap_total_bytes', $2::bigint, 'swap_free_bytes', $3::bigint, 'load1', 0.1), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [450 * MB, SWAP_TOTAL, SWAP_TOTAL - 490 * MB],
  );
  // Its last advancing run before this week's slot (prod: 10-08), and nothing of group mvs running.
  await c.query(
    "DELETE FROM public.data_sync_log WHERE pipeline = $1 AND (completed_at >= public.cron_prev_slot($2, now()) OR status = 'running')",
    [PIPELINE, SLOT],
  );
  await c.query(
    `DELETE FROM public.data_sync_log WHERE status = 'running'
       AND pipeline IN (SELECT pipeline FROM public.job_registry WHERE exclusion_group = 'mvs' AND pipeline IS NOT NULL)`,
  );
  // No reap of this job on the clone counts until a test seeds one.
  await c.query("DELETE FROM public.dispatch_log WHERE job = $1 AND decision IN ('armed', 'reaped', 'missed')", [JOB]);
}

async function lastTick(c: Client): Promise<{ decision: string; job: string; reason: string; excluded: string[] | null }> {
  return (await c.query("SELECT decision, job, reason, excluded FROM public.dispatch_log ORDER BY id DESC LIMIT 1")).rows[0];
}

test("clone: tick 1 arms contract-flow at MemAvailable 450; tick 2 with refresh-derived-mvs-daily DUE reads group busy: mvs beside live", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await tickFixture(c, 0);
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const t1 = await lastTick(c);
      assert.equal(t1.decision, "armed", JSON.stringify(t1));
      assert.equal(t1.job, JOB);
      assert.match(t1.reason, new RegExp(`^by ${re(SLOT)} → -`), "DUE: ttd negative, since its prev slot");
      const armed: { n: number } = (await c.query(
        "SELECT count(*)::int AS n FROM public.dispatch_log WHERE job = $1 AND decision = 'armed' AND armed_jobname LIKE 'disp-contract-flow-rollups-refresh-%'",
        [JOB],
      )).rows[0];
      assert.equal(armed.n, 1, "a disp- one-shot");

      // The daily comes due (its own cron slot, priority 2) while contract-flow's one-shot is armed.
      await c.query("UPDATE public.job_registry SET deadline_rule = 'by 0 6 * * *' WHERE job = 'refresh-derived-mvs-daily'");
      await c.query(
        "DELETE FROM public.data_sync_log WHERE pipeline = 'refresh_derived_mvs' AND (completed_at >= public.cron_prev_slot('0 6 * * *', now()) OR status = 'running')",
      );
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const t2 = await lastTick(c);
      assert.equal(t2.decision, "nothing_due", JSON.stringify(t2));
      const ex = t2.excluded ?? [];
      assert.ok(ex.includes(`live (${JOB})`), JSON.stringify(ex));
      assert.ok(ex.includes("group busy: mvs (refresh-derived-mvs-daily)"), JSON.stringify(ex));
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the I6 ladder — one non-advancing reap → cooldown until reap + 1800 s; two → the newest + 3600 s; either reap text counts", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await tickFixture(c, 1800);
      const adv: { at: Date | null } = (await c.query(
        "SELECT max(completed_at) AS at FROM public.data_sync_log WHERE pipeline = $1 AND status IN ('complete', 'partial')",
        [PIPELINE],
      )).rows[0];
      // A failed reap (an error) 10 min ago, armed 20 min ago — after the pipeline's newest complete.
      const seed = async (reason: string, armedAgo: string, reapedAgo: string, n: number): Promise<Date> =>
        (await c.query(
          `INSERT INTO public.dispatch_log (source, job, decision, reason, armed_jobid, armed_jobname, armed_for, ticked_at)
           VALUES ('manual', $1, 'reaped', $2, $3::bigint, 'disp-contract-flow-rollups-refresh-' || $3::bigint, now() - $4::interval, now() - $5::interval)
           RETURNING ticked_at`,
          [JOB, reason, 900000000 + n, armedAgo, reapedAgo],
        )).rows[0].ticked_at;
      const at1 = await seed("failed: CALL ERROR: [contract-flow rollups] contract_recipient_rollup: …", "20 minutes", "10 minutes", 1);
      assert.ok(adv.at === null || at1 > adv.at);
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const t1 = await lastTick(c);
      assert.equal(t1.decision, "nothing_due", JSON.stringify(t1));
      const until1 = (await c.query("SELECT date_trunc('second', $1::timestamptz + interval '1800 seconds') AS u", [at1])).rows[0].u as Date;
      const cd1 = (t1.excluded ?? []).find((e) => e.startsWith(`cooldown: ${JOB} (1 non-advancing reap(s), last 'failed: CALL`));
      assert.ok(cd1, JSON.stringify(t1.excluded));
      const iso = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
      assert.ok(cd1!.includes(`re-arm at ${iso(until1)}`), `${cd1} vs ${iso(until1)}`);
      assert.ok(cd1!.endsWith(`(${JOB})`));

      // A budget cancel: the body catches it and RETURNs, so the reap reads `succeeded` — a pipeline row still counts it.
      const at2 = await seed("succeeded: CALL", "8 minutes", "2 minutes", 2);
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const t2 = await lastTick(c);
      const until2 = (await c.query("SELECT date_trunc('second', $1::timestamptz + interval '3600 seconds') AS u", [at2])).rows[0].u as Date;
      const cd2 = (t2.excluded ?? []).find((e) => e.startsWith(`cooldown: ${JOB} (2 non-advancing reap(s), last 'succeeded: CALL'`));
      assert.ok(cd2, JSON.stringify(t2.excluded));
      assert.ok(cd2!.includes(`re-arm at ${iso(until2)}`), `${cd2} vs ${iso(until2)}`);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
