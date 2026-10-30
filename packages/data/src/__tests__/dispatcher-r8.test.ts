/**
 * FIX-1366 — dpr-vacuum-analyze MOVED to the dispatcher as `dead_tuples > 60%
 * of trigger + floor 7 days`, gates {prod_session}, no phase_lock (fix1335's
 * shape), its cron parked at the move. cc-254,
 * `*_fix1366_move_dpr_vacuum_analyze.sql`. It rides donor-party's RETURN
 * (FIX-1335 D-b): the MV's only writers were parked until FIX-1365.
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-r8.test.ts
 *
 * No dispatcher body change, so no body test (rule 305). Text anchors on the
 * migration and its revert payload (no DB, run in CI):
 *   - the rule literal parses under the dead_tuples regex READ OUT OF the live
 *     dispatcher migration (d6a9073b, 20261029000000), groups 60 / 7 days;
 *   - the UPDATE is matched on its exact `at …` text and sets gates
 *     {prod_session}; phase_lock is not written;
 *   - the park is by NAME with the count-1 guard (FIX-946);
 *   - nothing is redefined, no VACUUM runs and no vacuum-name loop is added;
 *   - officials, donor-party and the moved vacuums are never written;
 *   - the read-back pins the current four bodies;
 *   - the revert matches the moved text and re-activates exactly that name.
 * One clone test (CIVITICS_CLONE_TESTS=1) applies the file and its revert
 * inside a rolled-back transaction.
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

function one(suffix: string): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(suffix));
  assert.equal(hits.length, 1, `expected exactly one *${suffix}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}
const DPR = () => one("_fix1366_move_dpr_vacuum_analyze.sql");
const LIVE = () => one("_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1366-revert-move-dpr-vacuum.sql"));

const JOB = "dpr-vacuum-analyze";
const AT = "at 0 2 * * 0,3";
const RULE = "dead_tuples > 60% of trigger + floor 7 days";
const NOT_MOVED = [
  "officials-vacuum-analyze",
  "donor-party-rollup-refresh",
  "fr-vacuum-analyze",
  "ec-vacuum-analyze",
  "fe-vacuum-analyze",
  "votes-vacuum-analyze",
  "xsr-vacuum-analyze",
];

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The dead_tuples parser as the live body runs it: the literal after `regexp_match(r.deadline_rule,`. */
function deadTuplesRegex(): RegExp {
  const lit = /regexp_match\(r\.deadline_rule,\s*'(\^dead_tuples(?:[^']|'')*)'/.exec(LIVE());
  assert.ok(lit, "the live body carries the dead_tuples regexp_match");
  return new RegExp(lit[1]!.replace(/''/g, "'"));
}

test("the rule parses under the live pick's own dead_tuples regex: groups 60 / 7 days", () => {
  const sets = [...stripComments(DPR()).matchAll(/SET deadline_rule = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sets, [RULE], "exactly one rule write");
  const m = deadTuplesRegex().exec(RULE);
  assert.ok(m, `${RULE} matches the pick's regex`);
  assert.equal(m[1], "60");
  assert.equal(m[2], "7 days");
  // The read-back re-parses the rule with the pick's regex, identical literal.
  assert.ok(stripComments(DPR()).includes(deadTuplesRegex().source.replace(/'/g, "''")), "the read-back uses the pick's regex literal verbatim");
});

test("the UPDATE is matched on its exact `at …` text and sets gates {prod_session}; phase_lock untouched (D-d)", () => {
  const sql = stripComments(DPR());
  const updates = sql.split(/UPDATE public\.job_registry/).slice(1);
  assert.equal(updates.length, 1, "one job_registry UPDATE");
  const u = updates[0]!;
  assert.ok(u.includes(`SET deadline_rule = '${RULE}'`));
  assert.match(u, /gates\s*=\s*'\{prod_session\}'/);
  assert.doesNotMatch(u.split("WHERE")[0]!, /phase_lock/, "a weekly floor is not phase-locked (fix1335 D-d)");
  assert.match(u, new RegExp(`WHERE job = '${reEsc(JOB)}'\\s+AND deadline_rule = '${reEsc(AT)}'`));
  assert.ok(u.includes(`'; MOVED 2026-10-30 (FIX-1366, cc-254) from ${AT}'`), "the note append");
});

test("the park is by NAME (FIX-946) with the count-1 guard: alter_job(job_id := v_jobid, active := false)", () => {
  const sql = stripComments(DPR());
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := false)"));
  assert.match(sql, /SELECT count\(\*\) INTO v_n FROM cron\.job WHERE jobname = 'dpr-vacuum-analyze';\s+IF v_n <> 1 THEN/);
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  assert.doesNotMatch(sql, /jobid\s*=\s*31\b/, "never by jobid");
  assert.doesNotMatch(sql, /cron\.unschedule/);
  assert.doesNotMatch(sql, /cron\.schedule\s*\(/);
});

test("the MOVE redefines nothing, runs no VACUUM and adds no vacuum-name loop (rule 295)", () => {
  const sql = stripComments(DPR());
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i);
  assert.doesNotMatch(sql, /^\s*VACUUM\b/im, "class P: no VACUUM statement in the file");
  assert.doesNotMatch(sql, /ILIKE '%vacuum%'/i);
  assert.doesNotMatch(sql, /LIKE '%vacuum/i);
  assert.doesNotMatch(sql, /platform_dials|pipeline_state|rollup_watch_overrides/, "no dial, no hold row");
});

test("officials, donor-party and the already-moved vacuums are never written; officials read back unmoved", () => {
  const sql = stripComments(DPR());
  for (const job of NOT_MOVED) {
    assert.doesNotMatch(sql, new RegExp(`WHERE job = '${reEsc(job)}'\\s+AND deadline_rule`), `${job} is not UPDATEd`);
  }
  assert.ok(sql.includes("IS DISTINCT FROM 'at 30 1 * * 1'"));
  assert.ok(sql.includes("NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'officials-vacuum-analyze' AND active)"));
});

test("the read-back pins the current four bodies and RAISEs on any miss", () => {
  const sql = stripComments(DPR());
  for (const pin of [
    "d6a9073bcc4d9084b9d7994324a89b18",
    "4c30523742e280a4b48ea2ec390654d6",
    "ac8dbcddf71978e73d28c999433156b7",
    "1d3507cd4b71439f0cfff51cde49b9d8",
  ]) {
    assert.ok(sql.includes(`'${pin}'`), pin);
  }
  assert.match(sql, /RAISE EXCEPTION '\[fix1366\] read-back failed: %'/);
  assert.ok(sql.includes("v_rel IS DISTINCT FROM 'public.donor_party_rollup_mv'::regclass"), "the VACUUM target resolves");
  assert.ok(sql.includes("v_r.idempotent_refire IS DISTINCT FROM true"), "the unchanged columns include idempotent_refire");
});

test("the revert pairs the move: the at text, gates {}, phase_lock false, the cron RE-ACTIVATED by name", () => {
  const sql = stripComments(REVERT());
  assert.match(sql, new RegExp(`SET deadline_rule = '${reEsc(AT)}'`));
  assert.match(sql, new RegExp(`WHERE job = '${reEsc(JOB)}'\\s+AND deadline_rule = '${reEsc(RULE)}'`));
  assert.match(sql, /gates\s*=\s*'\{\}'/);
  assert.match(sql, /phase_lock\s*=\s*false/);
  assert.match(sql, /phase_due_at\s*=\s*NULL/);
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := true)"), "the ONE case a revert re-activates a cron");
  assert.ok(sql.includes("WHERE jobname = 'dpr-vacuum-analyze'"));
  assert.equal([...sql.matchAll(/alter_job\(/g)].length, 1, "exactly one cron touched");
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  for (const job of NOT_MOVED) assert.ok(!sql.includes(job), `the revert does not name ${job}`);
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});

// ---------------------------------------------------------------------------
// Behavioural — the clone (CIVITICS_CLONE_TESTS=1 only)
// ---------------------------------------------------------------------------

test("clone: the move and its revert, inside one rolled-back transaction", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to read the migrated clone");
    return;
  }
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  await c.connect();
  const state = async () => {
    const r = (await c.query("SELECT deadline_rule, gates, phase_lock FROM public.job_registry WHERE job = $1", [JOB])).rows[0];
    const cron = (await c.query("SELECT active FROM cron.job WHERE jobname = $1", [JOB])).rows;
    const off = (await c.query("SELECT active FROM cron.job WHERE jobname = 'officials-vacuum-analyze'")).rows[0];
    return { rule: r.deadline_rule, gates: r.gates, lock: r.phase_lock, crons: cron.length, active: cron[0]?.active, officials: off?.active };
  };
  try {
    await c.query("BEGIN");
    try {
      await c.query(REVERT());  // from the un-moved row, whichever state the clone is in
      assert.deepEqual(await state(), { rule: AT, gates: [], lock: false, crons: 1, active: true, officials: true });
      await c.query(DPR());
      assert.deepEqual(await state(), { rule: RULE, gates: ["prod_session"], lock: false, crons: 1, active: false, officials: true });
      await c.query(DPR());  // idempotent
      assert.deepEqual(await state(), { rule: RULE, gates: ["prod_session"], lock: false, crons: 1, active: false, officials: true });
      await c.query(REVERT());
      assert.deepEqual(await state(), { rule: AT, gates: [], lock: false, crons: 1, active: true, officials: true });
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
});
