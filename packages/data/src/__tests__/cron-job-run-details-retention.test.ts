/**
 * FIX-1221 + FIX-1223 — cron.job_run_details keeps 42 days, and the one reader
 * that looked past that stops needing the purged rows.
 *
 * Runs via:  tsx --test src/__tests__/cron-job-run-details-retention.test.ts
 *
 * Source anchors (no DB, run in CI), against the latest migration that
 * defines list_scheduled_rollup_pipelines() and the one that schedules the
 * retention job:
 *   - the FIX-1135 era boundary reads public.cron_job_first_seen;
 *   - correlation reads both sides from v_corr_since, and its 42 days is the
 *     retention job's 42 days (one number, two places — pinned here);
 *   - the correlation join goes through a shared minute, never a bare range
 *     (FIX-1223: the range join cost 35.7 s on prod and the canary's 8 s
 *     timeout fell back to a 1-entry literal for 17 days), with
 *     enable_nestloop off so a 1-row misestimate cannot bring it back;
 *   - the job: one statement, an odd minute off the crawls, a budget row.
 *
 * Behavioural, against the local clone, inside BEGIN … ROLLBACK:
 *   - a synthetic driver's era boundary does not move when its run rows older
 *     than 42 days are deleted (the purge, simulated on its rows only);
 *   - a run in an INTERIOR minute of a long firing still correlates to it,
 *     and a run 2 minutes outside every firing does not.
 * Skips when the DB is unreachable or unmigrated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function latestContaining(needle: string): string {
  const f = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .filter((n) => fs.readFileSync(path.join(MIGRATIONS_DIR, n), "utf8").includes(needle))
    .pop();
  assert.ok(f, `no migration contains ${needle}`);
  return fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
}

const DEFINES = "CREATE OR REPLACE FUNCTION public.list_scheduled_rollup_pipelines(";

function registrySource(): string {
  const src = latestContaining(DEFINES);
  const i = src.indexOf(DEFINES);
  return src.slice(i, src.indexOf("$function$;", src.indexOf("AS $function$", i)));
}

test("FIX-1221: the era boundary reads cron_job_first_seen, and correlation reads the retention window", () => {
  const f = registrySource();
  assert.match(f, /LEAST\(min\(fs\.first_seen_at\), min\(rd\.start_time\)\) AS first_firing/);
  assert.match(f, /LEFT JOIN public\.cron_job_first_seen fs ON fs\.jobname = j\.jobname/);
  assert.match(f, /v_corr_since timestamptz := GREATEST\(v_since, now\(\) - make_interval\(days => \d+\)\)/);
  // Both sides of the two-sided support test, and the firings, read v_corr_since.
  assert.match(f, /runs AS \(SELECT pipeline, started_at FROM all_runs WHERE metadata->>'source' LIKE 'pg_cron%'\s+AND started_at >= v_corr_since\)/);
  assert.match(f, /FROM cron\.job_run_details\s+WHERE start_time >= v_corr_since GROUP BY 1/);
  assert.match(f, /FROM cron\.job_run_details d\s+WHERE d\.start_time >= v_corr_since/);
});

test("FIX-1223: correlation joins through a shared minute, with nested loops off", () => {
  const f = registrySource();
  const header = f.slice(0, f.indexOf("AS $function$"));
  assert.match(header, /\bSTABLE SECURITY DEFINER\b/);
  assert.match(header, /SET search_path TO 'public', 'cron', 'pg_catalog'/);
  assert.match(header, /SET enable_nestloop TO 'off'/);
  assert.equal((header.match(/\bSET\s+\w+/g) ?? []).length, 2, "search_path and enable_nestloop, nothing else");
  assert.doesNotMatch(header, /statement_timeout/, "a routine-level statement_timeout bounds nothing (FIX-1128)");
  assert.match(f, /firing_minutes AS MATERIALIZED \(/);
  assert.match(f, /generate_series\(date_trunc\('minute', f\.lo\), date_trunc\('minute', f\.hi\),\s+interval '1 minute'\)/);
  assert.match(f, /ON d\.minute = date_trunc\('minute', r\.started_at\)\s+AND r\.started_at BETWEEN d\.lo AND d\.hi/);
  // The old shape — a join whose only condition is the range — must not return.
  assert.doesNotMatch(f, /JOIN cron\.job_run_details d\s+ON r\.started_at BETWEEN/);
});

test("FIX-1221: the retention job deletes at the registry's 42 days, one statement, 01:51, budgeted", () => {
  const f = registrySource();
  const corrDays = Number(/v_corr_since timestamptz := GREATEST\(v_since, now\(\) - make_interval\(days => (\d+)\)\)/.exec(f)![1]);
  const job = latestContaining("'cron-job-run-details-retention'");
  const m = /cron\.schedule\(c_jobname, c_sched,\s+\$job\$(.*?)\$job\$\)/s.exec(job);
  assert.ok(m, "the job is scheduled by name");
  const cmd = m[1]!;
  assert.doesNotMatch(cmd, /;/, "one statement: a multi-statement pg_cron command runs in an implicit transaction block");
  const retentionDays = Number(/^DELETE FROM cron\.job_run_details WHERE start_time < now\(\) - make_interval\(days => (\d+)\)$/.exec(cmd)?.[1]);
  assert.equal(retentionDays, corrDays, "the purge and the registry's correlation window are one number");
  assert.equal(retentionDays, 42);
  const sched = /c_sched\s+CONSTANT text := '([^']+)'/.exec(job)![1]!;
  assert.equal(sched, "51 1 * * *");
  const [min, hour] = sched.split(" ").map(Number) as [number, number];
  assert.equal(min % 2, 1, "an odd minute clears the */2 watchdogs");
  assert.notEqual(min % 15, 0, "clear of ec-crawl (*/15) and fe-crawl (*/30)");
  assert.ok(hour >= 18 || hour <= 5, "inside the 18-05 UTC quiet band");
  assert.match(job, /INSERT INTO public\.cron_job_budget \(jobname, budget_seconds, note\)\s+VALUES \(\s+'cron-job-run-details-retention',\s+300,/);
});

type Element = { pipeline: string; jobname: string | null; cadence_hours: number | string; cadence_source: string; cadence_support: number; escalate_after_hours: number | string | null };

async function onClone(t: { skip: (m: string) => void }, body: (c: Client) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const fn = await c.query("SELECT prosrc FROM pg_proc WHERE proname = 'list_scheduled_rollup_pipelines' AND pronamespace = 'public'::regnamespace");
    if (fn.rowCount === 0 || !String(fn.rows[0].prosrc).includes("cron_job_first_seen")) {
      t.skip("list_scheduled_rollup_pipelines() without FIX-1221 on this DB");
      return;
    }
    await c.query("BEGIN");
    await body(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
}

async function element(c: Client, pipeline: string): Promise<Element | undefined> {
  const r = await c.query<{ r: { pipelines: Element[] } }>("SELECT public.list_scheduled_rollup_pipelines() AS r");
  return r.rows[0]!.r.pipelines.find((p) => p.pipeline === pipeline);
}

let runid = 9_221_000_000;
async function firing(c: Client, jobid: number, startSql: string, minutes: number): Promise<void> {
  await c.query(
    `INSERT INTO cron.job_run_details
       (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
     VALUES ($1, $2, 1, 'postgres', 'postgres', 'synthetic fix1221', 'succeeded', '1 row',
             ${startSql}, ${startSql} + make_interval(mins => $3))`,
    [jobid, runid++, minutes]);
}
async function closure(c: Client, pipeline: string, startSql: string, status = "complete"): Promise<void> {
  await c.query(
    `INSERT INTO public.data_sync_log (pipeline, started_at, completed_at, rows_inserted, rows_updated, status, metadata)
     VALUES ($1, ${startSql}, ${startSql} + interval '30 seconds', 1, 0, $2, '{"source":"pg_cron"}'::jsonb)`,
    [pipeline, status]);
}

test("FIX-1221: a driver's era boundary does not move when its runs older than 42 days are purged", async (t) => {
  await onClone(t, async (c) => {
    // A schedule cron_cadence_hours() does not parse, so the cadence is the
    // OBSERVED median over closures anchored at the era boundary — the case
    // where the boundary decides whether the pipeline can escalate at all.
    const s = await c.query<{ id: number }>(
      `SELECT cron.schedule('zz-fix1221-era', '*/15 * * * *', 'SELECT 1') AS id`);
    const jobid = Number(s.rows[0]!.id);
    const P = "zz_fix1221_era";
    await c.query(`INSERT INTO public.cron_job_first_seen (jobname, first_seen_at)
                   VALUES ('zz-fix1221-era', now() - interval '60 days')
                   ON CONFLICT (jobname) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at`);
    // The job's firings: every 10 days from its first sighting, 60 days ago.
    for (let d = 60; d >= 0; d -= 10) await firing(c, jobid, `now() - make_interval(days => ${d})`, 1);
    // Closures of the OLD driver, daily, before the job existed: excluded by
    // the era boundary, or the median would read 24 h.
    for (let d = 80; d >= 61; d--) await closure(c, P, `now() - make_interval(days => ${d})`);
    // The new driver's closures, 10 days apart from its first firing: 7
    // closures = 6 gaps. After a purge that moved the boundary to 42 days
    // ago, only 4 (-40 … -10) + today would count — and the old boundary
    // from min(start_time) would have done exactly that.
    for (let d = 60; d >= 0; d -= 10) await closure(c, P, `now() - make_interval(days => ${d}) + interval '1 minute'`);

    const before = await element(c, P);
    assert.ok(before, "the synthetic pipeline is listed");
    assert.equal(before.cadence_source, "observed_median");
    assert.equal(Number(before.cadence_hours), 240, "10-day cadence: the old driver's daily closures are outside the era");
    assert.equal(before.cadence_support, 6);
    assert.ok(before.escalate_after_hours !== null, "6 gaps >= the 4-gap support floor");

    // The purge, on this job's rows only.
    await c.query(`DELETE FROM cron.job_run_details WHERE jobid = $1 AND start_time < now() - interval '42 days'`, [jobid]);
    const after = await element(c, P);
    assert.ok(after);
    assert.equal(Number(after.cadence_hours), 240);
    assert.equal(after.cadence_support, 6, "the boundary is the ledger's, not the oldest retained firing");
    assert.deepEqual(after.escalate_after_hours, before.escalate_after_hours);
  });
});

test("FIX-1223: a run in an interior minute of a long firing correlates; one 2 minutes outside does not", async (t) => {
  await onClone(t, async (c) => {
    // A job whose name matches no pipeline, so the pipelines below can only
    // find it by TIME (by_time -> the two-sided support test).
    const s = await c.query<{ id: number }>(
      `SELECT cron.schedule('zz-fix1221-long-firings', '7 3 * * *', 'SELECT 1') AS id`);
    const jobid = Number(s.rows[0]!.id);
    const IN = "zz_fix1221_interior_runs";
    const OUT = "zz_fix1221_outside_runs";
    // 19:13 UTC: no fixed-hour job on this instance fires between 18:00 and
    // 23:59, so no real daily job's window can claim these runs by time. (The
    // */1, */2, */15 and */30 jobs fire thousands of times in the window, far
    // under the support test's 25% on their side.)
    for (let d = 20; d >= 1; d--) {
      const start = `date_trunc('day', now()) - make_interval(days => ${d}) + interval '19 hours 13 minutes'`;
      // A 30-minute firing: [start - 90 s, start + 30 min + 90 s].
      await firing(c, jobid, start, 30);
      // Its pipeline's run, 17 minutes in: an interior minute, neither the
      // firing's first nor its last.
      await closure(c, IN, `${start} + interval '17 minutes 20 seconds'`);
      // A run 2 minutes after the window closes.
      await closure(c, OUT, `${start} + interval '33 minutes 31 seconds'`);
    }
    const inside = await element(c, IN);
    assert.ok(inside);
    assert.equal(inside.jobname, "zz-fix1221-long-firings", "runs inside the firing's window are correlated to it");
    const outside = await element(c, OUT);
    assert.ok(outside);
    assert.equal(outside.jobname, null, "runs outside every firing's window are not");
  });
});
