/**
 * FIX-1368 / FIX-1369 / FIX-1370 — the rollups-group chain RETURNed:
 * treemap-individuals-global-refresh `by 0 14 * * 2`, agency-staffing-rollup-
 * refresh `by 5 0 * * 2`, group-donor-rollup-refresh `by 10 3 * * 3`. cc-256,
 * `20261031000000_fix1368_…`, `20261031001000_fix1369_…`, `20261031002000_fix1370_…`.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r9.test.ts
 *
 * Text anchors (no DB, run in CI):
 *   - each file touches exactly its one registry row, by name, matched on the
 *     exact old text; the pick's `by` parse reads each as a weekly slot;
 *   - none writes pipeline_state (no dial, no cursor), defines a routine,
 *     touches a cron or platform_dials;
 *   - the FIX-1311 hold rows are asserted, never converted or deleted: only
 *     their notes are appended to; the guard admits the gated push's own hold;
 *   - the read-back pins every other column, one row on the pipeline, and the
 *     current four bodies (dispatch_one_unit = the md5 of FIX-1361's body);
 *   - each body's decision lines, in the migration that last CREATEs it, at
 *     the md5 prod runs (cc-256 read 4): treemap c_max_sweep 240 h + c_budget
 *     5400 s; agency c_full_lag 14 days; group-donor's wrapper calls
 *     refresh_group_donor_rollup() and writes a `complete` row only;
 *   - each revert matches the new text and touches only the rule.
 * Clone tests (CIVITICS_CLONE_TESTS=1): the files apply from the un-RETURNed
 * rows (and under a session hold), twice; RAISE on a human hold, a second
 * registry row on the pipeline; the live bodies pin the same md5 and their
 * constants evaluate as the headers say; one manual tick at MemAvailable 450
 * arms the earliest prev slot and queues the other two, and a second tick in
 * the same transaction reads `group busy: rollups` on both — read 5's answer:
 * a dispatched unit that writes no running row is live from its own armed
 * dispatch_log row.
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
const anchorPin = () => md5(prosrc(ANCHOR(), "CREATE OR REPLACE FUNCTION public.dispatch_one_unit(", "$function$"));

interface Row {
  fix: string;
  tag: string;
  job: string;
  pipeline: string;
  slot: string;
  file: () => string;
  revert: () => string;
  shape: string;
  call: string;
  cls: string;
  cap: number;
  budget: number;
  cronName: string;
}

const ROWS: Row[] = [
  {
    fix: "FIX-1368",
    tag: "fix1368",
    job: "treemap-individuals-global-refresh",
    pipeline: "treemap_individuals_global_refresh",
    slot: "0 14 * * 2",
    file: () => one("_fix1368_return_treemap_individuals_global_refresh.sql"),
    revert: () => read(path.join(ROOT, "scripts", "fix1368-revert-return-treemap-individuals-global-refresh.sql")),
    shape: "resumable",
    call: "CALL public.refresh_treemap_individuals_global();",
    cls: "cpu",
    cap: 64,
    budget: 5400,
    cronName: "treemap-individuals-global-refresh",
  },
  {
    fix: "FIX-1369",
    tag: "fix1369",
    job: "agency-staffing-rollup-refresh",
    pipeline: "agency_staffing_rollup_refresh",
    slot: "5 0 * * 2",
    file: () => one("_fix1369_return_agency_staffing_rollup_refresh.sql"),
    revert: () => read(path.join(ROOT, "scripts", "fix1369-revert-return-agency-staffing-rollup-refresh.sql")),
    shape: "atomic",
    call: "CALL public.refresh_agency_staffing_rollup();",
    cls: "memory",
    cap: 128,
    budget: 3600,
    cronName: "agency-staffing-rollup-refresh",
  },
  {
    fix: "FIX-1370",
    tag: "fix1370",
    job: "group-donor-rollup-refresh",
    pipeline: "group_donor_rollup_refresh",
    slot: "10 3 * * 3",
    file: () => one("_fix1370_return_group_donor_rollup_refresh.sql"),
    revert: () => read(path.join(ROOT, "scripts", "fix1370-revert-return-group-donor-rollup-refresh.sql")),
    shape: "atomic",
    call: "CALL public.run_group_donor_rollup_refresh();",
    cls: "memory",
    cap: 64,
    budget: 1800,
    cronName: "group-donor-rollup-refresh",
  },
];

const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The live bodies (cc-256 read 4: prod = clone), and where each was last CREATEd. */
const BODIES = {
  treemap: {
    md5: "227e99957d5f2db9b8e9b3b2bd8c984c",
    src: () =>
      prosrc(one("_fix1295_work_mem_m2.sql"), "CREATE OR REPLACE PROCEDURE public.refresh_treemap_individuals_global()", "$procedure$"),
    name: "refresh_treemap_individuals_global",
  },
  agency: {
    md5: "c2802f128d566bc068d8fab1175277b1",
    src: () =>
      prosrc(one("_fix1194_p1a_box_backoff_gates.sql"), "CREATE OR REPLACE PROCEDURE public.refresh_agency_staffing_rollup()", "$procedure$"),
    name: "refresh_agency_staffing_rollup",
  },
  gdWrapper: {
    md5: "a656fca845af1414348c282ed2f29ccd",
    src: () =>
      prosrc(one("_fix950_guards_rollup_family.sql"), "CREATE OR REPLACE PROCEDURE public.run_group_donor_rollup_refresh()", "$procedure$"),
    name: "run_group_donor_rollup_refresh",
  },
  gdInner: {
    md5: "362d05796d1c04d144aee259e3569590",
    src: () =>
      prosrc(one("_fix1296_group_donor_work_mem_64mb.sql"), "CREATE OR REPLACE FUNCTION public.refresh_group_donor_rollup()", "$function$"),
    name: "refresh_group_donor_rollup",
  },
} as const;

for (const r of ROWS) {
  test(`${r.fix} RETURN: exactly one rule write, ${r.job} by name, matched on at ${r.slot}`, () => {
    const sql = stripComments(r.file());
    const sets = [...sql.matchAll(/SET deadline_rule = '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(sets, [`by ${r.slot}`]);
    assert.match(sql, new RegExp(`WHERE job = '${re(r.job)}'\\s+AND deadline_rule = 'at ${re(r.slot)}';`));
    assert.equal([...sql.matchAll(/UPDATE public\.job_registry/g)].length, 1, "one registry write");
    assert.ok(sql.includes(`note || '; RETURNED 2026-10-31 (${r.fix}, cc-256): by ${r.slot} = its cron slot'`));
    assert.ok(sql.includes(`IF v_rule = 'by ${r.slot}' THEN`), "already returned → NOTICE");
    assert.doesNotMatch(sql, /SET anchor_cadence|anchor_cadence\s*=\s*'/, "its own pipeline: no anchor_cadence (rule 378)");
    for (const other of ROWS.filter((o) => o !== r)) {
      assert.ok(!sql.includes(`'${other.job}'`), `${r.tag} never names ${other.job}`);
    }
    assert.match(r.slot, /^\d+ \d+ \* \* \d$/, "a weekly M H * * D slot (D-d, FIX-1329)");
  });

  test(`${r.fix}: no pipeline_state write, no routine, no cron write, no dial`, () => {
    const sql = stripComments(r.file());
    assert.doesNotMatch(sql, /(INSERT INTO|UPDATE|DELETE FROM)\s+public\.pipeline_state/i, "no pipeline_state write");
    assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i, "no routine");
    assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/);
    assert.doesNotMatch(sql, /UPDATE public\.platform_dials/);
    assert.doesNotMatch(sql, /jobid\s*=\s*\d+/, "by name, never by jobid (FIX-946)");
    assert.doesNotMatch(sql, /set_config\s*\(\s*'civitics\./, "no GUC write (the treemap budget GUC stands)");
  });

  test(`${r.fix}: the hold row is asserted as FIX-1311's takeover hold (or the push's own); only the note appended`, async () => {
    const { SESSION_HOLD_PREFIX } = await import("../lib/prod-session");
    assert.equal(SESSION_HOLD_PREFIX, "prod session held: ");
    const sql = stripComments(r.file());
    assert.doesNotMatch(sql, /SET\s+held_since|cadence_hours\s*=\s*\d+|hold_reason\s*=\s*(NULL|')|retired_at\s*=/, "no hold conversion");
    assert.doesNotMatch(sql, /DELETE FROM/i, "rule 289: never DELETE");
    assert.ok(sql.includes(`FROM public.rollup_watch_overrides WHERE pipeline = '${r.pipeline}';`));
    assert.match(sql, /v_row\.hold_reason LIKE 'parked for the dispatcher cutover%'/);
    assert.match(sql, /v_row\.cadence_hours IS NULL/);
    assert.match(sql, /v_row\.note LIKE 'FIX-1311 \(cc-232\)%'/);
    assert.ok(sql.includes(`OR v_row.hold_reason LIKE '${SESSION_HOLD_PREFIX}%'`), "the gate's own hold is admitted, not refused");
    const note = `; ${r.job} RETURNED 2026-10-31 (${r.fix}) — hold kept, conversion to cadence_hours 168 owed (cc-259)`;
    assert.ok(sql.includes(`SET note       = note || '${note}'`), "the note, appended");
    assert.ok(sql.includes(`AND note NOT LIKE '%${r.job} RETURNED 2026-10-31 (${r.fix})%';`), "idempotent");
    assert.ok(sql.includes("a human hold is resolved by a human"));
  });

  test(`${r.fix}: one owner — cron ${r.cronName} by NAME, inactive, exactly one row`, () => {
    const sql = stripComments(r.file());
    assert.ok(sql.includes(`SELECT count(*) INTO v_n FROM cron.job WHERE jobname = '${r.cronName}';`));
    assert.ok(sql.includes(`SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = '${r.cronName}';`));
  });

  test(`${r.fix} read-back: every other column unchanged, one row on the pipeline, the four pins current`, () => {
    const sql = stripComments(r.file());
    assert.ok(sql.includes(`WHERE job = '${r.job}' AND runner = 'pg_cron' AND pipeline = '${r.pipeline}'`));
    assert.ok(sql.includes(`AND unit_shape = '${r.shape}' AND unit_call = '${r.call}'`));
    assert.ok(sql.includes(`AND priority = 3 AND cost_class = '${r.cls}' AND cap_mb = ${r.cap} AND exclusion_group = 'rollups'`));
    assert.ok(sql.includes(`AND budget_seconds = ${r.budget} AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL`));
    assert.ok(sql.includes("AND by_window_minutes IS NULL AND yield_to = '{}' AND yield_lead_seconds = 0 AND NOT idempotent_refire"));
    assert.ok(sql.includes("AND anchor_cadence IS NULL;"));
    assert.ok(sql.includes(`SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = '${r.pipeline}';`), "rule 378");
    assert.ok(r.file().includes(`c_pin_d CONSTANT text := '${anchorPin()}'`), "the asserted pin is FIX-1361's body");
    assert.equal(anchorPin(), "d6a9073bcc4d9084b9d7994324a89b18");
    for (const pin of ["ac8dbcddf71978e73d28c999433156b7", "4c30523742e280a4b48ea2ec390654d6", "1d3507cd4b71439f0cfff51cde49b9d8"]) {
      assert.ok(sql.includes(`'${pin}'`), pin);
    }
    assert.ok(sql.includes(`RAISE EXCEPTION '[${r.tag}] read-back failed: %'`));
    assert.ok(sql.includes(`v_prev := public.cron_prev_slot('${r.slot}', now());`), "the pick's arithmetic, printed");
    assert.ok(sql.includes(`WHEN v_avail - ${r.cap} < v_head THEN`), `the ${r.cap}-cap headroom reading`);
  });

  test(`${r.fix} revert: matches the new text, touches only the rule, never un-parks`, () => {
    const sql = stripComments(r.revert());
    assert.ok(sql.includes(`SET deadline_rule = 'at ${r.slot}'`));
    assert.match(sql, new RegExp(`WHERE job = '${re(r.job)}'\\s+AND deadline_rule = 'by ${re(r.slot)}';`));
    assert.doesNotMatch(sql, /pipeline_state/, "no dial was written");
    assert.doesNotMatch(sql, /UPDATE public\.rollup_watch_overrides/, "the hold note stays");
    assert.doesNotMatch(sql, /cron\.(alter_job|unschedule|schedule)\s*\(/, "the cron stays parked");
    assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
  });
}

test("the three files sort in the push order, after FIX-1366's", () => {
  const names = fs.readdirSync(MIGRATIONS).filter((f) => /_fix13(68|69|70)_return_/.test(f)).sort();
  assert.deepEqual(names, [
    "20261031000000_fix1368_return_treemap_individuals_global_refresh.sql",
    "20261031001000_fix1369_return_agency_staffing_rollup_refresh.sql",
    "20261031002000_fix1370_return_group_donor_rollup_refresh.sql",
  ]);
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(all.indexOf(names[0]!), all.indexOf("20261030001000_fix1366_move_dpr_vacuum_analyze.sql") + 1, "nothing between");
});

test("treemap: the live body (227e9995) is a 64-chunk resumable sweep; c_max_sweep 240 h covers two Tuesday slots", () => {
  const b = BODIES.treemap.src();
  assert.equal(md5(b), BODIES.treemap.md5, "the last CREATE of the body is the one prod runs");
  assert.ok(b.includes("c_chunks    int    := 64;"));
  assert.ok(b.includes("c_max_sweep interval := interval '240 hours';"));
  assert.ok(b.includes("c_budget    interval := interval '5400 seconds';"));
  assert.ok(b.includes("v_budget_cfg := NULLIF(current_setting('civitics.treemap_global_budget_seconds', true), '')::int;"));
  assert.ok(b.includes("value || jsonb_build_object('chunk_cursor', k)"), "the cursor advances inside the chunk txn");
  assert.match(b, /IF v_max_chunk > 0\s+AND v_elapsed \+ \(v_max_chunk \* 1\.25\) > EXTRACT\(epoch FROM c_budget\) THEN/, "the predictive guard");
  assert.ok(b.includes("SET work_mem = '64MB';"), "= cap_mb 64");
  // Rule 390: a partial's resume one Tuesday later is inside the staleness bound; two Tuesdays later it is not.
  const hours = 240;
  assert.ok(7 * 24 < hours && 14 * 24 > hours, "a partial resumes next Tuesday; a third CALL restarts — the body's design");
  const file = stripComments(ROWS[0]!.file());
  assert.ok(file.includes(`'${BODIES.treemap.md5}'`), "the NOTICE says whether the body is still the one its premise reads");
  assert.ok(file.includes("current_setting('civitics.treemap_global_budget_seconds', true)"), "the GUC is read, not written");
});

test("agency: the live body (c2802f12) picks full past a HARD-CODED 14 days; no running row, terminal row only", () => {
  const b = BODIES.agency.src();
  assert.equal(md5(b), BODIES.agency.md5);
  assert.ok(b.includes("c_full_lag interval := interval '14 days';"));
  assert.ok(b.includes("c_chunk    int      := 50;"));
  assert.match(b, /WHEN v_w_fr IS NULL OR v_w_ec IS NULL THEN 'full'\s+WHEN v_h - v_w_fr > c_full_lag\s+THEN 'full'\s+ELSE\s+'incremental'/);
  assert.ok(b.includes("v_gate := public.box_backoff_gate('agency-staffing-rollup-refresh', 600);"), "its own START gate");
  assert.ok(b.includes("SET work_mem = '128MB';"), "= cap_mb 128");
  assert.doesNotMatch(b, /'running'/, "no running row: the census reads it from its armed row (read 5)");
  const file = stripComments(ROWS[1]!.file());
  assert.ok(file.includes("WHEN v_h - v_w_fr > interval '14 days' THEN 'full'"), "the file's NOTICE copies the decision");
  assert.ok(file.includes(`'${BODIES.agency.md5}'`));
});

test("group-donor: the wrapper (a656fca8) calls refresh_group_donor_rollup() and writes a complete row only; 64MB is in-body", () => {
  const w = BODIES.gdWrapper.src();
  assert.equal(md5(w), BODIES.gdWrapper.md5);
  assert.ok(w.includes("SELECT public.refresh_group_donor_rollup() INTO v_result;"));
  assert.ok(w.includes("'complete',"));
  assert.doesNotMatch(w, /'running'/, "no running row (read 5)");
  const i = BODIES.gdInner.src();
  assert.equal(md5(i), BODIES.gdInner.md5);
  assert.ok(i.includes("SET LOCAL work_mem = '64MB';"), "FIX-1296: in-body, not proconfig");
  assert.ok(i.includes("DELETE FROM public.group_donor_rollup;"), "atomic: DELETE + re-INSERT in one transaction");
  const file = stripComments(ROWS[2]!.file());
  assert.ok(file.includes(`'${BODIES.gdWrapper.md5}'`) && file.includes(`'${BODIES.gdInner.md5}'`));
  assert.ok(file.includes(`position('SET LOCAL work_mem = ''64MB''' IN v_src_r) > 0`), "the NOTICE reads the in-body SET");
});

test("read 5: the census counts an armed, unreaped one-shot live with no running row — and puts its group in v_busy_groups", () => {
  const src = ANCHOR();
  const b = prosrc(src, "CREATE OR REPLACE FUNCTION public.dispatch_one_unit(", "$function$");
  assert.match(
    b,
    /INTO v_armed_jobs, v_armed_names\s+FROM public\.dispatch_log a\s+WHERE a\.armed_jobid IS NOT NULL AND a\.decision = 'armed'\s+AND NOT EXISTS/,
    "an armed row with no reaped/missed row",
  );
  assert.ok(b.includes("SELECT 'armed:' || a.armed_jobname AS unit_key, a.job"), "is a unit of the census");
  assert.ok(b.includes("s.query ~* ('(CALL|SELECT)\\s+(public\\.)?' || reg.routine || '\\s*\\(')"), "as is its CALL in pg_stat_activity");
  assert.match(b, /array_agg\(DISTINCT reg\.exclusion_group\)\s+FROM rep, unnest\(rep\.jobs\) j JOIN reg ON reg\.job = j/);
  assert.ok(b.includes("v_why := 'group busy: ' || r.exclusion_group;"));
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

/**
 * BEGIN, then the registry's table lock FIRST. These transactions write three
 * rows and then every other row; r4 / r5 / r7 write the same table in another
 * order, and the default run executes files concurrently (deadlock 40P01 on
 * job_registry, seen in cc-256's first full clone run). Holding the table lock
 * before any row lock means this file waits holding nothing, and a peer that
 * waits on it has taken nothing of ours.
 */
async function begin(c: Client): Promise<void> {
  await c.query("BEGIN");
  await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
}

/** Apply every file inside the caller's transaction, from the un-RETURNed rows. */
async function applyFresh(c: Client): Promise<void> {
  for (const r of ROWS) await c.query(r.revert());
  for (const r of ROWS) await c.query(r.file());
}

test("clone: the files apply from the un-RETURNed rows, twice; holds stay holds, notes appended once", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await applyFresh(c);
      for (const r of ROWS) await c.query(r.file());  // idempotent: a second run NOTICEs and changes nothing
      for (const r of ROWS) {
        const reg = (await c.query("SELECT deadline_rule, note FROM public.job_registry WHERE job = $1", [r.job])).rows[0];
        assert.equal(reg.deadline_rule, `by ${r.slot}`, r.job);
        const hold = (await c.query(
          "SELECT held_since, cadence_hours, retired_at, note FROM public.rollup_watch_overrides WHERE pipeline = $1",
          [r.pipeline],
        )).rows[0];
        assert.notEqual(hold.held_since, null, `${r.pipeline} still a hold`);
        assert.equal(hold.cadence_hours, null, "not converted");
        assert.equal(hold.retired_at, null);
        assert.match(hold.note, /^FIX-1311 \(cc-232\)/);
        assert.equal((hold.note as string).split(`(${r.fix})`).length - 1, 1, "the hold note is appended once");
        const cron = (await c.query("SELECT active FROM cron.job WHERE jobname = $1", [r.cronName])).rows;
        assert.deepEqual(cron, [{ active: false }], "parked, by name");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: each file applies under the gate's own session hold; RAISEs on a human hold or a second row on its pipeline", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const attempt = async (r: Row, setup: string, params: unknown[] = []): Promise<string | null> => {
    await begin(c);
    try {
      await c.query(r.revert());
      await c.query(setup, params);
      await c.query(r.file());
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await c.query("ROLLBACK");
    }
  };
  try {
    for (const r of ROWS) {
      assert.equal(
        await attempt(r, `UPDATE public.rollup_watch_overrides SET hold_reason = 'prod session held: cc-256 clone test', held_since = now()
                           WHERE pipeline = $1`, [r.pipeline]),
        null,
        `${r.job}: the session's own hold is admitted`,
      );
      assert.match(
        (await attempt(r, "UPDATE public.rollup_watch_overrides SET hold_reason = 'Craig: hands off' WHERE pipeline = $1", [r.pipeline])) ?? "",
        new RegExp(`\\[${r.tag}\\] ${r.pipeline} override is not FIX-1311's takeover hold`),
      );
      assert.match(
        (await attempt(
          r,
          `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, note)
           SELECT job || '-sibling', runner, pipeline, unit_shape, unit_call, priority, 'at 0 0 1 1 *', cost_class, cap_mb, exclusion_group, budget_seconds, gates, 'cc-256 clone test'
             FROM public.job_registry WHERE job = $1`,
          [r.job],
        )) ?? "",
        new RegExp(`\\[${r.tag}\\] read-back failed: .*2 registry rows on ${r.pipeline}`),
      );
    }
  } finally {
    await c.end();
  }
});

test("clone: the live bodies are prod's, and their constants evaluate as the headers say", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    for (const b of Object.values(BODIES)) {
      const live = (await c.query(
        "SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace",
        [b.name],
      )).rows[0];
      assert.equal(live.m, b.md5, `${b.name}: the clone runs prod's body (text tests pin its lines)`);
    }
    // agency: the decision as the body computes it, against the clone's own horizon.
    const decide = async (lagDays: number): Promise<string> =>
      (await c.query(
        `WITH h AS (SELECT public.fr_watermark_horizon() AS h)
         SELECT CASE WHEN h.h - (h.h - make_interval(days => $1::int)) > interval '14 days' THEN 'full' ELSE 'incremental' END AS mode FROM h`,
        [lagDays],
      )).rows[0].mode;
    assert.equal(await decide(18), "full", "the ~18-day park → full (136 agencies on prod)");
    assert.equal(await decide(7), "incremental", "a weekly slot after it → incremental");
    // treemap: a partial's resume a week later is inside c_max_sweep; two weeks later it restarts.
    const resumes = (await c.query(
      "SELECT interval '7 days' <= interval '240 hours' AS week, interval '14 days' <= interval '240 hours' AS fortnight",
    )).rows[0];
    assert.deepEqual(resumes, { week: true, fortnight: false });
  } finally {
    await c.end();
  }
});

/** The tick fixture: every other dispatched row parked, the box fresh at MemAvailable 450, the three DUE. */
async function tickFixture(c: Client, eligible: string[]): Promise<void> {
  const MB = 1048576;
  const SWAP_TOTAL = 1073737728;
  await applyFresh(c);
  await c.query(
    "UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND NOT (job = ANY ($1::text[]))",
    [eligible],
  );
  await c.query("UPDATE public.platform_dials SET pause = false, max_concurrent_units = 10, max_live_caps_mb = 100000, rearm_cooldown_seconds = 0");
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
  for (const r of ROWS) {
    // Its own last advancing run before this week's slot (prod: 10-13 / 10-13 / 10-07), and nothing running.
    await c.query(
      "DELETE FROM public.data_sync_log WHERE pipeline = $1 AND (completed_at >= public.cron_prev_slot($2, now()) OR status = 'running')",
      [r.pipeline, r.slot],
    );
  }
  // Nothing else of group rollups live on the clone.
  await c.query(
    `DELETE FROM public.data_sync_log WHERE status = 'running'
       AND pipeline IN (SELECT pipeline FROM public.job_registry WHERE exclusion_group = 'rollups' AND pipeline IS NOT NULL)`,
  );
}

async function lastTick(c: Client): Promise<{ decision: string; job: string; reason: string; excluded: string[] | null }> {
  return (await c.query("SELECT decision, job, reason, excluded FROM public.dispatch_log ORDER BY id DESC LIMIT 1")).rows[0];
}

test("clone: one tick at MemAvailable 450 arms the earliest prev slot and queues the other two; a second reads group busy: rollups on both", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await tickFixture(c, ROWS.map((r) => r.job));
      // ttd ranks (all priority 3): the earliest prev slot is the pick (agency at a Fri/Sat push).
      const prevs = (await c.query(
        "SELECT j, public.cron_prev_slot(s, now()) AS prev FROM unnest($1::text[], $2::text[]) AS x(j, s) ORDER BY 2, 1",
        [ROWS.map((r) => r.job), ROWS.map((r) => r.slot)],
      )).rows as { j: string }[];
      const [pick, ...rest] = prevs.map((p) => p.j);
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const t1 = await lastTick(c);
      assert.equal(t1.decision, "armed", JSON.stringify(t1));
      assert.equal(t1.job, pick);
      const slot = ROWS.find((r) => r.job === pick)!.slot;
      assert.match(t1.reason, new RegExp(`^by ${re(slot)} → -`), "DUE: ttd negative, since its prev slot");
      assert.deepEqual([...(t1.excluded ?? [])].sort(), rest.map((j) => `queued (${j})`).sort());

      // The second tick: the armed one-shot (no run row, no data_sync_log running row) is the only signal.
      const running = (await c.query(
        "SELECT count(*)::int AS n FROM public.data_sync_log WHERE status = 'running' AND pipeline = ANY ($1::text[])",
        [ROWS.map((r) => r.pipeline)],
      )).rows[0];
      assert.equal(running.n, 0, "no running row anywhere in the chain");
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const t2 = await lastTick(c);
      assert.equal(t2.decision, "nothing_due", JSON.stringify(t2));
      const ex = t2.excluded ?? [];
      assert.ok(ex.includes(`live (${pick})`), JSON.stringify(ex));
      for (const j of rest) assert.ok(ex.includes(`group busy: rollups (${j})`), `${j}: ${JSON.stringify(ex)}`);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone: each no-running-row unit (agency, group-donor) armed alone holds group rollups against the other two", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    for (const solo of [ROWS[1]!, ROWS[2]!, ROWS[0]!]) {
      await begin(c);
      try {
        await tickFixture(c, [solo.job]);
        await c.query("SELECT public.dispatch_one_unit('manual')");
        const t1 = await lastTick(c);
        assert.equal(t1.decision, "armed", JSON.stringify(t1));
        assert.equal(t1.job, solo.job);
        // The other two come back DUE; the armed one-shot is the only live signal.
        for (const r of ROWS.filter((o) => o !== solo)) {
          await c.query("UPDATE public.job_registry SET deadline_rule = $2 WHERE job = $1", [r.job, `by ${r.slot}`]);
        }
        await c.query("SELECT public.dispatch_one_unit('manual')");
        const t2 = await lastTick(c);
        const ex = t2.excluded ?? [];
        for (const r of ROWS.filter((o) => o !== solo)) {
          assert.ok(ex.includes(`group busy: rollups (${r.job})`), `${solo.job} armed → ${r.job}: ${JSON.stringify(ex)}`);
        }
      } finally {
        await c.query("ROLLBACK");
      }
    }
  } finally {
    await c.end();
  }
});
