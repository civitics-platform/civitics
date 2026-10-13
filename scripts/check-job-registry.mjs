#!/usr/bin/env node
// check-job-registry.mjs — FIX-1307
//
// WHY THIS EXISTS. public.job_registry (supabase/migrations/20261014230000)
// is the catalog the unit dispatcher (FIX-1308) reads: one row per scheduled
// job. A registry that silently misses a job is worse than none, because the
// dispatcher's box rule sums the caps of what it can SEE. A pg_cron job added
// by a migration with no registry row runs outside the Σ-caps budget, and
// nothing says so. This guard keeps the seed in parity with the two places a
// schedule can come from, using the tree only (CI has no database):
//
//   - prod's cron.job, as mirrored by the newest docs/receipts/<day>.json →
//     cron_jobs[] (the nightly's tree-resident copy; active AND inactive rows,
//     because the registry is the whole catalog);
//   - every .github/workflows/*.yml with an on.schedule block.
//
// WHAT IT FLAGS (exit 1)
//   (i)   a `-- job-registry-seed:begin` … `end` fence that does not parse — a
//         row whose job literal is not first on its line, a begin with no end,
//         a fence with no INSERT column list — named by file:line
//   (ii)  a receipts cron job with no registry row
//   (iii) a scheduled workflow with no row whose unit_call is gha:<file> or
//         gha-dispatch:<stem>
//   (iv)  a unit_call `CALL|SELECT public.<name>(` naming no routine any
//         migration CREATEs; a bare row whose unit_call is not a
//         `VACUUM (ANALYZE) public.<t>` or a `DELETE FROM`; a gha: /
//         gha-dispatch: unit_call naming no workflow file
//   (v)   a registry job with no docs/receipts/bands.json key (the job, or a
//         `<job>:<unit>` key) whose note does not declare `no-band`
//   and a job seeded by two fences.
//
// WHAT IT WARNS ON (exit 0)
//   (vi)  a registry job in no receipts row, no workflow, and not marked
//         `INACTIVE on prod` in its note — a job seeded ahead of its landing
//   - an `at <cron>` deadline_rule that differs from the live schedule
//   - a `no-band` declaration on a job that bands.json does band
//
// IGNORED: receipts jobnames matching ^disp- (vii). Those are the dispatcher's
// own one-shot ARM jobs (FIX-1308, C1), alive for a minute and unscheduled
// after the run; one may be alive when the nightly reads the receipts.
//
// Membership is the UNION of every fence: a later migration that schedules a
// new job adds its rows in the same one-row-per-line fence shape.
//
// Dependency-free, same shape as check-proconfig-timeouts.mjs. Fixtures:
// scripts/__fixtures__/job-registry/, suite: scripts/test-check-job-registry.mjs.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "[job-registry]";

export const FENCE_BEGIN = "-- job-registry-seed:begin";
export const FENCE_END = "-- job-registry-seed:end";
const RECEIPTS_RE = /^\d{4}-\d{2}-\d{2}\.json$/;
const ROUTINE_CALL_RE = /^(?:CALL|SELECT)\s+public\.([a-z_0-9]+)\s*\(/i;
const BARE_RE = /^(VACUUM \(ANALYZE\) public\.\w+;?|DELETE FROM .+)$/;
const GHA_RE = /^gha:(.+)$/;
const GHA_DISPATCH_RE = /^gha-dispatch:(.+)$/;
const DISPATCHER_JOB_RE = /^disp-/;

/**
 * Split one SQL row tuple — `('a', 'b''c', NULL, 3, true),` — into values.
 * Strings are unescaped (`''` → `'`); NULL → null; true/false → boolean;
 * digits → number. Returns null when the line is not a single tuple.
 */
export function parseTuple(line) {
  const s = line.trim().replace(/,$/, "");
  if (!s.startsWith("(") || !s.endsWith(")")) return null;
  const inner = s.slice(1, -1);
  const out = [];
  let i = 0;
  while (i < inner.length) {
    while (inner[i] === " ") i++;
    if (inner[i] === "'") {
      let k = i + 1, v = "";
      for (;;) {
        if (k >= inner.length) return null; // unterminated
        if (inner[k] === "'" && inner[k + 1] === "'") { v += "'"; k += 2; continue; }
        if (inner[k] === "'") { k++; break; }
        v += inner[k++];
      }
      out.push(v);
      i = k;
    } else {
      const k = inner.indexOf(",", i);
      const tok = (k === -1 ? inner.slice(i) : inner.slice(i, k)).trim();
      if (/^null$/i.test(tok)) out.push(null);
      else if (/^(true|false)$/i.test(tok)) out.push(tok.toLowerCase() === "true");
      else if (/^-?\d+$/.test(tok)) out.push(Number(tok));
      else return null;
      i = k === -1 ? inner.length : k;
    }
    while (inner[i] === " ") i++;
    if (i < inner.length) {
      if (inner[i] !== ",") return null;
      i++;
    }
  }
  return out;
}

/**
 * Every seed fence in one migration's text.
 * Returns { rows: [{job, line, file, ...columns}], problems: [string] }.
 */
export function parseSeedFences(text, file) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const problems = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== FENCE_BEGIN) { i++; continue; }
    const beginLine = i + 1;
    let cols = null;
    let closed = false;
    for (i++; i < lines.length; i++) {
      const raw = lines[i];
      const t = raw.trim();
      if (t === FENCE_END) { closed = true; i++; break; }
      if (t === "" || t.startsWith("--")) continue;
      const ins = /^INSERT\s+INTO\s+(?:public\.)?job_registry\s*\(([^)]*)\)\s*VALUES\s*$/i.exec(t);
      if (ins) { cols = ins[1].split(",").map((c) => c.trim()); continue; }
      if (/^ON\s+CONFLICT\b/i.test(t)) continue;
      if (!cols) {
        problems.push(`fence does not parse: ${file}:${i + 1} — a row before the INSERT INTO public.job_registry (…) VALUES line`);
        continue;
      }
      if (!/^\(\s*'/.test(t)) {
        problems.push(`fence does not parse: ${file}:${i + 1} — the job literal is not first on the row`);
        continue;
      }
      const vals = parseTuple(t);
      if (!vals || vals.length !== cols.length) {
        problems.push(`fence does not parse: ${file}:${i + 1} — expected one ${cols.length}-value tuple per line, got ${vals ? vals.length : "no tuple"}`);
        continue;
      }
      const row = Object.fromEntries(cols.map((c, n) => [c, vals[n]]));
      if (typeof row.job !== "string" || row.job === "") {
        problems.push(`fence does not parse: ${file}:${i + 1} — no job literal`);
        continue;
      }
      rows.push({ ...row, file, line: i + 1 });
    }
    if (!closed) problems.push(`fence does not parse: ${file}:${beginLine} — ${FENCE_BEGIN} with no ${FENCE_END}`);
    if (!cols && closed) problems.push(`fence does not parse: ${file}:${beginLine} — no INSERT INTO public.job_registry (…) VALUES line`);
  }
  return { rows, problems };
}

/**
 * The cron expressions under a workflow's top-level `on:` → `schedule:`.
 * Narrow on purpose (the check-workflow-parity.mjs approach: shape-asserting,
 * no YAML dependency). Returns { crons: [string], error: string|null }.
 */
export function parseWorkflowSchedule(text) {
  const lines = text.split(/\r?\n/);
  const onIdx = lines.findIndex((l) => /^["']?on["']?:\s*$/.test(l));
  if (onIdx === -1) return { crons: [], error: null };
  const crons = [];
  let inSchedule = false;
  for (let i = onIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const ind = l.length - l.trimStart().length;
    if (ind === 0) break; // the next top-level key ends `on:`
    if (ind === 2) { inSchedule = /^ {2}schedule:\s*$/.test(l); continue; }
    if (!inSchedule) continue;
    const m = /^\s*-\s*cron:\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(l);
    if (m) crons.push(m[1]);
    else return { crons, error: `unparseable line under on.schedule: ${l.trim()}` };
  }
  return { crons, error: null };
}

/** Every `CREATE [OR REPLACE] FUNCTION|PROCEDURE public.<name>(` in the migrations. */
function definedRoutines(texts) {
  const names = new Set();
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+public\.([a-z_0-9]+)\s*\(/gi;
  for (const t of texts) for (const m of t.matchAll(re)) names.add(m[1].toLowerCase());
  return names;
}

/**
 * Run the whole check against a tree. `root` holds supabase/migrations,
 * docs/receipts and .github/workflows (the fixtures mirror that layout).
 * Returns { problems, warnings, stats }.
 */
export function checkRegistry({ root = ROOT } = {}) {
  const problems = [];
  const warnings = [];
  const migDir = join(root, "supabase", "migrations");
  const recDir = join(root, "docs", "receipts");
  const wfDir = join(root, ".github", "workflows");

  // (i) the fences
  const migFiles = existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort() : [];
  const migTexts = migFiles.map((f) => readFileSync(join(migDir, f), "utf8"));
  const registry = new Map();
  let fences = 0;
  migFiles.forEach((f, n) => {
    const text = migTexts[n];
    if (!text.includes(FENCE_BEGIN)) return;
    fences += text.split(/\r?\n/).filter((l) => l.trim() === FENCE_BEGIN).length;
    const parsed = parseSeedFences(text, `supabase/migrations/${f}`);
    problems.push(...parsed.problems);
    for (const r of parsed.rows) {
      const prev = registry.get(r.job);
      if (prev) problems.push(`job seeded twice: ${r.job} (${prev.file}:${prev.line} and ${r.file}:${r.line})`);
      else registry.set(r.job, r);
    }
  });
  if (fences === 0) problems.push(`no ${FENCE_BEGIN} fence in supabase/migrations — the registry has no rows`);

  // (ii) the newest receipts' cron_jobs[]
  const recFiles = existsSync(recDir) ? readdirSync(recDir).filter((f) => RECEIPTS_RE.test(f)).sort() : [];
  const recFile = recFiles.at(-1) ?? null;
  const cronSchedules = new Map();
  if (!recFile) {
    problems.push("no docs/receipts/<YYYY-MM-DD>.json to compare against");
  } else {
    let rec = null;
    try { rec = JSON.parse(readFileSync(join(recDir, recFile), "utf8")); }
    catch (e) { problems.push(`receipts ${recFile} does not parse: ${e.message}`); }
    if (rec && !Array.isArray(rec.cron_jobs)) problems.push(`receipts ${recFile} has no cron_jobs[] — nothing to compare the registry against`);
    for (const j of rec?.cron_jobs ?? []) {
      if (typeof j?.jobname !== "string" || DISPATCHER_JOB_RE.test(j.jobname)) continue; // (vii)
      cronSchedules.set(j.jobname, j.schedule ?? null);
      if (!registry.has(j.jobname)) problems.push(`missing registry row for cron job ${j.jobname} (receipts ${recFile})`);
    }
  }

  // (iii) the scheduled workflows
  const wfFiles = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  const scheduled = new Map(); // file → crons
  for (const f of wfFiles) {
    const { crons, error } = parseWorkflowSchedule(readFileSync(join(wfDir, f), "utf8"));
    if (error) problems.push(`workflow ${f}: ${error}`);
    if (crons.length) scheduled.set(f, crons);
  }
  const ghaCalls = new Map();
  for (const r of registry.values()) if (typeof r.unit_call === "string") ghaCalls.set(r.unit_call, r);
  for (const [f, crons] of scheduled) {
    const stem = f.replace(/\.ya?ml$/, "");
    const row = ghaCalls.get(`gha:${f}`) ?? ghaCalls.get(`gha-dispatch:${stem}`);
    if (!row) { problems.push(`missing registry row for scheduled workflow ${f}`); continue; }
    if (typeof row.deadline_rule === "string" && row.deadline_rule.startsWith("at ") && !crons.includes(row.deadline_rule.slice(3))) {
      warnings.push(`${row.job}: deadline_rule '${row.deadline_rule}' differs from ${f}'s schedule ${crons.join(" / ")}`);
    }
  }

  // (iv) unit_call shapes, (v) bands, (vi) orphans
  const routines = definedRoutines(migTexts);
  let bands = {};
  const bandsPath = join(recDir, "bands.json");
  if (existsSync(bandsPath)) {
    try { bands = JSON.parse(readFileSync(bandsPath, "utf8")); }
    catch (e) { problems.push(`docs/receipts/bands.json does not parse: ${e.message}`); }
  }
  const bandKeys = Object.keys(bands).filter((k) => !k.startsWith("$"));
  const hasBand = (job) => bandKeys.some((k) => k === job || k.startsWith(`${job}:`));
  for (const r of registry.values()) {
    const where = `${r.file}:${r.line}`;
    const call = typeof r.unit_call === "string" ? r.unit_call.trim() : "";
    const routine = ROUTINE_CALL_RE.exec(call);
    const gha = GHA_RE.exec(call);
    const dispatch = GHA_DISPATCH_RE.exec(call);
    if (r.unit_shape === "bare") {
      if (!BARE_RE.test(call)) problems.push(`bare row's unit_call is not a VACUUM (ANALYZE) public.<table> or a DELETE FROM: ${r.job} (${where})`);
    } else if (BARE_RE.test(call)) {
      problems.push(`unit_call is a bare VACUUM/DELETE but unit_shape is '${r.unit_shape}': ${r.job} (${where})`);
    }
    if (routine && !routines.has(routine[1].toLowerCase())) problems.push(`unit_call names no routine: ${routine[1]} (${r.job}, ${where})`);
    if (gha && !existsSync(join(wfDir, gha[1]))) problems.push(`unit_call names no workflow: ${call} (${r.job}, ${where})`);
    if (dispatch && !existsSync(join(wfDir, `${dispatch[1]}.yml`))) problems.push(`unit_call names no workflow: ${call} (${r.job}, ${where})`);
    if (r.runner === "pg_cron" && !routine && !BARE_RE.test(call)) {
      problems.push(`pg_cron row's unit_call is neither CALL/SELECT public.<routine>( nor a bare VACUUM/DELETE: ${r.job} (${where})`);
    }

    const declared = typeof r.note === "string" && r.note.includes("no-band");
    if (!hasBand(r.job) && !declared) problems.push(`no band and no 'no-band' declaration: ${r.job} (${where})`);
    if (hasBand(r.job) && declared) warnings.push(`${r.job} declares no-band but docs/receipts/bands.json bands it (${where})`);

    const inReceipts = cronSchedules.has(r.job);
    const inWorkflow = (gha && scheduled.has(gha[1])) || (dispatch && scheduled.has(`${dispatch[1]}.yml`));
    const inactive = typeof r.note === "string" && r.note.includes("INACTIVE on prod");
    if (!inReceipts && !inWorkflow && !inactive) {
      warnings.push(`registry row ${r.job} matches no cron job in ${recFile ?? "the receipts"} and no scheduled workflow — seeded ahead of its landing? (${where})`);
    }
    if (inReceipts && typeof r.deadline_rule === "string" && r.deadline_rule.startsWith("at ")) {
      const live = cronSchedules.get(r.job);
      if (live && r.deadline_rule.slice(3) !== live) warnings.push(`${r.job}: deadline_rule '${r.deadline_rule}' differs from the receipts schedule '${live}'`);
    }
  }

  return {
    problems,
    warnings,
    stats: { rows: registry.size, fences, receipts: recFile, cronJobs: cronSchedules.size, workflows: scheduled.size },
  };
}

function main(argv) {
  let root = ROOT;
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--root") root = argv[++i];
  const { problems, warnings, stats } = checkRegistry({ root });
  for (const w of warnings) console.log(`${TAG} WARN ${w}`);
  for (const p of problems) console.error(`${TAG} ${p}`);
  const summary =
    `${TAG} ${stats.rows} registry row(s) from ${stats.fences} fence(s); ` +
    `receipts ${stats.receipts ?? "—"}: ${stats.cronJobs} cron job(s); ` +
    `${stats.workflows} scheduled workflow(s); ${problems.length} problem(s), ${warnings.length} warning(s).`;
  if (problems.length > 0) {
    console.error(summary);
    console.error(
      `${TAG} Every scheduled job needs a public.job_registry row (FIX-1307): add it to a\n` +
        `${TAG} ${FENCE_BEGIN} … ${FENCE_END} fence in the migration that schedules it,\n` +
        `${TAG} one row per line with the job literal first. Playbook D9 item 3.`,
    );
    return 1;
  }
  console.log(summary);
  return 0;
}

if (basename(process.argv[1] ?? "") === "check-job-registry.mjs") {
  process.exitCode = main(process.argv.slice(2));
}
