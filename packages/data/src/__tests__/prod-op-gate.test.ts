/**
 * FIX-1215 — prod_op_gate(): every branch, with time injected.
 *
 * Runs via:  tsx --test src/__tests__/prod-op-gate.test.ts
 *
 * Source anchors (no DB, run in CI): the function is VOLATILE / SECURITY
 * INVOKER with search_path as its ONLY SET clause (check:proconfig), and the
 * guarded-set regexes are byte-identical to cron-job-pipelines.ts — two
 * derivations of one set that could drift is exactly what rule 122 forbids.
 *
 * Behavioural, against the local clone. `cron.job_run_details` there is LOCAL
 * HISTORY (CLAUDE.md: "cron.job is a prod-only read"), so every case runs at a
 * p_now in 2030 — where no real row exists — inside BEGIN … ROLLBACK, with
 * the synthetic rows it needs. Explicit runids (postgres has no USAGE on
 * cron.runid_seq). Jobs are found by NAME: jobids differ between prod and the
 * clone. Skips when the DB is unreachable or the function is not migrated.
 * Cheap (milliseconds per case), so not behind CIVITICS_DB_HEAVY_TESTS.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import {
  Q_GUARDED_PIPELINES,
  RE_COMMENT_ONLY_LINE,
  RE_PIPELINE_FROM_INSERT,
  RE_PIPELINE_FROM_LOCAL,
  RE_PROC_FROM_COMMAND,
} from "../lib/cron-job-pipelines";

const MIGRATION = path.join(
  __dirname, "..", "..", "..", "..",
  "supabase", "migrations", "20260920120000_fix1215_prod_op_gate.sql",
);
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function header(src: string): string {
  const i = src.indexOf("CREATE OR REPLACE FUNCTION public.prod_op_gate(");
  assert.notEqual(i, -1);
  return src.slice(i, src.indexOf("AS $function$", i));
}

// ---------------------------------------------------------------------------
// Source anchors — no database.
// ---------------------------------------------------------------------------

test("FIX-1215: VOLATILE, SECURITY INVOKER, search_path the only SET clause", () => {
  const h = header(fs.readFileSync(MIGRATION, "utf8"));
  assert.match(h, /\bVOLATILE\b/);
  assert.match(h, /\bSECURITY INVOKER\b/);
  assert.match(h, /SET search_path TO 'public', 'pg_catalog'/);
  assert.equal((h.match(/\bSET\s+\w+/g) ?? []).length, 1, "exactly one SET clause");
  assert.match(h, /p_now\s+timestamptz DEFAULT clock_timestamp\(\)/);
});

test("FIX-1215: the guarded-set regexes are the cron-job-pipelines.ts constants, byte for byte", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  for (const [name, re] of Object.entries({
    RE_PROC_FROM_COMMAND, RE_COMMENT_ONLY_LINE, RE_PIPELINE_FROM_INSERT, RE_PIPELINE_FROM_LOCAL,
  })) {
    assert.ok(src.includes(`'${re}'`), `${name} is not in the migration verbatim: ${re}`);
  }
});

test("FIX-1215: every clock comparison reads p_now — no now() in the body", () => {
  const src = fs.readFileSync(MIGRATION, "utf8");
  const body = src.slice(src.indexOf("AS $function$"), src.lastIndexOf("$function$"))
    .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  assert.doesNotMatch(body, /\bnow\(\)/);
  assert.doesNotMatch(body, /clock_timestamp\(\)/);
});

// ---------------------------------------------------------------------------
// Behavioural — synthetic rows at p_now in 2030, rolled back.
// ---------------------------------------------------------------------------

type Blocked = { check: string; name: string; detail: string; retry_after: string | null };
type Gate = { ok: boolean; blocked_by: Blocked[]; readings: Record<string, any> };

let runid = 9_150_000_000;

async function jobid(c: Client, name: string): Promise<number | null> {
  const r = await c.query<{ jobid: number }>("SELECT jobid FROM cron.job WHERE jobname = $1", [name]);
  return r.rows[0]?.jobid ?? null;
}

async function run(c: Client, job: number, start: string, end: string | null, status = "succeeded", msg = ""): Promise<void> {
  await c.query(
    `INSERT INTO cron.job_run_details
       (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
     VALUES ($1, $2, 1, 'postgres', 'postgres', 'synthetic fix1215', $3, $4, $5::timestamptz, $6::timestamptz)`,
    [job, runid++, status, msg, start, end]);
}

async function gate(c: Client, now: string, expected = 5400): Promise<Gate> {
  const r = await c.query<{ g: Gate }>("SELECT public.prod_op_gate($1, $2::timestamptz) AS g", [expected, now]);
  return r.rows[0]!.g;
}

const has = (g: Gate, check: string, name?: string) =>
  g.blocked_by.some((b) => b.check === check && (name === undefined || b.name === name));

test("FIX-1215: prod_op_gate() branches on the clone (p_now injected, rolled back)", async (t) => {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  try {
    const fn = await c.query("SELECT 1 FROM pg_proc WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace");
    if (fn.rowCount === 0) {
      t.skip("prod_op_gate() not migrated on this DB");
      return;
    }

    // Healthy watchdogs for the hour before `now` (30 runs each), written as
    // SQL so the interval arithmetic is Postgres's. `lastWall` is the newest run.
    const watchdogs = async (now: string, wall = 0.05, lastWall = wall) => {
      await c.query(`
        INSERT INTO cron.job_run_details
          (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
        SELECT j.jobid, $3::bigint + row_number() OVER (), 1, 'postgres', 'postgres', 'synthetic fix1215',
               'succeeded', '', t, t + make_interval(secs => CASE WHEN k = 1 THEN $4::float8 ELSE $2::float8 END)
          FROM cron.job j
          CROSS JOIN generate_series(1, 30) k
          CROSS JOIN LATERAL (SELECT $1::timestamptz - make_interval(mins => 2 * k - 1) AS t) x
         WHERE j.schedule = '*/2 * * * *' AND j.active`, [now, wall, runid, lastWall]);
      runid += 1000;
    };

    const cases: Array<[string, () => Promise<void>]> = [];
    const tx = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

    const NOON = "2030-03-12 12:00:00+00";
    const ecv = await jobid(c, "ec-vacuum-analyze");
    const fev = await jobid(c, "fe-vacuum-analyze");
    const frv = await jobid(c, "fr-vacuum-analyze");
    assert.ok(ecv && fev && frv, "the clone has the three daily vacuum jobs");

    tx("all clear at 12:00 with healthy watchdogs", async () => {
      await watchdogs(NOON);
      const g = await gate(c, NOON);
      console.log(`[fix1215] clear: ok=${g.ok} blocked=${JSON.stringify(g.blocked_by)}`);
      assert.deepEqual(g.blocked_by.filter((b) => b.check !== "e"), [], "only the live interlock may block here");
      assert.equal(g.readings["watchdogs"].jobs.length >= 2, true);
    });

    tx("(b) a > 60 s vacuum ended 30 min ago blocks; 100 min ago clears", async () => {
      await watchdogs(NOON);
      await run(c, ecv!, "2030-03-12 11:28:00+00", "2030-03-12 11:30:00+00");
      const g = await gate(c, NOON);
      assert.ok(has(g, "b", "ec-vacuum-analyze"), JSON.stringify(g.blocked_by));
      assert.match(g.blocked_by.find((b) => b.check === "b")!.detail, /ran 120\.0 s/);
    });
    tx("(b) …ended 100 min ago → clear", async () => {
      await watchdogs(NOON);
      await run(c, ecv!, "2030-03-12 10:18:00+00", "2030-03-12 10:20:00+00");
      const g = await gate(c, NOON);
      assert.ok(!has(g, "b"), JSON.stringify(g.blocked_by));
    });
    tx("(b) a 2 s vacuum ended 5 min ago blocks", async () => {
      await watchdogs(NOON);
      await run(c, fev!, "2030-03-12 11:54:58+00", "2030-03-12 11:55:00+00");
      const g = await gate(c, NOON);
      assert.ok(has(g, "b", "fe-vacuum-analyze"), JSON.stringify(g.blocked_by));
    });
    tx("(b) …ended 15 min ago → clear", async () => {
      await watchdogs(NOON);
      await run(c, fev!, "2030-03-12 11:44:58+00", "2030-03-12 11:45:00+00");
      const g = await gate(c, NOON);
      assert.ok(!has(g, "b"), JSON.stringify(g.blocked_by));
    });
    tx("(b) a running vacuum blocks", async () => {
      await watchdogs(NOON);
      await run(c, fev!, "2030-03-12 11:58:00+00", null, "running");
      const g = await gate(c, NOON);
      assert.ok(has(g, "b", "fe-vacuum-analyze"), JSON.stringify(g.blocked_by));
    });

    const active = (await c.query<{ active: boolean }>("SELECT active FROM cron.job WHERE jobid = $1", [frv])).rows[0]!.active;
    tx("(b) a > 60 s-mean daily slot 40 min ahead: expected 1800 blocks, 600 clears", async () => {
      if (!active) { console.log("[fix1215] fr-vacuum-analyze inactive on this clone — slot case not exercised"); return; }
      const now = "2030-03-12 02:20:00+00";
      await watchdogs(now);
      for (const d of ["09", "10", "11"]) {
        await run(c, frv!, `2030-03-${d} 03:00:00+00`, `2030-03-${d} 03:02:00+00`);
      }
      const g1 = await gate(c, now, 1800);
      assert.ok(has(g1, "b", "fr-vacuum-analyze"), JSON.stringify(g1.blocked_by));
      const g2 = await gate(c, now, 600);
      assert.ok(!has(g2, "b"), JSON.stringify(g2.blocked_by));
    });

    tx("(b) an unparsed schedule is reported and never blocks", async () => {
      await watchdogs(NOON);
      const g = await gate(c, NOON);
      const unparsed = g.readings["vacuum"].unparsed as Array<{ schedule: string }>;
      assert.ok(unparsed.every((u) => !/^\d+ \d+ \* \* \*$/.test(u.schedule)));
      assert.ok(unparsed.length > 0, "the 11,17 series should be listed");
    });

    tx("(d) a startup-timeout failure 30 min ago blocks", async () => {
      await watchdogs(NOON);
      await run(c, fev!, "2030-03-12 11:30:00+00", "2030-03-12 11:30:10+00", "failed", "job startup timeout");
      const g = await gate(c, NOON);
      assert.ok(has(g, "d", "startup_timeout"), JSON.stringify(g.blocked_by));
    });
    tx("(d) no watchdog runs in the hour blocks; a 1.5 s wall in the last 10 min blocks", async () => {
      const g0 = await gate(c, NOON);
      assert.ok(g0.blocked_by.filter((b) => b.check === "d").length >= 2, JSON.stringify(g0.blocked_by));
      await watchdogs(NOON, 0.05, 1.5);
      const g1 = await gate(c, NOON);
      assert.ok(g1.blocked_by.some((b) => b.check === "d" && /max wall 1\.500/.test(b.detail)), JSON.stringify(g1.blocked_by));
    });

    tx("(c) 06:00 UTC is inside the blackout", async () => {
      const now = "2030-03-12 06:00:00+00";
      await watchdogs(now);
      const g = await gate(c, now);
      const b = g.blocked_by.find((x) => x.check === "c");
      assert.ok(b, JSON.stringify(g.blocked_by));
      assert.match(b!.detail, /is open now/);
      assert.equal(new Date(b!.retry_after!).toISOString(), "2030-03-12T09:00:00.000Z");
    });
    tx("(c) an ec_crawl.blackout of [] falls back to the constant", async () => {
      await c.query(`UPDATE public.pipeline_state SET value = jsonb_set(value, '{blackout}', '[]'::jsonb) WHERE key = 'ec_crawl'`);
      const now = "2030-03-12 04:00:00+00";
      await watchdogs(now);
      const g = await gate(c, now, 3600);   // span to 06:00 → crosses 05:45
      assert.match(g.readings["blackout"].source, /^constant/);
      assert.ok(has(g, "c"), JSON.stringify(g.blocked_by));
    });
    tx("(c) the pipeline_state window is the one used, span-bounded, wrap-midnight included", async () => {
      await c.query(`
        INSERT INTO public.pipeline_state (key, value) VALUES ('ec_crawl', '{"blackout":[{"from":"13:00","to":"14:00"}]}')
        ON CONFLICT (key) DO UPDATE SET value = jsonb_set(pipeline_state.value, '{blackout}', '[{"from":"13:00","to":"14:00"}]'::jsonb)`);
      await watchdogs(NOON);
      const g1 = await gate(c, NOON, 1800);   // span to 13:00 — touches, does not enter
      assert.equal(g1.readings["blackout"].source, "pipeline_state.ec_crawl");
      assert.ok(!has(g1, "c"), JSON.stringify(g1.blocked_by));
      const g2 = await gate(c, NOON, 3600);   // span to 14:00
      assert.ok(has(g2, "c"), JSON.stringify(g2.blocked_by));
      await c.query(`UPDATE public.pipeline_state SET value = jsonb_set(value, '{blackout}', '[{"from":"23:00","to":"01:00"}]'::jsonb) WHERE key = 'ec_crawl'`);
      const g3 = await gate(c, "2030-03-12 00:30:00+00", 600);
      assert.ok(g3.blocked_by.some((b) => b.check === "c" && /is open now/.test(b.detail)), JSON.stringify(g3.blocked_by));
    });

    tx("(a) a running nightly phase blocks", async () => {
      await watchdogs(NOON);
      await c.query(`INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
                     VALUES ('nightly_cron', 'running', '2030-03-12 11:40:00+00', '{"phase":"fec"}')`);
      const g = await gate(c, NOON);
      assert.ok(has(g, "a", "nightly_running"), JSON.stringify(g.blocked_by));
    });
    tx("(a) the next nightly start closer than 2 x expected + 15 min blocks", async () => {
      const now = "2030-03-12 20:00:00+00";
      await watchdogs(now);
      const g = await gate(c, now);   // 155 min to 22:35 < 195
      assert.ok(has(g, "a", "nightly_next_start"), JSON.stringify(g.blocked_by));
      const g2 = await gate(c, now, 1800);  // needs 75 min
      assert.ok(!has(g2, "a"), JSON.stringify(g2.blocked_by));
    });
    tx("(a) past 22:35 with no nightly row yet reads as due", async () => {
      const now = "2030-03-12 22:40:00+00";
      await watchdogs(now);
      const g = await gate(c, now, 600);
      assert.ok(has(g, "a", "nightly_due"), JSON.stringify(g.blocked_by));
    });

    tx("(f) a guarded unit running > 60 min blocks", async () => {
      await watchdogs(NOON);
      await c.query(`INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
                     VALUES ('donor_party_rollup_refresh', 'running', '2030-03-12 10:30:00+00', '{}')`);
      const g = await gate(c, NOON);
      assert.ok(has(g, "f", "stuck_units"), JSON.stringify(g.blocked_by));
    });
    tx("(f) the derived guarded set equals Q_GUARDED_PIPELINES", async () => {
      const g = await gate(c, NOON);
      const q = await c.query<{ pipeline: string }>(Q_GUARDED_PIPELINES);
      assert.deepEqual(g.readings["stuck_units"].guarded_pipelines, q.rows.map((r) => r.pipeline));
    });

    for (const [name, fn] of cases) {
      await t.test(name, async () => {
        await c.query("BEGIN");
        try {
          await fn();
        } finally {
          await c.query("ROLLBACK");
        }
      });
    }
  } finally {
    await c.end();
  }
});
