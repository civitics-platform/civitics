/**
 * FIX-1453 (cc-328 D6) — `20261126008000_fix1453_bill_details_registry_row.sql`:
 * the bill-details walker becomes a dispatcher unit, a mirror of crs-summaries.
 *
 * Runs via:  tsx --test src/__tests__/fix1453-bill-details-row.test.ts
 *
 * Text (no DB, run in CI): the one fenced row parses with check:job-registry's
 * reader and equals cc-318's crs-summaries row (20261126004000's read-back
 * string) in every column but the job, its unit_call and its pipeline, which is
 * the walker's own PIPELINE; the note declares no-band; the guard and the
 * read-back; the revert deletes that one row and nothing else.
 * Clone (CIVITICS_CLONE_TESTS=1), each inside BEGIN … ROLLBACK, r19's staging:
 * never run → armed with its request; a fresh row → not due; crs-summaries live
 * → group busy; a finished run → reaped succeeded: GHA; the status call counts
 * it; the revert takes it out and the file re-applies, idempotent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";
import { PIPELINE } from "../pipelines/congress/bill-details";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const FILE_NAME = "20261126008000_fix1453_bill_details_registry_row.sql";
const FILE = () => read(path.join(MIGRATIONS, FILE_NAME));
const CC318 = () => read(path.join(MIGRATIONS, "20261126004000_fix1454_fix1455_gha_one_row_reap_and_crs_walker_row.sql"));
const REVERT = () => read(path.join(ROOT, "scripts", "fix1453-revert-bill-details-row.sql"));

/** cc-318's read-back string for crs-summaries, the model row. */
function crsRow(): string {
  const m = /c_row\s+CONSTANT text := '([^']+)';/.exec(CC318());
  assert.ok(m, "20261126004000's read-back names the crs-summaries row");
  return m[1]!;
}
const ROW_COLS = ["deadline_rule", "runner", "unit_call", "pipeline", "unit_shape", "priority", "cost_class", "cap_mb",
  "exclusion_group", "budget_seconds", "gates", "idempotent_refire", "yield_to", "yield_lead_seconds"] as const;

type Fence = Record<string, unknown> & { job: string };
async function fence(): Promise<Fence> {
  const m = (await import(pathToFileURL(path.join(ROOT, "scripts", "check-job-registry.mjs")).href)) as {
    parseSeedFences: (src: string, file: string) => { rows: Fence[]; problems: string[] };
  };
  const { rows, problems } = m.parseSeedFences(FILE(), FILE_NAME);
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 1);
  return rows[0]!;
}
const fmt = (v: unknown) => (v === true ? "t" : v === false ? "f" : String(v));

test("D6: the one fenced row is cc-318's crs-summaries row but for its job, unit_call and pipeline (the walker's own)", async () => {
  const r = await fence();
  assert.equal(r.job, "bill-details");
  assert.equal(PIPELINE, "congress_bill_details");
  const mine = ROW_COLS.map((c) => fmt(r[c])).join(" | ");
  const want = crsRow()
    .replace("gha-dispatch:crs-summaries", "gha-dispatch:bill-details")
    .replace("congress_crs_summaries", PIPELINE);
  assert.equal(mine, want);
  assert.equal(r["phase_lock"], false);
  assert.equal(typeof r["note"] === "string" && (r["note"] as string).includes("no-band"), true, "bands.json has no key: the note declares no-band");
  assert.match(FILE(), /\nON CONFLICT \(job\) DO NOTHING;\n-- job-registry-seed:end\n/);
});

test("the guard: crs-summaries as cc-318 left it, bill-details absent or this file's; the read-back RAISEs on any miss", () => {
  const sql = stripComments(FILE());
  const guard = sql.slice(0, sql.indexOf("INSERT INTO public.job_registry"));
  assert.ok(guard.includes(`c_crs  CONSTANT text := '${crsRow()}';`));
  assert.ok(guard.includes("IF FOUND AND v_bd IS DISTINCT FROM c_mine THEN"));
  const readBack = sql.slice(sql.lastIndexOf("DO $$"));
  assert.ok(readBack.includes("c_disp CONSTANT text := 'd0f5bf5b59120716ab15e73c805435d2';"), "the dispatch_one_unit pin is not moved");
  assert.ok(readBack.includes("(deadline_rule NOT LIKE 'at %' AND unit_call ~ '^gha-dispatch:[a-z0-9-]+$')"), "the pick's eligibility predicate");
  assert.ok(readBack.includes("RAISE EXCEPTION '[fix1453] read-back failed: %'"));
  // One INSERT of one table; nothing else written outside the DO blocks.
  const outside = sql.replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.equal(outside.match(/INSERT INTO/g)?.length, 1);
  assert.doesNotMatch(outside, /\b(UPDATE|DELETE FROM|DROP|ALTER|CREATE)\b/i);
  assert.doesNotMatch(sql.replace(/INSERT INTO public\.job_registry[\s\S]*?ON CONFLICT \(job\) DO NOTHING;/, ""), /\b(UPDATE public\.|DELETE FROM|INSERT INTO)/);
});

test("the revert deletes the one row the file wrote, guarded on it, and nothing else", () => {
  const sql = stripComments(REVERT());
  assert.equal(sql.match(/DELETE FROM/g)?.length, 1);
  assert.ok(sql.includes("DELETE FROM public.job_registry WHERE job = 'bill-details';"));
  assert.ok(sql.includes("c_row CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:bill-details | congress_bill_details';"));
  assert.doesNotMatch(sql, /\b(UPDATE|DROP|INSERT INTO|ALTER)\b/i);
});

test("the version is above every other migration", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(all[all.length - 1], FILE_NAME);
});

// ---------------------------------------------------------------------------
// Clone — r19's staging, the migrated bill-details row
// ---------------------------------------------------------------------------

async function inTx(t: { skip: (m: string) => void }, fn: (c: Client) => Promise<void>): Promise<void> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  try {
    if (!(await c.query("SELECT 1 FROM public.job_registry WHERE job = 'bill-details'")).rowCount) {
      t.skip("20261126008000 is not applied on the clone");
      return;
    }
    await c.query("BEGIN");
    try {
      await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
      await fn(c);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
}

/** r19's stage: prod's dials, no mirror / session / hold / request, an empty dispatch_log, a fresh probe; every looped row parked but `keep`; no recent walker rows. */
async function stage(c: Client, keep: string[]): Promise<void> {
  await c.query(
    `UPDATE public.platform_dials SET pause = false, rearm_cooldown_seconds = 0, max_live_caps_mb = 100000,
            landing_after_minutes = 30, landing_quiet_factor = 3, stall_hold_minutes = 120, ramp_minutes = 60, max_concurrent_units = 2`,
  );
  await c.query("DELETE FROM public.pipeline_state WHERE key IN ('box_health_mem', 'prod_session', 'dispatcher_hold') OR key LIKE 'gha_dispatch_request_%'");
  await c.query("DELETE FROM public.dispatch_log");
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', 0,
                                              'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  );
  await c.query(
    "UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job <> 'dispatcher-tick' AND job <> ALL ($1::text[])",
    [keep],
  );
  await c.query("DELETE FROM public.data_sync_log WHERE pipeline IN ('congress_crs_summaries', 'congress_bill_details', 'nightly_cron')");
}

type Tick = { id: number; decision: string; job: string | null; reason: string; excluded: string[] };
async function tick(c: Client): Promise<Tick> {
  const id = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d.id;
  const r = (await c.query("SELECT decision, job, reason, excluded FROM public.dispatch_log WHERE id = $1", [id])).rows[0];
  return { id, decision: r.decision, job: r.job, reason: r.reason, excluded: (r.excluded as string[] | null) ?? [] };
}
async function row(c: Client, pipeline: string, status: string, start: number, end: number | null, metadata: Record<string, unknown> = {}): Promise<void> {
  await c.query(
    `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
     VALUES ($1, $2, clock_timestamp() - make_interval(secs => $3::float8 * 60),
             CASE WHEN $4::float8 IS NULL THEN NULL ELSE clock_timestamp() - make_interval(secs => $4::float8 * 60) END,
             $5::jsonb || '{"cc328": true}'::jsonb)`,
    [pipeline, status, start, end, JSON.stringify(metadata)],
  );
}

test("clone: never run → armed with gha_dispatch_request_bill-details (prod's state at the push); a fresh row → not due", async (t) => {
  await inTx(t, async (c) => {
    await stage(c, ["bill-details"]);
    const t1 = await tick(c);
    assert.equal(t1.decision, "armed", t1.reason);
    assert.equal(t1.job, "bill-details");
    assert.match(t1.reason, /^stale_after 2 hours → .*; request gha_dispatch_request_bill-details$/, t1.reason);
    console.info(`[fix1453] never run: ${t1.reason}`);
    const req = (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'gha_dispatch_request_bill-details'")).rows[0].value;
    assert.equal(req.job, "bill-details");
    assert.equal(req.dispatch_log_id, t1.id);
  });
  await inTx(t, async (c) => {
    await stage(c, ["bill-details"]);
    await row(c, "congress_bill_details", "partial", 20, 5);
    const t1 = await tick(c);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM public.dispatch_log WHERE decision = 'armed'")).rows[0].n, 0);
    assert.match(t1.reason, /next: bill-details in 01:5[45]:/, t1.reason);
  });
});

test("clone: crs-summaries live → group busy: proposals; a finished run with no phase reaps succeeded: GHA", async (t) => {
  await inTx(t, async (c) => {
    await stage(c, ["bill-details"]);
    await row(c, "congress_crs_summaries", "running", 2, null);
    const t1 = await tick(c);
    assert.equal(t1.excluded.find((e) => e.endsWith("(bill-details)")), "group busy: proposals (bill-details)", t1.reason);
  });
  await inTx(t, async (c) => {
    await stage(c, ["bill-details"]);
    await c.query(
      `INSERT INTO public.pipeline_state (key, value, updated_at)
       VALUES ('gha_dispatch_request_bill-details',
               jsonb_build_object('job', 'bill-details', 'requested_at', clock_timestamp() - interval '20 minutes', 'dispatch_log_id', NULL,
                                  'consumed_at', clock_timestamp() - interval '19 minutes', 'outcome', 'dispatched', 'http_status', 204, 'reaped_at', NULL), now())`,
    );
    await row(c, "congress_bill_details", "partial", 18, 2, { stop: "max_minutes" });
    await tick(c);
    const r = (await c.query("SELECT decision, reason FROM public.dispatch_log WHERE job = 'bill-details' AND decision = 'reaped' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.deepEqual(r, { decision: "reaped", reason: "succeeded: GHA" });
  });
});

test("clone: the status call counts bill-details; the revert takes it out of the pick; the file re-applies, idempotent", async (t) => {
  await inTx(t, async (c) => {
    const elig = async () => (await c.query("SELECT public.get_dispatcher_status() AS s")).rows[0].s.registry.eligible as number;
    const predicate = async () => (await c.query(
      `SELECT count(*)::int AS n FROM public.job_registry j WHERE j.deadline_rule NOT LIKE 'at %'
         AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$')`,
    )).rows[0].n as number;
    const n0 = await elig();
    assert.equal(n0, await predicate(), "the status call counts what the pick admits");
    await c.query(REVERT());
    await c.query(REVERT());
    assert.equal(await elig(), n0 - 1);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM public.job_registry WHERE job = 'bill-details'")).rows[0].n, 0);
    await c.query(FILE());
    assert.equal(await elig(), n0);
    await c.query(FILE());
    assert.equal(await elig(), n0, "idempotent");
  });
});
