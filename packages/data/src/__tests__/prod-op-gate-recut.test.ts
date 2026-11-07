/**
 * FIX-1342 (cc-247) — `*_fix1342_prod_op_gate_op_classes_spacing_retired.sql`:
 * prod_op_gate() learns the op classes (p_expected_seconds <= 60 is class P, a
 * push, and skips only nightly_next_start) and the clocked vacuum spacing
 * retires (a live VACUUM, or an unguarded > 60 s cron slotted in the span —
 * never "N min after an END").
 *
 * Runs via:  tsx --test src/__tests__/prod-op-gate-recut.test.ts
 *
 * The dispatcher-n2.test.ts shape (rule 305; no DB, run in CI):
 *   - the base is N2 verbatim (its body hashes to what prod carried at cc-247
 *     read 2) and the recut file to the md5 its read-back NOTICEs;
 *   - an LCS line diff removes exactly the pinned lines and adds a pinned
 *     number; the header is N2's byte for byte;
 *   - each hunk by anchor; the read-back RAISEs; the revert carries N2's body.
 * prod-op-gate.test.ts keeps the branch-by-branch clone cases (it derives the
 * latest file). The rehearsal arm below runs only with CIVITICS_CLONE_TESTS=1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

/** Exactly one file per suffix. Lazy, so a missing file fails each test, not the load. */
function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const N2 = () => one("_fix1336_n2_nightly_start_blackout_retired_yield_next_due.sql");
const RECUT = () => one("_fix1342_prod_op_gate_op_classes_spacing_retired.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1342-revert-prod-op-gate.sql"));

const N2_MD5 = "e3e543cd9a30a4b0dca2b52b159410a0";
const RECUT_MD5 ="1d3507cd4b71439f0cfff51cde49b9d8";
const PAIR = { dispatch_one_unit: "7b4e3f66105a49d030c41539e4cd2d56", get_dispatcher_status: "2716fcca9ba97b683963cd499bc78136" };
/** Lines the recut adds vs N2: 15 code + 12 comment. A change anywhere else moves this. */
const ADDED_LINES = 27;

function definition(src: string): string {
  const i = src.lastIndexOf("CREATE OR REPLACE FUNCTION public.prod_op_gate(");
  assert.notEqual(i, -1, "prod_op_gate is defined");
  return src.slice(i, src.indexOf("$function$", src.indexOf("AS $function$", i) + 13));
}
const prosrc = (src: string) => {
  const d = definition(src);
  return d.slice(d.indexOf("AS $function$") + 13);
};
const headerOf = (src: string) => definition(src).split(/\nAS \$/)[0] as string;
const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
const section = (body: string, from: string, to: string) => body.slice(body.indexOf(from), body.indexOf(to));

function lineDiff(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const L: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) removed.push(a[i++] as string);
    else added.push(b[j++] as string);
  }
  while (i < n) removed.push(a[i++] as string);
  while (j < m) added.push(b[j++] as string);
  return { removed, added };
}

// ---------------------------------------------------------------------------
// (1) the base, the diff, the header
// ---------------------------------------------------------------------------

test("(1) N2 is what prod carried at cc-247 read 2; the recut hashes to its NOTICE", () => {
  assert.equal(md5(prosrc(N2())), N2_MD5);
  assert.equal(md5(prosrc(RECUT())), RECUT_MD5);
});

test("(1) the LCS diff against N2 removes the two constants, the two post-END branches, and the lines the hunk rewrote", () => {
  const d = lineDiff(prosrc(N2()), prosrc(RECUT()));
  assert.deepEqual(d.removed, [
    "  -- (b) rule 155.",
    "  c_vac_long_gap    CONSTANT interval := interval '90 minutes';",
    "  c_vac_any_gap     CONSTANT interval := interval '10 minutes';",
    "  IF v_next_start > p_now AND v_next_start - p_now < 2 * v_exp + interval '15 minutes' THEN",
    "    -- The newest run of each job decides; an older long run inside 90 min is",
    "    -- only possible for a job firing more than once in 90 min, and none does.",
    "    IF r.last_end IS NOT NULL AND r.last_wall_s > c_vac_long_s",
    "       AND r.last_end > p_now - c_vac_long_gap THEN",
    "      v_blocked := v_blocked || jsonb_build_object(",
    "        'check', 'b', 'name', r.jobname,",
    "        'detail', format('%s ran %s s, ended %s; +90 min = %s', r.jobname, r.last_wall_s,",
    "                         to_char(r.last_end AT TIME ZONE 'UTC', 'HH24:MI'),",
    "                         to_char((r.last_end + c_vac_long_gap) AT TIME ZONE 'UTC', 'HH24:MI')),",
    "        'retry_after', r.last_end + c_vac_long_gap);",
    "    ELSIF r.last_end IS NOT NULL AND r.last_end > p_now - c_vac_any_gap THEN",
    "      v_blocked := v_blocked || jsonb_build_object(",
    "        'check', 'b', 'name', r.jobname,",
    "        'detail', format('%s ended %s (%s s); +10 min = %s', r.jobname,",
    "                         to_char(r.last_end AT TIME ZONE 'UTC', 'HH24:MI:SS'), r.last_wall_s,",
    "                         to_char((r.last_end + c_vac_any_gap) AT TIME ZONE 'UTC', 'HH24:MI')),",
    "        'retry_after', r.last_end + c_vac_any_gap);",
    "    END IF;",
    "",
    "    IF v_slot IS NOT NULL AND r.active AND COALESCE(r.mean_s, 0) > c_vac_long_s",
    "        'retry_after', v_slot + make_interval(secs => r.mean_s) + c_vac_long_gap);",
  ]);
  assert.equal(d.added.length, ADDED_LINES, d.added.join("\n"));
  assert.equal(d.added.filter((l) => !l.trim().startsWith("--")).length, 15, "15 code lines");
});

test("(1) the header — signature, VOLATILE, SECURITY INVOKER, the one SET — is N2's byte for byte", () => {
  assert.equal(headerOf(RECUT()), headerOf(N2()));
});

// ---------------------------------------------------------------------------
// (2) the hunk, by anchor
// ---------------------------------------------------------------------------

test("(2) c_push_s 60 is declared and read in (a): class P skips only nightly_next_start", () => {
  const b = stripComments(prosrc(RECUT()));
  assert.match(b, /c_push_s {10}CONSTANT numeric {2}:= 60;/);
  const a = section(b, "v_json\n    FROM public.data_sync_log d", "FOR r IN");
  assert.match(a, /v_class := CASE WHEN COALESCE\(p_expected_seconds, 5400\) <= c_push_s THEN 'P' ELSE 'B' END;/);
  assert.match(a, /IF v_class = 'B' AND v_next_start > p_now AND v_next_start - p_now < 2 \* v_exp \+ interval '15 minutes' THEN/);
  assert.equal((a.match(/v_class = 'B'/g) ?? []).length, 1, "only the distance is class-gated");
  for (const name of ["nightly_running", "nightly_between_phases", "nightly_due"]) {
    const at = a.indexOf(`'name', '${name}'`);
    assert.ok(at > 0, name);
    assert.ok(!/v_class/.test(a.slice(Math.max(0, a.lastIndexOf("IF ", at)), at)), `${name} is not class-gated`);
  }
  assert.match(a, /jsonb_build_object\('nightly', jsonb_build_object\(\s+'class', v_class,/);
});

test("(2) dispatched is read from public.job_registry with the three predicates, or a disp- one-shot by name", () => {
  const b = stripComments(prosrc(RECUT()));
  assert.match(b, /\(j\.jobname ~ '\^disp-\.\+-\[0-9\]\+\$'\s+OR EXISTS \(SELECT 1 FROM public\.job_registry g\s+WHERE g\.job = j\.jobname\s+AND g\.deadline_rule !~ '\^at '\s+AND 'prod_session' = ANY \(g\.gates\)\)\)\s+AS dispatched,/);
  assert.match(b, /'dispatched', r\.dispatched,/);
  assert.match(b, /'spacing', 'none \(FIX-1342\): live or slot-in-span',/);
});

test("(2) (b) keeps running_since and the slot clause, re-scoped; no clock after an END", () => {
  const b = stripComments(prosrc(RECUT()));
  assert.doesNotMatch(b, /c_vac_long_gap|c_vac_any_gap|\+90 min|\+10 min|last_end > p_now/);
  assert.match(b, /IF r\.running_since IS NOT NULL THEN/);
  assert.match(b, /IF v_slot IS NOT NULL AND r\.active AND NOT r\.dispatched\s+AND GREATEST\(COALESCE\(r\.mean_s, 0\), COALESCE\(r\.last_wall_s, 0\)\) > c_vac_long_s\s+AND v_slot <= v_span_end THEN/);
  assert.match(b, /'retry_after', v_slot \+ make_interval\(secs => GREATEST\(COALESCE\(r\.mean_s, 0\), COALESCE\(r\.last_wall_s, 0\)\)\)\);/);
});

test("(2) (c) (d) (e) (f) are N2's to the byte", () => {
  const n = prosrc(N2());
  const r = prosrc(RECUT());
  const tail = (s: string) => s.slice(s.indexOf("-- ══ (c) blackout"));
  assert.equal(tail(r), tail(n));
});

// ---------------------------------------------------------------------------
// (3) the file around the body, the read-back, the revert
// ---------------------------------------------------------------------------

test("(3) the file is the function, its COMMENT, the grants and the read-back — nothing else", () => {
  const code = stripComments(RECUT());
  assert.equal((code.match(/CREATE OR REPLACE/g) ?? []).length, 1);
  assert.doesNotMatch(code, /\b(UPDATE|INSERT|DELETE)\s+(INTO\s+)?public\./i);
  assert.doesNotMatch(code, /^\s*(ALTER\s+TABLE|VACUUM|CREATE\s+(UNIQUE\s+)?INDEX|REFRESH\s+MATERIALIZED)\b|cron\.(schedule|alter_job)|CONCURRENTLY/m);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.prod_op_gate\(int, timestamptz\) FROM PUBLIC, anon, authenticated;/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.prod_op_gate\(int, timestamptz\) TO service_role;/);
  assert.match(code, /COMMENT ON FUNCTION public\.prod_op_gate\(int, timestamptz\) IS\s+'FIX-1215 — may a supervised prod op/);
});

test("(3) the read-back RAISEs on the pair, the spacing text, the classes; NOTICEs the md5 and the dispatched set", () => {
  const code = stripComments(RECUT());
  assert.match(code, new RegExp(`v_md5_d IS DISTINCT FROM '${PAIR.dispatch_one_unit}'`));
  assert.match(code, new RegExp(`v_md5_g IS DISTINCT FROM '${PAIR.get_dispatcher_status}'`));
  assert.match(code, /IF v_src ~ 'c_vac_long_gap\|c_vac_any_gap\|\\\+90 min\|\\\+10 min' THEN/);
  assert.match(code, /v_p := public\.prod_op_gate\(60, {3}'2026-10-24 20:40:00Z'\);/);
  assert.match(code, /v_b := public\.prod_op_gate\(5400, '2026-10-24 20:40:00Z'\);/);
  assert.match(code, /IF \(v_p->'readings'->'nightly'->>'class'\) IS DISTINCT FROM 'P' THEN/);
  assert.match(code, /RAISE EXCEPTION '\[fix1342\] read-back failed: %'/);
  assert.match(code, /RAISE NOTICE '\[fix1342\] md5 prod_op_gate %', v_md5_p;/);
  assert.match(code, /RAISE NOTICE '\[fix1342\] \(b\) readings: % job\(s\), dispatched %'/);
});

test("(3) the revert: N2's body verbatim, the recut md5 asserted first, N2's after", () => {
  const src = REVERT();
  assert.equal(md5(prosrc(src)), N2_MD5);
  const code = stripComments(src);
  const pre = code.indexOf(`IF v IS DISTINCT FROM '${RECUT_MD5}' THEN`);
  const fn = code.indexOf("CREATE OR REPLACE FUNCTION public.prod_op_gate(");
  const post = code.indexOf(`IF v IS DISTINCT FROM '${N2_MD5}' THEN`);
  assert.ok(pre > 0 && fn > pre && post > fn, "pre-assert → body → post-assert");
  assert.match(code, /^BEGIN;$/m);
  assert.match(code, /^COMMIT;$/m);
  assert.match(read(path.join(ROOT, "scripts", "fix1336-revert-prod-op-gate.sql")),
    /^-- superseded as a revert target by fix1342: running this after 20261025000000 also re-installs the 05:45–09:00 blackout constants$/m);
});

// ---------------------------------------------------------------------------
// (4) the clone rehearsal — CIVITICS_CLONE_TESTS=1, rolled back
// ---------------------------------------------------------------------------

type Blocked = { check: string; name: string; detail: string; retry_after: string | null };
type Gate = {
  ok: boolean;
  blocked_by: Blocked[];
  readings: {
    nightly: { class: string; required_minutes: number };
    vacuum: { jobs: Array<{ jobname: string; dispatched: boolean }> };
  };
};

test("(4) clone rehearsal (r1)-(r6): classes, the dispatched skip, live and slot-in-span", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("CIVITICS_CLONE_TESTS!=1");
    return;
  }
  const { Client } = await import("pg");
  const c = new Client({
    connectionString: process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    connectionTimeoutMillis: 2500,
  });
  try {
    await c.connect();
  } catch {
    t.skip("local Docker DB unreachable");
    return;
  }
  let runid = 9_134_200_000;
  const jobid = async (name: string) =>
    (await c.query<{ jobid: number }>("SELECT jobid FROM cron.job WHERE jobname = $1", [name])).rows[0]?.jobid ?? null;
  const run = async (job: number, start: string, end: string | null, status = "succeeded") => {
    await c.query(
      `INSERT INTO cron.job_run_details
         (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
       VALUES ($1, $2, 1, 'postgres', 'postgres', 'synthetic fix1342', $3, '', $4::timestamptz, $5::timestamptz)`,
      [job, runid++, status, start, end]);
  };
  const gate = async (now: string, expected: number) =>
    (await c.query<{ g: Gate }>("SELECT public.prod_op_gate($1, $2::timestamptz) AS g", [expected, now])).rows[0]!.g;
  const b = (g: Gate, name?: string) => g.blocked_by.filter((x) => x.check === "b" && (name === undefined || x.name === name));
  const has = (g: Gate, check: string, name: string) => g.blocked_by.some((x) => x.check === check && x.name === name);
  const tx = async (name: string, fn: () => Promise<void>) => {
    await t.test(name, async () => {
      await c.query("BEGIN");
      try { await fn(); } finally { await c.query("ROLLBACK"); }
    });
  };
  try {
    const md = (await c.query<{ m: string }>(
      "SELECT md5(prosrc) AS m FROM pg_proc WHERE proname = 'prod_op_gate' AND pronamespace = 'public'::regnamespace")).rows[0]?.m;
    if (md !== RECUT_MD5 && md !== D_RECUT_MD5) {
      t.skip(`FIX-1342 not applied on this DB (md5 ${md})`);
      return;
    }
    const NOON = "2030-03-12 12:00:00+00";

    await tx("(r1) a 200 s dispatched vacuum ended 20 min ago: (60) and (5400) not blocked on (b)", async () => {
      const fr = (await jobid("fr-vacuum-analyze"))!;
      await c.query("SELECT cron.alter_job($1, active := false)", [fr]);
      await run(fr, "2030-03-12 11:36:40+00", "2030-03-12 11:40:00+00");
      for (const e of [60, 5400]) {
        const g = await gate(NOON, e);
        assert.deepEqual(b(g), [], `(${e}) ${JSON.stringify(g.blocked_by)}`);
        assert.equal(g.readings.vacuum.jobs.find((j) => j.jobname === "fr-vacuum-analyze")?.dispatched, true);
      }
    });

    await tx("(r2) an active unguarded 200 s-mean cron slotted 40 min ahead: (5400) blocked, (60) not", async () => {
      const off = (await jobid("officials-vacuum-analyze"))!;
      const now = "2030-03-12 00:50:00+00";
      // Its real schedule is weekly (30 1 * * 1), which the daily regex reads
      // as unparsed — the slot clause needs a daily one to exercise.
      await c.query("SELECT cron.alter_job($1, schedule := '30 1 * * *', active := true)", [off]);
      for (const d of ["09", "10", "11"]) await run(off, `2030-03-${d} 01:30:00+00`, `2030-03-${d} 01:33:20+00`);
      const g1 = await gate(now, 5400);
      assert.equal(b(g1, "officials-vacuum-analyze").length, 1, JSON.stringify(g1.blocked_by));
      assert.equal(new Date(b(g1, "officials-vacuum-analyze")[0]!.retry_after!).toISOString(), "2030-03-12T01:33:20.000Z");
      const g2 = await gate(now, 60);
      assert.deepEqual(b(g2), [], JSON.stringify(g2.blocked_by));
    });

    await tx("(r3) a live disp- one-shot blocks (60) and (5400) on (b) running since", async () => {
      await c.query(`SELECT cron.schedule('disp-fr-vacuum-analyze-1761300000', '0 3 1 1 *', 'SELECT 1')`);
      const id = (await jobid("disp-fr-vacuum-analyze-1761300000"))!;
      await run(id, "2030-03-12 11:58:00+00", null, "running");
      for (const e of [60, 5400]) {
        const g = await gate(NOON, e);
        assert.match(b(g, "disp-fr-vacuum-analyze-1761300000")[0]?.detail ?? "", /running since 11:58:00/, JSON.stringify(g.blocked_by));
        assert.equal(g.readings.vacuum.jobs.find((j) => j.jobname === "disp-fr-vacuum-analyze-1761300000")?.dispatched, true);
      }
    });

    await tx("(r4) a running nightly phase, then a phase closed 5 min ago: both classes blocked", async () => {
      await c.query(`INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
                     VALUES ('nightly_cron', 'running', '2030-03-12 11:40:00+00', '{"phase":"fec"}')`);
      for (const e of [60, 5400]) assert.ok(has(await gate(NOON, e), "a", "nightly_running"), `(${e})`);
      await c.query(`UPDATE public.data_sync_log SET status = 'complete', completed_at = '2030-03-12 11:55:00+00'
                      WHERE pipeline = 'nightly_cron' AND started_at = '2030-03-12 11:40:00+00'`);
      for (const e of [60, 5400]) assert.ok(has(await gate(NOON, e), "a", "nightly_between_phases"), `(${e})`);
    });

    await tx("(r5) 20:50Z: (60) clear on (a), (5400) blocked nightly_next_start, required 195", async () => {
      const now = "2030-03-12 20:50:00+00";
      const g1 = await gate(now, 60);
      assert.ok(!g1.blocked_by.some((x) => x.check === "a"), JSON.stringify(g1.blocked_by));
      assert.equal(g1.readings.nightly.class, "P");
      const g2 = await gate(now, 5400);
      assert.ok(has(g2, "a", "nightly_next_start"), JSON.stringify(g2.blocked_by));
      assert.equal(g2.readings.nightly.required_minutes, 195);
      assert.equal(g2.readings.nightly.class, "B");
    });

    await tx("(r6) 21:30Z with no nightly row since 20:00Z: nightly_due blocks both classes", async () => {
      const now = "2030-03-12 21:30:00+00";
      for (const e of [60, 5400]) assert.ok(has(await gate(now, e), "a", "nightly_due"), `(${e})`);
    });
  } finally {
    await c.end();
  }
});

// ---------------------------------------------------------------------------
// FIX-1377 + FIX-1353 (cc-264) — (d) re-cut: 3 h for class B, the last 10 min and
// the live box for class P, the mirror's io: keys for both.
// ---------------------------------------------------------------------------

const D_RECUT = () => one("_fix1377_fix1353_prod_op_gate_d_3h_class_b_10m_live_box_class_p_io_input.sql");
const D_REVERT = () => read(path.join(ROOT, "scripts", "fix1377-revert-prod-op-gate-d.sql"));
const D_RECUT_MD5 = "6488601cf8c09287d540989c0e0fd074";

test("(5) the re-cut hashes to its read-back; the header is fix1342's; (a)(b)(c)(e)(f) are fix1342's to the byte", () => {
  assert.equal(md5(prosrc(D_RECUT())), D_RECUT_MD5);
  assert.ok(D_RECUT().includes(D_RECUT_MD5));
  assert.ok(D_RECUT().includes(RECUT_MD5), "the guard names fix1342's");
  assert.equal(headerOf(D_RECUT()), headerOf(RECUT()));
  const was = prosrc(RECUT());
  const now = prosrc(D_RECUT());
  for (const [from, to] of [
    ["  v_exp      := make_interval(", "  -- ══ (d) watchdogs"],
    ["  -- ══ (e) interlock", "  RETURN jsonb_build_object("],
  ] as const) {
    assert.equal(section(now, from, to), section(was, from, to), `${from} … ${to}`);
  }
});

test("(5) the windows by class, the detail names its own, retry_after = latest + the window", () => {
  const b = stripComments(prosrc(D_RECUT()));
  assert.match(b, /c_st_window_b\s+CONSTANT interval := interval '3 hours';/);
  assert.match(b, /c_st_window_p\s+CONSTANT interval := interval '10 minutes';/);
  assert.match(b, /v_st_window := CASE WHEN v_class = 'P' THEN c_st_window_p ELSE c_st_window_b END;/);
  assert.match(b, /in the last %s, latest %s/);
  assert.match(b, /'retry_after', v_t \+ v_st_window/);
  assert.doesNotMatch(b, /d\.startup_timeout AND d\.start_time > p_now - interval '60 minutes'/);
});

test("(5) class P reads the live box with the NAMED argument; both read the mirror; p_now is the only clock", () => {
  const b = stripComments(prosrc(D_RECUT()));
  assert.match(b, /public\.box_is_saturated\(p_now := p_now, p_include_watchdog_wall := false\)/);
  assert.doesNotMatch(b, /box_is_saturated\(false\)/, "false would bind to p_stale_seconds");
  assert.ok(b.indexOf("IF v_class = 'P' THEN\n    v_box :=") > 0, "class P only");
  assert.match(b, /'name', 'box_' \|\| COALESCE\(v_box->>'reason', 'unknown'\)/);
  assert.match(b, /NOT IN \('io_saturated', 'io_throttled'\)/, "named once, by the mirror blocks");
  assert.match(b, /IF v_io_fresh AND v_io_until > p_now THEN/);
  assert.match(b, /IF v_io_fresh AND v_io_streak >= v_io_need THEN/);
  assert.match(b, /'name', 'io_throttled'[\s\S]*?'retry_after', v_io_until\)/);
  assert.match(b, /'name', 'io_saturated'[\s\S]*?'retry_after', p_now \+ c_box_retry\)/);
  assert.doesNotMatch(b, /clock_timestamp\(\)|\bnow\(\)/);
});

test("(5) the read-back cannot assert ok under its own claim: it asserts the windows and the new readings", () => {
  const s = D_RECUT();
  const rb = s.slice(s.indexOf("read-back — RAISE on any miss"));
  assert.match(rb, /public\.prod_op_gate\(1\)/);
  assert.match(rb, /public\.prod_op_gate\(5400\)/);
  assert.doesNotMatch(rb, /IF NOT \(v_[pb]->>'ok'\)/, "(e) reads session_held inside a gated push");
  assert.match(rb, /aaf6cc6552df532eff4a9b21e9780670/, "file A's NEW box md5, not fix1354's");
  assert.match(rb, /d6a9073bcc4d9084b9d7994324a89b18/);
  assert.match(rb, /4c30523742e280a4b48ea2ec390654d6/);
});

test("(5) the revert: fix1342's body verbatim, the re-cut md5 asserted first, fix1342's after", () => {
  const r = D_REVERT();
  assert.equal(md5(prosrc(r)), RECUT_MD5);
  assert.ok(r.indexOf(D_RECUT_MD5) < r.indexOf("CREATE OR REPLACE FUNCTION public.prod_op_gate("));
});

test("(6) clone: the windows, the box and the io: keys by class", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const { Client } = await import("pg");
  const c = new Client({
    connectionString: process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    connectionTimeoutMillis: 2500,
  });
  await c.connect();

  type Block = { check: string; name: string; detail: string; retry_after: string | null };
  type G = {
    ok: boolean;
    blocked_by: Block[];
    readings: { box: { reason: string } | null; io: { fresh: boolean }; watchdogs: { startup_timeout_window: string } };
  };
  const NOW = "2030-03-12 12:00:00+00";
  const P = 60;
  const B = 5400;
  const iso = (s: string) => new Date(s).toISOString();
  const gate = async (expected: number, now = NOW) =>
    (await c.query<{ g: G }>("SELECT public.prod_op_gate($1, $2::timestamptz) AS g", [expected, now])).rows[0]!.g;
  const d = (g: G, name: string) => g.blocked_by.find((x) => x.check === "d" && x.name === name);

  let runid = 9_137_700_000;
  const timeout = async (at: string) => {
    const job = (await c.query<{ jobid: number }>("SELECT jobid FROM cron.job ORDER BY jobid LIMIT 1")).rows[0]!.jobid;
    await c.query(
      `INSERT INTO cron.job_run_details
         (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
       VALUES ($1, $2, 1, 'postgres', 'postgres', 'synthetic fix1377', 'failed', 'job startup timeout', $3::timestamptz, $3::timestamptz)`,
      [job, runid++, at]);
  };
  /** A fresh probe and mirror at NOW, plus any mirror keys. Stamped directly, not through the RPC's clock. */
  const seed = async (mirror: Record<string, unknown> = {}, probeAt = "2030-03-12 11:59:30+00") => {
    await c.query("DELETE FROM public.pipeline_state WHERE key = 'prod_session'");
    await c.query(
      `INSERT INTO public.pipeline_state (key, value, updated_at)
       VALUES ('box_health', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ at: probeAt, startup_timeouts_10m: 0, watchdog_max_wall_10m: { unit: 0, budget: 0 } })]);
    await c.query(
      `INSERT INTO public.pipeline_state (key, value, updated_at)
       VALUES ('box_health_mem', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({
        at: "2030-03-12 11:59:00+00", mem_total_bytes: 948191232, mem_available_bytes: 450 * 1048576,
        swap_total_bytes: 1073737728, swap_free_bytes: 600 * 1048576, ...mirror,
      })]);
  };
  const tx = async (name: string, fn: () => Promise<void>) => {
    await t.test(name, async () => {
      await c.query("BEGIN");
      try { await fn(); } finally { await c.query("ROLLBACK"); }
    });
  };

  try {
    await tx("a timeout 2 h old blocks class B to latest + 3 h, and not class P", async () => {
      await seed();
      await timeout("2030-03-12 10:00:00+00");
      const b = d(await gate(B), "startup_timeout");
      assert.ok(b, "class B");
      assert.equal(iso(b.retry_after!), iso("2030-03-12 13:00:00+00"));
      assert.match(b.detail, /in the last 3 h, latest 10:00:00/);
      assert.equal(d(await gate(P), "startup_timeout"), undefined, "class P");
    });

    await tx("a timeout 5 min old blocks both, class P to latest + 10 min", async () => {
      await seed();
      await timeout("2030-03-12 11:55:00+00");
      const p = d(await gate(P), "startup_timeout");
      assert.ok(p, "class P");
      assert.equal(iso(p.retry_after!), iso("2030-03-12 12:05:00+00"));
      assert.match(p.detail, /in the last 10 min, latest 11:55:00/);
      assert.ok(d(await gate(B), "startup_timeout"), "class B");
    });

    await tx("a hold 40 min out blocks both, to that instant", async () => {
      await seed({ io_busy_streak: 0, io_throttle_until: "2030-03-12 12:40:00+00" });
      for (const e of [P, B]) {
        const g = await gate(e);
        const x = d(g, "io_throttled");
        assert.ok(x, `(${e})`);
        assert.equal(iso(x.retry_after!), iso("2030-03-12 12:40:00+00"));
        assert.equal(d(g, "box_io_throttled"), undefined, "named once");
      }
    });

    await tx("a streak of 3 blocks both, now + 10 min, the detail naming N, M and the sample", async () => {
      await seed({ io_busy_streak: 3 });
      for (const e of [P, B]) {
        const g = await gate(e);
        const x = d(g, "io_saturated");
        assert.ok(x, `(${e})`);
        assert.equal(iso(x.retry_after!), iso("2030-03-12 12:10:00+00"));
        assert.match(x.detail, /io_busy_streak 3 >= 3 at 11:59Z/);
        assert.equal(d(g, "box_io_saturated"), undefined, "named once");
      }
    });

    await tx("a stale mirror reads neither io: block", async () => {
      await seed({ at: "2030-03-12 11:00:00+00", io_busy_streak: 9, io_throttle_until: "2030-03-12 13:00:00+00" });
      for (const e of [P, B]) {
        const g = await gate(e);
        assert.equal(d(g, "io_saturated"), undefined, `(${e})`);
        assert.equal(d(g, "io_throttled"), undefined, `(${e})`);
        assert.equal(g.readings.io.fresh, false);
      }
    });

    await tx("memory saturates class P through (d), and never class B", async () => {
      await seed({ swap_free_bytes: 0 });
      const p = await gate(P);
      assert.ok(d(p, "box_memory"), JSON.stringify(p.blocked_by));
      assert.equal(iso(d(p, "box_memory")!.retry_after!), iso("2030-03-12 12:10:00+00"));
      assert.equal(d(p, "box_memory")!.detail, "box_is_saturated: memory");
      assert.equal(p.readings.box?.reason, "memory");
      const b = await gate(B);
      assert.equal(d(b, "box_memory"), undefined);
      assert.equal(b.readings.box, null);
    });

    await tx("a stale probe blocks class P as d:box_stale", async () => {
      await seed({}, "2030-03-12 11:00:00+00");
      assert.ok(d(await gate(P), "box_stale"));
    });

    await tx("the windows read back by class", async () => {
      await seed();
      assert.equal((await gate(P)).readings.watchdogs.startup_timeout_window, "10 min");
      assert.equal((await gate(B)).readings.watchdogs.startup_timeout_window, "3 h");
    });
  } finally {
    await c.end();
  }
});
