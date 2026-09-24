/**
 * FIX-1194 P1-B / FIX-1125 — the box_health probe, box_is_saturated() and the
 * on-box memory stamp (20260920130000_fix1194_box_health_probe.sql).
 *
 * Runs via:  tsx --test src/__tests__/box-health-probe.test.ts
 *
 * Source anchors (no DB, run in CI): each function's SET clause is search_path
 * only (check:proconfig — no transaction control here, so proconfig is legal,
 * and a statement_timeout one would be inert); the startup-timeout predicate is
 * prod_op_gate()'s, byte for byte (rule 93 — one predicate, and two copies that
 * could drift are the thing this test exists to stop); box_is_saturated()'s
 * watchdog-wall constant is prod_op_gate()'s c_wd_max_wall_s; the job is
 * `* * * * *` with a 60 s cron_job_budget row (rule 120).
 *
 * Behavioural, against the local clone, inside BEGIN … ROLLBACK. The probe
 * case writes synthetic cron.job_run_details rows at a p_now in 2030 — where
 * no real row exists — with explicit runids, and finds the watchdogs by NAME
 * (jobids differ between prod and the clone). Skips when the DB is unreachable
 * or the migration is not applied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS = path.join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const MIGRATION = path.join(MIGRATIONS, "20260920130000_fix1194_box_health_probe.sql");
const GATE = path.join(MIGRATIONS, "20260920120000_fix1215_prod_op_gate.sql");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** The one startup-timeout predicate (rule 93), whitespace-normalised. */
const PREDICATE = "d.status = 'failed' AND d.return_message ILIKE '%startup timeout%'";
const norm = (s: string) => s.replace(/\s+/g, " ");

function header(src: string, fn: string): string {
  const i = src.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  assert.notEqual(i, -1, `${fn} is defined in the migration`);
  return src.slice(i, src.indexOf("AS $function$", i));
}

function body(src: string, fn: string): string {
  const i = src.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  const a = src.indexOf("AS $function$", i);
  return src.slice(a, src.indexOf("$function$;", a + 13));
}

// ---------------------------------------------------------------------------
// Source anchors — no database.
// ---------------------------------------------------------------------------

const SRC = fs.readFileSync(MIGRATION, "utf8");

test("FIX-1194: every function's only SET clause is search_path; DEFINER only on the mem stamp", () => {
  for (const [fn, security] of [
    ["record_box_health", "SECURITY INVOKER"],
    ["box_is_saturated", "SECURITY INVOKER"],
    ["record_box_health_mem", "SECURITY DEFINER"],
  ] as const) {
    const h = header(SRC, fn);
    assert.match(h, new RegExp(`\\b${security}\\b`), `${fn} is ${security}`);
    assert.match(h, /\bVOLATILE\b/, `${fn} is VOLATILE`);
    assert.equal((h.match(/\bSET\s+\w+/g) ?? []).length, 1, `${fn}: exactly one SET clause`);
    assert.match(h, /SET search_path TO /, `${fn}: the one SET is search_path`);
    assert.doesNotMatch(body(SRC, fn), /\bCOMMIT\b|statement_timeout/i, `${fn}: no txn control, no timeout`);
  }
});

test("FIX-1194: the startup-timeout predicate is prod_op_gate()'s, byte for byte (rule 93)", () => {
  const gate = fs.readFileSync(GATE, "utf8");
  assert.ok(norm(gate).includes(PREDICATE), "prod_op_gate() carries the predicate");
  assert.ok(norm(body(SRC, "record_box_health")).includes(PREDICATE), "the probe carries the SAME predicate");
  // No second spelling of the idea anywhere in the probe.
  assert.equal((body(SRC, "record_box_health").match(/startup timeout/g) ?? []).length, 1);
});

test("FIX-1194: box_is_saturated()'s watchdog wall is prod_op_gate()'s c_wd_max_wall_s", () => {
  const gate = fs.readFileSync(GATE, "utf8");
  const g = /c_wd_max_wall_s\s+CONSTANT numeric\s+:=\s+([\d.]+);/.exec(gate);
  const b = /c_watchdog_wall_s CONSTANT numeric := ([\d.]+);/.exec(body(SRC, "box_is_saturated"));
  assert.ok(g && b, "both constants found");
  assert.equal(Number(b![1]), Number(g![1]));
});

test("FIX-1194: the probe scans cron.job_run_details ONCE (the cost section's whole argument)", () => {
  const b = body(SRC, "record_box_health").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  assert.equal((b.match(/cron\.job_run_details/g) ?? []).length, 1);
  assert.match(b, /WITH d AS MATERIALIZED/);
  // It stamps on every firing and has no handler that could keep `at` fresh
  // while the readings are absent.
  assert.match(b, /INSERT INTO public\.pipeline_state[\s\S]*'box_health'/);
  assert.doesNotMatch(b, /\bEXCEPTION\b/);
});

test("FIX-1194: the job is * * * * *, single-statement, with a 60 s budget row (rule 120)", () => {
  assert.match(SRC, /cron\.schedule\('box-health-probe', '\* \* \* \* \*',\s*\$job\$SELECT public\.record_box_health\(\)\$job\$\)/);
  assert.match(SRC, /\('box-health-probe', 60,/);
  assert.match(SRC, /ON CONFLICT \(jobname\) DO NOTHING/);
});

test("FIX-1194: grants — the probe runs as postgres only; the reader and the stamp go to service_role", () => {
  assert.match(SRC, /REVOKE ALL ON FUNCTION public\.record_box_health\(timestamptz\) FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(SRC, /GRANT EXECUTE ON FUNCTION public\.record_box_health\(/);
  for (const sig of ["box_is_saturated(int, int, timestamptz)", "record_box_health_mem(jsonb)"]) {
    const s = sig.replace(/[()]/g, "\\$&");
    assert.match(SRC, new RegExp(`REVOKE ALL ON FUNCTION public\\.${s} FROM PUBLIC, anon, authenticated;`));
    assert.match(SRC, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${s} TO service_role;`));
  }
});

// ---------------------------------------------------------------------------
// Behavioural — the clone, rolled back.
// ---------------------------------------------------------------------------

type Sat = {
  saturated: boolean;
  reason: string;
  age_seconds: number | null;
  readings: { probe: Record<string, any> | null; memory: Record<string, any> | null };
};

let runid = 9_194_000_000;

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return null;
  }
  const fn = await c.query(
    "SELECT 1 FROM pg_proc WHERE proname = 'box_is_saturated' AND pronamespace = 'public'::regnamespace",
  );
  if (fn.rowCount === 0) {
    await c.end();
    t.skip("20260920130000 not migrated on this DB");
    return null;
  }
  return c;
}

async function inTx(c: Client, fn: () => Promise<void>): Promise<void> {
  await c.query("BEGIN");
  try {
    await fn();
  } finally {
    await c.query("ROLLBACK");
  }
}

const NOON = "2030-03-12 12:00:00+00";

async function stamp(c: Client, value: Record<string, unknown> | null, key = "box_health"): Promise<void> {
  await c.query("DELETE FROM public.pipeline_state WHERE key = $1", [key]);
  if (value !== null) {
    await c.query("INSERT INTO public.pipeline_state (key, value) VALUES ($1, $2::jsonb)", [key, JSON.stringify(value)]);
  }
}

async function saturated(c: Client, now = NOON): Promise<Sat> {
  const r = await c.query<{ s: Sat }>("SELECT public.box_is_saturated(180, 3, $1::timestamptz) AS s", [now]);
  return r.rows[0]!.s;
}

const healthy = (at: string) => ({
  at,
  startup_timeouts_10m: 0,
  startup_timeouts_60m: 0,
  watchdog_max_wall_10m: { budget: 0.016, unit: 0.004 },
  watchdog_runs_10m: { budget: 5, unit: 5 },
});

test("FIX-1194: box_is_saturated() — stale / absent / fork_failures / watchdog_wall / clear", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    const cases: Array<[string, Record<string, unknown> | null, string]> = [
      ["absent stamp is stale", null, "stale"],
      ["200 s old is stale", healthy("2030-03-12 11:56:40+00"), "stale"],
      ["179 s old is fresh and clear", healthy("2030-03-12 11:57:01+00"), "clear"],
      ["3 startup timeouts in 10 min", { ...healthy("2030-03-12 11:59:30+00"), startup_timeouts_10m: 3 }, "fork_failures"],
      ["2 startup timeouts is under the default", { ...healthy("2030-03-12 11:59:30+00"), startup_timeouts_10m: 2 }, "clear"],
      ["a 1.341 s watchdog wall (cc-147)",
        { ...healthy("2030-03-12 11:59:30+00"), watchdog_max_wall_10m: { budget: 1.341, unit: 0.004 } }, "watchdog_wall"],
      ["exactly 1.0 s is not over", { ...healthy("2030-03-12 11:59:30+00"), watchdog_max_wall_10m: { budget: 1.0, unit: 1.0 } }, "clear"],
      ["stale beats fork_failures", { ...healthy("2030-03-12 11:50:00+00"), startup_timeouts_10m: 9 }, "stale"],
    ];
    for (const [name, value, want] of cases) {
      await inTx(c, async () => {
        await stamp(c, value);
        const s = await saturated(c);
        assert.equal(s.reason, want, `${name}: ${JSON.stringify(s)}`);
        assert.equal(s.saturated, want !== "clear", name);
      });
    }
  } finally {
    await c.end();
  }
});

test("FIX-1194: memory is REPORT-ONLY — returned in readings, never sets saturated", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    await inTx(c, async () => {
      await stamp(c, healthy("2030-03-12 11:59:30+00"));
      // 1 MB available of 904 MB: as low as memory gets, and still `clear`.
      await stamp(c, {
        at: "2030-03-12 11:58:00+00", mem_available_bytes: 1048576, mem_total_bytes: 948195328,
        swap_total_bytes: 1073737728, swap_free_bytes: 502247424, load1: 7.5,
      }, "box_health_mem");
      const s = await saturated(c);
      assert.equal(s.saturated, false, JSON.stringify(s));
      assert.equal(s.reason, "clear");
      assert.equal(s.readings.memory!["mem_available_mb"], 1);
      assert.equal(s.readings.memory!["mem_total_mb"], 904);
      assert.equal(s.readings.memory!["swap_used_mb"], 545);
      assert.equal(s.readings.memory!["age_seconds"], 120);
    });
  } finally {
    await c.end();
  }
});

test("FIX-1194: record_box_health() on the clone — the stamp appears, readings from synthetic rows", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    const ids = await c.query<{ jobname: string; jobid: number }>(
      "SELECT jobname, jobid FROM cron.job WHERE jobname IN ('cron-job-budget-watchdog', 'derived-mvs-unit-watchdog', 'donor-rollup-refresh')",
    );
    const id = new Map(ids.rows.map((r) => [r.jobname, r.jobid]));
    if (!id.has("cron-job-budget-watchdog") || !id.has("derived-mvs-unit-watchdog") || !id.has("donor-rollup-refresh")) {
      t.skip("the clone lacks a watchdog or donor-rollup-refresh job");
      return;
    }
    const row = async (job: number, start: string, end: string | null, status: string, msg = "") =>
      c.query(
        `INSERT INTO cron.job_run_details
           (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
         VALUES ($1, $2, 1, 'postgres', 'postgres', 'synthetic fix1194', $3, $4, $5::timestamptz, $6::timestamptz)`,
        [job, runid++, status, msg, start, end],
      );
    await inTx(c, async () => {
      const b = id.get("cron-job-budget-watchdog")!;
      const u = id.get("derived-mvs-unit-watchdog")!;
      // Budget watchdog: 1.5 s, then two startup timeouts (one inside 10 min, one at 30 min).
      await row(b, "2030-03-12 11:58:00+00", "2030-03-12 11:58:01.5+00", "succeeded");
      await row(b, "2030-03-12 11:56:00+00", "2030-03-12 11:56:10+00", "failed", "job startup timeout");
      await row(b, "2030-03-12 11:30:00+00", "2030-03-12 11:30:10+00", "failed", "job startup timeout");
      await row(u, "2030-03-12 11:58:00+00", "2030-03-12 11:58:00.004+00", "succeeded");
      // A near miss that must NOT count: failed, but not a startup timeout.
      await row(u, "2030-03-12 11:54:00+00", "2030-03-12 11:54:01+00", "failed", "canceling statement due to statement timeout");
      // A budgeted job running 4 h. Over or under is read from its budget row,
      // not assumed: the clone's is 9,000 s today, prod's seed was 14,400.
      await row(id.get("donor-rollup-refresh")!, "2030-03-12 08:00:00+00", null, "running");
      const budget = (await c.query<{ b: number }>(
        "SELECT budget_seconds AS b FROM public.cron_job_budget WHERE jobname = 'donor-rollup-refresh'",
      )).rows[0]?.b;
      assert.ok(budget, "donor-rollup-refresh has a budget row");

      const r = await c.query<{ v: Record<string, any> }>("SELECT public.record_box_health($1::timestamptz) AS v", [NOON]);
      const v = r.rows[0]!.v;
      console.log(`[fix1194] probe on the clone: probe_ms=${v["probe_ms"]} ${JSON.stringify(v)}`);
      assert.equal(v["startup_timeouts_10m"], 1);
      assert.equal(v["startup_timeouts_60m"], 2);
      // The 10-s startup-timeout row IS the budget watchdog's max wall — prod_op_gate reads it the same way.
      assert.equal(Number(v["watchdog_max_wall_10m"]["budget"]), 10);
      assert.equal(Number(v["watchdog_max_wall_10m"]["unit"]), 1);
      assert.equal(v["watchdog_runs_10m"]["budget"], 2);
      assert.equal(v["watchdog_runs_10m"]["unit"], 2);
      assert.equal(v["running_budgeted_jobs"], 1);
      assert.equal(v["running_over_budget"], 14400 > budget! ? 1 : 0);
      assert.equal(v["oldest_running_s"], 14400);
      assert.equal(typeof v["backends"]["client"], "number");
      assert.equal(typeof v["probe_ms"], "number");

      const s = await c.query<{ value: Record<string, any> }>("SELECT value FROM public.pipeline_state WHERE key = 'box_health'");
      assert.equal(Date.parse(s.rows[0]!.value["at"]), Date.parse("2030-03-12T12:00:00Z"), "the stamp's `at` is the firing's");
      // And the reader sees a fresh stamp with 1 failure and a 10 s wall.
      assert.equal((await saturated(c)).reason, "watchdog_wall");
    });
  } finally {
    await c.end();
  }
});

test("FIX-1125: record_box_health_mem() validates, drops unknown keys, stamps the DB clock", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    const call = (p: unknown) => c.query<{ r: Record<string, any> }>("SELECT public.record_box_health_mem($1::jsonb) AS r", [JSON.stringify(p)]);
    const good = { mem_available_bytes: 418258944, mem_total_bytes: 948195328, load1: 0.14, route_at: "2026-09-24T01:34:29.602Z" };

    await inTx(c, async () => {
      const r = (await call({ ...good, bogus: 1 })).rows[0]!.r;
      assert.deepEqual(r["ignored_keys"], ["bogus"]);
      const v = (await c.query<{ value: Record<string, any> }>("SELECT value FROM public.pipeline_state WHERE key = 'box_health_mem'")).rows[0]!.value;
      assert.equal(v["mem_available_bytes"], 418258944);
      assert.equal(v["route_at"], good.route_at);
      assert.ok(!("bogus" in v), "an unlisted key is not stored");
      assert.ok(typeof v["at"] === "string" && v["at"] !== good.route_at, "`at` is the DB clock, not the route's");
    });

    for (const [name, p] of [
      ["missing mem_total_bytes", { mem_available_bytes: 1 }],
      ["available > total", { mem_available_bytes: 2, mem_total_bytes: 1 }],
      ["a string where a number belongs", { ...good, load1: "0.14" }],
      ["a non-object", [1, 2]],
      ["an unparseable route_at", { ...good, route_at: "not a time" }],
    ] as const) {
      await inTx(c, async () => {
        await assert.rejects(call(p), (e: { code?: string }) => e.code === "22023" || e.code === "22007" || e.code === "22008", name);
      });
    }
  } finally {
    await c.end();
  }
});
