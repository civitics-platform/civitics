/**
 * FIX-1335 — V2: votes-vacuum-analyze and xsr-vacuum-analyze MOVED to the
 * dispatcher as `dead_tuples > 60% of trigger + floor 7 days`, gates
 * {prod_session}, their weekly crons parked at the move
 * (`*_fix1335_move_votes_xsr_vacuums.sql`, cc-240). officials-vacuum-analyze
 * is NOT moved: its trigger is 1,000 tuples (reloptions threshold 1000, scale
 * 0.0), so a 60 % line is crossed by every nightly. dpr-vacuum-analyze rides
 * the donor-party RETURN.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-v2.test.ts
 *
 * No dispatcher body changes in V2, so there is no body test. These are text
 * anchors on the migration and its revert payload (no DB, run in CI; rule
 * 305), plus one live-clone test that runs only with CIVITICS_CLONE_TESTS=1:
 *   - both rule literals parse under the dead_tuples regex READ OUT OF the B1
 *     migration (the body that runs), with groups 60 / 7 days. A typo here
 *     would be `unsupported_deadline` on the first tick;
 *   - each UPDATE is matched on its exact `at …` text and sets gates
 *     {prod_session};
 *   - the parks are by NAME (FIX-946): cron.alter_job(job_id := v_jobid,
 *     active := false), no numeric jobid, no cron.unschedule;
 *   - nothing is redefined (no CREATE OR REPLACE FUNCTION / PROCEDURE) and no
 *     `ILIKE '%vacuum%'` loop is added (rule 295);
 *   - officials and dpr are never written;
 *   - the read-back pins the B1 md5 pair (no body moved);
 *   - the revert pairs the move: both `at …` texts, gates '{}', both crons
 *     RE-ACTIVATED by name, and no third job.
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
const V2 = () => one("_fix1335_move_votes_xsr_vacuums.sql");
const B1 = () => one("_fix1329_dispatcher_b1.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1335-revert-move-votes-xsr-vacuums.sql"));

const RULE = "dead_tuples > 60% of trigger + floor 7 days";
const MOVES: ReadonlyArray<{ job: string; at: string }> = [
  { job: "votes-vacuum-analyze", at: "at 37 2 * * 6" },
  { job: "xsr-vacuum-analyze", at: "at 41 1 * * 2" },
];
const NOT_MOVED = ["officials-vacuum-analyze", "dpr-vacuum-analyze", "fr-vacuum-analyze"];

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The dead_tuples parser as the B1 body runs it: the literal after `regexp_match(r.deadline_rule,`. */
function deadTuplesRegex(): RegExp {
  const lit = /regexp_match\(r\.deadline_rule,\s*'(\^dead_tuples(?:[^']|'')*)'/.exec(B1());
  assert.ok(lit, "B1 carries the dead_tuples regexp_match");
  return new RegExp(lit[1]!.replace(/''/g, "'"));
}

test("both V2 rules parse under the B1 pick's own dead_tuples regex: groups 60 / 7 days", () => {
  const sets = [...stripComments(V2()).matchAll(/SET deadline_rule = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sets, [RULE, RULE], "exactly two rule writes, both the V2 rule");
  const m = deadTuplesRegex().exec(RULE);
  assert.ok(m, `${RULE} matches the pick's regex`);
  assert.equal(m[1], "60");
  assert.equal(m[2], "7 days");
  assert.ok(!RULE.includes("60 %"), "`60%` with no space before the `%` — the regex's literal shape");
});

test("each UPDATE is matched on its exact `at …` text and sets gates {prod_session}", () => {
  const sql = stripComments(V2());
  const updates = sql.split(/UPDATE public\.job_registry/).slice(1);
  assert.equal(updates.length, 2, "two job_registry UPDATEs");
  for (const [i, { job, at }] of MOVES.entries()) {
    const u = updates[i]!;
    assert.ok(u.includes(`SET deadline_rule = '${RULE}'`), `${job}: the rule`);
    assert.match(u, /gates\s*=\s*'\{prod_session\}'/, `${job}: gates`);
    assert.match(u, new RegExp(`WHERE job = '${reEsc(job)}'\\s+AND deadline_rule = '${reEsc(at)}'`), `${job}: matched on ${at}`);
    assert.ok(u.includes(`'; MOVED by cc-240 (FIX-1335) from ${at}'`), `${job}: the note append`);
  }
  // The read-back re-parses the rules with the pick's regex, identical literal.
  const pick = deadTuplesRegex().source;
  assert.ok(sql.includes(pick.replace(/'/g, "''")), "the read-back uses the pick's regex literal verbatim");
});

test("the parks are by NAME (FIX-946): alter_job(job_id := v_jobid, active := false), no numeric jobid, no unschedule", () => {
  const sql = stripComments(V2());
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := false)"));
  assert.ok(sql.includes("FOREACH v_job IN ARRAY ARRAY['votes-vacuum-analyze', 'xsr-vacuum-analyze']"));
  assert.match(sql, /FROM cron\.job WHERE jobname = v_job/);
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  assert.doesNotMatch(sql, /cron\.unschedule/);
  assert.doesNotMatch(sql, /cron\.schedule\s*\(/);
});

test("V2 redefines nothing and adds no vacuum-name loop (rule 295)", () => {
  const sql = stripComments(V2());
  assert.doesNotMatch(sql, /CREATE OR REPLACE (FUNCTION|PROCEDURE)/i);
  assert.doesNotMatch(sql, /CREATE (FUNCTION|PROCEDURE)/i);
  assert.doesNotMatch(sql, /ILIKE '%vacuum%'/i);
  assert.doesNotMatch(sql, /LIKE '%vacuum/i);
});

test("officials, dpr and fr are never written — only read back as unmoved", () => {
  const sql = stripComments(V2());
  for (const job of NOT_MOVED) {
    assert.doesNotMatch(sql, new RegExp(`WHERE job = '${reEsc(job)}'\\s+AND deadline_rule`), `${job} is not UPDATEd`);
  }
  assert.ok(!/ARRAY\['[^\]]*officials/.test(sql), "officials is not in the park loop");
  // The read-back asserts officials and dpr are still on their `at …` rules with active crons.
  assert.ok(sql.includes("IS DISTINCT FROM 'at 30 1 * * 1'"));
  assert.ok(sql.includes("IS DISTINCT FROM 'at 0 2 * * 0,3'"));
  assert.ok(sql.includes("jobname IN ('officials-vacuum-analyze', 'dpr-vacuum-analyze') AND active) <> 2"));
});

test("the V2 read-back pins the B1 md5 pair (no body moved)", () => {
  const sql = stripComments(V2());
  assert.ok(sql.includes("'cfc9ed48517cd7de6fa76cf807dd1f37'"), "dispatch_one_unit md5");
  assert.ok(sql.includes("'1cf4b7745f4c89ce978935648c87c92b'"), "get_dispatcher_status md5");
  assert.ok(!sql.includes("'98660b34c17c5c537fc3d2e03d021440'"), "not the M1 pair");
});

test("the revert pairs the move: both at texts, gates {}, both crons RE-ACTIVATED by name, no third job", () => {
  const sql = stripComments(REVERT());
  for (const { job, at } of MOVES) {
    assert.match(sql, new RegExp(`SET deadline_rule = '${reEsc(at)}'`), `${job} back to ${at}`);
    assert.match(sql, new RegExp(`WHERE job = '${reEsc(job)}'\\s+AND deadline_rule = '${reEsc(RULE)}'`), `${job} matched on the moved rule`);
  }
  assert.equal([...sql.matchAll(/gates\s*=\s*'\{\}'/g)].length, 2);
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := true)"));
  assert.ok(sql.includes("FOREACH v_job IN ARRAY ARRAY['votes-vacuum-analyze', 'xsr-vacuum-analyze']"));
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  for (const job of NOT_MOVED) assert.ok(!sql.includes(job), `the revert does not name ${job}`);
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});

// ---------------------------------------------------------------------------
// Behavioural — the clone, after apply (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

test("clone: the two rules read as written, both crons parked, officials untouched", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to read the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  try {
    const reg = await c.query(
      "SELECT job, deadline_rule, gates FROM public.job_registry " +
        "WHERE job IN ('votes-vacuum-analyze', 'xsr-vacuum-analyze', 'officials-vacuum-analyze') ORDER BY job",
    );
    const byJob = Object.fromEntries(reg.rows.map((r) => [r.job, r]));
    for (const { job } of MOVES) {
      assert.equal(byJob[job]?.deadline_rule, RULE, `${job} rule`);
      assert.deepEqual(byJob[job]?.gates, ["prod_session"], `${job} gates`);
    }
    assert.equal(byJob["officials-vacuum-analyze"]?.deadline_rule, "at 30 1 * * 1");
    const cron = await c.query(
      "SELECT jobname, active FROM cron.job " +
        "WHERE jobname IN ('votes-vacuum-analyze', 'xsr-vacuum-analyze', 'officials-vacuum-analyze') ORDER BY jobname",
    );
    const active = Object.fromEntries(cron.rows.map((r) => [r.jobname, r.active]));
    assert.equal(active["votes-vacuum-analyze"], false);
    assert.equal(active["xsr-vacuum-analyze"], false);
    assert.equal(active["officials-vacuum-analyze"], true);
  } finally {
    await c.end();
  }
});
