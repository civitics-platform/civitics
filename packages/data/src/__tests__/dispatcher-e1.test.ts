/**
 * FIX-1327 — ec-crawl (`stale_after 10 minutes`) and fe-crawl (`stale_after
 * 25 minutes`) RETURNED via job_registry; their cutover hold rows converted to
 * cadence_hours 24 (`*_fix1327_return_crawls.sql`, cc-237).
 *
 * Runs via:  tsx --test src/__tests__/dispatcher-e1.test.ts
 *
 * No dispatcher body changes (D-h); text anchors only (no DB, run in CI;
 * rule 105):
 *   - each `stale_after` literal, stripped of `stale_after `, is a PG interval
 *     literal of the shape the pick casts (`^stale_after\s+(.+)$` → ::interval
 *     in 20261016230000), with the planned value;
 *   - each hold row is matched on its EXACT cutover hold_reason literal, read
 *     out of the park migration that wrote it, and becomes cadence_hours 24;
 *   - both crons are asserted inactive by NAME, never re-scheduled, and no
 *     bare numeric jobid appears (FIX-946);
 *   - nothing is redefined, no vacuum-name loop is added (D-j);
 *   - the revert pairs the migration and leaves the crons parked.
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
const E1 = () => one("_fix1327_return_crawls.sql");
const PARK_1311 = () => one("_fix1311_park_derived_layer_crons.sql");
const E1_REVERT = () => read(path.join(ROOT, "scripts", "fix1327-revert-crawls-return.sql"));

const HOLD_1311 = "parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry";
const CRAWLS = {
  "ec-crawl": { at: "at */15 * * * *", rule: "stale_after 10 minutes", minutes: 10 },
  "fe-crawl": { at: "at */30 * * * *", rule: "stale_after 25 minutes", minutes: 25 },
} as const;

/** The shape both files may use for an interval literal: one integer and a unit. */
const IV = /^(\d+) (minutes|hours|days)$/;

test("both crawl rules are interval literals the pick casts, with the planned values", () => {
  const sql = stripComments(E1());
  for (const [job, c] of Object.entries(CRAWLS)) {
    assert.ok(sql.includes(`SET deadline_rule = '${c.rule}'`), `${job} → ${c.rule}`);
    const iv = c.rule.replace(/^stale_after\s+/, "");
    const m = IV.exec(iv);
    assert.ok(m, `${iv} is <n> minutes|hours|days`);
    assert.equal(m![2], "minutes");
    assert.equal(Number(m![1]), c.minutes);
    // matched on the cron-era literal
    assert.ok(sql.includes(`WHERE job = '${job}'\n     AND deadline_rule = '${c.at}'`), `${job} matched on ${c.at}`);
  }
  // the read-back casts the way the tick does, and compares to the planned interval
  assert.equal(sql.match(/\(substring\(v_(ec|fe) FROM '\^stale_after\\s\+\(\.\+\)\$'\)\)::interval/g)?.length, 2);
  assert.ok(sql.includes("IS DISTINCT FROM interval '10 minutes'"));
  assert.ok(sql.includes("IS DISTINCT FROM interval '25 minutes'"));
});

test("the hold_reason literal is the one FIX-1311 wrote, matched exactly, both rows → cadence 24", () => {
  assert.ok(PARK_1311().includes(`'${HOLD_1311}'`), "FIX-1311 wrote the cc-232 literal");
  const sql = stripComments(E1());
  for (const p of ["entity_connections_rebuild", "financial_entity_totals_refresh"]) {
    assert.ok(sql.includes(`WHERE pipeline = '${p}'\n     AND hold_reason = '${HOLD_1311}'`), `${p} matched on the cutover literal`);
  }
  assert.equal(sql.match(/cadence_hours = 24,/g)?.length, 2, "cadence_hours = 24 set exactly twice");
  assert.doesNotMatch(sql, /DELETE FROM public\.rollup_watch_overrides/, "converted, not deleted");
  // run_rule_taggers is FIX-1328's half and stays held: asserted, never written
  assert.doesNotMatch(sql, /WHERE pipeline = 'run_rule_taggers'\n\s+AND hold_reason/);
  assert.ok(sql.includes("WHERE pipeline = 'run_rule_taggers' AND held_since IS NOT NULL"));
});

test("both crons are asserted inactive by NAME, never touched, and no numeric jobid is hard-coded", () => {
  const sql = stripComments(E1());
  assert.ok(sql.includes("ARRAY['ec-crawl', 'fe-crawl']"));
  assert.ok(sql.includes("FROM cron.job WHERE jobname = v_name"));
  assert.match(sql, /IF v_active IS DISTINCT FROM false THEN\s+RAISE EXCEPTION/);
  assert.doesNotMatch(sql, /cron\.(alter_job|schedule|unschedule)\s*\(/);
  assert.doesNotMatch(sql, /active\s*:=\s*true/);
  assert.doesNotMatch(sql, /jobid\s*=\s*\d+/);
});

test("D-h / D-j: the crawls migration redefines nothing and adds no vacuum-name loop", () => {
  const sql = stripComments(E1());
  assert.doesNotMatch(sql, /CREATE OR REPLACE/i);
  assert.doesNotMatch(sql, /ILIKE '%vacuum%'/i);
  assert.doesNotMatch(sql, /pipeline_state/, "D-d: no crawl config write");
});

test("the crawls revert pairs the return: both at literals, the cutover hold verbatim twice, crons left parked", () => {
  const sql = stripComments(E1_REVERT());
  assert.ok(sql.includes("SET deadline_rule = 'at */15 * * * *'"));
  assert.ok(sql.includes("SET deadline_rule = 'at */30 * * * *'"));
  assert.equal(sql.split(`hold_reason   = '${HOLD_1311}'`).length - 1, 2);
  assert.equal(sql.match(/note LIKE 'FIX-1327 \(cc-237\)%'/g)?.length, 2);
  assert.doesNotMatch(sql, /cron\.(alter_job|schedule|unschedule)\s*\(/);
  assert.doesNotMatch(sql, /platform_dials/, "pause is the operator's, not the payload's");
});

// ── FIX-1328 — rule-taggers-weekly on a `stale_after 7 days` BRIDGE (D-e) ──

const WK = () => one("_fix1328_return_rule_taggers_weekly_bridge.sql");
const WK_REVERT = () => read(path.join(ROOT, "scripts", "fix1328-revert-weekly-bridge.sql"));

test("the weekly bridge is a 7-day interval literal, matched on the parked at 0 16 * * 2", () => {
  const sql = stripComments(WK());
  assert.ok(sql.includes("SET deadline_rule = 'stale_after 7 days'"));
  const m = IV.exec("stale_after 7 days".replace(/^stale_after\s+/, ""));
  assert.ok(m && m[2] === "days" && Number(m[1]) === 7);
  assert.ok(sql.includes("WHERE job = 'rule-taggers-weekly'\n     AND deadline_rule = 'at 0 16 * * 2'"));
  assert.ok(sql.includes("IS DISTINCT FROM interval '7 days'"));
  // not the unsupported by-weekly form (cron_next_daily reads M H * * * only — FIX-1329)
  assert.doesNotMatch(sql, /deadline_rule = 'by /);
});

test("D-e: the bridge never writes rollup_watch_overrides — run_rule_taggers stays held, asserted", () => {
  const sql = stripComments(WK());
  assert.doesNotMatch(sql, /UPDATE public\.rollup_watch_overrides/);
  assert.doesNotMatch(sql, /(INSERT INTO|DELETE FROM) public\.rollup_watch_overrides/);
  assert.ok(sql.includes("WHERE pipeline = 'run_rule_taggers' AND held_since IS NOT NULL"));
  assert.ok(sql.includes(`AND hold_reason = '${HOLD_1311}'`));
});

test("the bridge asserts both rule-tagger crons inactive by NAME and guards its own first-due instant", () => {
  const sql = stripComments(WK());
  assert.ok(sql.includes("ARRAY['rule-taggers-weekly', 'rule-taggers-daily']"));
  assert.ok(sql.includes("FROM cron.job WHERE jobname = v_name"));
  assert.doesNotMatch(sql, /cron\.(alter_job|schedule|unschedule)\s*\(/);
  assert.doesNotMatch(sql, /active\s*:=\s*true/);
  assert.doesNotMatch(sql, /jobid\s*=\s*\d+/);
  // < now + 24 h under a live tick is a RAISE, not a surprise firing tonight
  assert.match(sql, /v_due < now\(\) \+ interval '24 hours'/);
  assert.ok(sql.includes("jobname = 'dispatcher-tick' AND active"));
  assert.doesNotMatch(sql, /CREATE OR REPLACE/i);
  assert.doesNotMatch(sql, /ILIKE '%vacuum%'/i);
});

test("the weekly revert pairs the bridge and leaves the cron parked", () => {
  const sql = stripComments(WK_REVERT());
  assert.ok(sql.includes("SET deadline_rule = 'at 0 16 * * 2'"));
  assert.ok(sql.includes("AND deadline_rule = 'stale_after 7 days'"));
  assert.doesNotMatch(sql, /rollup_watch_overrides/);
  assert.doesNotMatch(sql, /cron\.(alter_job|schedule|unschedule)\s*\(/);
  assert.doesNotMatch(sql, /platform_dials/);
});
