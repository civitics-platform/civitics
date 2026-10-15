/**
 * FIX-1312 (cc-226) — `*_fix1312_park_vote_stats_refresh.sql` and its rollback
 * payload `scripts/fix1312-unpark-vote-stats-refresh.sql`. The one-job sibling
 * of fix1311-park-derived-layer.test.ts.
 *
 * Runs via:  tsx --test src/__tests__/fix1312-park-vote-stats-refresh.test.ts
 *
 * Source anchors only (no DB, run in CI):
 *   - the park and the unpark name the SAME one job, vote-stats-refresh;
 *   - it pairs to official_vote_stats_rebuild, its Q_CRON_JOB_PIPELINES pipeline;
 *   - no FIX-1311 PARK name and no plumbing KEEP name appears in either file's code;
 *   - the session-note literal the takeover keys on is prod-session.ts'
 *     SESSION_HOLD_NOTE verbatim (official_vote_stats_rebuild is the one
 *     guarded pipeline the gated push's own claim holds, so if the literal
 *     drifts the park lands with zero hold rows);
 *   - the hold_reason the park writes is the one the unpark deletes by, it
 *     does not carry the session prefix a release would clear, and neither
 *     unpark matches the other's rows;
 *   - no proconfig / SET (FIX-1128): both are DO blocks.
 *
 * Deliberately NO live-DB assertion: the parked state is temporary by design.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SESSION_HOLD_NOTE, SESSION_HOLD_PREFIX } from "../lib/prod-session";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const SUFFIX = "_fix1312_park_vote_stats_refresh.sql";
const ROLLBACK = path.join(ROOT, "scripts", "fix1312-unpark-vote-stats-refresh.sql");
const ROLLBACK_1311 = path.join(ROOT, "scripts", "fix1311-unpark-derived-layer-crons.sql");

const PARK = ["vote-stats-refresh"];

/** FIX-1311's 18 (already parked) and its 20 plumbing KEEP names, plus the 3 unlisted plumbing jobs. */
const NOT_HERE = [
  "ec-crawl",
  "fe-crawl",
  "donor-rollup-refresh",
  "donor-party-rollup-refresh",
  "treemap-individuals-global-refresh",
  "contract-flow-rollups-refresh",
  "agency-staffing-rollup-refresh",
  "group-donor-rollup-refresh",
  "fe-inbound-rollup-refresh",
  "rule-taggers-daily",
  "rule-taggers-weekly",
  "refresh-derived-mvs-daily",
  "refresh-derived-mvs-weekly",
  "financial-entity-totals-reconcile",
  "donation-edge-orphan-sweep",
  "donor-party-rollup-orphan-sweep",
  "donor-rollup-orphan-sweep",
  "entity-connection-stats-orphan-sweep",
  "box-health-probe",
  "cron-job-budget-watchdog",
  "derived-mvs-unit-watchdog",
  "vm-probe-pre-ec",
  "vm-probe-pre-fe",
  "vm-probe-pre-fr",
  "votes-vacuum-analyze",
  "abuse-events-retention",
  "cron-job-run-details-retention",
  "platform-counts-daily",
];

const read = (f: string) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

function migration(): string {
  const hits = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(SUFFIX));
  assert.equal(hits.length, 1, `expected exactly one *${SUFFIX}, found ${hits.join(", ") || "none"}`);
  return read(path.join(MIGRATIONS, hits[0] as string));
}

/** The code with every `--` comment removed — the header names other jobs. */
const code = (s: string) => s.replace(/--[^\n]*/g, "");

/** The quoted elements of `<name> CONSTANT text[] := ARRAY[ … ];`. */
function arrayConst(src: string, name: string): string[] {
  const m = new RegExp(`${name}\\s+CONSTANT\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\];`).exec(src);
  assert.ok(m, `no ${name} array`);
  return [...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
}

/** A `<name> CONSTANT text := '…' ['…' …];` value, adjacent literals joined. */
function textConst(src: string, name: string): string {
  const m = new RegExp(`${name}\\s+CONSTANT\\s+text\\s*:=\\s*((?:'(?:[^']|'')*'\\s*)+);`).exec(code(src));
  assert.ok(m, `no ${name} constant`);
  return [...(m[1] as string).matchAll(/'((?:[^']|'')*)'/g)].map((x) => (x[1] as string).replace(/''/g, "'")).join("");
}

test("the park names exactly vote-stats-refresh, paired to official_vote_stats_rebuild", () => {
  const src = migration();
  assert.deepEqual(arrayConst(src, "c_jobs"), PARK);
  assert.deepEqual(arrayConst(src, "c_pipes"), ["official_vote_stats_rebuild"]);
});

test("the unpark names the same job as the park", () => {
  assert.deepEqual(arrayConst(read(ROLLBACK), "c_jobs"), arrayConst(migration(), "c_jobs"));
});

test("no other cron job appears in the code of either file", () => {
  for (const [label, src] of [["migration", migration()], ["rollback", read(ROLLBACK)]] as const) {
    const body = code(src);
    for (const k of NOT_HERE) {
      assert.ok(!body.includes(`'${k}'`), `${label} names ${k} outside a comment`);
    }
  }
});

test("the takeover keys on prod-session.ts' SESSION_HOLD_NOTE, verbatim", () => {
  const src = migration();
  assert.equal(textConst(src, "c_session_note"), SESSION_HOLD_NOTE);
  assert.match(
    code(src),
    /ON CONFLICT \(pipeline\) DO UPDATE[\s\S]*?WHERE o\.note = c_session_note\s+AND o\.retired_at\s+IS NULL\s+AND o\.cadence_hours IS NULL;/,
  );
});

test("the park's hold_reason is what its unpark deletes by; a session release cannot clear it; FIX-1311's unpark does not match it", () => {
  const reason = textConst(migration(), "c_reason");
  assert.equal(reason, "parked for the dispatcher cutover (cc-226, FIX-1312); returns via job_registry");
  assert.ok(!reason.startsWith(SESSION_HOLD_PREFIX), "a session release clears hold_reason LIKE the session prefix");
  const like = textConst(read(ROLLBACK), "c_reason_like");
  assert.ok(like.endsWith("%"));
  assert.ok(reason.startsWith(like.slice(0, -1)), `unpark's ${like} does not match the park's reason`);
  assert.match(code(read(ROLLBACK)), /DELETE FROM public\.rollup_watch_overrides WHERE hold_reason LIKE c_reason_like;/);
  // The two cutover rollbacks are independent: neither LIKE matches the other's reason.
  const like1311 = textConst(read(ROLLBACK_1311), "c_reason_like");
  assert.ok(!reason.startsWith(like1311.slice(0, -1)), "FIX-1311's unpark would delete this hold");
  assert.ok(!"parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry".startsWith(like.slice(0, -1)));
});

test("by name: every alter_job resolves its jobid from cron.job.jobname, with a RAISE on a non-unique name", () => {
  for (const [src, to] of [[migration(), "false"], [read(ROLLBACK), "true"]] as const) {
    const body = code(src);
    assert.match(body, /SELECT count\(\*\) INTO v_n FROM cron\.job WHERE jobname = v_name;\s*IF v_n <> 1 THEN\s*RAISE EXCEPTION/);
    assert.match(body, /SELECT jobid, active INTO v_jobid, v_active FROM cron\.job WHERE jobname = v_name;/);
    assert.match(body, new RegExp(`PERFORM cron\\.alter_job\\(job_id := v_jobid, active := ${to}\\);`));
    assert.doesNotMatch(body, /cron\.unschedule|cron\.schedule\(/, "park, don't unschedule");
    assert.doesNotMatch(body, /alter_job\(\s*\d/, "a literal jobid (FIX-946)");
  }
});

test("no proconfig, no SET (FIX-1128) — both are DO blocks", () => {
  for (const src of [migration(), read(ROLLBACK)]) {
    const body = code(src);
    assert.match(body, /^DO \$\$/m);
    assert.doesNotMatch(body, /\bSET\s+(LOCAL\s+|SESSION\s+)?[a-z_.]+\s*(=|TO)\s*'/i);
    assert.doesNotMatch(body, /set_config\s*\(/i);
    assert.doesNotMatch(body, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i);
  }
});
