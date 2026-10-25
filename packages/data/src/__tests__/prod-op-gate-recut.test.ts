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
    if (md !== RECUT_MD5) {
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
