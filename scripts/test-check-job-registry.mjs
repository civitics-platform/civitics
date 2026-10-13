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
import { checkRegistry, parseSeedFences, parseTuple, parseWorkflowSchedule } from "./check-job-registry.mjs";

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
