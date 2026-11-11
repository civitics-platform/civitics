/**
 * cc-267 — the last MOVEs and the push that carries them:
 *   A *_fix1396_move_officials_and_mv_vacuum_series_eight_rows.sql   (FIX-1396)
 *   B *_fix1397_fix1398_mirror_disk_all_reads_status_readings_io.sql (FIX-1397, FIX-1398)
 *   C *_fix1399_io_samples_2.sql                                      (FIX-1399)
 *   D *_fix1392_io_hold_survives_stale_mirror.sql                     (FIX-1392 H1)
 *   E *_fix1393_donor_bulk_preloop_transaction_timeout.sql            (FIX-1393)
 *   F *_fix1293_get_ec_crawl_health_firings_bounded.sql               (FIX-1293)
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r16.test.ts
 *
 * Text (no DB, run in CI): every UPDATE on its exact `at` text, the parks by
 * name, the read-backs' pins; each new body is the history file's body plus
 * ONLY its hunks (a line diff), and hashes to the md5 its read-back names;
 * every v_missing element is ::text (rule 421); the reverts pair.
 * Clone (CIVITICS_CLONE_TESTS=1), each inside BEGIN … ROLLBACK unless it must
 * kill a session: the MOVE and its revert; the due computation; the status
 * call's io block; the dial; the hold at any mirror age; transaction_timeout's
 * three cases and the staging's residue; the crawl's firings off dispatch_log.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { read, stripComments, withCurrentPins } from "./lib/migration-text";

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

const A = () => one("_fix1396_move_officials_and_mv_vacuum_series_eight_rows.sql");
const B = () => one("_fix1397_fix1398_mirror_disk_all_reads_status_readings_io.sql");
const C = () => one("_fix1399_io_samples_2.sql");
const D = () => one("_fix1392_io_hold_survives_stale_mirror.sql");
const E = () => one("_fix1393_donor_bulk_preloop_transaction_timeout.sql");
const F = () => one("_fix1293_get_ec_crawl_health_firings_bounded.sql");
const LIVE = () => one("_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql");
const RUNG = () => one("_fix1375_io_rung_box_is_saturated_mirror_streak_dials.sql");
const BASE_STATUS = () => one("_fix1354_box_gate_memory_rules.sql");
const BASE_GATE = () => one("_fix1377_fix1353_prod_op_gate_d_3h_class_b_10m_live_box_class_p_io_input.sql");
const BASE_DRB = () => one("_fix1294_fix1295_fix1287_work_mem_m1.sql");
const BASE_ECH = () => one("_fix1293_ec_crawl_health_reads_staged_cycle.sql");

/** was = prod's body at cc-267 read 1 (and the history file's), now = this push's. */
const MD5 = {
  mem: { was: "de9ebee733077a59dfe2959981f8e0c3", now: "5cc93c2ade0f9f6008154e3ffbf5276c" },
  status: { was: "4c30523742e280a4b48ea2ec390654d6", now: "d6bb02aab3eb8c9625275227f564c5c9" },
  box: { was: "aaf6cc6552df532eff4a9b21e9780670", now: "b05961ca6d1cf7e56874071bfe334da1" },
  gate: { was: "6488601cf8c09287d540989c0e0fd074", now: "70a799ab3df2484fc424fe2762ffa797" },
  drb: { was: "1de3c10f261899852e11c5867b45bdc5", now: "b7df526046f4911f9cac3c5ace222b60" },
  ech: { was: "e6741c018c5b771343f2fb11e015a341", now: "0365316a209dd5b5db80f81e9364b2b0" },
};
const DISPATCH = "d6a9073bcc4d9084b9d7994324a89b18";

const MOVES = [
  { job: "officials-vacuum-analyze", at: "at 30 1 * * 1", floor: "7 days", table: "public.officials", grp: "officials" },
  { job: "odr-mv-vacuum-analyze", at: "at 5 11,17 * * *", floor: "24 hours", table: "public.official_donor_rollup_mv", grp: "rollups" },
  { job: "treemap-individuals-vacuum-analyze", at: "at 10 11,17 * * *", floor: "24 hours", table: "public.treemap_individuals_rollup", grp: "rollups" },
  { job: "odt-vacuum-analyze", at: "at 12 11,17 * * *", floor: "24 hours", table: "public.official_donor_totals", grp: "rollups" },
  { job: "osdr-vacuum-analyze", at: "at 14 11,17 * * *", floor: "24 hours", table: "public.official_small_dollar_rollup", grp: "rollups" },
  { job: "osar-vacuum-analyze", at: "at 16 11,17 * * *", floor: "24 hours", table: "public.official_sector_affinity_rollup", grp: "rollups" },
  { job: "odbt-vacuum-analyze", at: "at 18 11,17 * * *", floor: "24 hours", table: "public.official_donor_bracket_totals", grp: "rollups" },
  { job: "ecs-vacuum-analyze", at: "at 20 11,17 * * *", floor: "24 hours", table: "public.entity_connection_stats_mv", grp: "ec" },
] as const;
const rule = (floor: string) => `dead_tuples > 60% of trigger + floor ${floor}`;

const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A routine's prosrc: the LAST definition in the file, between its dollar quotes. */
function prosrc(src: string, kind: "FUNCTION" | "PROCEDURE", name: string): string {
  const i = src.lastIndexOf(`CREATE OR REPLACE ${kind} public.${name}`);
  assert.notEqual(i, -1, `${name} is defined`);
  const m = src.slice(i).match(/AS (\$\w*\$)([\s\S]*?)\1/);
  assert.ok(m, `no dollar-quoted body after ${name}`);
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

// ---------------------------------------------------------------------------
// Text — file A, the eight MOVEs
// ---------------------------------------------------------------------------

/** The dead_tuples parser as the live body runs it: the literal after `regexp_match(r.deadline_rule,`. */
function deadTuplesRegex(): RegExp {
  const lit = /regexp_match\(r\.deadline_rule,\s*'(\^dead_tuples(?:[^']|'')*)'/.exec(LIVE());
  assert.ok(lit, "the live body carries the dead_tuples regexp_match");
  return new RegExp(lit[1]!.replace(/''/g, "'"));
}

test("A: each rule parses under the live pick's dead_tuples regex — 60 / 7 days for officials, 60 / 24 hours for the seven", () => {
  for (const m of MOVES) {
    const g = deadTuplesRegex().exec(rule(m.floor));
    assert.ok(g, m.job);
    assert.equal(g[1], "60");
    assert.equal(g[2], m.floor);
  }
  assert.ok(stripComments(A()).includes(deadTuplesRegex().source.replace(/'/g, "''")), "the read-back uses the pick's regex verbatim");
});

test("A: eight UPDATEs, each matched on its exact `at` text, gates {prod_session}, no phase_lock written", () => {
  const sql = stripComments(A());
  const updates = sql.split(/UPDATE public\.job_registry/).slice(1);
  assert.equal(updates.length, 8, "one UPDATE per row");
  for (const m of MOVES) {
    const u = updates.find((x) => x.includes(`WHERE job = '${m.job}'`));
    assert.ok(u, `${m.job} is UPDATEd`);
    assert.match(u, new RegExp(`SET deadline_rule = '${reEsc(rule(m.floor))}'`));
    assert.match(u, /gates\s*=\s*'\{prod_session\}'/);
    assert.doesNotMatch(u.split("WHERE")[0]!, /phase_lock|phase_due_at|budget_seconds/, "only the rule, the gates, the note");
    assert.match(u, new RegExp(`WHERE job = '${reEsc(m.job)}'\\s+AND deadline_rule = '${reEsc(m.at)}'`));
    assert.ok(u.includes(`'; MOVED 2026-11-11 (FIX-1396, cc-267) from ${m.at}; first dispatched firing owed'`), `${m.job} note`);
  }
});

test("A: eight parks by NAME (FIX-946), count-1 guarded; never by jobid, never unscheduled", () => {
  const sql = stripComments(A());
  assert.equal([...sql.matchAll(/cron\.alter_job\(job_id := v_jobid, active := false\)/g)].length, 8);
  for (const m of MOVES) {
    assert.match(sql, new RegExp(`SELECT count\\(\\*\\) INTO v_n FROM cron\\.job WHERE jobname = '${reEsc(m.job)}';\\s+IF v_n <> 1 THEN`));
  }
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  assert.doesNotMatch(sql, /cron\.unschedule|cron\.schedule\s*\(/);
});

test("A: no routine, no VACUUM, no dial, no hold row; the read-back pins dispatch_one_unit and admits B / D's bodies", () => {
  const sql = stripComments(A());
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i);
  assert.doesNotMatch(sql, /^\s*VACUUM\b/im);
  assert.doesNotMatch(sql, /platform_dials|pipeline_state|rollup_watch_overrides/);
  assert.ok(sql.includes(`v_md5_d IS DISTINCT FROM '${DISPATCH}'`), "dispatch_one_unit exactly");
  assert.ok(sql.includes(`NOT IN ('${MD5.status.was}', '${MD5.status.now}')`));
  assert.ok(sql.includes(`NOT IN ('${MD5.box.was}', '${MD5.box.now}')`));
  assert.ok(sql.includes(`NOT IN ('${MD5.gate.was}', '${MD5.gate.now}')`));
  for (const m of MOVES) assert.ok(sql.includes(`"target": "${m.table}"`), `${m.job} target`);
});

test("A: the revert pairs the eight — the `at` text back, gates {}, phase_lock false, the crons RE-ACTIVATED by name", () => {
  const sql = stripComments(script("fix1396-revert-move-officials-mv-vacuums.sql"));
  for (const m of MOVES) assert.ok(sql.includes(`('${m.job}',`) && sql.includes(`'${m.at}'`), m.job);
  assert.match(sql, /gates\s*=\s*'\{\}'/);
  assert.match(sql, /phase_lock\s*=\s*false/);
  assert.match(sql, /phase_due_at\s*=\s*NULL/);
  assert.match(sql, /AND deadline_rule = v_x\.moved_rule/);
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := true)"));
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});

test("A: check-job-registry reads the eight fences' `at` → dead_tuples as RETURNED and names none of them a problem", async () => {
  type Checker = { checkRegistry: (o: { fencesOnly?: boolean }) => { problems: string[] } };
  const { checkRegistry } = (await import(pathToFileURL(path.join(ROOT, "scripts", "check-job-registry.mjs")).href)) as Checker;
  const { problems } = checkRegistry({});
  for (const m of MOVES) assert.ok(!problems.some((p) => p.includes(m.job)), `${m.job}: ${problems.filter((p) => p.includes(m.job)).join("; ")}`);
});

// ---------------------------------------------------------------------------
// Text — B .. F: each body is its history body plus ONLY its hunks
// ---------------------------------------------------------------------------

test("B1: record_box_health_mem = the rung's body with c_numeric + disk_all_reads, disk_all_reads_ps; nothing else", () => {
  const was = prosrc(RUNG(), "FUNCTION", "record_box_health_mem");
  const now = prosrc(B(), "FUNCTION", "record_box_health_mem");
  assert.equal(md5(was), MD5.mem.was);
  assert.equal(md5(now), MD5.mem.now);
  const arr = (s: string) => [.../c_numeric\s+CONSTANT text\[\] := ARRAY\[([\s\S]*?)\];/.exec(s)![1]!.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
  assert.deepEqual(arr(now), [...arr(was), "disk_all_reads", "disk_all_reads_ps"]);
  const cut = (s: string) => s.replace(/c_numeric\s+CONSTANT text\[\] := ARRAY\[[\s\S]*?\];/, "c_numeric");
  assert.equal(cut(now), cut(was), "the body minus the array literal is byte-identical");
  const store = fs.readFileSync(path.join(__dirname, "..", "..", "..", "db", "src", "box-health-store.ts"), "utf8");
  for (const k of ["disk_all_reads", "disk_all_reads_ps"]) assert.ok(store.includes(`${k}:`), `box-health-store.ts emits ${k}`);
});

test("B2: get_dispatcher_status = fix1354's body + the io block in box + the four io dials; one line edited", () => {
  const was = prosrc(BASE_STATUS(), "FUNCTION", "get_dispatcher_status");
  const now = prosrc(B(), "FUNCTION", "get_dispatcher_status");
  assert.equal(md5(was), MD5.status.was);
  assert.equal(md5(now), MD5.status.now);
  const d = lineDiff(was, now);
  assert.deepEqual(d.removed, ["             'thresholds_memory', v_box.box->'thresholds'->'memory') END,"]);
  assert.equal(d.added.length, 19);
  for (const l of d.added) {
    assert.match(l, /io|thresholds|mirror_age_seconds|mem_stale|v_dials|^\s+--|END\),?$/, `an added line outside the hunks: ${l}`);
  }
  for (const k of ["'io',", "'thresholds_io',", "'mirror_age_seconds',", "'mem_stale',", "'io_time_pct_ceiling',", "'io_samples',", "'io_mbps_floor',", "'io_throttle_hold_min',"]) {
    assert.ok(now.includes(k), k);
  }
  assert.ok(now.includes("v_box.box->'io'") && !now.includes("box->'readings'"), "read 7's real paths, not the prompt's");
});

test("D: box_is_saturated and prod_op_gate each drop the mirror-age test from the HOLD only", () => {
  const box = lineDiff(prosrc(RUNG(), "FUNCTION", "box_is_saturated"), prosrc(D(), "FUNCTION", "box_is_saturated"));
  assert.deepEqual(box.removed, ["  ELSIF NOT v_mem_stale AND v_io_until > p_now THEN"]);
  assert.equal(box.added[0], "  ELSIF v_io_until > p_now THEN");
  assert.ok(box.added.slice(1).every((l) => l.trimStart().startsWith("--")), "the rest is the comment");
  const boxNow = prosrc(D(), "FUNCTION", "box_is_saturated");
  assert.ok(boxNow.includes("ELSIF NOT v_mem_stale AND v_io_streak >= v_io_samples THEN"), "the stale streak stays fail-open");
  assert.ok(boxNow.includes("ELSIF NOT v_mem_stale AND v_swap_used >= v_ceiling THEN"), "the stale swap stays fail-open");

  const gate = lineDiff(prosrc(BASE_GATE(), "FUNCTION", "prod_op_gate"), prosrc(D(), "FUNCTION", "prod_op_gate"));
  assert.deepEqual(gate.removed.filter((l) => !l.trimStart().startsWith("--")), ["  IF v_io_fresh AND v_io_until > p_now THEN"]);
  assert.deepEqual(gate.added.filter((l) => !l.trimStart().startsWith("--")), ["  IF v_io_until > p_now THEN"]);
  assert.ok(prosrc(D(), "FUNCTION", "prod_op_gate").includes("IF v_io_fresh AND v_io_streak >= v_io_need THEN"), "the streak still needs a fresh mirror");
  assert.equal(md5(prosrc(D(), "FUNCTION", "box_is_saturated")), MD5.box.now);
  assert.equal(md5(prosrc(D(), "FUNCTION", "prod_op_gate")), MD5.gate.now);
  assert.doesNotMatch(stripComments(D()), /\(v_gate->>'ok'\)::boolean|v_gate->>'ok' IS DISTINCT/, "no prod_op_gate ok assertion (rule 452)");
});

test("E: donor_rollup_rebuild_bulk = prod's body + the bound, its override and one SET LOCAL; nothing removed", () => {
  const was = prosrc(BASE_DRB(), "PROCEDURE", "donor_rollup_rebuild_bulk");
  const now = prosrc(E(), "PROCEDURE", "donor_rollup_rebuild_bulk");
  assert.equal(md5(was), MD5.drb.was);
  assert.equal(md5(now), MD5.drb.now);
  const d = lineDiff(was, now);
  assert.deepEqual(d.removed, []);
  const code = d.added.filter((l) => l.trim() !== "" && !l.trimStart().startsWith("--"));
  assert.deepEqual(code, [
    "  c_preloop_timeout int := 2400;",
    "  v_cfg := NULLIF(current_setting('civitics.donor_rollup_preloop_timeout_seconds', true), '')::int;",
    "  IF COALESCE(v_cfg, 0) > 0 THEN",
    "    c_preloop_timeout := v_cfg;",
    "  END IF;",
    "    EXECUTE format('SET LOCAL transaction_timeout = %L', c_preloop_timeout || 's');",
  ]);
  const at = now.indexOf("EXECUTE format('SET LOCAL transaction_timeout");
  assert.ok(at > 0 && now.indexOf("PERFORM public.donor_rollup_bulk_assert_invariants();") > at, "immediately before the invariants assert");
  assert.equal(now.slice(at).split("transaction_timeout").length - 1, 1, "nothing resets it after the staging: the COMMIT does");
  const head = E().indexOf("CREATE OR REPLACE PROCEDURE public.donor_rollup_rebuild_bulk()");
  assert.doesNotMatch(E().slice(head, E().indexOf("AS $procedure$", head)), /\bSET\b/, "no proconfig");
});

test("F: get_ec_crawl_health reads dispatch_log for its firings; cron.job_run_details is gone; the keys stand", () => {
  const was = prosrc(BASE_ECH(), "FUNCTION", "get_ec_crawl_health");
  const now = prosrc(F(), "FUNCTION", "get_ec_crawl_health");
  assert.equal(md5(was), MD5.ech.was);
  assert.equal(md5(now), MD5.ech.now);
  assert.doesNotMatch(stripComments(now), /job_run_details|cron\.job\b/);
  assert.match(now, /FROM public\.dispatch_log a/);
  assert.ok(now.includes("l.started_at >  a.armed_for - interval '5 seconds'"), "the window opens 5 s before armed_for");
  assert.ok(now.includes("l.started_at <  a.armed_for + interval '60 seconds'"), "and closes 60 s after it");
  const keys = (s: string) => [...s.matchAll(/^\s+'([a-z_0-9]+)',\s/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys(now.slice(now.indexOf("RETURN jsonb_build_object("))), keys(was.slice(was.indexOf("RETURN jsonb_build_object("))));
});

test("B..F: every read-back's v_missing element is ::text (rule 421); each revert restores the md5 it names", () => {
  for (const [name, src] of [["A", A()], ["B", B()], ["C", C()], ["D", D()], ["E", E()], ["F", F()]] as const) {
    const adds = [...stripComments(src).matchAll(/v_missing := v_missing \|\| ([^;]+);/g)].map((m) => m[1]!.trim());
    assert.ok(adds.length > 0, name);
    for (const a of adds) assert.match(a, /::text$/, `${name}: ${a.slice(0, 80)}`);
  }
  const reverts = [
    ["fix1398-revert-status-readings-io.sql", "FUNCTION", "record_box_health_mem", MD5.mem.was],
    ["fix1398-revert-status-readings-io.sql", "FUNCTION", "get_dispatcher_status", MD5.status.was],
    ["fix1392-revert-io-hold-stale.sql", "FUNCTION", "box_is_saturated", MD5.box.was],
    ["fix1392-revert-io-hold-stale.sql", "FUNCTION", "prod_op_gate", MD5.gate.was],
    ["fix1393-revert-donor-preloop-timeout.sql", "PROCEDURE", "donor_rollup_rebuild_bulk", MD5.drb.was],
    ["fix1293-revert-ec-crawl-health-firings.sql", "FUNCTION", "get_ec_crawl_health", MD5.ech.was],
  ] as const;
  for (const [f, kind, name, want] of reverts) assert.equal(md5(prosrc(script(f), kind, name)), want, `${f}: ${name}`);
  assert.match(script("fix1399-revert-io-samples-3.sql"), /UPDATE public\.platform_dials SET io_samples = 3 WHERE io_samples = 2;/);
});

test("C: one dial UPDATE matched on 3; the read-back reads 90 / 2 / 12 / 60", () => {
  const sql = stripComments(C());
  assert.equal([...sql.matchAll(/UPDATE public\.platform_dials/g)].length, 1);
  assert.match(sql, /UPDATE public\.platform_dials SET io_samples = 2 WHERE io_samples = 3;/);
  assert.match(sql, /v_d\.io_samples IS DISTINCT FROM 2/);
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/);
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

const MB = 1048576;
const MEM = { mem_available_bytes: 450 * MB, mem_total_bytes: 948191232, swap_total_bytes: 1073737728, swap_free_bytes: 1073737728 - 490 * MB };

/** A fresh probe and no mirror, with the dials at this push's values. */
async function freshBox(c: Client, samples = 2): Promise<void> {
  await c.query(`UPDATE public.platform_dials SET io_time_pct_ceiling = 90, io_samples = $1, io_mbps_floor = 12, io_throttle_hold_min = 60, pause = false`, [samples]);
  await c.query("DELETE FROM public.pipeline_state WHERE key IN ('box_health_mem', 'prod_session')");
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health', jsonb_build_object('at', clock_timestamp(), 'startup_timeouts_10m', 0,
                                              'watchdog_max_wall_10m', jsonb_build_object('unit', 0, 'budget', 0)), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  );
}
async function sample(c: Client, rates: Record<string, unknown>): Promise<void> {
  await c.query("SELECT public.record_box_health_mem($1::jsonb)", [JSON.stringify({ ...MEM, ...rates })]);
}
async function mirror(c: Client): Promise<Record<string, unknown>> {
  return (await c.query("SELECT value FROM public.pipeline_state WHERE key = 'box_health_mem'")).rows[0].value;
}
async function verdict(c: Client): Promise<{ reason: string }> {
  return (await c.query("SELECT public.box_is_saturated(p_include_watchdog_wall := false) AS b")).rows[0].b;
}
const BUSY = { io_time_pct: 97, disk_all_read_mbps: 30, disk_all_write_mbps: 1, disk_reads_ps: 2800 };
const THROTTLED = { io_time_pct: 99, disk_all_read_mbps: 4, disk_all_write_mbps: 1, disk_reads_ps: 300 };

/** Seed the mirror directly: an age, a streak, a hold (minutes from now; negative = past), swap. */
async function seedMirror(c: Client, o: { ageS: number; streak: number; holdMin: number | null; swapUsedMb?: number }): Promise<void> {
  await c.query(
    `INSERT INTO public.pipeline_state (key, value, updated_at)
     VALUES ('box_health_mem', jsonb_build_object(
               'at', clock_timestamp() - make_interval(secs => $1),
               'mem_available_bytes', $2::bigint, 'mem_total_bytes', $3::bigint,
               'swap_total_bytes', $4::bigint, 'swap_free_bytes', $4::bigint - $5::bigint * 1048576,
               'io_time_pct', 99, 'disk_all_read_mbps', 4, 'disk_all_write_mbps', 1,
               'io_busy_streak', $6::int)
             || CASE WHEN $7::int IS NULL THEN '{}'::jsonb
                     ELSE jsonb_build_object('io_throttle_until', clock_timestamp() + make_interval(mins => $7::int)) END, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [o.ageS, MEM.mem_available_bytes, MEM.mem_total_bytes, MEM.swap_total_bytes, o.swapUsedMb ?? 490, o.streak, o.holdMin],
  );
}

/** The tick's own row: `job` is the pick, or the first blocked due row. */
async function tickSees(c: Client, job: string): Promise<boolean> {
  const id = (await c.query("SELECT public.dispatch_one_unit('manual') AS d")).rows[0].d.id;
  const r = (await c.query("SELECT job, excluded FROM public.dispatch_log WHERE id = $1", [id])).rows[0];
  return r.job === job || ((r.excluded as string[] | null) ?? []).some((e) => e.includes(job));
}

test("clone A: the MOVE and its revert, inside one rolled-back transaction — idempotent both ways", async (t) => {
  const c0 = await clone(t);
  if (!c0) return;
  const c = withCurrentPins(c0);
  const state = async () => {
    const reg = (await c.query("SELECT job, deadline_rule, gates, phase_lock FROM public.job_registry WHERE job = ANY($1)", [MOVES.map((m) => m.job)])).rows;
    const cron = (await c.query("SELECT jobname, active FROM cron.job WHERE jobname = ANY($1)", [MOVES.map((m) => m.job)])).rows;
    return MOVES.map((m) => {
      const r = reg.find((x) => x.job === m.job);
      const k = cron.filter((x) => x.jobname === m.job);
      return `${m.job} ${r?.deadline_rule} ${JSON.stringify(r?.gates)} ${r?.phase_lock} crons=${k.length} active=${k[0]?.active}`;
    });
  };
  const at = MOVES.map((m) => `${m.job} ${m.at} [] false crons=1 active=true`);
  const moved = MOVES.map((m) => `${m.job} ${rule(m.floor)} ["prod_session"] false crons=1 active=false`);
  try {
    await begin(c);
    try {
      await c.query(script("fix1396-revert-move-officials-mv-vacuums.sql"));
      assert.deepEqual(await state(), at);
      await c.query(A());
      assert.deepEqual(await state(), moved);
      await c.query(A());
      assert.deepEqual(await state(), moved, "idempotent");
      const elig = (await c.query(
        `SELECT count(*)::int AS n FROM public.job_registry j WHERE j.deadline_rule NOT LIKE 'at %'
           AND (j.runner = 'pg_cron' OR j.unit_call ~ '^gha-dispatch:[a-z0-9-]+$')`,
      )).rows[0].n;
      const status = (await c.query("SELECT public.get_dispatcher_status() AS s")).rows[0].s;
      assert.equal(status.registry.eligible, elig, "the status call counts what the pick admits");
      await c.query(script("fix1396-revert-move-officials-mv-vacuums.sql"));
      assert.deepEqual(await state(), at);
      assert.equal((await c.query("SELECT public.get_dispatcher_status() AS s")).rows[0].s.registry.eligible, elig - 8);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c0.end();
  }
});

test("clone A: the check's snapshot path reads the moved rows as RETURNED + gates UPDATED by this file, no drift", async (t) => {
  const c = await clone(t);
  if (!c) return;
  type Fence = { job: string; file: string; line: number } & Record<string, unknown>;
  type Mod = {
    SNAPSHOT_COLUMNS: string[];
    parseSeedFences: (src: string, file: string) => { rows: Fence[]; problems: string[] };
    compareSnapshot: (reg: Map<string, Fence>, rows: Record<string, unknown>[], files: string[], texts: string[]) => {
      info: string[]; problems: string[];
    };
  };
  const m = (await import(pathToFileURL(path.join(ROOT, "scripts", "check-job-registry.mjs")).href)) as Mod;
  try {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const texts = files.map((f) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
    const registry = new Map<string, Fence>();
    files.forEach((f, i) => {
      for (const r of m.parseSeedFences(texts[i]!, `supabase/migrations/${f}`).rows) if (!registry.has(r.job)) registry.set(r.job, r);
    });
    const cols = ["job", ...m.SNAPSHOT_COLUMNS].map((x) => `"${x}"`).join(", ");
    const rows = (await c.query(`SELECT ${cols} FROM public.job_registry`)).rows;
    const out = m.compareSnapshot(registry, rows, files, texts);
    for (const mv of MOVES) {
      assert.ok(!out.problems.some((p) => p.includes(mv.job)), out.problems.filter((p) => p.includes(mv.job)).join("; "));
      const returned = out.info.find((l) => l.startsWith(`RETURNED: ${mv.job} `));
      const updated = out.info.find((l) => l.startsWith(`UPDATED: ${mv.job} `));
      assert.ok(returned?.includes(rule(mv.floor)), `${mv.job}: ${returned}`);
      assert.ok(updated?.includes("20261111000000_fix1396_move_officials_and_mv_vacuum_series_eight_rows"), `${mv.job}: ${updated}`);
      console.info(`[r16] ${returned} | ${updated}`);
    }
  } finally {
    await c.end();
  }
});

test("clone A: the due computation — over 60 % of the trigger due, under it not; a daily row and officials", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    for (const m of MOVES.filter((x) => x.job === "odt-vacuum-analyze" || x.job === "officials-vacuum-analyze")) {
      await begin(c);
      try {
        await freshBox(c);
        await c.query(
          "UPDATE public.job_registry SET deadline_rule = 'at 0 0 1 1 *' WHERE deadline_rule NOT LIKE 'at %' AND job <> $1",
          [m.job],
        );
        await c.query("UPDATE public.platform_dials SET max_concurrent_units = 10, max_live_caps_mb = 100000, rearm_cooldown_seconds = 0");
        // A recent reaped run, so the floor is not due and only the percentage term can be.
        await c.query(
          `INSERT INTO public.dispatch_log (source, job, decision, reason, armed_jobid, ticked_at)
           VALUES ('manual', $1, 'reaped', 'succeeded: VACUUM', 999999, clock_timestamp())`,
          [m.job],
        );
        await c.query(`ALTER TABLE ${m.table} SET (autovacuum_vacuum_threshold = 2000000000)`);
        assert.equal(await tickSees(c, m.job), false, `${m.job}: under 60 % of the trigger, inside the floor — not due`);
        await c.query(`ALTER TABLE ${m.table} SET (autovacuum_vacuum_threshold = 0, autovacuum_vacuum_scale_factor = 0)`);
        assert.equal(await tickSees(c, m.job), true, `${m.job}: at the trigger — due`);
      } finally {
        await c.query("ROLLBACK");
      }
    }
  } finally {
    await c.end();
  }
});

test("clone B: the mirror stores the read count; the status call shows io, thresholds_io, the age, mem_stale, the io dials", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await freshBox(c);
      const r = (await c.query("SELECT public.record_box_health_mem($1::jsonb) AS r", [
        JSON.stringify({ ...MEM, ...BUSY, disk_all_reads: 341667667, disk_all_reads_ps: 215.7, disk_device: "nvme1n1" }),
      ])).rows[0].r;
      assert.deepEqual(r.ignored_keys, ["disk_device"], "the read count is stored, not ignored");
      const m = await mirror(c);
      assert.equal(m["disk_all_reads"], 341667667);
      assert.equal(m["disk_all_reads_ps"], 215.7);
      await sample(c, BUSY);
      await c.query("SELECT public.dispatch_one_unit('manual')");
      const s = (await c.query("SELECT public.get_dispatcher_status() AS s")).rows[0].s;
      assert.equal(s.box.io.busy_streak, 2);
      assert.deepEqual(s.box.thresholds_io, { ceiling: 90, samples: 2, hold_min: 60, mbps_floor: 12 });
      assert.equal(typeof s.box.mirror_age_seconds, "number");
      assert.equal(s.box.mem_stale, false);
      assert.deepEqual(
        [s.dials.io_time_pct_ceiling, s.dials.io_samples, s.dials.io_mbps_floor, s.dials.io_throttle_hold_min].map(Number),
        [90, 2, 12, 60],
      );
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone C: a fresh streak of 2 reads io_saturated under io_samples 2 and clear under 3; the hold sets on the 2nd sample at the floor", async (t) => {
  const c = await clone(t);
  if (!c) return;
  try {
    await begin(c);
    try {
      await freshBox(c, 2);
      await sample(c, BUSY);
      await sample(c, BUSY);
      assert.equal((await mirror(c))["io_busy_streak"], 2);
      assert.equal((await verdict(c)).reason, "io_saturated");
      await c.query("UPDATE public.platform_dials SET io_samples = 3");
      assert.equal((await verdict(c)).reason, "clear", "the same streak under 3");

      await freshBox(c, 2);
      await sample(c, THROTTLED);
      assert.equal((await mirror(c))["io_throttle_until"], undefined, "one sample is not a hold");
      await sample(c, THROTTLED);
      assert.ok((await mirror(c))["io_throttle_until"], "the second sample at <= 12 MB/s sets the hold");
      assert.equal((await verdict(c)).reason, "io_throttled");

      await freshBox(c, 2);
      await sample(c, BUSY);
      await sample(c, BUSY);
      assert.equal((await mirror(c))["io_throttle_until"], undefined, "31 MB/s is a burst above the floor: no hold");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone D: a standing hold reads at ANY mirror age; a stale streak, a stale swap and no mirror stay clear", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const at = async (o: Parameters<typeof seedMirror>[1]) => {
    await freshBox(c, 2);
    await seedMirror(c, o);
    return (await verdict(c)).reason;
  };
  try {
    await begin(c);
    try {
      assert.equal(await at({ ageS: 30, streak: 0, holdMin: 30 }), "io_throttled", "fresh + hold (as before)");
      assert.equal(await at({ ageS: 400, streak: 0, holdMin: 30 }), "io_throttled", "STALE + hold (FIX-1392)");
      assert.equal(await at({ ageS: 400, streak: 0, holdMin: -1 }), "clear", "stale + an expired hold");
      assert.equal(await at({ ageS: 400, streak: 5, holdMin: null }), "clear", "stale + streak 5, no hold: fail-open kept (FIX-1354 D1)");
      assert.equal(await at({ ageS: 400, streak: 0, holdMin: null, swapUsedMb: 1020 }), "clear", "stale + swap at the ceiling: fail-open kept");
      await freshBox(c, 2);
      assert.equal((await verdict(c)).reason, "clear", "no mirror row");
      await seedMirror(c, { ageS: 400, streak: 0, holdMin: 30 });
      await c.query("UPDATE public.pipeline_state SET value = value || jsonb_build_object('startup_timeouts_10m', 3) WHERE key = 'box_health'");
      assert.equal((await verdict(c)).reason, "fork_failures", "the on-box clauses keep their precedence");
      await c.query("UPDATE public.pipeline_state SET value = value || jsonb_build_object('at', clock_timestamp() - interval '10 minutes') WHERE key = 'box_health'");
      assert.equal((await verdict(c)).reason, "stale");

      for (const exp of [1, 5400]) {
        await freshBox(c, 2);
        await seedMirror(c, { ageS: 400, streak: 0, holdMin: 30 });
        type Block = { name: string; check: string; retry_after: string | null };
        const g: { blocked_by: Block[] } = (await c.query("SELECT public.prod_op_gate($1) AS g", [exp])).rows[0].g;
        const io: Block[] = g.blocked_by.filter((b) => /io_/.test(b.name));
        assert.equal(io.length, 1, `(${exp}) ${JSON.stringify(io)}`);
        assert.equal(io[0]!.name, "io_throttled");
        assert.equal(io[0]!.check, "d");
        const hold = (await mirror(c))["io_throttle_until"] as string;
        assert.equal(new Date(io[0]!.retry_after!).getTime(), new Date(hold).getTime(), "retry_after is the hold");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

test("clone B/D/E/F: each revert restores its md5s and the file re-applies, inside one rolled-back transaction", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const md5s = async () => Object.fromEntries((await c.query(
    `SELECT proname, md5(prosrc) AS m FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('record_box_health_mem', 'get_dispatcher_status', 'box_is_saturated', 'prod_op_gate',
                      'donor_rollup_rebuild_bulk', 'get_ec_crawl_health', 'dispatch_one_unit')`,
  )).rows.map((r: { proname: string; m: string }) => [r.proname, r.m]));
  const now = {
    record_box_health_mem: MD5.mem.now, get_dispatcher_status: MD5.status.now, box_is_saturated: MD5.box.now,
    prod_op_gate: MD5.gate.now, donor_rollup_rebuild_bulk: MD5.drb.now, get_ec_crawl_health: MD5.ech.now, dispatch_one_unit: DISPATCH,
  };
  try {
    await c.query("BEGIN");
    try {
      assert.deepEqual(await md5s(), now, "the clone carries this push");
      await c.query(script("fix1392-revert-io-hold-stale.sql"));
      await c.query(script("fix1398-revert-status-readings-io.sql"));
      await c.query(script("fix1393-revert-donor-preloop-timeout.sql"));
      await c.query(script("fix1293-revert-ec-crawl-health-firings.sql"));
      await c.query(script("fix1399-revert-io-samples-3.sql"));
      assert.deepEqual(await md5s(), {
        record_box_health_mem: MD5.mem.was, get_dispatcher_status: MD5.status.was, box_is_saturated: MD5.box.was,
        prod_op_gate: MD5.gate.was, donor_rollup_rebuild_bulk: MD5.drb.was, get_ec_crawl_health: MD5.ech.was, dispatch_one_unit: DISPATCH,
      });
      assert.equal((await c.query("SELECT io_samples FROM public.platform_dials WHERE id")).rows[0].io_samples, 3);
      for (const f of [B(), C(), D(), E(), F()]) await c.query(f);
      assert.deepEqual(await md5s(), now, "each file re-applies on its prior body");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});

/** A client of its own: transaction_timeout terminates the session it fires in. */
async function solo(): Promise<Client> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  c.on("error", () => { /* the FATAL arrives as a connection error too */ });
  await c.connect();
  return c;
}

test("clone E: transaction_timeout set LOCAL in a procedure arms at the SET, its COMMIT ends it; statement_timeout is inert", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const proc = `CREATE PROCEDURE pg_temp.cc267_tt(p_case int) LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(1);
      COMMIT;
      IF p_case = 1 THEN
        SET LOCAL transaction_timeout = '1s';
        PERFORM pg_sleep(3);
      ELSIF p_case = 2 THEN
        SET LOCAL transaction_timeout = '1s';
        COMMIT;
        PERFORM pg_sleep(2);
      ELSE
        SET LOCAL statement_timeout = '1s';
        PERFORM pg_sleep(2);
      END IF;
    END $$`;
  for (const k of [1, 2, 3]) {
    const c = await solo();
    try {
      await c.query(proc);
      const t0 = Date.now();
      if (k === 1) {
        await assert.rejects(c.query("CALL pg_temp.cc267_tt(1)"), (e: { code?: string; message?: string }) =>
          e.code === "25P04" || /transaction timeout|terminated/i.test(e.message ?? ""));
        const s = (Date.now() - t0) / 1000;
        assert.ok(s >= 1.8 && s < 3.5, `case 1 died ${s} s after the CALL: the SET at ~1 s + 1 s, not the CALL + 1 s`);
      } else {
        await c.query(`CALL pg_temp.cc267_tt(${k})`);
        assert.ok((Date.now() - t0) / 1000 >= 2.8, `case ${k} survived its sleep`);
      }
    } finally {
      await c.end().catch(() => undefined);
    }
  }
});

test("clone E: the real staging dies at a 1 s bound and leaves nothing a cancel would not", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const census = async (c: Client) => (await c.query(
    `SELECT (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory'
               AND objid = (hashtext('official_donor_rollup_refresh')::bigint & 4294967295)::oid) AS locks,
            (SELECT count(*)::int FROM public._drb_targets) AS targets,
            (SELECT count(*)::int FROM public._drb_fe) AS fe,
            (SELECT value::text FROM public.pipeline_state WHERE key = 'donor_rollup_bulk_sweep') AS sweep,
            (SELECT value::text FROM public.pipeline_state WHERE key = 'donor_rollup_watermark') AS wm,
            (SELECT count(*)::int FROM public.data_sync_log WHERE pipeline = 'donor_rollup_refresh') AS rows`,
  )).rows[0];
  const watcher = await solo();
  try {
    const before = await census(watcher);
    const c = await solo();
    try {
      // One transaction: the setup and the CALL die together, so nothing here is ever committed.
      await c.query("BEGIN");
      await c.query(`UPDATE public.pipeline_state SET value = jsonb_set(value, '{last_indexed_at}', '"2026-08-19 00:00:00+00"')
                      WHERE key = 'donor_rollup_watermark'`);
      await freshBox(c);
      await c.query("SET LOCAL civitics.donor_rollup_ignore_start_window = 'true'");
      await c.query("SET LOCAL civitics.donor_rollup_preloop_timeout_seconds = '1'");
      await assert.rejects(c.query("CALL public.donor_rollup_rebuild_bulk()"), (e: { code?: string; message?: string }) =>
        e.code === "25P04" || /transaction timeout|terminated/i.test(e.message ?? ""));
    } finally {
      await c.end().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await census(watcher), before, "no lock, staging, cursor, watermark or log row survives the FATAL");
  } finally {
    await watcher.end();
  }
});

test("clone F: firings_7d counts the ec-crawl arms, their failed reaps and the units in the window; the keys match the old body's", async (t) => {
  const c = await clone(t);
  if (!c) return;
  const keys = (h: Record<string, unknown>) => ({
    top: Object.keys(h).sort(),
    firings: Object.keys(h["firings_7d"] as Record<string, unknown>).sort(),
  });
  try {
    await c.query("BEGIN");
    try {
      const base = (await c.query("SELECT public.get_ec_crawl_health() AS h")).rows[0].h;
      // Three arms: one reaped succeeded with its unit row 0.1 s after armed_for, one failed, one missed.
      await c.query(
        `INSERT INTO public.dispatch_log (source, job, decision, reason, armed_jobid, armed_jobname, armed_for, ticked_at) VALUES
           ('manual', 'ec-crawl', 'armed',  'test', 990001, 'disp-ec-crawl-990001', now() - interval '3 hours', now() - interval '3 hours 2 minutes'),
           ('manual', 'ec-crawl', 'reaped', 'succeeded: CALL', 990001, 'disp-ec-crawl-990001', NULL, now() - interval '2 hours 58 minutes'),
           ('manual', 'ec-crawl', 'armed',  'test', 990002, 'disp-ec-crawl-990002', now() - interval '2 hours', now() - interval '2 hours 2 minutes'),
           ('manual', 'ec-crawl', 'reaped', 'failed: job startup timeout', 990002, 'disp-ec-crawl-990002', NULL, now() - interval '1 hour 58 minutes'),
           ('manual', 'ec-crawl', 'armed',  'test', 990003, 'disp-ec-crawl-990003', now() - interval '1 hour', now() - interval '1 hour 2 minutes'),
           ('manual', 'ec-crawl', 'missed', 'test', 990003, 'disp-ec-crawl-990003', NULL, now() - interval '50 minutes')`,
      );
      await c.query(
        `INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
         VALUES ('entity_connections_rebuild', 'partial', now() - interval '3 hours' + interval '100 milliseconds', now() - interval '2 hours 59 minutes',
                 '{"units": [{"arm": "test"}]}')`,
      );
      const h = (await c.query("SELECT public.get_ec_crawl_health() AS h")).rows[0].h;
      const d = (k: string) => Number(h.firings_7d[k]) - Number(base.firings_7d[k]);
      assert.deepEqual([d("total"), d("failed"), d("units_run")], [3, 2, 1], JSON.stringify(h.firings_7d));
      await c.query(script("fix1293-revert-ec-crawl-health-firings.sql"));
      const old = (await c.query("SELECT public.get_ec_crawl_health() AS h")).rows[0].h;
      assert.deepEqual(keys(h), keys(old), "the returned key set is unchanged");
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
