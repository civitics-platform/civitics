/**
 * cc-318 — one class-P file, a PIN MOVE:
 *   *_fix1454_fix1455_gha_one_row_reap_and_crs_walker_row.sql   (FIX-1454 + FIX-1455)
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r19.test.ts
 *
 * Text (no DB, run in CI): the body is FIX-1444's plus ONLY D1's two branches (a
 * line diff), each closed to the nightly; everything D2 names is byte-equal; the
 * guard, the read-back, the one row UPDATE, and both reverts (cc-303's text, and
 * the row back on cc-292's values).
 * Clone (CIVITICS_CLONE_TESTS=1), each inside BEGIN … ROLLBACK: dispatch_one_unit
 * takes no clock, so every fabrication is relative to clock_timestamp() — a
 * registry row `cc318-walker` that is not the nightly (its own stem, pipeline
 * cc318_walker, group proposals), its request stamp and its pipeline rows; the
 * nightly's request and its phase rows (r18's shape); and the migrated
 * crs-summaries row with its congress_crs_summaries anchor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { MOVED_LINEAGE, PIN_LINEAGE, read, stripComments } from "./lib/migration-text";

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

const FILE = () => one("_fix1454_fix1455_gha_one_row_reap_and_crs_walker_row.sql");
const BASE = () => one("_fix1444_fix1445_dispatcher_hold_and_restarted_run_reap.sql");
const REVERT_BODY = () => script("fix1454-revert-gha-one-row-reap.sql");
const REVERT_ROW = () => script("fix1455-revert-crs-summaries-row.sql");

/** FIX-1444's body (history, the revert's target) and this file's. */
const WAS = "1f001294265b03c09db34aa47311954c";
const NOW = "d0f5bf5b59120716ab15e73c805435d2";
const PINS = {
  get_dispatcher_status: "d6bb02aab3eb8c9625275227f564c5c9",
  box_is_saturated: "b05961ca6d1cf7e56874071bfe334da1",
  prod_op_gate: "70a799ab3df2484fc424fe2762ffa797",
};
/** cc-292's crs-summaries note (the seed's text plus its FIX-1424 clause), which the row revert restores. */
const OLD_NOTE =
  "writes proposals.summary_plain; no data_sync_log row; no-band; cc-292 (FIX-1424): START by Vercel dispatch " +
  "(/api/cron/gha-dispatch/crs-summaries, 0 10 * * 6, the slot kept) — GitHub started it 3.7–6.2 h late; on time a 350-min run ends by 15:50Z";

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");

/** A routine's prosrc: the LAST definition in the text, between its dollar quotes. */
function prosrc(src: string): string {
  const i = src.lastIndexOf("CREATE OR REPLACE FUNCTION public.dispatch_one_unit");
  assert.notEqual(i, -1, "dispatch_one_unit is defined");
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, "no dollar-quoted body");
  return m[2] as string;
}

type Hunk = { at: number; removed: string[]; added: string[] };
/** An LCS line diff of `a` → `b`, grouped into hunks (`at` = the hunk's first line in `b`, 1-based). r18's. */
function hunks(a: string, b: string): Hunk[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const L = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    }
  }
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { cur = null; i++; j++; continue; }
    if (!cur) { cur = { at: j + 1, removed: [], added: [] }; out.push(cur); }
    if (j >= y.length || (i < x.length && L[i + 1]![j]! >= L[i]![j + 1]!)) cur.removed.push(x[i++]!);
    else cur.added.push(y[j++]!);
  }
  return out;
}

/** The text between two markers of a body (the start marker included). */
function section(body: string, from: string, to: string): string {
  const i = body.indexOf(from);
  const k = body.indexOf(to, i + from.length);
  assert.ok(i !== -1 && k !== -1, `section ${from} … ${to}`);
  return body.slice(i, k);
}

const firstCode = (h: Hunk) => (h.added.find((l) => l.trim() !== "" && !l.trim().startsWith("--")) ?? "").trim();

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test("the body is FIX-1444's plus ONLY D1's two branches in 3b, and hashes to the read-back's pin", () => {
  const was = prosrc(BASE());
  const now = prosrc(FILE());
  assert.equal(md5(was), WAS, "the history file's body");
  assert.equal(md5(now), NOW, "this file's body");
  const hs = hunks(was, now);
  assert.deepEqual(hs.flatMap((h) => h.removed), [], "nothing removed");
  assert.equal(hs.length, 2, hs.map((h) => `+${h.at} ${firstCode(h)}`).join("\n"));
  assert.match(firstCode(hs[0]!), /^ELSIF r\.job <> c_landing_job AND COALESCE\(v_g_running, false\)$/, "D1 (a)");
  assert.match(firstCode(hs[1]!), /^ELSIF r\.job <> c_landing_job AND v_g_st IS NOT NULL AND v_g_phase IS NULL THEN$/, "D1 (b)");
  const g = section(now, "-- ── 3b. reap a GHA arm", "-- ── 4. the box");
  const at = (s: string) => { const i = g.indexOf(s); assert.notEqual(i, -1, s); return i; };
  assert.ok(at("ELSIF r.job <> c_landing_job AND COALESCE(v_g_running, false)") < at("ELSIF COALESCE(v_g_running, false) THEN"), "(a) before the occupant branch");
  assert.ok(at("ELSIF v_g_phase = c_gha_tail THEN") < at("ELSIF r.job <> c_landing_job AND v_g_st IS NOT NULL"), "(b) after the tail branch");
  assert.ok(at("ELSIF r.job <> c_landing_job AND v_g_st IS NOT NULL") < at("ELSIF v_g_end IS NOT NULL AND v_g_end < v_now - c_gha_quiet THEN"), "(b) before the quiet branch");
  const added = hs.reduce((s, h) => s + h.added.length, 0);
  console.info(`[r19] body ${was.split("\n").length} → ${now.split("\n").length} lines; −0 +${added}; ${hs.length} hunks at ` +
    hs.map((h) => `+${h.at} (${h.added.length} lines: ${firstCode(h).slice(0, 60)})`).join(" · "));
});

test("D1: each branch is closed to the nightly; (a) closes in reap_stale_sync_log()'s shape; (b) times the run from its first row", () => {
  const g = stripComments(section(prosrc(FILE()), "-- ── 3b. reap a GHA arm", "-- ── 4. the box"));
  const a = section(g, "ELSIF r.job <> c_landing_job AND COALESCE(v_g_running, false)", "ELSIF COALESCE(v_g_running, false) THEN");
  assert.match(a, /AND v_now > r\.req_at \+ make_interval\(secs => COALESCE\(r\.budget_seconds, 18000\)\) THEN/);
  assert.match(a, /SET status\s+= 'reaped',/);
  assert.doesNotMatch(a, /completed_at/, "FIX-944: completed_at is left as it is");
  assert.match(a, /'reaped', true, 'reaped_at', v_now,\s+'reaped_by', 'dispatch_one_unit', 'armed_jobname', r\.req_key\)/);
  assert.match(a, /WHERE l\.pipeline = r\.pipeline AND l\.status = 'running' AND l\.started_at >= r\.req_at;/);
  assert.match(a, /GET DIAGNOSTICS v_closed = ROW_COUNT;/);
  assert.match(a, /v_g_why := format\('failed: GHA running past its budget \(%s s\); closed %s running row\(s\)',/);
  const b = section(g, "ELSIF r.job <> c_landing_job AND v_g_st IS NOT NULL", "ELSIF v_g_end IS NOT NULL AND v_g_end < v_now - c_gha_quiet THEN");
  assert.match(b, /v_g_why := CASE WHEN v_g_st IN \('complete', 'partial'\) THEN 'succeeded: GHA'\s+ELSE 'failed: GHA ' \|\| v_g_st END;/);
  assert.match(b, /v_g_ms\s+:= round\(EXTRACT\(epoch FROM \(COALESCE\(v_g_end, v_now\) - v_g_first\)\) \* 1000\)::int;/);
  assert.doesNotMatch(b, /c_gha_quiet/, "no quiet wait");
});

test("D2: the constants, step 3, L, S, 4b, the census, the pick, the cooldown, step 7 and the final row are FIX-1444's, byte for byte", () => {
  const was = prosrc(BASE());
  const now = prosrc(FILE());
  assert.equal(now.slice(0, now.indexOf("\nBEGIN\n")), was.slice(0, was.indexOf("\nBEGIN\n")), "the DECLARE block, c_gha_quiet / c_gha_fire_lapse / c_gha_tail with it");
  for (const [from, to] of [
    ["IF v_source NOT IN", "-- ── 3b. reap a GHA arm"],
    ["          IF v_g_dec IS NULL THEN", "-- ── 4. the box"],
    ["-- ── 4. the box", "END body;"],
    ["END body;", "$function$"],
  ] as const) {
    const end = (s: string) => (to === "$function$" ? s.length : s.indexOf(to, s.indexOf(from)));
    assert.equal(now.slice(now.indexOf(from), end(now)), was.slice(was.indexOf(from), end(was)), `${from} … unchanged`);
  }
  const chain = (s: string) => section(s, "-- ── 3b. reap a GHA arm", "          IF v_g_dec IS NULL THEN")
    .replace(/ {10}ELSIF r\.job <> c_landing_job AND COALESCE\(v_g_running, false\)[\s\S]*?(?= {10}ELSIF COALESCE\(v_g_running, false\) THEN)/, "")
    .replace(/ {10}ELSIF r\.job <> c_landing_job AND v_g_st IS NOT NULL[\s\S]*?(?= {10}ELSIF v_g_end IS NOT NULL AND v_g_end < v_now - c_gha_quiet THEN)/, "");
  assert.equal(chain(now), chain(was), "3b less the two branches is FIX-1444's 3b");
});

test("the guard admits FIX-1444's body or this file's; the read-back pins all four and the row; every v_missing element is ::text", () => {
  const sql = FILE();
  const guard = sql.slice(0, sql.indexOf("CREATE OR REPLACE FUNCTION"));
  assert.ok(guard.includes(`v_d IS DISTINCT FROM '${WAS}' AND v_d IS DISTINCT FROM '${NOW}'`));
  const rb = sql.slice(sql.lastIndexOf("DO $$"));
  assert.ok(rb.includes(`c_new_d CONSTANT text := '${NOW}'`));
  assert.ok(rb.includes(`c_old_d CONSTANT text := '${WAS}'`));
  for (const [name, m] of Object.entries(PINS)) {
    assert.ok(rb.includes(`'${m}'`), `${name} pinned at ${m}`);
    assert.ok(rb.includes(`proname = '${name}'`), name);
  }
  assert.ok(rb.includes("'stale_after 2 hours | github_actions | gha-dispatch:crs-summaries | congress_crs_summaries | resumable | 5 | cpu | 16 | proposals | 2700 | {prod_session} | t | {nightly} | 2400'"));
  const appends = [...rb.matchAll(/v_missing := v_missing \|\| ([^;]+);/g)].map((m) => m[1]!);
  assert.equal(appends.length, 7);
  for (const a of appends) assert.match(a, /::text$/, a);
  assert.match(rb, /search_path=public, pg_catalog, cron/);
});

test("D4: ONE UPDATE, of crs-summaries alone, on its old rule and unit_call; no INSERT, no bill-details row, no other table", () => {
  const sql = stripComments(FILE());
  const outside = sql.slice(0, sql.indexOf("CREATE OR REPLACE FUNCTION")) + sql.slice(sql.indexOf("\n$function$;\n"));
  assert.equal(outside.split(/\bUPDATE public\.job_registry\b/).length - 1, 1);
  const code = outside.replace(/'(?:[^']|'')*'/g, "''");  // the COMMENT and the note are prose
  assert.doesNotMatch(code, /\bINSERT\b|\bDELETE\b|\bTRUNCATE\b|\bDROP\b|platform_dials|pipeline_state|cron\.schedule/i);
  assert.doesNotMatch(outside, /bill-details/);
  const u = section(outside, "UPDATE public.job_registry", "GET DIAGNOSTICS");
  assert.match(u, /WHERE job = 'crs-summaries'\s+AND deadline_rule = 'at 0 10 \* \* 6'\s+AND unit_call = 'gha-dispatch:crs-summaries';/);
  const cols = /SET([\s\S]*?)WHERE/.exec(u.replace(/'(?:[^']|'')*'/g, "''"))![1]!.match(/^\s*([a-z_]+)\s*=/gm)!.map((x) => x.trim().replace(/\s*=$/, ""));
  assert.deepEqual(cols, ["deadline_rule", "pipeline", "unit_shape", "priority", "cost_class", "cap_mb", "exclusion_group",
    "budget_seconds", "gates", "idempotent_refire", "yield_to", "yield_lead_seconds", "note", "updated_at"]);
  assert.match(FILE(), /'MOVED 2026-11-26 \(FIX-1455, cc-318\) from at 0 10 \* \* 6 /, "the note carries the MOVE (MOVED_LINEAGE)");
  assert.match(FILE(), /no-band\. '/, "the note keeps its no-band declaration");
});

test("owner and grants are FIX-1444's; the comment gains one sentence; the body revert is FIX-1444's text and asserts its pin", () => {
  const tail = (s: string) => {
    const i = s.lastIndexOf("ALTER FUNCTION public.dispatch_one_unit(text) OWNER TO postgres;");
    return s.slice(i, s.indexOf("';\n", i) + 3);
  };
  const now = tail(FILE());
  const was = tail(BASE());
  const last = "its running rows close there.';\n";
  assert.ok(was.endsWith(last));
  assert.ok(now.startsWith(was.slice(0, -last.length)), "the same owner, grants and comment up to its last sentence");
  assert.match(now, /its running rows close there\. '\n {2}'FIX-1454 \(cc-318\): a github_actions row other than the nightly ends on its own pipeline row/);
  const rev = REVERT_BODY();
  assert.equal(prosrc(rev), prosrc(BASE()), "the revert's body is FIX-1444's, byte for byte");
  assert.equal(tail(rev), was);
  assert.ok(rev.includes(`IF v_d IS DISTINCT FROM '${WAS}' THEN`));
  assert.match(rev, /It supersedes\n-- scripts\/fix1444-revert-dispatcher-hold\.sql/);
  assert.equal(PIN_LINEAGE[WAS], NOW, "PIN_LINEAGE carries the move");
});

test("the row revert: matched on the new rule, cc-292's values and note verbatim, asserted; MOVED_LINEAGE names it", () => {
  const sql = stripComments(REVERT_ROW());
  assert.equal(sql.split(/\bUPDATE public\.job_registry\b/).length - 1, 1);
  assert.match(sql, /WHERE job = 'crs-summaries'\s+AND deadline_rule = 'stale_after 2 hours'\s+AND unit_call = 'gha-dispatch:crs-summaries';/);
  for (const v of [/deadline_rule\s+= 'at 0 10 \* \* 6'/, /pipeline\s+= NULL/, /unit_shape\s+= 'atomic'/, /priority\s+= 3/, /cost_class\s+= 'io'/,
    /cap_mb\s+= 128/, /budget_seconds\s+= 21000/, /gates\s+= '\{\}'/, /idempotent_refire\s+= false/, /yield_to\s+= '\{\}'/, /yield_lead_seconds = 0/]) {
    assert.match(sql, v);
  }
  assert.ok(REVERT_ROW().includes(`note               = '${OLD_NOTE}'`), "cc-292's note, verbatim");
  assert.match(sql, /'at 0 10 \* \* 6 \| github_actions \| gha-dispatch:crs-summaries \| atomic \| 3 \| io \| 128 \| proposals \| 21000 \| \{\} \| f \| \{\} \| 0'/);
  assert.match(REVERT_ROW(), /restore that cron and\n-- that target by a commit/, "the Saturday cron is a commit, not this file");
  assert.deepEqual(MOVED_LINEAGE["crs-summaries"], {
    fix: "FIX-1455", at: "at 0 10 * * 6", rule: "stale_after 2 hours", revert: "fix1455-revert-crs-summaries-row.sql",
  });
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

/** One rolled-back transaction, the registry's table lock FIRST (r9's reason). */
async function inTx(t: { skip: (m: string) => void }, fn: (c: Client) => Promise<void>): Promise<void> {
  const c = await clone(t);
  if (!c) return;
  try {
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

const WALKER = "cc318-walker";
const WALKER_PIPE = "cc318_walker";
const WALKER_KEY = `gha_dispatch_request_${WALKER}`;

/**
 * prod's dials, the cooldown at `cooldown` s; no mirror, no session, no hold, no
 * request, an empty dispatch_log, a fresh probe; a fabricated github_actions row
 * `cc318-walker` (group proposals, budget 2700 s, crs-summaries' shape); every
 * looped row parked but `keep`; no recent rows for the three pipelines read.
 */
async function stage(c: Client, o: { keep?: string[]; cooldown?: number } = {}): Promise<void> {
  await c.query(
    `UPDATE public.platform_dials SET pause = false, rearm_cooldown_seconds = $1, max_live_caps_mb = 100000,
            landing_after_minutes = 30, landing_quiet_factor = 3, stall_hold_minutes = 120, ramp_minutes = 60, max_concurrent_units = 2`,
    [o.cooldown ?? 0],
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
    `INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb,
                                      exclusion_group, budget_seconds, gates, idempotent_refire, yield_to, yield_lead_seconds, note)
     VALUES ($1, 'github_actions', $2, 'resumable', 'gha-dispatch:' || $1, 5, 'stale_after 2 hours', 'cpu', 16,
             'proposals', 2700, '{prod_session}', true, '{nightly}', 2400, 'cc-318 r19: a fabricated one-row walker; no-band')`,
    [WALKER, WALKER_PIPE],
  );
  await c.query(
    "UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job <> 'dispatcher-tick' AND job <> ALL ($1::text[])",
    [o.keep ?? []],
  );
  await c.query(
    "DELETE FROM public.data_sync_log WHERE pipeline IN ('congress_crs_summaries', $1, 'nightly_cron') AND started_at > now() - interval '30 days'",
    [WALKER_PIPE],
  );
}

type Tick = { id: number; decision: string; job: string | null; reason: string; excluded: string[] };
async function tick(c: Client): Promise<Tick> {
  const id = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d.id;
  const r = (await c.query("SELECT decision, job, reason, excluded FROM public.dispatch_log WHERE id = $1", [id])).rows[0];
  return { id, decision: r.decision, job: r.job, reason: r.reason, excluded: (r.excluded as string[] | null) ?? [] };
}
/** The newest reaped / missed row for a job, or null. */
async function reap(c: Client, job: string): Promise<{ decision: string; reason: string; unit_ms: number | null; armed_jobname: string } | null> {
  return (await c.query(
    "SELECT decision, reason, unit_ms, armed_jobname FROM public.dispatch_log WHERE job = $1 AND decision IN ('reaped', 'missed') ORDER BY id DESC LIMIT 1",
    [job],
  )).rows[0] ?? null;
}
const armed = async (c: Client) =>
  (await c.query("SELECT job, reason FROM public.dispatch_log WHERE decision = 'armed' ORDER BY id")).rows as Array<{ job: string; reason: string }>;
const ex = (t: Tick, job: string) => t.excluded.find((e) => e.endsWith(`(${job})`));

/** A request stamp `minAgo` minutes old; `outcome` null = the route never answered. */
async function request(c: Client, stem: string, job: string, minAgo: number, outcome: string | null = "dispatched"): Promise<void> {
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('gha_dispatch_request_' || $1,
             jsonb_build_object('job', $2::text, 'requested_at', clock_timestamp() - make_interval(secs => $3::float8 * 60),
                                'dispatch_log_id', NULL,
                                'consumed_at', CASE WHEN $4::text IS NULL THEN NULL ELSE clock_timestamp() - make_interval(secs => ($3::float8 - 1) * 60) END,
                                'outcome', $4::text, 'http_status', CASE WHEN $4::text = 'dispatched' THEN 204 END, 'reaped_at', NULL), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [stem, job, minAgo, outcome],
  );
}
/** One data_sync_log row: started `start` min ago, completed `end` min ago (null = NULL). */
async function row(c: Client, pipeline: string, status: string, start: number, end: number | null, metadata: Record<string, unknown> = {}): Promise<string> {
  return (await c.query(
    `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
     VALUES ($1, $2, clock_timestamp() - make_interval(secs => $3::float8 * 60),
             CASE WHEN $4::float8 IS NULL THEN NULL ELSE clock_timestamp() - make_interval(secs => $4::float8 * 60) END,
             $5::jsonb || '{"cc318": true}'::jsonb)
     RETURNING id`,
    [pipeline, status, start, end, JSON.stringify(metadata)],
  )).rows[0].id;
}
const near = (got: number, want: number, tol: number) => assert.ok(Math.abs(got - want) <= tol, `${got} ≉ ${want} (±${tol})`);

test("clone (b): a complete or partial row with no phase reaps succeeded: GHA on that tick, timed, and the row rests its 2 hours", async (t) => {
  for (const status of ["complete", "partial"]) {
    await inTx(t, async (c) => {
      await stage(c, { keep: [WALKER] });
      await request(c, WALKER, WALKER, 12);
      await row(c, WALKER_PIPE, status, 10, 2);
      const t1 = await tick(c);
      const r = await reap(c, WALKER);
      assert.equal(r?.decision, "reaped", status);
      assert.equal(r?.reason, "succeeded: GHA", status);
      assert.equal(r?.armed_jobname, WALKER_KEY);
      near(r!.unit_ms!, 8 * 60_000, 100);
      const req = (await c.query("SELECT value FROM public.pipeline_state WHERE key = $1", [WALKER_KEY])).rows[0].value;
      assert.ok(req.reaped_at, "the request's reaped_at is set");
      assert.equal(req.reap, "reaped: succeeded: GHA");
      assert.notEqual(t1.decision, "armed", t1.reason);
      assert.match(t1.reason, new RegExp(`next: ${WALKER} in 01:5[78]:`), `${status}: due again 2 h after its row — ${t1.reason}`);
    });
  }
});

test("clone (b): a failed row reaps failed: GHA failed and the cooldown's GHA branch counts it; no strike; completed_at NULL is reaped, not an occupant", async (t) => {
  await inTx(t, async (c) => {
    await stage(c, { keep: [WALKER], cooldown: 1800 });
    await request(c, WALKER, WALKER, 12);
    await row(c, WALKER_PIPE, "failed", 10, 2);
    const t1 = await tick(c);
    assert.equal((await reap(c, WALKER))?.reason, "failed: GHA failed");
    assert.match(ex(t1, WALKER) ?? "", /^cooldown: cc318-walker \(1 non-advancing reap\(s\), last 'failed: GHA failed' at /, t1.reason);
    const hold = (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'dispatcher_hold'")).rows[0]?.value ?? null;
    assert.ok(hold === null || hold.strikes === undefined, `no failed GHA reap strikes the key: ${JSON.stringify(hold)}`);
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: [WALKER] });
    await request(c, WALKER, WALKER, 70);
    await row(c, WALKER_PIPE, "reaped", 65, null);  // reap_stale_sync_log()'s close: completed_at NULL
    await tick(c);
    const r = await reap(c, WALKER);
    assert.equal(r?.reason, "failed: GHA reaped", "reaped at once — the old body read it as an occupant until the budget");
    near(r!.unit_ms!, 65 * 60_000, 2000);
  });
});

test("clone (a): a running row inside the budget is an occupant and its group reads busy; past it, failed and its rows closed with completed_at untouched", async (t) => {
  await inTx(t, async (c) => {
    await stage(c, { keep: [WALKER, "crs-summaries"] });
    await request(c, WALKER, WALKER, 10);
    await row(c, WALKER_PIPE, "running", 8, null);
    const t1 = await tick(c);
    assert.equal(await reap(c, WALKER), null, "an occupant");
    assert.equal(ex(t1, "crs-summaries"), "group busy: proposals (crs-summaries)", t1.reason);
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: [WALKER] });
    await request(c, WALKER, WALKER, 46);
    const mine = await row(c, WALKER_PIPE, "running", 45.5, null);
    const before = await row(c, WALKER_PIPE, "running", 50, null);  // started before the request: not this run's
    await tick(c);
    const r = await reap(c, WALKER);
    assert.equal(r?.reason, "failed: GHA running past its budget (2700 s); closed 1 running row(s)");
    assert.equal(r?.unit_ms, null, "a reap instant is not a runtime");
    const rows = (await c.query("SELECT id, status, completed_at, error_message, metadata FROM public.data_sync_log WHERE id = ANY ($1::uuid[])", [[mine, before]])).rows;
    const m = rows.find((x) => x.id === mine)!;
    const b = rows.find((x) => x.id === before)!;
    assert.equal(m.status, "reaped");
    assert.equal(m.completed_at, null, "completed_at untouched (FIX-944)");
    assert.match(m.error_message, /^reaped_orphan — still running 2700 s past the GHA request's budget/);
    assert.equal(m.metadata.reaped_by, "dispatch_one_unit");
    assert.equal(m.metadata.armed_jobname, WALKER_KEY);
    assert.equal(b.status, "running", "a row started before the request is not closed");
  });
});

test("clone: no row — an occupant inside the budget, today's no-row failure past it; no answer by 20 minutes is today's missed", async (t) => {
  await inTx(t, async (c) => {
    await stage(c, { keep: [WALKER] });
    await request(c, WALKER, WALKER, 30);
    await tick(c);
    assert.equal(await reap(c, WALKER), null, "dispatched, no row yet, inside 2700 s: an occupant");
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: [WALKER] });
    await request(c, WALKER, WALKER, 46);
    await tick(c);
    assert.equal((await reap(c, WALKER))?.reason, "failed: GHA no cc318_walker row within 2700 s of the request");
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: [WALKER] });
    await request(c, WALKER, WALKER, 21, null);
    await tick(c);
    const r = await reap(c, WALKER);
    assert.equal(r?.decision, "missed");
    assert.match(r!.reason, /^no dispatch by .* — the request route did not fire \(N2\); idempotent_refire t;/);
  });
});

test("clone: the nightly is unchanged — a non-tail row waits c_gha_quiet, a phase past its budget stays an occupant, the tail reaps succeeded", async (t) => {
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, "nightly", "nightly", 20);
    await row(c, "nightly_cron", "complete", 18, 5, { phase: "fec" });
    await tick(c);
    assert.equal(await reap(c, "nightly"), null, "5 min after a non-tail phase: still waiting");
  });
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, "nightly", "nightly", 20);
    await row(c, "nightly_cron", "complete", 18, 11, { phase: "fec" });
    await tick(c);
    assert.equal((await reap(c, "nightly"))?.reason, "failed: GHA fec complete", "11 min after: the quiet branch, as before");
  });
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, "nightly", "nightly", 302);
    await row(c, "nightly_cron", "running", 301, null, { phase: "enrichment" });
    await tick(c);
    assert.equal(await reap(c, "nightly"), null, "a phase running past 18000 s is still an occupant: (a) never reads the nightly");
  });
  await inTx(t, async (c) => {
    await stage(c);
    await request(c, "nightly", "nightly", 32);
    await row(c, "nightly_cron", "complete", 30, 25, { phase: "fec" });
    await row(c, "nightly_cron", "complete", 20, 3, { phase: "enrichment-tail" });
    await tick(c);
    const r = await reap(c, "nightly");
    assert.equal(r?.reason, "succeeded: GHA");
    near(r!.unit_ms!, 27 * 60_000, 100);
  });
});

test("clone: crs-summaries — not due on a fresh row, armed at 2 h 1 min with its request, and resting on a next_due_at 6 h out", async (t) => {
  await inTx(t, async (c) => {
    await stage(c, { keep: ["crs-summaries"] });
    await row(c, "congress_crs_summaries", "partial", 20, 5);
    const t1 = await tick(c);
    assert.deepEqual(await armed(c), []);
    assert.match(t1.reason, /next: crs-summaries in 01:5[45]:/, t1.reason);
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: ["crs-summaries"] });
    await row(c, "congress_crs_summaries", "complete", 136, 121);
    const t1 = await tick(c);
    assert.equal(t1.decision, "armed", t1.reason);
    assert.equal(t1.job, "crs-summaries");
    assert.match(t1.reason, /^stale_after 2 hours → -00:0[01]:\d\d; request gha_dispatch_request_crs-summaries$/);
    const req = (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'gha_dispatch_request_crs-summaries'")).rows[0].value;
    assert.equal(req.job, "crs-summaries");
    assert.equal(req.dispatch_log_id, t1.id);
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: ["crs-summaries"] });
    await row(c, "congress_crs_summaries", "complete", 190, 180, { next_due_at: new Date(Date.now() + 6 * 3_600_000).toISOString() });
    const t1 = await tick(c);
    assert.deepEqual(await armed(c), [], "2 h passed, but the unit said 6 h");
    assert.match(t1.reason, /next: crs-summaries in 0[56]:\d\d:/, t1.reason);
  });
});

test("clone: crs-summaries yields to the nightly (due in 30 min, or live), waits on its group, and arms nothing under a landing hold", async (t) => {
  const nightlyIn30 = async (c: Client) => {
    await c.query("UPDATE public.job_registry SET deadline_rule = 'stale_after 1 hour' WHERE job = 'nightly'");
    await row(c, "nightly_cron", "complete", 35, 30, { phase: "enrichment-tail" });
  };
  await inTx(t, async (c) => {
    await stage(c, { keep: ["crs-summaries", "nightly"] });
    await nightlyIn30(c);
    const t1 = await tick(c);
    assert.match(ex(t1, "crs-summaries") ?? "", /^yield: nightly due in 00:(29|30):\d\d \(crs-summaries\)$/, t1.reason);
    assert.deepEqual(await armed(c), []);
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: ["crs-summaries", "nightly"] });
    await nightlyIn30(c);
    await request(c, "nightly", "nightly", 10);
    await row(c, "nightly_cron", "running", 8, null, { phase: "fec" });
    const t1 = await tick(c);
    assert.equal(ex(t1, "crs-summaries"), "yield: nightly live (crs-summaries)", t1.reason);
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: ["crs-summaries"] });
    await row(c, WALKER_PIPE, "running", 2, null);  // the other walker in group proposals, live by its row
    const t1 = await tick(c);
    assert.equal(ex(t1, "crs-summaries"), "group busy: proposals (crs-summaries)", t1.reason);
  });
  await inTx(t, async (c) => {
    await stage(c, { keep: ["crs-summaries", WALKER] });
    await c.query(
      `INSERT INTO public.pipeline_state (key, value, updated_at)
       VALUES ('dispatcher_hold', jsonb_build_object('landing_until', clock_timestamp() + interval '1 hour', 'landing_set_by', 'cc-318 r19'), now())`,
    );
    const t1 = await tick(c);
    assert.equal(t1.decision, "skipped");
    assert.match(t1.reason, /^hold: landing until .* \(cc-318 r19\)$/);
    assert.deepEqual(await armed(c), [], "neither walker arms under the hold");
  });
});

test("clone: the row revert takes crs-summaries out of the pick; the body revert restores FIX-1444's; the file re-applies, idempotent", async (t) => {
  await inTx(t, async (c) => {
    const pin = async () => (await c.query("SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace")).rows[0].m;
    const rule = async () => (await c.query("SELECT deadline_rule, note FROM public.job_registry WHERE job = 'crs-summaries'")).rows[0];
    assert.equal(await pin(), NOW, "the clone carries this file");
    assert.equal((await rule()).deadline_rule, "stale_after 2 hours");
    await c.query(REVERT_ROW());
    await c.query(REVERT_ROW());
    assert.deepEqual(await rule(), { deadline_rule: "at 0 10 * * 6", note: OLD_NOTE });
    await c.query(REVERT_BODY());
    assert.equal(await pin(), WAS);
    await c.query(FILE());
    assert.equal(await pin(), NOW);
    assert.equal((await rule()).deadline_rule, "stale_after 2 hours");
    await c.query(FILE());
    assert.equal(await pin(), NOW, "idempotent");
  });
});
