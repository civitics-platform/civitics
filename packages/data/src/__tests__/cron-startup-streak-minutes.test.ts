/**
 * FIX-1220 — check_cron_job_health()'s startup-timeout STREAK keys on minutes
 * as well as runs (rule 178: a new every-minute job recalibrates every alert
 * that counts failures per run).
 *
 * Runs via:  tsx --test src/__tests__/cron-startup-streak-minutes.test.ts
 *
 * Source anchors (no DB, run in CI): the latest migration defining the
 * function carries the minutes floor, keeps the runs floor, and keeps STABLE /
 * SECURITY DEFINER / search_path as its only SET clause.
 *
 * Behavioural, against the local clone, inside BEGIN … ROLLBACK: synthetic
 * cron.job_run_details rows (no FK to cron.job, explicit runids — postgres has
 * no USAGE on cron.runid_seq) for jobids no real job uses, shaped as cc-153
 * measured them on prod. Only those jobids are asserted on; the clone's own
 * history is left alone. Skips when the DB is unreachable or unmigrated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const DEFINES = "CREATE OR REPLACE FUNCTION public.check_cron_job_health(";
const MIGRATION = path.join(
  MIGRATIONS_DIR,
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").includes(DEFINES))
    .pop()!,
);
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function fnSource(): string {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const i = src.indexOf(DEFINES);
  return src.slice(i, src.indexOf("$function$;", src.indexOf("AS $function$", i)));
}

test("FIX-1220: the streak needs runs >= 6 AND runs x interval >= 12 min; STABLE, DEFINER, one SET", () => {
  const f = fnSource();
  const header = f.slice(0, f.indexOf("AS $function$"));
  assert.match(header, /\bSTABLE SECURITY DEFINER\b/);
  assert.equal((header.match(/\bSET\s+\w+/g) ?? []).length, 1, "exactly one SET clause");
  assert.match(header, /SET search_path TO 'public', 'cron', 'pg_catalog'/);
  assert.match(f, /v_streak_n\s+int := 6;/, "the runs floor stays");
  assert.match(f, /v_streak_min\s+int := 12;/);
  assert.match(f, /WHERE s\.streak >= v_streak_n\s+AND s\.streak \* COALESCE\(c\.interval_minutes, 2\) >= v_streak_min/);
  // Both the degrade branch and the real answer report the new threshold.
  assert.equal((f.match(/'streak_minutes_threshold', v_streak_min/g) ?? []).length, 2);
  // The burst's runs floor stays; FIX-1222 adds the weighted decision beside it
  // (cron-startup-burst-weight.test.ts owns that rule).
  assert.match(f, /FROM buckets WHERE n >= v_burst_m/);
});

type Streak = { jobid: number; streak: number; interval_minutes: number; streak_minutes: number };
type Tiers = { streak_threshold: number; streak_minutes_threshold: number; per_job: Streak[] };

test("FIX-1220: cc-153's fixtures on the clone (rolled back)", async (t) => {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const fn = await c.query("SELECT prosrc FROM pg_proc WHERE proname = 'check_cron_job_health' AND pronamespace = 'public'::regnamespace");
    if (fn.rowCount === 0 || !String(fn.rows[0].prosrc).includes("v_streak_min")) {
      t.skip("check_cron_job_health() without FIX-1220 on this DB");
      return;
    }
    await c.query("BEGIN");
    let runid = 9_220_000_000;
    // One job's history: `ok` successes every `stepMin` minutes, then startup
    // timeouts at the offsets given (minutes after the first), ending `endAgo`
    // minutes before now().
    const job = async (jobid: number, stepMin: number, ok: number, toOffsets: number[], endAgo = 20) => {
      const last = toOffsets[toOffsets.length - 1]!;
      const t0 = `now() - make_interval(mins => ${endAgo + last})`;
      await c.query(
        `INSERT INTO cron.job_run_details
           (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
         SELECT $1, $2::bigint + g, 1, 'postgres', 'postgres', 'synthetic fix1220', 'succeeded', '1 row',
                ${t0} - make_interval(mins => $3 * g), ${t0} - make_interval(mins => $3 * g) + interval '1 second'
           FROM generate_series(1, $4) g`,
        [jobid, runid, stepMin, ok]);
      runid += ok + 1;
      for (const off of toOffsets) {
        await c.query(
          `INSERT INTO cron.job_run_details
             (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
           VALUES ($1, $2, NULL, 'postgres', 'postgres', 'synthetic fix1220', 'failed', 'job startup timeout',
                   ${t0} + make_interval(secs => $3), ${t0} + make_interval(secs => $3 + 10))`,
          [jobid, runid++, Math.round(off * 60)]);
      }
    };
    const every = (n: number, step: number) => Array.from({ length: n }, (_, i) => i * step);

    await job(9_220_001, 1, 60, every(6, 1));   // the probe's shape: 6 in a row = 6 min
    await job(9_220_002, 1, 60, every(12, 1));  // 12 in a row = 12 min
    await job(9_220_003, 2, 60, every(6, 2));   // a */2 watchdog: 6 in a row = 12 min
    // Queued firings released in a bunch (09-22 fired 16:01:04, 16:02:07,
    // 16:03:25, 16:04:06 …): first-to-last is 6 min, so a span-based rule would
    // read 6 + 2 = 8 min. Runs x interval reads 12.
    await job(9_220_004, 2, 60, [0, 0.5, 1.0, 1.5, 2.0, 6.0]);
    await job(9_220_005, 60, 20, every(5, 60), 5);  // hourly, 5 in a row: 300 min, but 5 runs
    await job(9_220_006, 1440, 1, [0], 60);         // a daily job's one lost firing

    const r = await c.query<{ h: { startup_timeout_tiers: Tiers } }>("SELECT public.check_cron_job_health() AS h");
    const tiers = r.rows[0]!.h.startup_timeout_tiers;
    assert.equal(tiers.streak_threshold, 6);
    assert.equal(tiers.streak_minutes_threshold, 12);
    const by = new Map(tiers.per_job.filter((s) => s.jobid >= 9_220_001 && s.jobid <= 9_220_006).map((s) => [s.jobid, s]));

    assert.equal(by.has(9_220_001), false, "the probe's 6-minute streak does NOT escalate");
    const p12 = by.get(9_220_002);
    assert.ok(p12, "the probe escalates at 12 runs = 12 min");
    assert.equal(p12.streak, 12);
    assert.equal(Number(p12.interval_minutes), 1);
    assert.equal(Number(p12.streak_minutes), 12);
    const w = by.get(9_220_003);
    assert.ok(w, "a */2 watchdog's 6 consecutive still escalates — unchanged");
    assert.equal(w.streak, 6);
    assert.equal(Number(w.interval_minutes), 2);
    assert.equal(Number(w.streak_minutes), 12);
    assert.ok(by.get(9_220_004), "bunched firings under stress cannot shorten a */2 streak below 12 min");
    assert.equal(by.has(9_220_005), false, "5 runs never escalate, however many minutes they span");
    assert.equal(by.has(9_220_006), false, "a slow job's single lost firing is weather (FIX-1073)");
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
});
