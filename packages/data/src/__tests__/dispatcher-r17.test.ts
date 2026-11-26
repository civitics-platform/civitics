/**
 * cc-292 — the three-file class-P push:
 *   A *_fix1421_reap_closes_a_failed_units_running_rows.sql   (FIX-1421, a PIN MOVE)
 *   B *_fix1423_ec_crawl_stale_after_25_minutes.sql           (FIX-1423)
 *   C *_fix1424_three_gha_starts_by_vercel_dispatch.sql        (FIX-1424)
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r17.test.ts
 *
 * Text (no DB, run in CI): A's body is FIX-1361's plus ONLY the close and the
 * reason suffix (a line diff), the close sits in step 3's failed arm, c_running_win,
 * the census, step 3b and the pick are byte-equal, the md5 is the read-back's,
 * the revert is FIX-1361's text; every v_missing element is ::text (rule 421);
 * B and C match on the exact old text and pair with their reverts.
 * Clone (CIVITICS_CLONE_TESTS=1), each inside BEGIN … ROLLBACK: the failed run is
 * fabricated as the reap reads one — a dispatch_log `armed` row with a jobid no
 * cron.job carries (so the reap skips cron.unschedule) and a runid_floor, and a
 * cron.job_run_details row `failed` above that floor. One tick closes the unit's
 * row; a row that started before the run, another pipeline's row and a succeeded
 * unit's row are left alone; the reaped row moves no anchor; FIX-1361's body (the
 * revert) reads the same row `live`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { MOVED_LINEAGE, PIN_LINEAGE, atCurrentPins, read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const script = (f: string) => read(path.join(ROOT, "scripts", f));

const A = () => one("_fix1421_reap_closes_a_failed_units_running_rows.sql");
const B = () => one("_fix1423_ec_crawl_stale_after_25_minutes.sql");
const C = () => one("_fix1424_three_gha_starts_by_vercel_dispatch.sql");
const LIVE = () => one("_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql");
const REVERT_A = () => script("fix1421-revert-reap-close.sql");
const REVERT_B = () => script("fix1423-revert-ec-crawl-cadence.sql");
const REVERT_C = () => script("fix1424-revert-gha-dispatch-starts.sql");

/** FIX-1361's body (history) and this push's. */
const WAS = "d6a9073bcc4d9084b9d7994324a89b18";
const NOW = "142869d4f55f8eae73c7dd49ceae4b7a";
/** The three pins this push leaves where cc-267 put them. */
const PINS = {
  get_dispatcher_status: "d6bb02aab3eb8c9625275227f564c5c9",
  box_is_saturated: "b05961ca6d1cf7e56874071bfe334da1",
  prod_op_gate: "70a799ab3df2484fc424fe2762ffa797",
};

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

/** A routine's prosrc: the LAST definition in the text, between its dollar quotes. */
function prosrc(src: string): string {
  const i = src.lastIndexOf("CREATE OR REPLACE FUNCTION public.dispatch_one_unit");
  assert.notEqual(i, -1, "dispatch_one_unit is defined");
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, "no dollar-quoted body");
  return m[2] as string;
}

/** The lines `b` drops from `a` and the lines it adds (an LCS line diff). */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split("\n");
  const y = b.split("\n");
  const L = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; } else if (L[i + 1]![j]! >= L[i]![j + 1]!) removed.push(x[i++]!); else added.push(y[j++]!);
  }
  while (i < x.length) removed.push(x[i++]!);
  while (j < y.length) added.push(y[j++]!);
  return { removed, added };
}

/** The text between two markers of a body (the start marker included). */
function section(body: string, from: string, to: string): string {
  const i = body.indexOf(from);
  const k = body.indexOf(to, i + from.length);
  assert.ok(i !== -1 && k !== -1, `section ${from} … ${to}`);
  return body.slice(i, k);
}

// ---------------------------------------------------------------------------
// Text — file A
// ---------------------------------------------------------------------------

test("A: the body is FIX-1361's plus ONLY the close and the reason suffix, and hashes to the read-back's pin", () => {
  const was = prosrc(LIVE());
  const now = prosrc(A());
  assert.equal(md5(was), WAS, "the history file's body");
  assert.equal(md5(now), NOW, "this file's body");
  const d = lineDiff(was, now);
  assert.deepEqual(d.removed, ["                 r.run_status || ': ' || left(COALESCE(r.run_message, ''), 200),"]);
  assert.equal(d.added.length, 23, d.added.join("\n"));
  assert.deepEqual(d.added.slice(-2), [
    "                 r.run_status || ': ' || left(COALESCE(r.run_message, ''), 200)",
    "                   || CASE WHEN v_closed > 0 THEN format('; closed %s running row(s)', v_closed) ELSE '' END,",
  ]);
  const code = stripComments(d.added.join("\n"));
  for (const l of [
    /v_closed\s+int;/,
    /\(SELECT j\.pipeline FROM public\.job_registry j WHERE j\.job = armed\.job\) AS pipeline,/,
    /v_closed := 0;/,
    /IF r\.run_status = 'failed' AND r\.pipeline IS NOT NULL THEN/,
    /UPDATE public\.data_sync_log l/,
    /GET DIAGNOSTICS v_closed = ROW_COUNT;/,
  ]) assert.match(code, l);
  console.info(`[r17] A body ${was.split("\n").length} → ${now.split("\n").length} lines; −${d.removed.length} +${d.added.length}`);
});

test("A: the close sits inside step 3's succeeded|failed arm, before that arm's reap row, and nowhere else", () => {
  const body = prosrc(A());
  const step3 = section(body, "-- ── 3. reap ──", "-- ── 3b. reap a GHA arm");
  const arm = section(step3, "IF r.run_status IN ('succeeded', 'failed') THEN", "ELSIF r.run_status IS NOT NULL THEN");
  const close = section(arm, "IF r.run_status = 'failed' AND r.pipeline IS NOT NULL THEN", "INSERT INTO public.dispatch_log");
  const sql = stripComments(close);
  assert.match(sql, /SET status\s+= 'reaped',/);
  assert.match(sql, /completed_at\s+= r\.run_end,/);
  assert.match(sql, /error_message = 'reaped_orphan — the unit''s cron run ended failed: '\s+\|\| left\(COALESCE\(r\.run_message, ''\), 200\),/);
  assert.match(sql, /'reaped', true, 'reaped_at', v_now,\s+'reaped_by', 'dispatch_one_unit', 'armed_jobname', r\.armed_jobname\)/);
  assert.match(sql, /WHERE l\.pipeline = r\.pipeline AND l\.status = 'running'\s+AND l\.started_at >= r\.run_start AND l\.started_at <= r\.run_end;/);
  assert.equal(stripComments(body).split("UPDATE public.data_sync_log").length - 1, 1, "the body's one data_sync_log write");
  assert.ok(arm.indexOf("v_closed := 0;") < arm.indexOf("INSERT INTO public.dispatch_log"), "counted before the reap row");
});

test("A: c_running_win, the census, step 3b, the box and the pick are byte-equal to FIX-1361's", () => {
  const was = prosrc(LIVE());
  const now = prosrc(A());
  assert.match(now, /c_running_win CONSTANT interval := interval '6 hours';/);
  for (const [from, to] of [
    ["-- ── 3b. reap a GHA arm", "-- ── 4. the box"],
    ["-- ── 4. the box", "-- ── 5. the census"],
    ["-- ── 5. the census", "-- ── 6. pick"],
    ["-- ── 6. pick", "-- ── 7. ARM"],
    ["-- ── 7. ARM", "END body;"],
  ] as const) assert.equal(section(now, from, to), section(was, from, to), `${from} unchanged`);
  assert.equal(now.slice(0, now.indexOf("DECLARE")), was.slice(0, was.indexOf("DECLARE")));
  assert.equal(now.slice(now.indexOf("END body;")), was.slice(was.indexOf("END body;")), "the error path and the final row");
});

test("A (D4): every anchor read in the pick admits complete|partial only — a reaped row never anchors", () => {
  const pick = stripComments(section(prosrc(A()), "-- ── 6. pick", "-- ── 7. ARM"));
  const reads = [...pick.matchAll(/FROM public\.data_sync_log l\s+WHERE l\.pipeline = r\.pipeline AND l\.status ([^\n]+)/g)].map((m) => m[1]!.trim());
  assert.deepEqual(reads, [
    "IN ('complete', 'partial')",    // v_last / v_next_due
    "IN ('complete', 'partial')",    // the phase-lock start
    "IN ('complete', 'partial')))",  // the I6 cooldown's v_adv fallback
    "= 'skipped'",                   // D-f: the unit's own backoff_until
  ]);
  assert.doesNotMatch(pick, /'reaped'\)|status = 'reaped'/, "no data_sync_log read admits reaped (the cooldown counts dispatch_log)");
});

test("A: the guard admits FIX-1361's body or this file's; the read-back pins all four; every v_missing element is ::text", () => {
  const sql = A();
  const guard = sql.slice(0, sql.indexOf("CREATE OR REPLACE FUNCTION"));
  assert.ok(guard.includes(`v_d IS DISTINCT FROM '${WAS}' AND v_d IS DISTINCT FROM '${NOW}'`));
  const rb = sql.slice(sql.lastIndexOf("DO $$"));
  assert.ok(rb.includes(`c_new_d CONSTANT text := '${NOW}'`));
  for (const [name, m] of Object.entries(PINS)) {
    assert.ok(rb.includes(`'${m}'`), `${name} pinned at ${m}`);
    assert.ok(rb.includes(`proname = '${name}'`), name);
  }
  const appends = [...rb.matchAll(/v_missing := v_missing \|\| ([^;]+);/g)].map((m) => m[1]!);
  assert.equal(appends.length, 5);
  for (const a of appends) assert.match(a, /::text$/, a);
  assert.match(rb, /search_path=public, pg_catalog, cron/);
  const outside = sql.slice(0, sql.indexOf("CREATE OR REPLACE FUNCTION")) + sql.slice(sql.indexOf("\n$function$;\n"));
  assert.doesNotMatch(stripComments(outside), /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i, "a body and two reads, no row written");
});

test("A: owner, grants and comment are FIX-1361's; the revert is FIX-1361's text and asserts its pin", () => {
  const tail = (s: string) => {
    const i = s.lastIndexOf("ALTER FUNCTION public.dispatch_one_unit(text) OWNER TO postgres;");
    return s.slice(i, s.indexOf("';\n", i) + 3);
  };
  assert.equal(tail(A()), tail(LIVE()));
  const rev = REVERT_A();
  assert.equal(prosrc(rev), prosrc(LIVE()), "the revert's body is FIX-1361's, byte for byte");
  assert.equal(tail(rev), tail(LIVE()));
  assert.ok(rev.includes(`v_d IS DISTINCT FROM '${WAS}'`));
  assert.equal(PIN_LINEAGE[WAS], NOW, "PIN_LINEAGE carries the move");
});

// ---------------------------------------------------------------------------
// Text — files B and C
// ---------------------------------------------------------------------------

test("B: one UPDATE of ec-crawl on its exact old text; the note gains the cc-292 clause; no other column, row or dial", () => {
  const sql = stripComments(B());
  const updates = sql.split(/UPDATE public\.job_registry/).slice(1);
  assert.equal(updates.length, 1);
  const u = updates[0]!;
  assert.match(u, /SET deadline_rule = 'stale_after 25 minutes',/);
  assert.match(u, /note\s+= note \|\| '; cc-292 \(FIX-1423\): 25 minutes from 10 — the post-landing pass',/);
  assert.match(u, /WHERE job = 'ec-crawl'\s+AND deadline_rule = 'stale_after 10 minutes';/);
  const cols = /SET([\s\S]*?)WHERE/.exec(u)![1]!.match(/^\s*([a-z_]+)\s*=/gm)!.map((x) => x.trim().replace(/\s*=$/, ""));
  assert.deepEqual(cols, ["deadline_rule", "note", "updated_at"]);
  assert.doesNotMatch(sql, /platform_dials|pipeline_state|rollup_watch_overrides|CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/);
  assert.match(REVERT_B(), /WHERE job = 'ec-crawl'\s+AND deadline_rule = 'stale_after 25 minutes'/);
});

const STARTS = [
  { job: "irs990", was: "at 0 15 * * 1", now: "at 0 15 * * 2", wf: "irs990.yml", stem: "irs990" },
  { job: "audit", was: "at 0 4 * * 1", now: "at 0 17 * * 2", wf: "audit.yml", stem: "audit" },
  { job: "crs-summaries", was: "at 0 10 * * 6", now: "at 0 10 * * 6", wf: "crs-summaries.yml", stem: "crs-summaries" },
] as const;

test("C: three UPDATEs, each on its exact old rule AND unit_call, to the Vercel dispatch; the revert matches the new text", () => {
  const sql = stripComments(C());
  const rev = stripComments(REVERT_C());
  for (const s of STARTS) {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(sql, new RegExp(`\\('${esc(s.job)}',\\s+'${esc(s.was)}',\\s+'gha:${esc(s.wf)}',\\s+'${esc(s.now)}',\\s+'gha-dispatch:${esc(s.stem)}'`), s.job);
    assert.match(rev, new RegExp(`\\('${esc(s.job)}',\\s+'${esc(s.now)}',\\s+'gha-dispatch:${esc(s.stem)}',\\s+'${esc(s.was)}',\\s+'gha:${esc(s.wf)}'`), `${s.job} revert`);
  }
  assert.match(sql, /WHERE job = v\.job AND deadline_rule = v\.was_rule AND unit_call = v\.was_call/);
  assert.doesNotMatch(sql, /platform_dials|pipeline_state|cron\.|CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/);
});

// ---------------------------------------------------------------------------
// Clone
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

/** The registry's table lock FIRST (r9's reason: other files write it in another order). */
async function begin(c: Client): Promise<void> {
  await c.query("BEGIN");
  await c.query("LOCK TABLE public.job_registry IN SHARE ROW EXCLUSIVE MODE");
}

/**
 * A fresh box, no session, ec-crawl the only looped row, the cooldown off and a
 * 1 MB caps ceiling: a DUE ec-crawl is excluded by `live` if the census sees a
 * unit and by `caps:` otherwise, and is never armed. The pipeline's last week is
 * cleared and one complete row an hour old is its anchor. cc-303: FIX-1444's hold
 * is off here (stall_hold_minutes 0, no dispatcher_hold key): this file's failed
 * cancel would otherwise strike and hold its own tick (dispatcher-r18 covers that).
 */
async function stage(c: Client): Promise<void> {
  await c.query(`UPDATE public.platform_dials SET pause = false, io_time_pct_ceiling = 90, io_samples = 2, io_mbps_floor = 12,
                   io_throttle_hold_min = 60, rearm_cooldown_seconds = 0, max_concurrent_units = 10, max_live_caps_mb = 1,
                   stall_hold_minutes = 0`);
  await c.query("DELETE FROM public.pipeline_state WHERE key IN ('box_health_mem', 'prod_session', 'dispatcher_hold')");
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', 0,
                                              'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  );
  await c.query("UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job NOT IN ('ec-crawl', 'dispatcher-tick')");
  await c.query("UPDATE public.job_registry SET deadline_rule = 'stale_after 10 minutes' WHERE job = 'ec-crawl'");
  await c.query("DELETE FROM public.data_sync_log WHERE pipeline IN ('entity_connections_rebuild', 'financial_entity_totals_refresh') AND started_at > now() - interval '7 days'");
  await c.query(
    `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
     VALUES ('entity_connections_rebuild', 'complete', clock_timestamp() - interval '61 minutes',
             clock_timestamp() - interval '60 minutes', '{"cc292": "anchor"}')`,
  );
}

let jobid = 990_292_000;

/**
 * A reaped-to-be unit as step 3 reads one: an `armed` row (no cron.job row, so
 * the reap skips cron.unschedule) and its run row above the floor. The run
 * started 5 min ago and ended 2 min ago. Returns the instants.
 */
async function fabricateRun(c: Client, job: string, status: "failed" | "succeeded"): Promise<{ id: number; name: string }> {
  const id = jobid++;
  const name = `disp-${job}-cc292-${id}`;
  const floor = (await c.query("SELECT COALESCE(max(runid), 0)::bigint AS f FROM cron.job_run_details")).rows[0].f;
  await c.query(
    `INSERT INTO public.dispatch_log (source, job, decision, reason, armed_jobid, armed_jobname, armed_for, runid_floor, ticked_at)
     VALUES ('manual', $1, 'armed', 'stale_after 10 minutes → synthetic (cc-292)', $2, $4,
             clock_timestamp() - interval '5 minutes', $3, clock_timestamp() - interval '6 minutes')`,
    [job, id, floor, name],
  );
  await c.query(
    `INSERT INTO cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
     VALUES ($1, $2::bigint + 1, 1, 'postgres', 'postgres', 'synthetic cc-292', $3,
             CASE WHEN $3 = 'failed' THEN E'ERROR:  canceling statement due to user request\nCONTEXT:  synthetic (cc-292)\n' ELSE '1 row' END,
             clock_timestamp() - interval '5 minutes', clock_timestamp() - interval '2 minutes')`,
    [id, floor, status],
  );
  return { id, name };
}

/** A `running` row of `pipeline`, `offsetMs` after the run's start (negative = before it), read in SQL to the microsecond. */
async function running(c: Client, pipeline: string, armedJobid: number, offsetMs: number): Promise<string> {
  return (await c.query(
    `INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
     SELECT $1, 'running', d.start_time + make_interval(secs => $3::float8 / 1000), '{"mode": "incremental", "cc292": true}'
       FROM cron.job_run_details d WHERE d.jobid = $2
     RETURNING id`,
    [pipeline, armedJobid, offsetMs],
  )).rows[0].id;
}
/** The closed row's completed_at against the run's end_time, compared in SQL. */
async function endsAtRunEnd(c: Client, id: string, armedJobid: number): Promise<boolean> {
  return (await c.query(
    `SELECT l.completed_at = d.end_time AS eq FROM public.data_sync_log l, cron.job_run_details d WHERE l.id = $1 AND d.jobid = $2`,
    [id, armedJobid],
  )).rows[0].eq;
}

type Row = { status: string; completed_at: Date | null; error_message: string | null; metadata: Record<string, unknown> };
async function row(c: Client, id: string): Promise<Row> {
  return (await c.query("SELECT status, completed_at, error_message, metadata FROM public.data_sync_log WHERE id = $1", [id])).rows[0];
}
async function tick(c: Client): Promise<{ id: number; excluded: string[]; reason: string }> {
  const id = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d.id;
  const r = (await c.query("SELECT excluded, reason FROM public.dispatch_log WHERE id = $1", [id])).rows[0];
  return { id, excluded: (r.excluded as string[] | null) ?? [], reason: r.reason };
}
async function reapRow(c: Client, armedJobid: number): Promise<{ reason: string; unit_ms: number } | undefined> {
  return (await c.query("SELECT reason, unit_ms FROM public.dispatch_log WHERE armed_jobid = $1 AND decision = 'reaped'", [armedJobid])).rows[0];
}
const ecExclusion = (t: { excluded: string[] }) => t.excluded.find((e) => e.endsWith("(ec-crawl)"));

async function livePin(c: Client): Promise<string> {
  return (await c.query("SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace")).rows[0].m;
}

test("clone A: a failed unit's running row inside its run is closed by one tick; the reap row says so; the next census does not see it", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    assert.equal(await livePin(c), atCurrentPins(NOW), "the clone carries file A (cc-303 moved the pin on: PIN_LINEAGE)");
    await begin(c);
    try {
      await stage(c);
      const run = await fabricateRun(c, "ec-crawl", "failed");
      const orphan = await running(c, "entity_connections_rebuild", run.id, 0.4);  // 11-16: 0.44 ms after run_start
      const t1 = await tick(c);
      const r = await row(c, orphan);
      assert.equal(r.status, "reaped");
      assert.equal(await endsAtRunEnd(c, orphan, run.id), true, "completed_at = the run's end_time");
      assert.match(r.error_message ?? "", /^reaped_orphan — the unit's cron run ended failed: ERROR: {2}canceling statement due to user request/);
      assert.equal(r.metadata["reaped"], true);
      assert.equal(r.metadata["reaped_by"], "dispatch_one_unit");
      assert.equal(r.metadata["armed_jobname"], run.name);
      assert.equal(r.metadata["mode"], "incremental", "the row's own metadata is kept");
      const reap = await reapRow(c, run.id);
      assert.match(reap?.reason ?? "", /^failed: ERROR: {2}canceling statement due to user request\nCONTEXT: {2}synthetic \(cc-292\)\n; closed 1 running row\(s\)$/);
      assert.equal(reap?.unit_ms, 180000);
      // The same tick's census already ran after the reap: ec-crawl is DUE (its
      // anchor is the hour-old complete row, not the reaped row's end — D4) and is
      // held by caps, never by live.
      assert.match(ecExclusion(t1) ?? "", /^caps: \d+ MB live \+ 64 MB > 1 MB \(ec-crawl\)$/, JSON.stringify(t1.excluded));
      const t2 = await tick(c);
      assert.match(ecExclusion(t2) ?? "", /^caps: /, "the next tick's census does not list ec-crawl live");
      assert.equal(await reapRow(c, run.id).then((x) => x?.reason), reap?.reason, "reaped once");
      console.info(`[r17] tick ${t1.id}: ${reap?.reason.replace(/\n/g, " ")} · ${ecExclusion(t1)} · next ${ecExclusion(t2)}`);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone A: a row that started before the run, another pipeline's row and a succeeded unit's row are left alone", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    for (const k of ["before", "other", "succeeded"] as const) {
      await begin(c);
      try {
        await stage(c);
        const run = await fabricateRun(c, "ec-crawl", k === "succeeded" ? "succeeded" : "failed");
        const id =
          k === "before" ? await running(c, "entity_connections_rebuild", run.id, -1000)
          : k === "other" ? await running(c, "financial_entity_totals_refresh", run.id, 1000)
          : await running(c, "entity_connections_rebuild", run.id, 1000);
        const t1 = await tick(c);
        const r = await row(c, id);
        assert.equal(r.status, "running", k);
        assert.equal(r.completed_at, null, k);
        const reap = await reapRow(c, run.id);
        assert.ok(reap, `${k}: the unit is reaped`);
        assert.doesNotMatch(reap.reason, /closed/, k);
        assert.match(reap.reason, k === "succeeded" ? /^succeeded: / : /^failed: /, k);
        // A row of the crawl's own pipeline still running is the census's to read.
        if (k !== "other") assert.equal(ecExclusion(t1), "live (ec-crawl)", `${k}: ${JSON.stringify(t1.excluded)}`);
      } finally {
        await c.query("ROLLBACK");
      }
    }
  } finally {
    await c.end();
  }
});

test("clone A: a pipeline-less job's failed run closes nothing", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await stage(c);
      const job = (await c.query("SELECT job FROM public.job_registry WHERE pipeline IS NULL AND runner = 'pg_cron' AND job <> 'dispatcher-tick' ORDER BY job LIMIT 1")).rows[0].job;
      const run = await fabricateRun(c, job, "failed");
      const id = await running(c, "entity_connections_rebuild", run.id, 1000);
      await tick(c);
      assert.equal((await row(c, id)).status, "running");
      assert.doesNotMatch((await reapRow(c, run.id))?.reason ?? "", /closed/);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone A: FIX-1361's body (the revert) leaves the same row running and reads ec-crawl live; the file re-applies", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await c.query(REVERT_A());
      assert.equal(await livePin(c), WAS);
      await stage(c);
      const run = await fabricateRun(c, "ec-crawl", "failed");
      const orphan = await running(c, "entity_connections_rebuild", run.id, 0.4);
      const t1 = await tick(c);
      assert.equal((await row(c, orphan)).status, "running", "the old body leaves it");
      assert.equal(ecExclusion(t1), "live (ec-crawl)", "and the census reads it live for c_running_win");
      assert.doesNotMatch((await reapRow(c, run.id))?.reason ?? "", /closed/);
      await c.query(A());
      assert.equal(await livePin(c), NOW);
      await c.query(A());
      assert.equal(await livePin(c), NOW, "idempotent");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone B / C: each revert restores the old rows and the file re-applies, inside one rolled-back transaction", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const rows = async () => (await c.query(
    `SELECT job, deadline_rule, unit_call, (note LIKE '%; cc-292 (FIX-142_): %') AS clause
       FROM public.job_registry WHERE job IN ('ec-crawl', 'irs990', 'audit', 'crs-summaries') ORDER BY job`,
  )).rows.map((r: { job: string; deadline_rule: string; unit_call: string; clause: boolean }) =>
    [r.job, r.deadline_rule, r.job === "ec-crawl" ? null : r.unit_call, r.clause].filter((x) => x !== null).join(" "));
  const now = [
    "audit at 0 17 * * 2 gha-dispatch:audit true",
    "crs-summaries at 0 10 * * 6 gha-dispatch:crs-summaries true",
    "ec-crawl stale_after 25 minutes true",
    "irs990 at 0 15 * * 2 gha-dispatch:irs990 true",
  ];
  try {
    await begin(c);
    try {
      // cc-318 (FIX-1455) MOVEd crs-summaries off `at 0 10 * * 6`: put it back on
      // C's row first, inside this rolled-back transaction (MOVED_LINEAGE).
      await c.query(read(path.join(ROOT, "scripts", MOVED_LINEAGE["crs-summaries"]!.revert)));
      assert.deepEqual(await rows(), now, "the clone carries B and C");
      await c.query(REVERT_B());
      await c.query(REVERT_C());
      await c.query(REVERT_C());
      assert.deepEqual(await rows(), [
        "audit at 0 4 * * 1 gha:audit.yml false",
        "crs-summaries at 0 10 * * 6 gha:crs-summaries.yml false",
        "ec-crawl stale_after 10 minutes false",
        "irs990 at 0 15 * * 1 gha:irs990.yml false",
      ]);
      await c.query(B());
      await c.query(C());
      assert.deepEqual(await rows(), now, "each file re-applies on the old rows");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
