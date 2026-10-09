/**
 * FIX-1284 — run_rule_taggers' weekly branch runs the size-tags merge at
 * work_mem 64MB, behind the P1-A box gate
 * (20261007010000_fix1284_weekly_merge_work_mem_box_gate.sql, cc-205).
 *
 * Runs via:  tsx --test src/__tests__/weekly-size-tags-merge.test.ts
 *
 * Source anchors (no DB, run in CI). The weekly branch SETs work_mem 64MB
 * between `IF p_cadence = 'weekly'` and the _scan call. cc-210 M1
 * (`*_work_mem_m1.sql`) took the daily's SET from 256MB to 64MB too, so the D1
 * checker reads the LATEST body (M1's file, and the live one) and fails on a
 * 256MB daily; the 1284 file is that 256MB body and is a rule-105 twin now.
 * The weekly's own 64MB stays, explicit, once. The gate is called for the weekly
 * cadence only, BEFORE the advisory lock (P1-A: gate → lock → defer → work), and
 * its skip RETURNs before the lock. The procedure carries no SET clause
 * (FIX-1128: it COMMITs). The body minus the fenced FIX-1284 blocks, with the
 * one corrected budget comment put back, is 20261001010000's body byte for byte
 * (rule 34). The trio is not redefined. The D4 re-activation is by NAME,
 * guarded on `NOT active`, and never unschedules.
 *
 * Rule 105 — each checker is also run against the twin it must reject: the 1248
 * body (no 64MB, no gate), the 1284 body (the daily at 256MB), the M1 body
 * without the weekly's own SET, and the gate moved after the lock.
 *
 * Against the local DB (skipped when it is unreachable): the same two checkers
 * over pg_get_functiondef — RED before `migration up --local` — the PROCEDURE's
 * proconfig IS NULL, the three trio bodies byte-equal to the 1248 file's, and
 * the weekly job's schedule and command when the job exists locally. Its
 * `active` flag is NOT asserted here: D4 switches a parked job on, local parks
 * it again by convention (local mirrors prod's migration history, not its
 * runtime), and the prod read-back checks `active = true`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
// Found by suffix so a version bump at landing time does not orphan the anchors.
const MIGRATION_SUFFIX = "_fix1284_weekly_merge_work_mem_box_gate.sql";
const PRIOR = path.join(MIGRATIONS, "20261001010000_fix1248_weekly_size_tags_merge.sql");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const read = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

function bySuffix(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const migration = () => bySuffix(MIGRATION_SUFFIX);
/** cc-210 M1 — the latest run_rule_taggers definition (daily 64MB). */
const latest = () => bySuffix("_work_mem_m1.sql");
/**
 * The run_rule_taggers statement alone, through its closing dollar-quote — the
 * M1 file defines other bodies after it, with SETs of their own.
 */
function procOnly(src: string): string {
  const i = src.indexOf(PROC);
  assert.notEqual(i, -1, "run_rule_taggers not defined in this file");
  const end = src.indexOf("$procedure$;", i);
  assert.notEqual(end, -1, "no closing $procedure$;");
  return src.slice(i, end);
}

const PROC = "CREATE OR REPLACE PROCEDURE public.run_rule_taggers(";
const TRIO = ["scan", "delete", "insert"] as const;

/** A routine's body, between its opening and closing dollar-quote. */
function body(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.notEqual(i, -1, `routine not found: ${signature}`);
  const m = src.slice(i).match(/AS \$(function|procedure)\$([\s\S]*?)\$\1\$/);
  assert.ok(m, `no dollar-quoted body after ${signature}`);
  return m[2] as string;
}

/** `--` comments removed, so an anchor never matches prose. */
const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");

const SCAN_CALL = "public.rebuild_financial_entity_size_tags_scan()";
const WEEKLY_IF = "IF p_cadence = 'weekly' THEN";
const SET_64 = "SET work_mem = '64MB';";
const SET_256 = "SET work_mem = '256MB';";
const GATE = "public.box_backoff_gate('rule-taggers-weekly', 600)";
const LOCK = "pg_try_advisory_lock(c_lock_key)";

/** Everything wrong with D1 in a procedure definition; [] = the FIX-1284 + cc-210 M1 shape. */
function workMemProblems(def: string): string[] {
  const p: string[] = [];
  const code = stripComments(def);
  const scan = code.indexOf(SCAN_CALL);
  if (scan < 0) return ["no _scan call"];
  const branch = code.lastIndexOf(WEEKLY_IF, scan);
  const running = code.indexOf("VALUES ('run_rule_taggers', 'running'");
  // cc-210 M1 — the daily's SET is 64MB now (it was 256MB through FIX-1284).
  if (code.includes(SET_256)) p.push("the daily still reads 256MB (cc-210 M1: 64MB)");
  const daily = code.indexOf(SET_64);
  if (!(daily >= 0 && daily < running)) p.push("no SET work_mem = '64MB' before the running row (the daily's)");
  const weekly = code.indexOf(SET_64, branch);
  if (!(branch > running && weekly > branch && weekly < scan)) {
    p.push("no SET work_mem = '64MB' between the weekly branch and the _scan call");
  }
  const n = code.split(SET_64).length - 1;
  if (n !== 2) p.push(`${n} SETs of work_mem 64MB (want 2: the daily's, then the weekly's own)`);
  return p;
}

/** Everything wrong with D2 in a procedure definition; [] = the FIX-1284 shape. */
function gateProblems(def: string): string[] {
  const p: string[] = [];
  const code = stripComments(def);
  const gate = code.indexOf(GATE);
  const lock = code.indexOf(LOCK);
  if (gate < 0) return ["no box_backoff_gate('rule-taggers-weekly', 600)"];
  if (!(lock > gate)) p.push("gate after the lock (P1-A: a waiting firing must hold nothing)");
  const cond = code.lastIndexOf(WEEKLY_IF, gate);
  if (cond < 0 || /\bEND IF;/.test(code.slice(cond, gate))) p.push("the gate is not inside a weekly-only IF");
  if (!/'box saturated after %s s: %s'/.test(code)) p.push("skip_reason is not the P1-A vocabulary");
  const ret = code.indexOf("RETURN;", gate);
  if (!(ret > gate && ret < lock)) p.push("the skip does not RETURN before the lock");
  if (/box_is_saturated\(/.test(code)) p.push("reads box_is_saturated directly (the gate is the one reader)");
  return p;
}

// ---------------------------------------------------------------------------
// Source anchors — no database.
// ---------------------------------------------------------------------------

test("FIX-1284 D1 + cc-210 M1: the weekly branch SETs work_mem 64MB before the trio; the daily SETs 64MB too", () => {
  assert.deepEqual(workMemProblems(procOnly(latest())), []);
});

test("FIX-1284 D1 rule 105 twins: the 1248 body, the 1284 body's 256MB daily, and a dropped weekly SET are rejected", () => {
  const prior = read(PRIOR).slice(read(PRIOR).indexOf(PROC));
  assert.ok(workMemProblems(prior).includes("no SET work_mem = '64MB' between the weekly branch and the _scan call"));
  // The pre-M1 shape — this case FAILS if the daily reads 256MB.
  const d1284 = migration().slice(migration().indexOf(PROC));
  assert.ok(workMemProblems(d1284).includes("the daily still reads 256MB (cc-210 M1: 64MB)"), workMemProblems(d1284).join("; "));
  const src = procOnly(latest());
  const noWeekly = src.replace(/\n {8}SET work_mem = '64MB';/, "");
  assert.ok(workMemProblems(noWeekly).includes("no SET work_mem = '64MB' between the weekly branch and the _scan call"),
    workMemProblems(noWeekly).join("; "));
});

test("FIX-1284 D2: the P1-A gate, weekly only, before the lock; the skip RETURNs before the lock", () => {
  assert.deepEqual(gateProblems(migration().slice(migration().indexOf(PROC))), []);
  assert.deepEqual(gateProblems(procOnly(latest())), [], "cc-210 M1 keeps the gate");
});

test("FIX-1284 D2 rule 105 twins: the 1248 body and the gate moved after the lock are rejected", () => {
  const prior = read(PRIOR).slice(read(PRIOR).indexOf(PROC));
  assert.deepEqual(gateProblems(prior), ["no box_backoff_gate('rule-taggers-weekly', 600)"]);
  const src = stripComments(migration().slice(migration().indexOf(PROC)));
  const g0 = src.lastIndexOf(WEEKLY_IF, src.indexOf(GATE));
  const g1 = src.indexOf("END IF;\n  END IF;", g0) + "END IF;\n  END IF;".length;
  const block = src.slice(g0, g1);
  const without = src.slice(0, g0) + src.slice(g1);
  const lockEnd = without.indexOf("END IF;", without.indexOf(LOCK)) + "END IF;".length;
  const twin = without.slice(0, lockEnd) + "\n  " + block + without.slice(lockEnd);
  assert.ok(gateProblems(twin).includes("gate after the lock (P1-A: a waiting firing must hold nothing)"), gateProblems(twin).join("; "));
});

test("FIX-1284: the PROCEDURE takes no SET clause (FIX-1128 — it COMMITs)", () => {
  const src = migration();
  const head = src.slice(src.indexOf(PROC), src.indexOf("AS $procedure$", src.indexOf(PROC)));
  assert.doesNotMatch(head, /\bSET\s+\w+/, "ANY proconfig SET makes it atomic and it dies at the first COMMIT");
  const m1 = latest();
  const m1Head = m1.slice(m1.indexOf(PROC), m1.indexOf("AS $procedure$", m1.indexOf(PROC)));
  assert.doesNotMatch(m1Head, /\bSET\s+\w+/, "cc-210 M1 adds no SET clause either");
  assert.doesNotMatch(stripComments(body(src, PROC)), /\bSET\s+(LOCAL\s+)?statement_timeout/i);
  assert.match(src, /REVOKE ALL ON PROCEDURE public\.run_rule_taggers\(text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(src, /GRANT EXECUTE ON PROCEDURE public\.run_rule_taggers\(text\) TO service_role;/);
});

test("FIX-1284 rule 34: the body minus the fenced blocks, with the budget comment put back, is 20261001010000's", () => {
  const now = body(migration(), PROC);
  const fenced = /\n[ \t]*-- >>> FIX-1284[^\n]*\n[\s\S]*?\n[ \t]*-- <<< FIX-1284[^\n]*/g;
  assert.ok((now.match(fenced) ?? []).length >= 3, "the additions are fenced");
  const stripped = now
    .replace(fenced, "")
    .replace(/\n {2}v_gate +jsonb +:= NULL; +-- FIX-1284/, "")
    .replace(
      /Plain SET survives COMMIT\. Budget = 3 h \(FIX-1185;[^\n]*\n[^\n]*\n/,
      "Plain SET survives COMMIT. Budget = 6h role default (FIX-703).\n",
    );
  assert.equal(stripped, body(read(PRIOR), PROC));
});

test("FIX-1284: the trio is not redefined (its bodies stay the 1248 file's)", () => {
  assert.doesNotMatch(migration(), /CREATE (OR REPLACE )?FUNCTION public\.rebuild_financial_entity_size_tags/);
});

test("FIX-1284 D4: re-activation by NAME, guarded on NOT active, never unschedule", () => {
  const code = stripComments(migration());
  assert.match(code, /FROM cron\.job\s+WHERE jobname = 'rule-taggers-weekly' AND NOT active/);
  assert.match(code, /cron\.alter_job\(job_id := v_jobid, active := true\)/);
  assert.doesNotMatch(code, /cron\.(un)?schedule\s*\(/, "unschedule + schedule mints a new jobid and loses history");
  assert.doesNotMatch(code, /jobid\s*=\s*\d+/, "never a hard-coded jobid — 12 on prod, 24 on the clone");
});

// ---------------------------------------------------------------------------
// The local DB — skipped when unreachable.
// ---------------------------------------------------------------------------

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
    return c;
  } catch {
    t.skip("local Docker DB unreachable");
    return null;
  }
}

type Live = { d: string; cfg: string[] | null };
const live = async (c: Client): Promise<Live> =>
  (await c.query<Live>(
    `SELECT pg_get_functiondef('public.run_rule_taggers(text)'::regprocedure) AS d, proconfig AS cfg
       FROM pg_proc WHERE oid = 'public.run_rule_taggers(text)'::regprocedure`)).rows[0]!;

test("FIX-1284 local (1): the live weekly branch SETs work_mem 64MB before the _scan call; the daily is 64MB (cc-210 M1)", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    assert.deepEqual(workMemProblems((await live(c)).d), []);
  } finally {
    await c.end();
  }
});

test("FIX-1284 local (2): the live procedure calls box_backoff_gate('rule-taggers-weekly', 600) before the lock", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    assert.deepEqual(gateProblems((await live(c)).d), []);
  } finally {
    await c.end();
  }
});

test("FIX-1284 local (3)-(5): proconfig IS NULL; the trio is the 1248 file's; the job's slot and command", async (t) => {
  const c = await connect(t);
  if (!c) return;
  try {
    assert.equal((await live(c)).cfg, null, "(3) a COMMITting procedure carries no proconfig");
    const prior = read(PRIOR);
    for (const f of TRIO) {
      const sig = `public.rebuild_financial_entity_size_tags_${f}()`;
      const src: string = (await c.query<{ s: string }>(
        `SELECT prosrc AS s FROM pg_proc WHERE oid = '${sig}'::regprocedure`)).rows[0]!.s;
      assert.equal(src, body(prior, `CREATE OR REPLACE FUNCTION ${sig.slice(0, -1)}`), `(4) ${sig} is the 1248 body`);
    }
    const job = (await c.query<{ schedule: string; command: string }>(
      "SELECT schedule, command FROM cron.job WHERE jobname = 'rule-taggers-weekly'")).rows[0];
    if (job) {
      assert.equal(job.schedule, "0 16 * * 2", "(5) Tuesday 16:00 UTC");
      assert.equal(job.command, "CALL public.run_rule_taggers('weekly');");
    }
  } finally {
    await c.end();
  }
});
