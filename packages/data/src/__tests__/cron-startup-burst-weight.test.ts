/**
 * FIX-1222 — check_cron_job_health()'s startup-timeout BURST weighs each
 * failure at the 2-minute cadence its threshold was sized on:
 * least(1, interval / 2), the interval being the job's median firing gap from
 * the FIX-1220 `cadence` CTE (COALESCE 2). Every job at 2 minutes or slower
 * weighs 1; the every-minute box-health-probe weighs 0.5.
 *
 * Runs via:  tsx --test src/__tests__/cron-startup-burst-weight.test.ts
 *
 * Source anchors (no DB, run in CI): the latest migration defining the
 * function carries the weight, the threshold on the weighted sum, the runs
 * floor beside it, and STABLE / SECURITY DEFINER / one search_path SET.
 *
 * Behavioural, against the local clone, inside BEGIN … ROLLBACK: synthetic
 * cron.job_run_details rows for jobids no real job uses, in an hourly bucket
 * the clone's own history leaves empty. cc-156's two fixtures: 9 failures of a
 * 2-minute job plus 2 of an every-minute job = 10.0 (escalates, 11 runs), and
 * 9 + 1 = 9.5 (does not, although 10 runs reached the old threshold). Skips
 * when the DB is unreachable or unmigrated.
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

test("FIX-1222: the burst decides on failures weighed at the 2-minute cadence; STABLE, DEFINER, one SET", () => {
  const f = fnSource();
  const header = f.slice(0, f.indexOf("AS $function$"));
  assert.match(header, /\bSTABLE SECURITY DEFINER\b/);
  assert.equal((header.match(/\bSET\s+\w+/g) ?? []).length, 1, "exactly one SET clause");
  assert.match(f, /v_burst_m\s+int := 10;/, "the threshold's value is unchanged");
  assert.match(f, /sum\(LEAST\(1, COALESCE\(c\.interval_minutes, 2\) \/ 2\.0\)\) AS weighted_n/);
  // The weight uses the SAME interval the streak does, not a second estimate.
  assert.match(f, /LEFT JOIN cadence c ON c\.jobid = d\.jobid/);
  assert.match(f, /FROM buckets WHERE n >= v_burst_m\s+(--[^\n]*\n\s*)*AND weighted_n >= v_burst_m/);
  assert.match(f, /'weighted_count', ROUND\(weighted_n, 1\)/);
});

type Burst = { bucket: string; count: number; weighted_count: number | string; jobs: string | null };

async function scenario(c: Client, probeFailures: number): Promise<{ bucket: Date; burst: Burst | undefined } | null> {
  // An hourly bucket inside the 26 h window with no real startup timeout on
  // the clone, so the synthetic rows are the whole bucket.
  const b = await c.query<{ bucket: Date }>(
    `SELECT h AS bucket
       FROM generate_series(date_trunc('hour', now()) - interval '20 hours',
                            date_trunc('hour', now()) - interval '3 hours', interval '1 hour') h
      WHERE NOT EXISTS (SELECT 1 FROM cron.job_run_details d
                         WHERE d.start_time >= h AND d.start_time < h + interval '1 hour'
                           AND d.status = 'failed' AND d.return_message ILIKE '%startup timeout%')
      ORDER BY h DESC LIMIT 1`);
  const bucket = b.rows[0]?.bucket;
  if (!bucket) return null;

  let runid = 9_222_000_000 + probeFailures * 10_000_000;
  // A job's firings every `stepMin` minutes from 2 h before the bucket to its
  // end; the listed firing indexes (counted from the bucket's start) fail with
  // a startup timeout, the rest succeed. Failures are spread out so neither job
  // forms a streak — only the burst is under test.
  const job = async (jobid: number, stepMin: number, failAt: number[]) => {
    const before = Math.round(120 / stepMin);
    const inBucket = Math.round(60 / stepMin);
    for (let k = -before; k < inBucket; k++) {
      const failed = k >= 0 && failAt.includes(k);
      await c.query(
        `INSERT INTO cron.job_run_details
           (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
         VALUES ($1, $2, $3, 'postgres', 'postgres', 'synthetic fix1222', $4, $5,
                 $6::timestamptz + make_interval(mins => $7), $6::timestamptz + make_interval(mins => $7, secs => 1))`,
        [jobid, runid++, failed ? null : 1, failed ? "failed" : "succeeded", failed ? "job startup timeout" : "1 row",
         bucket, k * stepMin]);
    }
  };
  await job(9_222_001, 2, [1, 3, 5, 7, 9, 11, 13, 15, 17]); // a 2-minute watchdog: 9 failures, weight 1 each
  await job(9_222_002, 1, [40, 50].slice(0, probeFailures)); // the probe's shape: weight 0.5 each

  const r = await c.query<{ h: { startup_timeout_tiers: { burst_threshold: number; burst: Burst[] } } }>(
    "SELECT public.check_cron_job_health() AS h");
  const tiers = r.rows[0]!.h.startup_timeout_tiers;
  assert.equal(tiers.burst_threshold, 10);
  const burst = tiers.burst.find((x) => new Date(x.bucket).getTime() === new Date(bucket).getTime());
  return { bucket, burst };
}

async function onClone(t: { skip: (m: string) => void }, body: (c: Client) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const fn = await c.query("SELECT prosrc FROM pg_proc WHERE proname = 'check_cron_job_health' AND pronamespace = 'public'::regnamespace");
    if (fn.rowCount === 0 || !String(fn.rows[0].prosrc).includes("weighted_n")) {
      t.skip("check_cron_job_health() without FIX-1222 on this DB");
      return;
    }
    await c.query("BEGIN");
    await body(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
}

test("FIX-1222: 9 two-minute failures + 2 every-minute failures = 10.0 — escalates (11 runs)", async (t) => {
  await onClone(t, async (c) => {
    const s = await scenario(c, 2);
    if (!s) return t.skip("no startup-timeout-free hour on the clone's last 20 h");
    assert.ok(s.burst, "a bucket weighing 10.0 reaches the threshold of 10");
    assert.equal(Number(s.burst.count), 11);
    assert.equal(Number(s.burst.weighted_count), 10);
  });
});

test("FIX-1222: 9 two-minute failures + 1 every-minute failure = 9.5 — does NOT escalate (10 runs)", async (t) => {
  await onClone(t, async (c) => {
    const s = await scenario(c, 1);
    if (!s) return t.skip("no startup-timeout-free hour on the clone's last 20 h");
    assert.equal(s.burst, undefined, "10 runs, but one is a half-weight probe failure: 9.5 < 10");
  });
});
