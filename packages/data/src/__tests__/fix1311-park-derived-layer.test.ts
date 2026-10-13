/**
 * FIX-1311 (cc-232) — `*_fix1311_park_derived_layer_crons.sql` and its rollback
 * payload `scripts/fix1311-unpark-derived-layer-crons.sql`.
 *
 * Runs via:  tsx --test src/__tests__/fix1311-park-derived-layer.test.ts
 *
 * Source anchors only (no DB, run in CI):
 *   - the park and the unpark name the SAME 18 jobs, and each is exactly the
 *     cc-232 PARK list;
 *   - none of the 20 KEEP names (the plumbing) appears in either file's code;
 *   - the migration's job→pipeline pairs give 16 distinct pipelines, two of
 *     them shared by a daily/weekly pair;
 *   - the session-note literal the takeover keys on is prod-session.ts'
 *     SESSION_HOLD_NOTE verbatim (if it drifts, the gated push's own claim
 *     leaves the park with zero hold rows — the migration header says why);
 *   - the hold_reason the park writes is the one the unpark deletes by, and it
 *     does not carry the session prefix a release would clear;
 *   - no proconfig / SET (FIX-1128): both are DO blocks.
 *
 * Deliberately NO live-DB assertion: the parked state is temporary by design —
 * each job returns through job_registry — so a test pinned to it would go red
 * on the first return.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SESSION_HOLD_NOTE, SESSION_HOLD_PREFIX } from "../lib/prod-session";

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const SUFFIX = "_fix1311_park_derived_layer_crons.sql";
const ROLLBACK = path.join(ROOT, "scripts", "fix1311-unpark-derived-layer-crons.sql");

const PARK = [
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
];

const KEEP = [
  "box-health-probe",
  "cron-job-budget-watchdog",
  "derived-mvs-unit-watchdog",
  "dpr-vacuum-analyze",
  "ec-vacuum-analyze",
  "ecs-vacuum-analyze",
  "fe-vacuum-analyze",
  "fr-vacuum-analyze",
  "odbt-vacuum-analyze",
  "odr-mv-vacuum-analyze",
  "odt-vacuum-analyze",
  "officials-vacuum-analyze",
  "osar-vacuum-analyze",
  "osdr-vacuum-analyze",
  "treemap-individuals-vacuum-analyze",
  "xsr-vacuum-analyze",
  "vm-probe-pre-ec",
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

/** The code with every `--` comment removed — the header names the KEEP list. */
const code = (s: string) => s.replace(/--[^\n]*/g, "");

/** The quoted elements of `<name> CONSTANT text[] := ARRAY[ … ];`. */
function arrayConst(src: string, name: string): string[] {
  const m = new RegExp(`${name}\\s+CONSTANT\\s+text\\[\\]\\s*:=\\s*ARRAY\\[([\\s\\S]*?)\\];`).exec(src);
  assert.ok(m, `no ${name} array`);
  return [...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
}

/** A `<name> CONSTANT text := '…' ['…' …];` value, adjacent literals joined. */
function textConst(src: string, name: string): string {
  // The value is one or more quoted literals then `;` — a lazy match to the
  // first `;` would stop inside a literal that contains one.
  const m = new RegExp(`${name}\\s+CONSTANT\\s+text\\s*:=\\s*((?:'(?:[^']|'')*'\\s*)+);`).exec(code(src));
  assert.ok(m, `no ${name} constant`);
  return [...(m[1] as string).matchAll(/'((?:[^']|'')*)'/g)].map((x) => (x[1] as string).replace(/''/g, "'")).join("");
}

const sorted = (xs: string[]) => [...xs].sort();

test("the park names exactly the 18 cc-232 PARK jobs, each once", () => {
  const jobs = arrayConst(migration(), "c_jobs");
  assert.equal(jobs.length, 18);
  assert.equal(new Set(jobs).size, 18, "a job is named twice");
  assert.deepEqual(sorted(jobs), sorted(PARK));
});

test("the unpark names the same 18 jobs as the park", () => {
  assert.deepEqual(sorted(arrayConst(read(ROLLBACK), "c_jobs")), sorted(arrayConst(migration(), "c_jobs")));
});

test("no KEEP name appears in the code of either file", () => {
  for (const [label, src] of [["migration", migration()], ["rollback", read(ROLLBACK)]] as const) {
    const body = code(src);
    for (const k of KEEP) {
      assert.ok(!body.includes(`'${k}'`), `${label} names KEEP job ${k} outside a comment`);
    }
  }
});

test("PARK and KEEP are disjoint and total 38", () => {
  assert.equal(KEEP.length, 20);
  assert.equal(new Set([...PARK, ...KEEP]).size, 38);
});

test("18 jobs pair to 16 pipelines; the two shared pipelines are the daily/weekly pairs", () => {
  const src = migration();
  const jobs = arrayConst(src, "c_jobs");
  const pipes = arrayConst(src, "c_pipes");
  assert.equal(pipes.length, jobs.length, "c_jobs and c_pipes must pair position for position");
  assert.equal(new Set(pipes).size, 16);
  const byPipe = new Map<string, string[]>();
  jobs.forEach((j, i) => byPipe.set(pipes[i] as string, [...(byPipe.get(pipes[i] as string) ?? []), j]));
  const shared = [...byPipe.entries()].filter(([, js]) => js.length > 1);
  assert.deepEqual(
    sorted(shared.map(([p, js]) => `${p}=${sorted(js).join("+")}`)),
    [
      "refresh_derived_mvs=refresh-derived-mvs-daily+refresh-derived-mvs-weekly",
      "run_rule_taggers=rule-taggers-daily+rule-taggers-weekly",
    ],
  );
});

test("the takeover keys on prod-session.ts' SESSION_HOLD_NOTE, verbatim", () => {
  const src = migration();
  assert.equal(textConst(src, "c_session_note"), SESSION_HOLD_NOTE);
  // …and only a pure session row (no cadence, not retired) is taken over.
  assert.match(
    code(src),
    /ON CONFLICT \(pipeline\) DO UPDATE[\s\S]*?WHERE o\.note = c_session_note\s+AND o\.retired_at\s+IS NULL\s+AND o\.cadence_hours IS NULL;/,
  );
});

test("the park's hold_reason is what the unpark deletes by, and a session release cannot clear it", () => {
  const reason = textConst(migration(), "c_reason");
  assert.equal(reason, "parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry");
  assert.ok(!reason.startsWith(SESSION_HOLD_PREFIX), "a session release clears hold_reason LIKE the session prefix");
  const like = textConst(read(ROLLBACK), "c_reason_like");
  assert.ok(like.endsWith("%"));
  assert.ok(reason.startsWith(like.slice(0, -1)), `unpark's ${like} does not match the park's reason`);
  assert.match(code(read(ROLLBACK)), /DELETE FROM public\.rollup_watch_overrides WHERE hold_reason LIKE c_reason_like;/);
});

test("by name: every alter_job resolves its jobid from cron.job.jobname, with a RAISE on a non-unique name", () => {
  for (const [src, to] of [[migration(), "false"], [read(ROLLBACK), "true"]] as const) {
    const body = code(src);
    assert.match(body, /SELECT count\(\*\) INTO v_n FROM cron\.job WHERE jobname = v_name;\s*IF v_n <> 1 THEN\s*RAISE EXCEPTION/);
    assert.match(body, /SELECT jobid, active INTO v_jobid, v_active FROM cron\.job WHERE jobname = v_name;/);
    assert.match(body, new RegExp(`PERFORM cron\\.alter_job\\(job_id := v_jobid, active := ${to}\\);`));
    assert.doesNotMatch(body, /cron\.unschedule|cron\.schedule\(/, "park, don't unschedule (D2)");
    assert.doesNotMatch(body, /alter_job\(\s*\d/, "a literal jobid (FIX-946)");
  }
});

test("no proconfig, no SET (FIX-1128) — both are DO blocks", () => {
  for (const src of [migration(), read(ROLLBACK)]) {
    const body = code(src);
    assert.match(body, /^DO \$\$/m);
    // A GUC SET (`SET [LOCAL] x = '…'` / `TO`) or set_config — not ON CONFLICT's `SET col = EXCLUDED.col`.
    assert.doesNotMatch(body, /\bSET\s+(LOCAL\s+|SESSION\s+)?[a-z_.]+\s*(=|TO)\s*'/i);
    assert.doesNotMatch(body, /set_config\s*\(/i);
    assert.doesNotMatch(body, /CREATE (OR REPLACE )?(FUNCTION|PROCEDURE)/i);
  }
});
