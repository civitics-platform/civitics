/**
 * FIX-1448 (cc-331 D7) — `20261127001000_fix1448_vote_rolls_registry_row.sql`:
 * the vote-rolls walker becomes a dispatcher unit, a mirror of bill-details
 * but for its exclusion group. fix1453-bill-details-row.test.ts' cases, re-aimed.
 *
 * Runs via:  tsx --test src/__tests__/fix1448-vote-rolls-row.test.ts
 *
 * Text (no DB, run in CI): the one fenced row parses with check:job-registry's
 * reader and equals the bill-details row (20261126008000's read-back string) in
 * every column but the job, its unit_call, its pipeline (the walker's own
 * PIPELINE) and its exclusion group; the note declares no-band; the guard and
 * the read-back; the revert deletes that one row and nothing else.
 * Clone (CIVITICS_CLONE_TESTS=1), each inside BEGIN … ROLLBACK, r19's staging:
 * never run → armed with its request; a fresh row → not due; bill-details live
 * → no group busy (its own group); a finished run → reaped succeeded: GHA; the
 * status call counts it; the revert takes it out and the file re-applies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";
import { PIPELINE } from "../pipelines/congress/vote-rolls";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const FILE_NAME = "20261127001000_fix1448_vote_rolls_registry_row.sql";
const FILE = () => read(path.join(MIGRATIONS, FILE_NAME));
const CC328 = () => read(path.join(MIGRATIONS, "20261126008000_fix1453_bill_details_registry_row.sql"));
const REVERT = () => read(path.join(ROOT, "scripts", "fix1448-revert-vote-rolls-row.sql"));

/** 20261126008000's read-back string for bill-details, the model row. */
function billDetailsRow(): string {
  const m = /c_row\s+CONSTANT text := '([^']+)';/.exec(CC328());
  assert.ok(m, "20261126008000's read-back names the bill-details row");
  return m[1]!;
}
const ROW_COLS = ["deadline_rule", "runner", "unit_call", "pipeline", "unit_shape", "priority", "cost_class", "cap_mb",
  "exclusion_group", "budget_seconds", "gates", "idempotent_refire", "phase_lock", "yield_to", "yield_lead_seconds"] as const;

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

test("D7: the one fenced row is bill-details' row but for its job, unit_call, pipeline (the walker's own) and exclusion group (its own)", async () => {
  const r = await fence();
  assert.equal(r.job, "vote-rolls");
  assert.equal(PIPELINE, "congress_vote_rolls");
  const mine = ROW_COLS.map((c) => fmt(r[c])).join(" | ");
  const want = billDetailsRow()
    .replace("gha-dispatch:bill-details", "gha-dispatch:vote-rolls")
    .replace("congress_bill_details", PIPELINE)
    .replace(" | proposals | ", " | vote-rolls | ");
  assert.equal(mine, want);
  assert.equal(typeof r["note"] === "string" && (r["note"] as string).includes("no-band"), true, "bands.json has no key: the note declares no-band");
  assert.match(FILE(), /\nON CONFLICT \(job\) DO NOTHING;\n-- job-registry-seed:end\n/);
});

test("the guard: bill-details as cc-330 left it, vote-rolls absent or this file's; the read-back RAISEs on any miss", () => {
  const sql = stripComments(FILE());
  const guard = sql.slice(0, sql.indexOf("INSERT INTO public.job_registry"));
  const bd = billDetailsRow().replace(" | t | f | ", " | t | ");
  assert.ok(guard.includes(`c_bd   CONSTANT text := '${bd}';`));
  assert.ok(guard.includes("IF FOUND AND v_vr IS DISTINCT FROM c_mine THEN"));
  const readBack = sql.slice(sql.lastIndexOf("DO $$"));
  assert.ok(readBack.includes(`c_bd   CONSTANT text := '${billDetailsRow()}';`), "bill-details unchanged");
  assert.ok(readBack.includes("c_disp CONSTANT text := 'd0f5bf5b59120716ab15e73c805435d2';"), "the dispatch_one_unit pin is not moved");
  assert.ok(readBack.includes("(deadline_rule NOT LIKE 'at %' AND unit_call ~ '^gha-dispatch:[a-z0-9-]+$')"), "the pick's eligibility predicate");
  assert.ok(readBack.includes("RAISE EXCEPTION '[fix1448] read-back failed: %'"));
  const outside = sql.replace(/DO \$\$[\s\S]*?END \$\$;/g, "");
  assert.equal(outside.match(/INSERT INTO/g)?.length, 1);
  assert.doesNotMatch(outside, /\b(UPDATE|DELETE FROM|DROP|ALTER|CREATE)\b/i);
  assert.doesNotMatch(sql.replace(/INSERT INTO public\.job_registry[\s\S]*?ON CONFLICT \(job\) DO NOTHING;/, ""), /\b(UPDATE public\.|DELETE FROM|INSERT INTO)/);
});

test("the revert deletes the one row the file wrote, guarded on it, and nothing else", () => {
  const sql = stripComments(REVERT());
  assert.equal(sql.match(/DELETE FROM/g)?.length, 1);
  assert.ok(sql.includes("DELETE FROM public.job_registry WHERE job = 'vote-rolls';"));
  assert.ok(sql.includes("c_row CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:vote-rolls | congress_vote_rolls';"));
  assert.doesNotMatch(sql, /\b(UPDATE|DROP|INSERT INTO|ALTER)\b/i);
});

test("the version is above every other migration", () => {
  const all = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  assert.equal(all[all.length - 1], FILE_NAME);
  assert.equal(all[all.length - 2], "20261127000000_fix1448_vote_rolls.sql");
});

// ---------------------------------------------------------------------------
// Clone — r19's staging, the migrated vote-rolls row
// ---------------------------------------------------------------------------

async function inTx(t: { skip: (m: string) => void }, fn: (c: Client) => Promise<void>): Promise<void> {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  try {
    if (!(await c.query("SELECT 1 FROM public.job_registry WHERE job = 'vote-rolls'")).rowCount) {
      t.skip("20261127001000 is not applied on the clone");
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
  await c.query("DELETE FROM public.data_sync_log WHERE pipeline IN ('congress_bill_details', 'congress_vote_rolls', 'nightly_cron')");
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
             $5::jsonb || '{"cc331": true}'::jsonb)`,
    [pipeline, status, start, end, JSON.stringify(metadata)],
  );
}

test("clone: never run → armed with gha_dispatch_request_vote-rolls; a fresh row (the chunk's) → not due", async (t) => {
  await inTx(t, async (c) => {
    await stage(c, ["vote-rolls"]);
    const t1 = await tick(c);
    assert.equal(t1.decision, "armed", t1.reason);
    assert.equal(t1.job, "vote-rolls");
    assert.match(t1.reason, /^stale_after 2 hours → .*; request gha_dispatch_request_vote-rolls$/, t1.reason);
    console.info(`[fix1448] never run: ${t1.reason}`);
    const req = (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'gha_dispatch_request_vote-rolls'")).rows[0].value;
    assert.equal(req.job, "vote-rolls");
    assert.equal(req.dispatch_log_id, t1.id);
  });
  await inTx(t, async (c) => {
    await stage(c, ["vote-rolls"]);
    await row(c, "congress_vote_rolls", "partial", 20, 5);
    const t1 = await tick(c);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM public.dispatch_log WHERE decision = 'armed'")).rows[0].n, 0);
    assert.match(t1.reason, /next: vote-rolls in 01:5[45]:/, t1.reason);
  });
});

test("clone: bill-details live → no group busy for vote-rolls (its own group); a finished run with no phase reaps succeeded: GHA", async (t) => {
  await inTx(t, async (c) => {
    await stage(c, ["vote-rolls"]);
    await row(c, "congress_bill_details", "running", 2, null);
    const t1 = await tick(c);
    assert.equal(t1.excluded.find((e) => e.endsWith("(vote-rolls)") && e.startsWith("group busy")), undefined, t1.reason);
    assert.equal(t1.job, "vote-rolls", t1.reason);
  });
  await inTx(t, async (c) => {
    await stage(c, ["vote-rolls"]);
    await c.query(
      `INSERT INTO public.pipeline_state (key, value, updated_at)
       VALUES ('gha_dispatch_request_vote-rolls',
               jsonb_build_object('job', 'vote-rolls', 'requested_at', clock_timestamp() - interval '20 minutes', 'dispatch_log_id', NULL,
                                  'consumed_at', clock_timestamp() - interval '19 minutes', 'outcome', 'dispatched', 'http_status', 204, 'reaped_at', NULL), now())`,
    );
    await row(c, "congress_vote_rolls", "partial", 18, 2, { stop: "max_minutes" });
    await tick(c);
    const r = (await c.query("SELECT decision, reason FROM public.dispatch_log WHERE job = 'vote-rolls' AND decision = 'reaped' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.deepEqual(r, { decision: "reaped", reason: "succeeded: GHA" });
  });
});

test("clone: the status call counts vote-rolls; the revert takes it out of the pick; the file re-applies, idempotent", async (t) => {
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
    assert.equal((await c.query("SELECT count(*)::int AS n FROM public.job_registry WHERE job = 'vote-rolls'")).rows[0].n, 0);
    await c.query(FILE());
    assert.equal(await elig(), n0);
    await c.query(FILE());
    assert.equal(await elig(), n0, "idempotent");
  });
});
