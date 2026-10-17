/**
 * FIX-1321 — fe-inbound-rollup-refresh (`by 13 2 * * *`) and vote-stats-refresh
 * (`by 30 3 * * *`) RETURNED via job_registry; their cutover hold rows
 * converted to cadence_hours 24 (`*_fix1321_return_by_dailies.sql`, cc-235).
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-by.test.ts
 *
 * No dispatcher body changes (D-h); text anchors only (no DB, run in CI;
 * rule 105):
 *   - both `by` schedules are what cron_next_daily() accepts (M H * * *,
 *     minute <= 59, hour <= 23 — 20261004075000), so neither reads
 *     `unsupported_deadline` on the first tick;
 *   - each hold row is matched on its EXACT cutover hold_reason literal, read
 *     out of the park migration that wrote it, and becomes cadence_hours 24;
 *   - both crons are asserted inactive by NAME, never re-scheduled;
 *   - nothing is redefined, no vacuum-name loop is added (D-j);
 *   - the revert pairs the migration: both `at` literals, both cutover
 *     hold_reason literals verbatim, and no cron re-activation (a RETURN's
 *     revert leaves the crons parked).
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
const BY = () => one("_fix1321_return_by_dailies.sql");
const PARK_1311 = () => one("_fix1311_park_derived_layer_crons.sql");
const PARK_1312 = () => one("_fix1312_park_vote_stats_refresh.sql");
const REVERT = () => read(path.join(ROOT, "scripts", "fix1321-revert-by-dailies.sql"));

const HOLD_1311 = "parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry";
const HOLD_1312 = "parked for the dispatcher cutover (cc-226, FIX-1312); returns via job_registry";
const RULES = { "fe-inbound-rollup-refresh": "by 13 2 * * *", "vote-stats-refresh": "by 30 3 * * *" } as const;

test("both by schedules are what cron_next_daily() accepts (M H * * *, m <= 59, h <= 23)", () => {
  const sql = stripComments(BY());
  for (const [job, rule] of Object.entries(RULES)) {
    assert.ok(sql.includes(`SET deadline_rule = '${rule}'`), `${job} → ${rule}`);
    const sched = rule.replace(/^by\s+/, "");
    assert.match(sched, /^\d+ \d+ \* \* \*$/);
    const [m, h] = sched.split(" ").map(Number);
    assert.ok(m! <= 59 && h! <= 23, `${sched} is in range`);
    // matched on the cron-era literal — the same schedule, `at` → `by`
    assert.ok(sql.includes(`WHERE job = '${job}'\n     AND deadline_rule = 'at ${sched}'`), `${job} matched on at ${sched}`);
  }
});

test("the hold_reason literals are the ones the park migrations wrote, matched exactly", () => {
  assert.ok(PARK_1311().includes(`'${HOLD_1311}'`), "FIX-1311 wrote the cc-232 literal");
  assert.ok(PARK_1312().includes(`'${HOLD_1312}'`), "FIX-1312 wrote the cc-226 literal");
  const sql = stripComments(BY());
  assert.ok(sql.includes(`AND hold_reason = '${HOLD_1311}'`));
  assert.ok(sql.includes(`AND hold_reason = '${HOLD_1312}'`));
  assert.equal(sql.match(/cadence_hours = 24,/g)?.length, 2, "cadence_hours = 24 set twice");
  assert.doesNotMatch(sql, /DELETE FROM public\.rollup_watch_overrides/, "converted, not deleted");
});

test("both crons are asserted inactive by NAME and never touched", () => {
  const sql = stripComments(BY());
  assert.ok(sql.includes("ARRAY['fe-inbound-rollup-refresh', 'vote-stats-refresh']"));
  assert.match(sql, /IF v_active IS DISTINCT FROM false THEN\s+RAISE EXCEPTION/);
  assert.doesNotMatch(sql, /cron\.(alter_job|schedule|unschedule)\s*\(/);
});

test("the read-back fails the push on a schedule cron_next_daily() would refuse", () => {
  const sql = stripComments(BY());
  assert.equal(sql.match(/public\.cron_next_daily\(substring\(v_(fe|vs) FROM '\^by\\s\+\(\.\+\)\$'\), now\(\)\)/g)?.length, 2);
});

test("D-h / D-j: the by migration redefines nothing and adds no vacuum-name loop", () => {
  const sql = stripComments(BY());
  assert.doesNotMatch(sql, /CREATE OR REPLACE/i);
  assert.doesNotMatch(sql, /ILIKE '%vacuum%'/i);
});

test("the revert pairs the return: both at literals, both cutover holds verbatim, crons left parked", () => {
  const sql = stripComments(REVERT());
  assert.ok(sql.includes("SET deadline_rule = 'at 13 2 * * *'"));
  assert.ok(sql.includes("SET deadline_rule = 'at 30 3 * * *'"));
  assert.ok(sql.includes(`hold_reason   = '${HOLD_1311}'`));
  assert.ok(sql.includes(`hold_reason   = '${HOLD_1312}'`));
  assert.equal(sql.match(/note LIKE 'FIX-1321 \(cc-235\)%'/g)?.length, 2);
  assert.doesNotMatch(sql, /cron\.(alter_job|schedule|unschedule)\s*\(/);
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});
