#!/usr/bin/env node
// test-check-job-registry.mjs — FIX-1307
//
// Fixture suite for scripts/check-job-registry.mjs. Dependency-free, no
// database, same shape as the other scripts/test-*.mjs suites.
//
// The base fixture (scripts/__fixtures__/job-registry/) is a tree that PASSES.
// Each case copies it to a temp dir, breaks one thing, and asserts the check
// names exactly that thing: the wrong-but-green shapes (rule 105) are a guard
// that passes because it parsed nothing, read the wrong receipts file, or
// counted a dispatcher one-shot as a missing job. The real tree runs last.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRegistry, parseSeedFences, parseTuple, parseWorkflowSchedule, registryUpdates } from "./check-job-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "job-registry");
const SEED = join("supabase", "migrations", "20990101000000_fixture_seed.sql");
const RECEIPTS = join("docs", "receipts", "2099-01-01.json");

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

const temps = [];
/** A fresh copy of the base fixture, with `mutate(root)` applied. */
function variant(mutate) {
  const root = mkdtempSync(join(tmpdir(), "job-registry-"));
  temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  mutate?.(root);
  return checkRegistry({ root });
}
const edit = (root, rel, fn) => writeFileSync(join(root, rel), fn(readFileSync(join(root, rel), "utf8")));
const has = (list, needle) => list.some((p) => p.includes(needle));
const dump = (r) => JSON.stringify({ problems: r.problems, warnings: r.warnings });

console.log("check:job-registry — parsers");
{
  check("parseTuple unescapes '' and keeps commas inside a string",
    JSON.stringify(parseTuple("  ('a', 'it''s, x', NULL, 3, true, false),")) === JSON.stringify(["a", "it's, x", null, 3, true, false]));
  check("parseTuple refuses an unterminated string", parseTuple("('a, 1)") === null);
  check("parseTuple refuses a bare word", parseTuple("('a', now())") === null);
  const wf = parseWorkflowSchedule(readFileSync(join(FIXTURE, ".github", "workflows", "wf-dispatched.yml"), "utf8"));
  check("parseWorkflowSchedule reads the cron past comments in the block", wf.crons.join() === "0 21 * * *", JSON.stringify(wf));
  const manual = parseWorkflowSchedule(readFileSync(join(FIXTURE, ".github", "workflows", "wf-manual.yml"), "utf8"));
  check("…and a dispatch-only workflow whose COMMENT says schedule: has none", manual.crons.length === 0 && !manual.error, JSON.stringify(manual));
  const f = parseSeedFences(readFileSync(join(FIXTURE, SEED), "utf8"), "seed.sql");
  check("parseSeedFences reads all six fixture rows", f.rows.length === 6 && f.problems.length === 0, JSON.stringify(f.problems));
  check("…keyed by the INSERT column list", f.rows[0].unit_call === "CALL public.proc_a();" && f.rows[2].unit_call === "SELECT public.probe_b('x', ARRAY['y'])");
}

console.log("check:job-registry — fixtures");
{
  const r = variant();
  check("the base fixture PASSES", r.problems.length === 0 && r.warnings.length === 0, dump(r));
  check("…reading the NEWEST receipts (2098-12-31's retired-old is not asked for)",
    r.stats.receipts === "2099-01-01.json" && !has(r.problems, "retired-old"), JSON.stringify(r.stats));
  check("…with the disp- one-shot ignored (4 cron jobs, not 5)", r.stats.cronJobs === 4 && !has(r.problems, "disp-42"), JSON.stringify(r.stats));
  check("…and two scheduled workflows, the manual one not counted", r.stats.workflows === 2, JSON.stringify(r.stats));
}
{
  const r = variant((root) => edit(root, RECEIPTS, (t) => t.replace('"cron_jobs": [', '"cron_jobs": [\n    { "jobname": "job-new", "schedule": "0 9 * * *", "active": true },')));
  check("a job in the receipts but not in the fence FAILS",
    r.problems.length === 1 && has(r.problems, "missing registry row for cron job job-new (receipts 2099-01-01.json)"), dump(r));
}
{
  const r = variant((root) => writeFileSync(join(root, ".github", "workflows", "wf-extra.yml"),
    'name: extra\non:\n  schedule:\n    - cron: "5 5 * * *"\njobs:\n  run:\n    runs-on: ubuntu-latest\n'));
  check("a workflow with schedule: and no row FAILS",
    r.problems.length === 1 && has(r.problems, "missing registry row for scheduled workflow wf-extra.yml"), dump(r));
}
{
  const r = variant((root) => edit(root, SEED, (t) => t.replace("('job-a', 'pg_cron', 'pipe_a', 'atomic', 'CALL public.proc_a();'", "('job-a', 'pg_cron', 'pipe_a', 'atomic', 'CALL public.proc_missing();'")));
  check("a unit_call naming a routine no migration defines FAILS",
    r.problems.length === 1 && has(r.problems, "unit_call names no routine: proc_missing"), dump(r));
}
{
  const r = variant((root) => edit(root, SEED, (t) => t.replace("NULL, '{}', true, 'no-band')", "NULL, '{}', true, 'a vacuum')")));
  check("a row with no band and no no-band declaration FAILS",
    r.problems.length === 1 && has(r.problems, "no band and no 'no-band' declaration: job-vac"), dump(r));
}
{
  const r = variant((root) => {
    edit(root, RECEIPTS, (t) => t.replace('"cron_jobs": [', '"cron_jobs": [\n    { "jobname": "job-new", "schedule": "0 9 * * *", "active": true },'));
    writeFileSync(join(root, "supabase", "migrations", "20990201000000_second_fence.sql"),
      "-- job-registry-seed:begin\n" +
      "INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, note) VALUES\n" +
      "  ('job-new', 'pg_cron', NULL, 'atomic', 'CALL public.proc_a();', 3, 'at 0 9 * * *', 'io', 128, NULL, NULL, '{}', false, 'no-band')\n" +
      "ON CONFLICT (job) DO NOTHING;\n-- job-registry-seed:end\n");
  });
  check("two fences are a UNION (a later migration's row covers a new job) — PASSES",
    r.problems.length === 0 && r.stats.rows === 7 && r.stats.fences === 2, dump(r) + JSON.stringify(r.stats));
}
{
  const r = variant((root) => edit(root, SEED, (t) => t.replace("  ('job-sel', 'pg_cron',", "  (NULL, 'job-sel', 'pg_cron',")));
  check("a fence row whose job literal is not first FAILS, naming the file:line",
    has(r.problems, "20990101000000_fixture_seed.sql:8 — the job literal is not first on the row"), dump(r));
}
{
  const r = variant((root) => edit(root, SEED, (t) => t.replace("-- job-registry-seed:end", "-- (the end fence was lost)")));
  check("a begin fence with no end FAILS", has(r.problems, "with no -- job-registry-seed:end"), dump(r));
}
{
  const r = variant((root) => edit(root, SEED, (t) => t.replace("'bare', 'VACUUM (ANALYZE) public.some_table;'", "'bare', 'CALL public.proc_a();'")));
  check("a bare row whose unit_call is a CALL FAILS", has(r.problems, "bare row's unit_call is not a VACUUM (ANALYZE)"), dump(r));
}
{
  const r = variant((root) => edit(root, SEED, (t) => t.replace("'gha:wf-scheduled.yml'", "'gha:wf-gone.yml'")));
  check("a gha: unit_call naming no workflow file FAILS",
    has(r.problems, "unit_call names no workflow: gha:wf-gone.yml") && has(r.problems, "missing registry row for scheduled workflow wf-scheduled.yml"), dump(r));
}
{
  const r = variant((root) => edit(root, RECEIPTS, (t) => t.replace('    { "jobname": "job-sel", "jobid": 3, "schedule": "* * * * *", "active": true },\n', "")));
  check("a row in no receipts and no workflow is a WARNING, not a failure (seeded ahead)",
    r.problems.length === 0 && r.warnings.length === 1 && has(r.warnings, "registry row job-sel matches no cron job"), dump(r));
}
{
  const r = variant((root) => {
    edit(root, RECEIPTS, (t) => t.replace('    { "jobname": "job-sel", "jobid": 3, "schedule": "* * * * *", "active": true },\n', ""));
    edit(root, SEED, (t) => t.replace(/('job-sel'[^\n]*?)'at [^']*'/, "$1'dead_tuples > 60% of trigger + floor 24 hours'"));
  });
  check("a pg_cron row on a dispatched rule needs no cron job (FIX-1381): no warning",
    r.problems.length === 0 && !has(r.warnings, "job-sel matches no cron job"), dump(r));
}
{
  const r = variant((root) => edit(root, RECEIPTS, (t) => t.replace('"cron_jobs"', '"cron_jobz"')));
  check("a receipts file with no cron_jobs[] FAILS (it would otherwise compare against nothing)",
    has(r.problems, "has no cron_jobs[]"), dump(r));
}
{
  const r = variant((root) => writeFileSync(join(root, "supabase", "migrations", "20990201000000_dup.sql"),
    "-- job-registry-seed:begin\n" +
    "INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, note) VALUES\n" +
    "  ('job-a', 'pg_cron', NULL, 'atomic', 'CALL public.proc_a();', 3, 'at 0 1 * * *', 'io', 128, NULL, NULL, '{}', false, 'banded')\n" +
    "ON CONFLICT (job) DO NOTHING;\n-- job-registry-seed:end\n"));
  check("a job seeded by two fences FAILS (ON CONFLICT DO NOTHING would hide the second)",
    has(r.problems, "job seeded twice: job-a"), dump(r));
}
{
  const r = variant((root) => edit(root, SEED, (t) => t.replace(/-- job-registry-seed:begin[\s\S]*-- job-registry-seed:end\n/, "")));
  check("a tree with NO fence FAILS on every receipts job and workflow (main before cc-226)",
    has(r.problems, "no -- job-registry-seed:begin fence") && r.problems.filter((p) => p.startsWith("missing registry row")).length === 6, dump(r));
}

console.log("check:job-registry — the live snapshot (FIX-1325)");
// The fixture's fences as the receipts job would snapshot them, before any
// migration UPDATEs a row: every fence column copied, the late columns at their
// ADD COLUMN defaults, gates as the array pg returns.
const FENCE_ROWS = parseSeedFences(readFileSync(join(FIXTURE, SEED), "utf8"), "seed.sql").rows;
const liveRows = () => FENCE_ROWS.map((r) => ({
  job: r.job, deadline_rule: r.deadline_rule, unit_shape: r.unit_shape, priority: r.priority,
  cost_class: r.cost_class, cap_mb: r.cap_mb, exclusion_group: r.exclusion_group,
  budget_seconds: r.budget_seconds, gates: r.gates.replace(/^\{|\}$/g, "").split(",").filter(Boolean),
  phase_lock: false, by_window_minutes: null, yield_to: [], anchor_cadence: null,
}));
/** Write `rows` (after `tweak`) as receipts `file`'s job_registry. */
const withSnapshot = (root, tweak = (rows) => rows, file = RECEIPTS) => edit(root, file, (t) => {
  const j = JSON.parse(t);
  j.job_registry = { snapshot_at: "2099-01-01T00:01:00Z", rows: tweak(liveRows()) };
  return JSON.stringify(j, null, 2);
});
const setCol = (job, col, v) => (rows) => rows.map((r) => (r.job === job ? { ...r, [col]: v } : r));
const UPDATE_MIG = join("supabase", "migrations", "20990301000000_fixture_update.sql");
{
  const r = variant();
  check("no receipts carries job_registry → the fences-only check, plus one 'no live snapshot yet' note",
    r.problems.length === 0 && r.warnings.length === 0 && r.stats.snapshot === null &&
    r.notes.length === 1 && r.notes[0].startsWith("no live snapshot yet"), dump(r) + JSON.stringify(r.notes));
}
{
  const r = variant((root) => withSnapshot(root));
  check("a snapshot equal to the fences PASSES with nothing to say",
    r.problems.length === 0 && r.warnings.length === 0 && r.info.length === 0 &&
    r.stats.snapshot === "2099-01-01.json" && r.stats.liveRows === 6, dump(r) + JSON.stringify(r.stats));
}
{
  const r = variant((root) => withSnapshot(root, setCol("job-a", "deadline_rule", "stale_after 12 hours")));
  check("a fence `at` whose live rule is stale_after is RETURNED — green, one line",
    r.problems.length === 0 && r.warnings.length === 0 &&
    JSON.stringify(r.info) === JSON.stringify(["RETURNED: job-a at 0 1 * * * → stale_after 12 hours"]) &&
    r.stats.returned === 1, dump(r) + JSON.stringify(r.info));
}
{
  // job-a's cron row moves off the fence's `at 0 1 * * *`. Fences alone, that is
  // the deadline_rule-vs-schedule WARNING; with the live rule `by …` it is not,
  // because the comparison now reads the rule the job actually runs on.
  const moveCron = (root) => edit(root, RECEIPTS, (t) => t.replace('"jobname": "job-a", "jobid": 1, "schedule": "0 1 * * *"', '"jobname": "job-a", "jobid": 1, "schedule": "0 3 * * *"'));
  const before = variant(moveCron);
  const r = variant((root) => { moveCron(root); withSnapshot(root, setCol("job-a", "deadline_rule", "by 0 3 * * *")); });
  check("…and the at-vs-cron comparison reads the LIVE rule: a stale fence `at` no longer warns",
    has(before.warnings, "job-a: deadline_rule 'at 0 1 * * *' differs from the receipts schedule '0 3 * * *'") &&
    r.problems.length === 0 && r.warnings.length === 0 && has(r.info, "RETURNED: job-a at 0 1 * * * → by 0 3 * * *"),
    dump(before) + dump(r));
}
{
  const r = variant((root) => withSnapshot(root, setCol("job-a", "cap_mb", 64)));
  check("a cap that differs with NO migration behind it FAILS, naming both values",
    r.problems.length === 1 &&
    has(r.problems, "live drift: job-a cap_mb is 64 live, 128 in its fence, and no migration UPDATEs it"), dump(r));
}
{
  const r = variant((root) => {
    withSnapshot(root, setCol("job-a", "cap_mb", 64));
    // The SET list carries a note literal with semicolons BEFORE the column:
    // the statement must not be cut at the first `;` in a string.
    writeFileSync(join(root, UPDATE_MIG),
      "DO $$ BEGIN\n  UPDATE public.job_registry\n     SET note = note || '; cap 128 → 64; it''s re-derived',\n" +
      "         cap_mb = 64 -- a comment; with a semicolon\n   WHERE job = 'job-a';\nEND $$;\n");
  });
  check("…the same cap with a migration that UPDATEs it PASSES as UPDATED, quoting the file",
    r.problems.length === 0 &&
    JSON.stringify(r.info) === JSON.stringify(["UPDATED: job-a cap_mb 128 → 64 (20990301000000_fixture_update)"]), dump(r) + JSON.stringify(r.info));
}
{
  const r = variant((root) => {
    withSnapshot(root, setCol("job-vac", "cap_mb", 32));
    writeFileSync(join(root, UPDATE_MIG),
      "UPDATE public.job_registry SET cap_mb = 64 WHERE job = 'job-a';\n-- job-vac is named here but not updated: 'job-vac'\n");
  });
  check("…an UPDATE that names a DIFFERENT job does not explain the drift",
    has(r.problems, "live drift: job-vac cap_mb is 32 live, 64 in its fence"), dump(r));
}
{
  const r = variant((root) => withSnapshot(root, setCol("job-a", "phase_lock", true)));
  check("a late column (phase_lock) is compared with its ADD COLUMN default",
    has(r.problems, "live drift: job-a phase_lock is true live, false in its fence"), dump(r));
}
{
  const r = variant((root) => withSnapshot(root, setCol("job-a", "deadline_rule", "at 0 2 * * *")));
  check("an `at` → `at` reschedule is not a RETURN: unexplained, it FAILS",
    has(r.problems, "live drift: job-a deadline_rule is at 0 2 * * * live, at 0 1 * * * in its fence"), dump(r));
}
{
  const r = variant((root) => withSnapshot(root, (rows) => [...rows, { ...rows[0], job: "job-ghost" }]));
  check("a live row no fence seeds FAILS",
    r.problems.length === 1 && has(r.problems, "live job_registry row with no fence: job-ghost"), dump(r));
}
{
  const r = variant((root) => withSnapshot(root, (rows) => rows.filter((x) => x.job !== "job-vac")));
  check("a fence with no live row is a WARNING (the snapshot trails the tree), not a failure",
    r.problems.length === 0 && r.warnings.length === 1 && has(r.warnings, "fence row job-vac has no row in the live snapshot"), dump(r));
}
{
  const root = mkdtempSync(join(tmpdir(), "job-registry-"));
  temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  withSnapshot(root, setCol("job-a", "cap_mb", 64));
  const r = checkRegistry({ root, fencesOnly: true });
  check("--fences-only does not read the snapshot (the drift above PASSES)",
    r.problems.length === 0 && r.stats.snapshot === null && has(r.notes, "--fences-only"), dump(r));
}
{
  const r = variant((root) => withSnapshot(root, setCol("job-a", "deadline_rule", "by 0 1 * * *"), join("docs", "receipts", "2098-12-31.json")));
  check("the NEWEST file carrying a snapshot is read when the newest receipts has none",
    r.stats.snapshot === "2098-12-31.json" && r.stats.receipts === "2099-01-01.json" && r.stats.returned === 1, JSON.stringify(r.stats));
}
{
  const r = variant((root) => {
    withSnapshot(root, setCol("job-a", "cap_mb", 64), join("docs", "receipts", "2098-12-31.json"));
    edit(root, RECEIPTS, (t) => JSON.stringify({ ...JSON.parse(t), job_registry: { not_capturable: "job_registry read failed: boom" } }));
  });
  check("a newest file whose read failed is passed over and said — never read as an empty registry",
    r.stats.snapshot === "2098-12-31.json" && has(r.notes, "2099-01-01.json has no job_registry snapshot: job_registry read failed: boom") &&
    has(r.problems, "live drift: job-a cap_mb"), dump(r) + JSON.stringify(r.notes));
}
{
  const u = registryUpdates(
    "UPDATE public.job_registry SET gates = '{prod_session}', yield_to = '{a,b}' WHERE job IN ('x', 'y');\n" +
      "FOR r IN SELECT * FROM (VALUES ('z', 1)) v(job, n) LOOP UPDATE public.job_registry SET cap_mb = r.n WHERE job = r.job; END LOOP;\n",
    "m.sql", ["x", "y", "z"]);
  check("registryUpdates: SET columns per statement; a literal WHERE names its jobs, a variable one takes the file's",
    u.length === 2 && [...u[0].cols].join() === "gates,yield_to" && u[0].jobs.join() === "x,y" &&
    [...u[1].cols].join() === "cap_mb" && u[1].jobs.join() === "x,y,z", JSON.stringify(u.map((x) => ({ cols: [...x.cols], jobs: x.jobs }))));
}

console.log("check:job-registry — the real tree");
{
  const r = checkRegistry();
  check("the repo root PASSES", r.problems.length === 0, r.problems.join("\n      "));
  check("…with a row for every receipts cron job and every scheduled workflow",
    r.stats.rows >= r.stats.cronJobs + r.stats.workflows, JSON.stringify(r.stats));
}

for (const t of temps) rmSync(t, { recursive: true, force: true });
console.log(`\ncheck:job-registry:test — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
