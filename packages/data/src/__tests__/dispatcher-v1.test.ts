/**
 * FIX-1320 — V1: fr-vacuum-analyze MOVED to the dispatcher as `dead_tuples >
 * 60% of trigger + floor 24 hours`, gates {prod_session}, its 03:00Z cron
 * parked at the move (`*_fix1320_move_fr_vacuum_analyze.sql`, cc-235).
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-v1.test.ts
 *
 * No dispatcher body changes in V1 (D-h), so there is no body test; these are
 * text anchors on the migration and its revert payload (no DB, run in CI;
 * rule 105):
 *   - the rule literal parses under the dead_tuples regex READ OUT OF the M1
 *     migration (the body that actually runs), with groups 60 / 24 hours — a
 *     typo here would be `unsupported_deadline` on the first tick;
 *   - the park is by NAME (FIX-946): cron.alter_job(job_id := v_jobid, active
 *     := false), the literal 'fr-vacuum-analyze', no numeric jobid, no
 *     cron.unschedule;
 *   - nothing is redefined (no CREATE OR REPLACE) and no vacuum-name loop is
 *     added (D-j: the fix1239-family guards are not re-run);
 *   - the revert pairs the migration: `at 0 3 * * *` + gates '{}' + the cron
 *     RE-ACTIVATED by name (a MOVE's revert, unlike a RETURN's).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
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
const V1 = () => one("_fix1320_move_fr_vacuum_analyze.sql");
const M1 = () => one("_fix1316_return_donor_rollup_refresh.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1320-revert-fr-vacuum-move.sql"));

const RULE = "dead_tuples > 60% of trigger + floor 24 hours";

/** The dead_tuples parser as the M1 body runs it: the literal after `regexp_match(r.deadline_rule,`. */
function deadTuplesRegex(): RegExp {
  const src = M1();
  const at = src.indexOf("regexp_match(r.deadline_rule,");
  assert.notEqual(at, -1, "M1 carries the dead_tuples regexp_match");
  const lit = /'((?:[^']|'')*)'/.exec(src.slice(at))!;
  return new RegExp(lit[1]!.replace(/''/g, "'"));
}

test("the V1 rule parses under the M1 pick's own dead_tuples regex: groups 60 / 24 hours", () => {
  const set = /SET deadline_rule = '([^']+)'/.exec(stripComments(V1()));
  assert.ok(set, "the V1 file sets a deadline_rule");
  assert.equal(set[1], RULE);
  const m = deadTuplesRegex().exec(set[1]!);
  assert.ok(m, `${RULE} matches the pick's regex`);
  assert.equal(m[1], "60");
  assert.equal(m[2], "24 hours");
});

test("the pct parses as 60 and the floor is a plain PG interval literal", () => {
  const m = deadTuplesRegex().exec(RULE)!;
  assert.equal(Number(m[1]), 60);
  assert.match(m[2]!, /^\d+ hours?$/);
  // `60%` with no space before the `%` — the regex's literal shape.
  assert.ok(!RULE.includes("60 %"));
});

test("the V1 row move sets gates {prod_session} and matches only the seeded `at 0 3 * * *` row", () => {
  const sql = stripComments(V1());
  assert.match(sql, /gates\s*=\s*'\{prod_session\}'/);
  assert.match(sql, /WHERE job = 'fr-vacuum-analyze'\s+AND deadline_rule = 'at 0 3 \* \* \*'/);
  // The read-back re-parses the same rule with the pick's regex, identical literal.
  const pick = deadTuplesRegex().source;
  assert.ok(sql.includes(pick.replace(/'/g, "''")), "the read-back uses the pick's regex literal verbatim");
});

test("the park is by NAME (FIX-946): alter_job(job_id := v_jobid, active := false), no numeric jobid, no unschedule", () => {
  const sql = stripComments(V1());
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := false)"));
  assert.match(sql, /FROM cron\.job WHERE jobname = 'fr-vacuum-analyze'/);
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  assert.doesNotMatch(sql, /cron\.unschedule/);
  assert.doesNotMatch(sql, /cron\.schedule\s*\(/);
});

test("D-h / D-j: the V1 migration redefines nothing and adds no vacuum-name loop", () => {
  const sql = stripComments(V1());
  assert.doesNotMatch(sql, /CREATE OR REPLACE/i);
  assert.doesNotMatch(sql, /ILIKE '%vacuum%'/i);
});

test("the V1 read-back pins the two M1 body md5s (no body moved)", () => {
  const sql = stripComments(V1());
  assert.ok(sql.includes("'98660b34c17c5c537fc3d2e03d021440'"), "dispatch_one_unit md5");
  assert.ok(sql.includes("'4c9d0eb0cd85f9f46b38a9947cc94785'"), "get_dispatcher_status md5");
});

test("the revert pairs the move: at 0 3 * * *, gates {}, the cron RE-ACTIVATED by name", () => {
  const sql = stripComments(REVERT());
  assert.match(sql, /SET deadline_rule = 'at 0 3 \* \* \*'/);
  assert.match(sql, /gates\s*=\s*'\{\}'/);
  assert.ok(sql.includes(`AND deadline_rule = '${RULE}'`), "matched on the moved rule");
  assert.ok(sql.includes("cron.alter_job(job_id := v_jobid, active := true)"));
  assert.match(sql, /FROM cron\.job WHERE jobname = 'fr-vacuum-analyze'/);
  assert.doesNotMatch(sql, /alter_job\(\s*(job_id\s*:=\s*)?\d+/);
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});
