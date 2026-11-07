/**
 * FIX-1374 — the five monthly orphan sweeps RETURNed as `by … 1 * *`, the last
 * parked rows that return as `by` rows. cc-258, `20261102000000_fix1374_…`.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r11.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - the file touches exactly its five registry rows, by name, each matched
 *     on its exact old text; the RETURN note carries the UTC date of the apply;
 *   - it writes no pipeline_state, no budget (cron_job_budget or
 *     budget_seconds), no dial, defines no routine, makes no cron write;
 *   - the five FIX-1311 hold rows are asserted, never converted or deleted:
 *     only their notes are appended to; the guard admits the gated push's own
 *     hold; recipient_count_reconcile is never named;
 *   - the read-back pins every other column (budget_seconds NULL), one row per
 *     pipeline, and the current four bodies;
 *   - the five bodies (FIX-1295 M3, the md5s prod runs, cc-258 read 4): 64MB +
 *     parallel 0 in-body, no START gate, ONE query_canceled sub-block (fe-totals
 *     three) whose cancel closes the row `partial` (advancing) and whose error
 *     closes it `failed`, and the procedure RETURNs either way;
 *   - the revert matches the new texts and touches only the rules.
 * Clone tests (CIVITICS_CLONE_TESTS=1): the file applies from the un-RETURNed
 * rows (and under a session hold), twice, leaving a sixth `at … 1 * *` row
 * alone; RAISEs on a human hold, a second registry row on a pipeline; the live
 * bodies pin the same md5s and carry their constants; the revert restores all
 * five `at` texts and is a 0-row NOTICE the second time; the chain — four
 * ticks at MemAvailable 450 and prod's dials arm donation-edge, then
 * fe-totals, then hold the rest at `units: 2 live of 2` / `group busy: ec`,
 * then (donation-edge complete and reaped) arm donor-rollup ahead of ecs; a
 * seeded `partial` after the slot leaves the row NOT due with no cooldown,
 * where the same row `failed` is DUE in the I6 cooldown.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments, withCurrentPins } from "./lib/migration-text";

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
const M3 = () => one("_fix1295_work_mem_m3.sql");

const FILE = () => one("_fix1374_return_five_monthly_sweeps.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1374-revert-return-five-monthly-sweeps.sql"));
// FIX-1383 (cc-263) converted the holds this file asserts; its revert puts the RETURN's holds back first.
const CUTOVER = () => read(path.join(ROOT, "scripts", "fix1383-revert-convert-five-sweeps-holds.sql"));

/** The five rows in slot order, with the bodies prod runs (cc-258 read 4: prod = clone). */
const ROWS = [
  { job: "donation-edge-orphan-sweep", slot: "30 11 1 * *", pipeline: "donation_edge_orphan_sweep", routine: "reconcile_donation_edge_orphans", cls: "memory", grp: "ec", md5: "26a26588573220085174632fd2ce6c1b", cancels: 1, band: 204 },
  { job: "financial-entity-totals-reconcile", slot: "0 12 1 * *", pipeline: "financial_entity_totals_reconcile", routine: "reconcile_financial_entity_totals", cls: "io", grp: "fe-totals", md5: "f0710a7c430963597d67c83d1467a368", cancels: 3, band: 234 },
  { job: "donor-rollup-orphan-sweep", slot: "30 12 1 * *", pipeline: "donor_rollup_orphan_sweep", routine: "reconcile_donor_rollup_orphans", cls: "memory", grp: "rollups", md5: "cab2b74b4be409426e5d469276950441", cancels: 1, band: 156 },
  { job: "donor-party-rollup-orphan-sweep", slot: "0 13 1 * *", pipeline: "donor_party_rollup_orphan_sweep", routine: "reconcile_donor_party_rollup_orphans", cls: "io", grp: "rollups", md5: "fda377bb4d6ba88572310dbce55f0fd1", cancels: 1, band: 436 },
  { job: "entity-connection-stats-orphan-sweep", slot: "30 13 1 * *", pipeline: "entity_connection_stats_orphan_sweep", routine: "reconcile_entity_connection_stats_orphans", cls: "io", grp: "ec", md5: "791e3ba3e669570fbb3eed89e2e08004", cancels: 1, band: 140 },
] as const;
const JOBS = ROWS.map((r) => r.job);
const PIPELINES = ROWS.map((r) => r.pipeline);
const [DE, FE, DR, DP, ECS] = ROWS;
const body = (routine: string) => prosrc(M3(), `CREATE OR REPLACE PROCEDURE public.${routine}()`, "$procedure$");

const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The file's row list, parsed from its c_rows constant. */
function cRows(): Record<string, unknown>[] {
  const src = FILE();
  const m = src.match(/c_rows\s+CONSTANT jsonb := '(\[[\s\S]*?\])';/);
  assert.ok(m, "c_rows constant");
  return JSON.parse(m![1] as string);
}

test("FIX-1374 RETURN: exactly the five rows, by name, each matched on its at text; the UTC date, not a literal", () => {
  const rows = cRows();
  assert.deepEqual(rows.map((r) => r["job"]), JOBS, "the five jobs, in slot order, and no sixth");
  for (const [i, r] of ROWS.entries()) {
    const got = rows[i] as Record<string, unknown>;
    assert.equal(got["old_rule"], `at ${r.slot}`);
    assert.equal(got["new_rule"], `by ${r.slot}`);
    assert.equal(got["slot"], r.slot);
    assert.equal(got["pipeline"], r.pipeline);
    assert.equal(got["routine"], r.routine);
    assert.equal(got["cost_class"], r.cls);
    assert.equal(got["grp"], r.grp);
    assert.equal(got["body_md5"], r.md5);
    assert.equal(got["n_cancel"], r.cancels);
    assert.equal(got["band_hi"], r.band, "bands.json's hi_s");
  }
  const sql = stripComments(FILE());
  assert.equal([...sql.matchAll(/UPDATE public\.job_registry/g)].length, 1, "one registry write, in the loop");
  assert.match(sql, /SET deadline_rule = r\.new_rule,/);
  assert.match(sql, /WHERE job = r\.job\s+AND deadline_rule = r\.old_rule;/, "matched on the exact old text");
  assert.ok(sql.includes("v_day     text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');"), "the UTC date, not a literal");
  assert.ok(sql.includes("note || '; RETURNED ' || v_day || ' (FIX-1374, cc-258): ' || r.new_rule || ' = its cron slot'"));
  assert.doesNotMatch(sql, /RETURNED 20\d\d-\d\d-\d\d/, "no literal date anywhere");
  assert.ok(sql.includes("IF v_rule = r.new_rule THEN"), "already returned → NOTICE");
  assert.match(sql, /RAISE EXCEPTION '\[fix1374\] job_registry % reads %, expected % or %',\s+r\.job,/, "anything else RAISEs naming the row");
  assert.doesNotMatch(sql, /SET anchor_cadence|anchor_cadence\s*=\s*'/, "one row per pipeline: no anchor_cadence (rule 378)");
  for (const other of ["contract-flow-rollups-refresh", "recipient_count_reconcile", "officials-"]) {
    assert.ok(!sql.includes(other), `never names ${other}`);
  }
});

test("FIX-1374: no pipeline_state, no budget, no dial, no routine, no cron write", () => {
  const sql = stripComments(FILE());
  assert.doesNotMatch(sql, /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.pipeline_state/i, "no pipeline_state write");
  assert.doesNotMatch(sql, /cron_job_budget/, "no budget row");
  assert.doesNotMatch(sql, /SET\s+[^;]*budget_seconds\s*=/, "budget_seconds is the unwritten dial");
  assert.ok(sql.includes("AND budget_seconds IS NULL"), "the read-back asserts it stays NULL");
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i, "no routine");
  assert.doesNotMatch(sql, /CREATE (TEMP|TEMPORARY )?TABLE/i, "no table, temp or otherwise");
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/);
  assert.doesNotMatch(sql, /UPDATE public\.platform_dials/);
  assert.doesNotMatch(sql, /jobid\s*=\s*\d+/, "by name, never by jobid (FIX-946)");
  assert.doesNotMatch(sql, /SET\s+[^;]*by_window_minutes\s*=/, "by_window_minutes untouched");
  assert.ok(sql.includes("AND by_window_minutes IS NULL"));
});

test("FIX-1374: the five holds are asserted as FIX-1311's takeover hold (or the push's own); only the notes appended", async () => {
  const { SESSION_HOLD_PREFIX } = await import("../lib/prod-session");
  assert.equal(SESSION_HOLD_PREFIX, "prod session held: ");
  const sql = stripComments(FILE());
  assert.doesNotMatch(sql, /SET\s+held_since|cadence_hours\s*=\s*\d+|hold_reason\s*=\s*(NULL|')|retired_at\s*=/, "no hold conversion");
  assert.doesNotMatch(sql, /DELETE FROM/i, "rule 289: never DELETE");
  assert.ok(sql.includes("SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = r.pipeline;"));
  assert.match(sql, /v_row\.hold_reason LIKE 'parked for the dispatcher cutover%'/);
  assert.match(sql, /v_row\.cadence_hours IS NULL/);
  assert.match(sql, /v_row\.note LIKE 'FIX-1311 \(cc-232\)%'/);
  assert.ok(sql.includes(`OR v_row.hold_reason LIKE '${SESSION_HOLD_PREFIX}%'`), "the gate's own hold is admitted, not refused");
  assert.ok(
    sql.includes("SET note       = note || '; ' || r.job || ' RETURNED ' || v_day || ' (FIX-1374) — hold kept, conversion to cadence_hours 744 owed (cc-259)'"),
    "the note, appended",
  );
  assert.ok(sql.includes("AND note NOT LIKE '%' || r.job || ' RETURNED % (FIX-1374)%';"), "idempotent across a UTC midnight");
  assert.ok(sql.includes("a human hold is resolved by a human"));
});

test("FIX-1374: one owner ×5 — each cron by NAME, inactive, exactly one row", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes("SELECT count(*) INTO v_n FROM cron.job WHERE jobname = r.job;"));
  assert.ok(sql.includes("SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = r.job;"));
  assert.ok(sql.includes("IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = r.job AND active) THEN"), "the read-back re-reads it");
});

test("FIX-1374 read-back: every other column unchanged, one row per pipeline, the four pins current", () => {
  const sql = stripComments(FILE());
  assert.ok(sql.includes("WHERE job = r.job AND runner = 'pg_cron' AND pipeline = r.pipeline"));
  assert.ok(sql.includes("AND unit_shape = 'atomic' AND unit_call = 'CALL public.' || r.routine || '();'"));
  assert.ok(sql.includes("AND priority = 5 AND cost_class = r.cost_class AND cap_mb = 64 AND exclusion_group = r.grp"));
  assert.ok(sql.includes("AND budget_seconds IS NULL AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL"));
  assert.ok(sql.includes("AND by_window_minutes IS NULL AND yield_to = '{}' AND yield_lead_seconds = 0 AND NOT idempotent_refire"));
  assert.ok(sql.includes("AND anchor_cadence IS NULL"));
  assert.ok(sql.includes("SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = r.pipeline;"), "rule 378");
  assert.ok(FILE().includes(`c_pin_d CONSTANT text := '${md5(anchorBody())}'`), "the asserted pin is FIX-1361's body");
  assert.equal(md5(anchorBody()), "d6a9073bcc4d9084b9d7994324a89b18");
  for (const pin of ["ac8dbcddf71978e73d28c999433156b7", "4c30523742e280a4b48ea2ec390654d6", "1d3507cd4b71439f0cfff51cde49b9d8"]) {
    assert.ok(sql.includes(`'${pin}'`), pin);
  }
  assert.ok(sql.includes("RAISE EXCEPTION '[fix1374] read-back failed: %'"));
  assert.ok(sql.includes("v_prev := public.cron_prev_slot(r.slot, now());"), "the pick's arithmetic, printed ×5");
  assert.ok(sql.includes("SELECT temp_bytes INTO v_temp FROM pg_stat_database WHERE datname = current_database();"), "the spill's before-number");
  assert.ok(sql.includes("WHEN v_avail - 64 < v_head THEN"), "the 64-cap headroom reading");
});

test("the five bodies (FIX-1295 M3): 64MB + parallel 0 in-body, no START gate; a cancel closes partial and RETURNs, an error closes failed and RETURNs", () => {
  for (const r of ROWS) {
    const b = body(r.routine);
    assert.equal(md5(b), r.md5, `${r.routine}: the last CREATE is the body prod runs`);
    assert.ok(b.includes("SET work_mem = '64MB';") && b.includes("SET max_parallel_workers_per_gather = 0;"), `${r.routine}: = cap_mb 64`);
    assert.ok(!b.includes("box_backoff_gate("), `${r.routine}: no START gate`);
    assert.equal(b.split("WHEN query_canceled THEN").length - 1, r.cancels, `${r.routine}: query_canceled sub-blocks`);
    assert.ok(b.indexOf("pg_try_advisory_lock(c_lock_key)") < b.indexOf("SET work_mem = '64MB';"), "the session lock first");
    assert.ok(b.indexOf("'running'") < b.indexOf("WHEN query_canceled THEN"), "the running row COMMITs before the sweep");
    assert.match(b, /WHEN v_canceled IS NOT NULL\s+THEN 'partial'/, `${r.routine}: a cancel closes partial — ADVANCING`);
    assert.match(b, /WHEN array_length\(v_failures, 1\) > 0 THEN 'failed'/, `${r.routine}: an error closes failed`);
    assert.doesNotMatch(b, /RAISE EXCEPTION/, `${r.routine}: never re-RAISEs — the reap reads succeeded either way`);
  }
  const de = body(DE.routine);
  assert.match(de, /DELETE FROM public\.entity_connections ec\s+WHERE ec\.connection_type = 'donation'/);
  assert.ok(de.includes("AND fr.relationship_type IN ('donation', 'ie_support')"), "the anti-join mirrors the 'donation' edge derivation");
  assert.ok(body(DR.routine).includes("DELETE FROM public.official_donor_rollup_mv r"));
  assert.ok(body(DP.routine).includes("DELETE FROM public.donor_party_rollup_mv r"));
  assert.ok(body(ECS.routine).includes("DELETE FROM public.entity_connection_stats_mv s"));
  const fe = body(FE.routine);
  assert.ok(fe.includes("UPDATE public.financial_entities fe") && !fe.includes("DELETE FROM"), "fe-totals zeroes, never deletes");
});

test("dispatch_one_unit: a NULL budget arms no cron_job_budget row; partial is advancing for the pick and the ladder", () => {
  const b = anchorBody();
  assert.ok(b.includes("IF v_pick_budget IS NOT NULL THEN"), "a NULL-budget unit gets no budget row");
  assert.match(b, /l\.status IN \('complete', 'partial'\)/, "partial counts as the anchor");
  assert.ok(b.includes("AND (v_adv IS NULL OR x.armed_for > v_adv)"), "the ladder counts only reaps after the last advancing row");
});

test("FIX-1374 revert: matches the new texts, touches only the rules, never un-parks", () => {
  const sql = stripComments(REVERT());
  assert.ok(sql.includes("SET deadline_rule = 'at ' || r.slot,"));
  assert.match(sql, /WHERE job = r\.job\s+AND deadline_rule = 'by ' \|\| r\.slot;/);
  for (const r of ROWS) assert.ok(sql.includes(`('${r.job}',`) && sql.includes(`'${r.slot}')`), r.job);
  assert.doesNotMatch(sql, /pipeline_state/, "no dial was written");
  assert.doesNotMatch(sql, /UPDATE public\.rollup_watch_overrides/, "the hold notes stay");
  assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/, "the crons stay parked");
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});

test("the file sorts after FIX-1371's, nothing between", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const at = all.indexOf("20261102000000_fix1374_return_five_monthly_sweeps.sql");
  assert.ok(at > 0);
  assert.equal(all[at - 1], "20261101000000_fix1371_return_contract_flow_rollups_refresh.sql");
});

// ---------------------------------------------------------------------------
// Behavioural — the clone (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

async function clone(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return null;
  }
  const c = withCurrentPins(new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 }));
  await c.connect();
  return c;
}

/** BEGIN, then the registry's table lock FIRST (r9's lesson, cc-256 contradiction 8: 40P01 on job_registry). */
async function begin(c: Client): Promise<void> {
  await c.query("BEGIN");
  await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
}

/** Apply the file inside the caller's transaction, from the un-RETURNed rows. */
async function applyFresh(c: Client): Promise<void> {
  await c.query(CUTOVER());
  await c.query(REVERT());
  await c.query(FILE());
}

test("clone: the file applies from the un-RETURNed rows, twice; a sixth `at … 1 * *` row untouched; the holds stay holds", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await c.query(CUTOVER());
      await c.query(REVERT());
      // A sixth monthly row on its own pipeline: the file must not touch it.
      await c.query(
        `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, note)
         SELECT 'cc258-sixth-monthly', runner, 'cc258_sixth_monthly', unit_shape, unit_call, priority, 'at 45 13 1 * *', cost_class, cap_mb, exclusion_group, budget_seconds, gates, 'cc-258 clone test'
           FROM public.job_registry WHERE job = $1`,
        [ECS.job],
      );
      const readReg = async (): Promise<{ job: string; deadline_rule: string; budget_seconds: number | null; note: string }[]> =>
        (await c.query(
          "SELECT job, deadline_rule, budget_seconds, note FROM public.job_registry WHERE job = ANY ($1) ORDER BY array_position($1, job)",
          [[...JOBS, "cc258-sixth-monthly"]],
        )).rows;
      await c.query(FILE());
      const reg = await readReg();
      await c.query(FILE()); // idempotent: a second run NOTICEs and changes nothing
      assert.deepEqual(await readReg(), reg, "the second run changes no row");
      for (const [i, r] of ROWS.entries()) {
        assert.equal(reg[i]!.deadline_rule, `by ${r.slot}`, r.job);
        assert.equal(reg[i]!.budget_seconds, null, `${r.job}: no budget`);
        assert.match(reg[i]!.note, new RegExp(`; RETURNED \\d{4}-\\d{2}-\\d{2} \\(FIX-1374, cc-258\\): by ${re(r.slot)} = its cron slot$`), "the RETURN note, last");
      }
      assert.equal(reg[5]!.deadline_rule, "at 45 13 1 * *", "the sixth monthly row is untouched");
      const holds: { pipeline: string; held_since: Date | null; cadence_hours: number | null; retired_at: Date | null; note: string }[] = (await c.query(
        "SELECT pipeline, held_since, cadence_hours, retired_at, note FROM public.rollup_watch_overrides WHERE pipeline = ANY ($1)",
        [PIPELINES],
      )).rows;
      assert.equal(holds.length, 5);
      for (const h of holds) {
        assert.notEqual(h.held_since, null, `${h.pipeline}: still a hold`);
        assert.equal(h.cadence_hours, null, `${h.pipeline}: not converted`);
        assert.equal(h.retired_at, null);
        assert.match(h.note, /^FIX-1311 \(cc-232\)/);
        assert.equal(h.note.split("(FIX-1374)").length - 1, 1, `${h.pipeline}: the hold note is appended once`);
      }
      const rcr: { note: string; updated_at: Date }[] = (await c.query(
        "SELECT note, updated_at FROM public.rollup_watch_overrides WHERE pipeline = 'recipient_count_reconcile'",
      )).rows;
      for (const x of rcr) assert.ok(!x.note.includes("FIX-1374"), "recipient_count_reconcile untouched");
      const cron: { jobname: string; active: boolean }[] = (await c.query(
        "SELECT jobname, active FROM cron.job WHERE jobname = ANY ($1) ORDER BY jobname",
        [JOBS],
      )).rows;
      assert.equal(cron.length, 5, "one cron per job, by name");
      assert.ok(cron.every((x) => x.active === false), "all five parked");
      const budgets: { n: number } = (await c.query("SELECT count(*)::int AS n FROM public.cron_job_budget WHERE jobname = ANY ($1)", [JOBS])).rows[0];
      assert.equal(budgets.n, 0, "no budget row");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: the file applies under the gate's own session hold; RAISEs on a human hold or a second row on a pipeline", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const attempt = async (setup: string, params: unknown[] = []): Promise<string | null> => {
    await begin(c);
    try {
      await c.query(CUTOVER());
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
        `UPDATE public.rollup_watch_overrides SET hold_reason = 'prod session held: cc-258 clone test', held_since = now()
          WHERE pipeline = $1`,
        [DR.pipeline],
      ),
      null,
      "the session's own hold is admitted",
    );
    assert.match(
      (await attempt("UPDATE public.rollup_watch_overrides SET hold_reason = 'Craig: hands off' WHERE pipeline = $1", [DP.pipeline])) ?? "",
      /\[fix1374\] donor_party_rollup_orphan_sweep override is not FIX-1311's takeover hold/,
    );
    assert.match(
      (await attempt(
        `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, note)
         SELECT job || '-sibling', runner, pipeline, unit_shape, unit_call, priority, 'at 0 0 1 1 *', cost_class, cap_mb, exclusion_group, budget_seconds, gates, 'cc-258 clone test'
           FROM public.job_registry WHERE job = $1`,
        [FE.job],
      )) ?? "",
      /\[fix1374\] read-back failed: .*2 registry rows on financial_entity_totals_reconcile/,
    );
    assert.match(
      (await attempt("UPDATE public.job_registry SET deadline_rule = 'at 31 11 1 * *' WHERE job = $1", [DE.job])) ?? "",
      /\[fix1374\] job_registry donation-edge-orphan-sweep reads at 31 11 1 \* \*, expected at 30 11 1 \* \* or by 30 11 1 \* \*/,
      "an unexpected rule RAISEs naming the row",
    );
  } finally {
    await c.end();
  }
});

test("clone: the live bodies are prod's, with their constants in text", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    for (const r of ROWS) {
      const live: { m: string; src: string; cfg: string[] | null; kind: string } = (await c.query(
        "SELECT md5(prosrc) AS m, prosrc AS src, proconfig AS cfg, prokind::text AS kind FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace",
        [r.routine],
      )).rows[0];
      assert.equal(live.m, r.md5, `${r.routine}: the clone runs prod's body`);
      assert.equal(live.kind, "p");
      assert.equal(live.cfg, null, `${r.routine}: proconfig NULL — the 64MB is in-body`);
      assert.ok(live.src.includes("SET work_mem = '64MB';"));
      assert.ok(!live.src.includes("box_backoff_gate"), `${r.routine}: no START gate`);
      assert.equal(live.src.split("WHEN query_canceled THEN").length - 1, r.cancels, `${r.routine}: query_canceled sub-blocks`);
    }
    const de: { src: string } = (await c.query(
      "SELECT prosrc AS src FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace",
      [DE.routine],
    )).rows[0];
    assert.ok(de.src.includes("AND fr.relationship_type IN ('donation', 'ie_support')"), "the donation-edge anti-join");
  } finally {
    await c.end();
  }
});

test("clone: the revert restores all five at texts; a second run is a 0-row NOTICE ×5", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const notices: string[] = [];
  c.on("notice", (n) => notices.push(n.message ?? ""));
  try {
    await begin(c);
    try {
      await applyFresh(c);
      notices.length = 0;
      await c.query(REVERT());
      assert.equal(notices.filter((n) => /: 1 row\(s\)$/.test(n)).length, 5, notices.join("\n"));
      const rules: { deadline_rule: string }[] = (await c.query(
        "SELECT deadline_rule FROM public.job_registry WHERE job = ANY ($1) ORDER BY array_position($1, job)",
        [JOBS],
      )).rows;
      assert.deepEqual(rules.map((x) => x.deadline_rule), ROWS.map((r) => `at ${r.slot}`));
      notices.length = 0;
      await c.query(REVERT());
      assert.equal(notices.filter((n) => /: 0 row\(s\)$/.test(n)).length, 5, notices.join("\n"));
      const holds: { n: number } = (await c.query(
        "SELECT count(*)::int AS n FROM public.rollup_watch_overrides WHERE pipeline = ANY ($1) AND held_since IS NOT NULL AND note LIKE '%(FIX-1374)%'",
        [PIPELINES],
      )).rows[0];
      assert.equal(holds.n, 5, "the holds and their notes stay");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

const MB = 1048576;
const SWAP_TOTAL = 1073737728;

/** The tick fixture: every other dispatched row parked, prod's dials, the box fresh at MemAvailable 450, the five DUE. */
async function tickFixture(c: Client, cooldownSeconds: number): Promise<void> {
  await applyFresh(c);
  await c.query("UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job <> ALL ($1)", [JOBS]);
  await c.query(
    "UPDATE public.platform_dials SET pause = false, max_concurrent_units = 2, max_live_caps_mb = 1024, headroom_target_mb = 150, rearm_cooldown_seconds = $1",
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
  // Each sweep's last advancing run before this month's slot (prod: 10-01), and nothing of the three groups running.
  for (const r of ROWS) {
    await c.query(
      "DELETE FROM public.data_sync_log WHERE pipeline = $1 AND (completed_at >= public.cron_prev_slot($2, now()) OR status = 'running')",
      [r.pipeline, r.slot],
    );
  }
  await c.query(
    `DELETE FROM public.data_sync_log WHERE status = 'running'
       AND pipeline IN (SELECT pipeline FROM public.job_registry WHERE exclusion_group IN ('ec', 'rollups', 'fe-totals') AND pipeline IS NOT NULL)`,
  );
  // No arm or reap of the five on the clone counts until a test seeds one.
  await c.query("DELETE FROM public.dispatch_log WHERE job = ANY ($1) AND decision IN ('armed', 'reaped', 'missed')", [JOBS]);
}

type Tick = { decision: string; job: string | null; reason: string; excluded: string[] | null; armed_jobid: string | null; live_units: number | null };
async function lastTick(c: Client): Promise<Tick> {
  return (await c.query("SELECT decision, job, reason, excluded, armed_jobid, live_units FROM public.dispatch_log ORDER BY id DESC LIMIT 1")).rows[0];
}
async function tick(c: Client): Promise<Tick> {
  await c.query("SELECT public.dispatch_one_unit('manual')");
  return lastTick(c);
}

test("clone: the chain — donation-edge, then fe-totals, then units 2 of 2; donation-edge complete → donor-rollup ahead of ecs (ttd order)", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await tickFixture(c, 0);

      const t1 = await tick(c);
      assert.equal(t1.decision, "armed", JSON.stringify(t1));
      assert.equal(t1.job, DE.job, "the most negative ttd (11-01 11:30Z) first");
      assert.match(t1.reason, new RegExp(`^by ${re(DE.slot)} → -`), "DUE since its prev slot");
      assert.deepEqual(
        [...(t1.excluded ?? [])].sort(),
        [FE, DR, DP, ECS].map((r) => `queued (${r.job})`).sort(),
        "the other four queued behind it",
      );

      const t2 = await tick(c);
      assert.equal(t2.decision, "armed", JSON.stringify(t2));
      assert.equal(t2.job, FE.job, "fe-totals next: ecs's group is busy, fe-totals' ttd beats the rollups'");
      const ex2 = t2.excluded ?? [];
      assert.ok(ex2.includes(`live (${DE.job})`), JSON.stringify(ex2));
      assert.ok(ex2.includes(`group busy: ec (${ECS.job})`), JSON.stringify(ex2));
      assert.ok(ex2.includes(`queued (${DR.job})`) && ex2.includes(`queued (${DP.job})`), JSON.stringify(ex2));

      const t3 = await tick(c);
      assert.equal(t3.decision, "nothing_due", JSON.stringify(t3));
      const ex3 = t3.excluded ?? [];
      assert.ok(ex3.includes(`live (${DE.job})`) && ex3.includes(`live (${FE.job})`), JSON.stringify(ex3));
      assert.ok(ex3.includes(`units: 2 live of 2 (${DR.job})`), JSON.stringify(ex3));
      assert.ok(ex3.includes(`units: 2 live of 2 (${DP.job})`), JSON.stringify(ex3));
      assert.ok(ex3.includes(`group busy: ec (${ECS.job})`), "group busy outranks units (first reason wins)");

      // donation-edge's one-shot ran: its row closed complete after the slot, and the tick reaped it.
      await c.query(
        `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
         VALUES ($1, 'complete', now() - interval '3 minutes', now() - interval '1 minute', 0,
                 jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep', 'canceled', false, 'orphan_edges_deleted', 0))`,
        [DE.pipeline],
      );
      await c.query(
        `INSERT INTO public.dispatch_log (source, job, decision, reason, armed_jobid, armed_jobname, armed_for, unit_ms)
         SELECT 'manual', job, 'reaped', 'succeeded: CALL', armed_jobid, armed_jobname, armed_for, 120000
           FROM public.dispatch_log WHERE job = $1 AND decision = 'armed' ORDER BY id DESC LIMIT 1`,
        [DE.job],
      );
      const t4 = await tick(c);
      assert.equal(t4.decision, "armed", JSON.stringify(t4));
      assert.equal(t4.job, DR.job, "donor-rollup (ttd −16:0x) ahead of ecs (−15:0x) and donor-party (−15:3x)");
      const ex4 = t4.excluded ?? [];
      assert.ok(ex4.includes(`queued (${ECS.job})`), JSON.stringify(ex4));
      assert.ok(ex4.includes(`queued (${DP.job})`), JSON.stringify(ex4));
      assert.ok(ex4.includes(`live (${FE.job})`), JSON.stringify(ex4));
      assert.ok(!ex4.some((e) => e.endsWith(`(${DE.job})`)), "donation-edge is satisfied for the month");
      const budgets: { n: number } = (await c.query(
        "SELECT count(*)::int AS n FROM public.cron_job_budget WHERE jobname LIKE ANY (ARRAY['disp-donation-edge-orphan-sweep-%', 'disp-financial-entity-totals-reconcile-%', 'disp-donor-rollup-orphan-sweep-%'])",
      )).rows[0];
      assert.equal(budgets.n, 0, "a NULL-budget row arms no cron_job_budget row");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: a cancel's `partial` after the slot is ADVANCING (not due, no cooldown); the same row `failed` is DUE in the I6 cooldown", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await tickFixture(c, 1800);
      // Only donor-rollup in play: the other four parked, so the tick's `next:` names it.
      await c.query("UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE job = ANY ($1)", [[DE.job, FE.job, DP.job, ECS.job]]);
      // The one-shot armed 50 min ago and reaped 4 min ago `succeeded: CALL` (the body caught the cancel and RETURNed).
      await c.query(
        `INSERT INTO public.dispatch_log (source, job, decision, reason, armed_jobid, armed_jobname, armed_for, ticked_at)
         VALUES ('manual', $1, 'reaped', 'succeeded: CALL', 900000101, 'disp-donor-rollup-orphan-sweep-900000101',
                 now() - interval '50 minutes', now() - interval '4 minutes')`,
        [DR.job],
      );
      const { rows } = await c.query(
        `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, error_message, metadata)
         VALUES ($1, 'partial', now() - interval '48 minutes', now() - interval '5 minutes', 0,
                 'canceled — rollup orphan DELETE: canceling statement due to statement timeout',
                 jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep', 'canceled', true,
                                    'cancel_detail', 'rollup orphan DELETE: canceling statement due to statement timeout',
                                    'elapsed_seconds', 2580))
         RETURNING id`,
        [DR.pipeline],
      );
      const t1 = await tick(c);
      assert.equal(t1.decision, "nothing_due", JSON.stringify(t1));
      assert.ok(!(t1.excluded ?? []).some((e) => e.includes(DR.job)), `partial = satisfied: ${JSON.stringify(t1.excluded)}`);
      assert.match(t1.reason, new RegExp(`next: ${re(DR.job)} in \\d+ days`), "next due at Dec 1's slot");
      assert.ok(!(t1.excluded ?? []).some((e) => e.startsWith("cooldown:")) && !t1.reason.includes("cooldown"), "no cooldown");

      // Side by side: the same row closed `failed` (an error) is non-advancing → DUE, and the reap puts it in the ladder.
      await c.query("UPDATE public.data_sync_log SET status = 'failed' WHERE id = $1", [rows[0].id]);
      const t2 = await tick(c);
      assert.equal(t2.decision, "nothing_due", JSON.stringify(t2));
      const cd2 = (t2.excluded ?? []).find((e) => e.startsWith(`cooldown: ${DR.job} (1 non-advancing reap(s), last 'succeeded: CALL'`));
      assert.ok(cd2, JSON.stringify(t2.excluded));
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
