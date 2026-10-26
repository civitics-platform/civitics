/**
 * FIX-1349 — the ec / fe daily VACUUMs MOVED to the dispatcher as
 * `dead_tuples > 60% of trigger + floor 24 hours`, gates {prod_session},
 * phase_lock true (fr's rule, FIX-1320 / FIX-1323), their daily crons parked
 * at the move (`*_fix1349_move_ec_fe_vacuums.sql`, cc-249). officials and dpr
 * stay on cron; refresh-derived-mvs-daily's RETURN is cc-251's.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r3.test.ts
 *
 * No dispatcher body changes, so there is no body test (rule 305). Text
 * anchors on the migration and its revert payload (no DB, run in CI), plus
 * one live-clone test that runs only with CIVITICS_CLONE_TESTS=1:
 *   - both rule literals parse under the dead_tuples regex READ OUT OF the N2
 *     migration (the body that runs, 20261023000000), groups 60 / 24 hours;
 *   - each UPDATE is matched on its exact `at …` text and sets gates
 *     {prod_session} and phase_lock true;
 *   - the parks are by NAME with the count-1 guard (FIX-946);
 *   - nothing is redefined and no vacuum-name loop is added (rule 295);
 *   - officials, dpr, fr, votes, xsr and refresh-derived-mvs-daily are never
 *     written;
 *   - the read-back pins the N2 pair + prod_op_gate (FIX-1342);
 *   - the revert matches the moved text and re-activates both crons by name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { read, stripComments } from "./lib/migration-text";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const LOCAL_DSN =
  process.env["SUPABASE_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Exactly one file per suffix. Lazy, so a missing file fails each test, not the load. */
function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const R3 = () => one("_fix1349_move_ec_fe_vacuums.sql");
const N2 = () => one("_fix1336_n2_nightly_start_blackout_retired_yield_next_due.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1349-revert-move-ec-fe-vacuums.sql"));

const RULE = "dead_tuples > 60% of trigger + floor 24 hours";
const MOVES: ReadonlyArray<{ job: string; at: string }> = [
  { job: "ec-vacuum-analyze", at: "at 30 4 * * *" },
  { job: "fe-vacuum-analyze", at: "at 50 4 * * *" },
];
const NOT_MOVED = [
  "officials-vacuum-analyze",
  "dpr-vacuum-analyze",
  "fr-vacuum-analyze",
  "votes-vacuum-analyze",
  "xsr-vacuum-analyze",
  "refresh-derived-mvs-daily",
];

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The dead_tuples parser as the N2 body runs it: the literal after `regexp_match(r.deadline_rule,`. */
function deadTuplesRegex(): RegExp {
  const lit = /regexp_match\(r\.deadline_rule,\s*'(\^dead_tuples(?:[^']|'')*)'/.exec(N2());
  assert.ok(lit, "N2 carries the dead_tuples regexp_match");
  return new RegExp(lit[1]!.replace(/''/g, "'"));
}

test("both rules parse under the N2 pick's own dead_tuples regex: groups 60 / 24 hours", () => {
  const sets = [...stripComments(R3()).matchAll(/SET deadline_rule = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sets, [RULE, RULE], "exactly two rule writes, both fr's rule");
  const m = deadTuplesRegex().exec(RULE);
  assert.ok(m, `${RULE} matches the pick's regex`);
  assert.equal(m[1], "60");
  assert.equal(m[2], "24 hours");
  assert.ok(!RULE.includes("60 %"), "`60%` with no space before the `%` — the regex's literal shape");
});

test("each UPDATE is matched on its exact `at …` text and sets gates {prod_session} + phase_lock true", () => {
  const sql = stripComments(R3());
  const updates = sql.split(/UPDATE public\.job_registry/).slice(1);
  assert.equal(updates.length, 2, "two job_registry UPDATEs");
  for (const [i, { job, at }] of MOVES.entries()) {
    const u = updates[i]!;
    assert.ok(u.includes(`SET deadline_rule = '${RULE}'`), `${job}: the rule`);
    assert.match(u, /gates\s*=\s*'\{prod_session\}'/, `${job}: gates`);
    assert.match(u, /phase_lock\s*=\s*true/, `${job}: phase_lock true (fr's shape)`);
    assert.match(u, new RegExp(`WHERE job = '${reEsc(job)}'\\s+AND deadline_rule = '${reEsc(at)}'`), `${job}: matched on ${at}`);
    assert.ok(u.includes(`'; MOVED by cc-249 (FIX-1349) from ${at}'`), `${job}: the note append`);
  }
  // The read-back re-parses the rules with the pick's regex, identical literal.
  const pick = deadTuplesRegex().source;
  assert.ok(sql.includes(pick.replace(/'/g, "''")), "the read-back uses the pick's regex literal verbatim");
});

test("the parks are by NAME (FIX-946) with the count-1 guard: alter_job(job_id := v_jobid, active := false)", () => {
  const sql = stripComments(R3());
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := false)"));
  assert.ok(sql.includes("FOREACH v_job IN ARRAY ARRAY['ec-vacuum-analyze', 'fe-vacuum-analyze']"));
  assert.match(sql, /SELECT count\(\*\) INTO v_n FROM cron\.job WHERE jobname = v_job;\s+IF v_n <> 1 THEN/);
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  assert.doesNotMatch(sql, /cron\.unschedule/);
  assert.doesNotMatch(sql, /cron\.schedule\s*\(/);
});

test("the MOVE redefines nothing, runs no VACUUM and adds no vacuum-name loop (rule 295)", () => {
  const sql = stripComments(R3());
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i);
  assert.doesNotMatch(sql, /^\s*VACUUM\b/im, "class P: no VACUUM statement in the file");
  assert.doesNotMatch(sql, /ILIKE '%vacuum%'/i);
  assert.doesNotMatch(sql, /LIKE '%vacuum/i);
});

test("officials, dpr, fr, votes, xsr and refresh-derived-mvs-daily are never written", () => {
  const sql = stripComments(R3());
  for (const job of NOT_MOVED) {
    assert.doesNotMatch(sql, new RegExp(`WHERE job = '${reEsc(job)}'\\s+AND deadline_rule`), `${job} is not UPDATEd`);
  }
  assert.doesNotMatch(sql, /rollup_watch_overrides/, "the refresh_derived_mvs hold row is cc-251's");
  // The read-back asserts officials and dpr are still on their `at …` rules with active crons.
  assert.ok(sql.includes("IS DISTINCT FROM 'at 30 1 * * 1'"));
  assert.ok(sql.includes("IS DISTINCT FROM 'at 0 2 * * 0,3'"));
  assert.ok(sql.includes("jobname IN ('officials-vacuum-analyze', 'dpr-vacuum-analyze') AND active) <> 2"));
});

test("the read-back pins the N2 pair and prod_op_gate (no routine moved)", () => {
  const sql = stripComments(R3());
  assert.ok(sql.includes("'7b4e3f66105a49d030c41539e4cd2d56'"), "dispatch_one_unit md5");
  assert.ok(sql.includes("'2716fcca9ba97b683963cd499bc78136'"), "get_dispatcher_status md5");
  assert.ok(sql.includes("'1d3507cd4b71439f0cfff51cde49b9d8'"), "prod_op_gate md5 (FIX-1342)");
  assert.match(sql, /RAISE EXCEPTION '\[fix1349\] read-back failed: %'/);
});

test("the revert pairs the move: both at texts, gates {}, phase_lock false, both crons RE-ACTIVATED by name", () => {
  const sql = stripComments(REVERT());
  for (const { job, at } of MOVES) {
    assert.match(sql, new RegExp(`SET deadline_rule = '${reEsc(at)}'`), `${job} back to ${at}`);
    assert.match(sql, new RegExp(`WHERE job = '${reEsc(job)}'\\s+AND deadline_rule = '${reEsc(RULE)}'`), `${job} matched on the moved rule`);
  }
  assert.equal([...sql.matchAll(/gates\s*=\s*'\{\}'/g)].length, 2);
  assert.equal([...sql.matchAll(/phase_lock\s*=\s*false/g)].length, 2);
  assert.equal([...sql.matchAll(/phase_due_at\s*=\s*NULL/g)].length, 2);
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := true)"));
  assert.ok(sql.includes("FOREACH v_job IN ARRAY ARRAY['ec-vacuum-analyze', 'fe-vacuum-analyze']"));
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  for (const job of NOT_MOVED) assert.ok(!sql.includes(job), `the revert does not name ${job}`);
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});

// ---------------------------------------------------------------------------
// Behavioural — the clone, after apply (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

test("clone: the two rules read as written, phase-locked, both crons parked, officials + dpr untouched", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to read the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  try {
    const reg = await c.query(
      "SELECT job, deadline_rule, gates, phase_lock FROM public.job_registry " +
        "WHERE job IN ('ec-vacuum-analyze', 'fe-vacuum-analyze', 'officials-vacuum-analyze', 'dpr-vacuum-analyze') ORDER BY job",
    );
    const byJob = Object.fromEntries(reg.rows.map((r) => [r.job, r]));
    for (const { job } of MOVES) {
      assert.equal(byJob[job]?.deadline_rule, RULE, `${job} rule`);
      assert.deepEqual(byJob[job]?.gates, ["prod_session"], `${job} gates`);
      assert.equal(byJob[job]?.phase_lock, true, `${job} phase_lock`);
    }
    assert.equal(byJob["officials-vacuum-analyze"]?.deadline_rule, "at 30 1 * * 1");
    assert.equal(byJob["dpr-vacuum-analyze"]?.deadline_rule, "at 0 2 * * 0,3");
    const cron = await c.query(
      "SELECT jobname, active FROM cron.job " +
        "WHERE jobname IN ('ec-vacuum-analyze', 'fe-vacuum-analyze', 'officials-vacuum-analyze', 'dpr-vacuum-analyze') ORDER BY jobname",
    );
    const active = Object.fromEntries(cron.rows.map((r) => [r.jobname, r.active]));
    assert.equal(active["ec-vacuum-analyze"], false);
    assert.equal(active["fe-vacuum-analyze"], false);
    assert.equal(active["officials-vacuum-analyze"], true);
    assert.equal(active["dpr-vacuum-analyze"], true);
  } finally {
    await c.end();
  }
});
