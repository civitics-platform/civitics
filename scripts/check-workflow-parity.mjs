#!/usr/bin/env node
// check-workflow-parity.mjs — FIX-1000
//
// WHY THIS EXISTS. `.github/workflows/nightly.yml` (fec-phase) and
// `.github/workflows/fec-backfill.yml` (backfill) both reach
// runFecBulkPipeline() → streamIndiv on the same ubuntu-latest 16 GB runner
// class, but their resource envelopes were set at different times for different
// reasons and NOTHING tied them together:
//
//   nightly fec-phase : NODE_OPTIONS 12288 / timeout-minutes 150  (FIX-254, FIX-689)
//   fec-backfill      : NODE_OPTIONS 14336 / timeout-minutes 350  (FIX-961)
//
// FIX-961 remediated the workflow where the OOM was OBSERVED, not the
// mechanism's other site — the classic enumeration gap, and the one FIX-995
// fell through two days later. On top of that, fec-backfill.yml's env block
// asserted for months that it "mirrors nightly.yml's fec-phase verbatim", which
// FIX-961 had falsified in the very commit that raised the value.
//
// WHAT THIS IS NOT. It is a PARITY check, not a tuning check. It never says
// which value is right; it says the two are different and nobody wrote down
// why. A divergence with an adjacent `# workflow-parity-waiver: <reason>`
// comment passes and is printed, so the reason stays attached to the value.
//
// USAGE
//   node scripts/check-workflow-parity.mjs          # exit 1 on undeclared divergence
//   pnpm check:workflow-parity
//
// Deliberately dependency-free: no YAML parser is installed at the repo root,
// and adding one for a 200-line guard is a worse trade than a narrow parser
// that fails loudly when the shape it expects is absent.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = join(ROOT, ".github", "workflows");
const TAG = "[workflow-parity]";

/** Keys whose divergence is a resource-envelope divergence. */
const COMPARED_KEYS = ["NODE_OPTIONS", "timeout-minutes"];

/**
 * Package scripts that are different entrypoints into the SAME underlying
 * work, so they share one resource envelope even though their names differ.
 * The literal "same package script" rule alone would never have caught FIX-1000
 * — the two fec entrypoints are `data:nightly:fec:ci` and `data:fec-bulk:ci`.
 */
const ENVELOPE_GROUPS = [
  {
    name: "fec-indiv",
    why: "both entrypoints reach runFecBulkPipeline() → streamIndiv on the same ubuntu-latest 16 GB runner class",
    scripts: ["data:nightly:fec:ci", "data:fec-bulk:ci"],
  },
];

/**
 * Scripts that carry no resource envelope of their own, so two jobs running
 * them under different budgets is meaningless rather than suspicious.
 */
const EXEMPT_SCRIPTS = new Set([
  // `if: always()` observability post-step; a few DB reads and one insert. Its
  // host job's budget is set by whatever that job actually does.
  "data:mark-killed:ci",
]);

const WAIVER_RE = /#\s*workflow-parity-waiver:\s*(.+?)\s*$/;

function fail(msg) {
  console.error(`${TAG} ${msg}`);
  process.exitCode = 1;
}

/** Indentation width of a line, or null for blank lines. */
function indentOf(line) {
  if (!line.trim()) return null;
  return line.length - line.trimStart().length;
}

/**
 * Narrow, shape-asserting reader for the subset of workflow YAML this guard
 * needs. Anything it cannot parse is reported, never silently skipped.
 */
function parseWorkflow(file, text) {
  const lines = text.split(/\r?\n/);
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) return { file, jobs: [], error: "no top-level `jobs:` key" };

  // Workflow-level env, inherited by jobs that do not set a key themselves.
  const wfEnv = {};
  const wfEnvIdx = lines.findIndex((l) => /^env:\s*$/.test(l));
  if (wfEnvIdx !== -1) {
    for (let i = wfEnvIdx + 1; i < lines.length; i++) {
      const ind = indentOf(lines[i]);
      if (ind === null) continue;
      if (ind < 2) break;
      const m = /^ {2}([A-Za-z0-9_]+):\s*(.*)$/.exec(lines[i]);
      if (m) wfEnv[m[1]] = { value: m[2].trim(), line: i };
    }
  }

  const jobHeaders = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(lines[i]);
    if (m) jobHeaders.push({ id: m[1], start: i });
  }
  if (jobHeaders.length === 0) return { file, jobs: [], error: "`jobs:` present but no job keys parsed" };

  const jobs = jobHeaders.map((h, n) => {
    const end = n + 1 < jobHeaders.length ? jobHeaders[n + 1].start : lines.length;
    const body = lines.slice(h.start, end);
    const keys = {};

    // timeout-minutes at job level (indent 4).
    for (let i = 0; i < body.length; i++) {
      const m = /^ {4}timeout-minutes:\s*(\S+)/.exec(body[i]);
      if (m) keys["timeout-minutes"] = { value: m[1], line: h.start + i };
    }

    // job-level env block (indent 4 key, indent 6 members).
    const envIdx = body.findIndex((l) => /^ {4}env:\s*$/.test(l));
    if (envIdx !== -1) {
      for (let i = envIdx + 1; i < body.length; i++) {
        const ind = indentOf(body[i]);
        if (ind === null) continue;
        if (ind <= 4) break;
        const m = /^ {6}([A-Za-z0-9_]+):\s*(.*)$/.exec(body[i]);
        if (m && COMPARED_KEYS.includes(m[1])) {
          keys[m[1]] = { value: m[2].trim(), line: h.start + i };
        }
      }
    }
    for (const k of COMPARED_KEYS) {
      if (!keys[k] && wfEnv[k]) keys[k] = { ...wfEnv[k], inherited: true };
    }

    const scripts = new Set();
    for (const l of body) {
      const re = /pnpm\s+--filter\s+\S+\s+([A-Za-z0-9:_.-]+)/g;
      let m;
      while ((m = re.exec(l)) !== null) scripts.add(m[1]);
    }

    const runsOn = (/^ {4}runs-on:\s*(\S+)/m.exec(body.join("\n")) || [])[1] ?? "?";
    return { id: h.id, file, start: h.start, end, keys, scripts, runsOn };
  });

  return { file, jobs, lines };
}

/**
 * Nearest `# workflow-parity-waiver:` comment above `line`, within this job.
 * Walking up (rather than requiring strict adjacency) lets the reason sit in a
 * job's or env block's leading comment where the surrounding rationale already
 * lives, instead of being wedged between two env keys.
 */
function findWaiver(lines, job, line) {
  for (let i = line; i >= job.start; i--) {
    const m = WAIVER_RE.exec(lines[i]);
    if (m) {
      // Continue upward across a contiguous comment run so a wrapped reason
      // reads whole.
      let text = m[1];
      for (let j = i + 1; j < lines.length && /^\s*#/.test(lines[j]) && !WAIVER_RE.test(lines[j]); j++) {
        const cont = /^\s*#\s?(.*)$/.exec(lines[j]);
        if (!cont || !cont[1].trim()) break;
        text += " " + cont[1].trim();
      }
      return text;
    }
  }
  return null;
}

// ── Collect ─────────────────────────────────────────────────────────────────
const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
if (files.length === 0) {
  fail(`no workflow files found under ${relative(ROOT, WF_DIR)} — refusing to pass vacuously`);
  process.exit(1);
}

const parsed = [];
for (const f of files) {
  const p = parseWorkflow(f, readFileSync(join(WF_DIR, f), "utf8"));
  if (p.error) {
    fail(`${f}: ${p.error}`);
    continue;
  }
  parsed.push(p);
}
const allJobs = parsed.flatMap((p) => p.jobs);
const linesByFile = Object.fromEntries(parsed.map((p) => [p.file, p.lines]));

// ── Build comparison groups ─────────────────────────────────────────────────
const groups = [];

for (const g of ENVELOPE_GROUPS) {
  const jobs = allJobs.filter((j) => g.scripts.some((s) => j.scripts.has(s)));
  const missing = g.scripts.filter((s) => !allJobs.some((j) => j.scripts.has(s)));
  if (missing.length > 0) {
    // A declared group whose scripts no longer exist is a stale registry entry,
    // not a pass. Say so rather than quietly comparing one job with itself.
    fail(`declared group '${g.name}' references script(s) no workflow invokes: ${missing.join(", ")}`);
    continue;
  }
  groups.push({ label: `${g.name} (declared: ${g.why})`, jobs });
}

const byScript = new Map();
for (const j of allJobs) {
  for (const s of j.scripts) {
    if (EXEMPT_SCRIPTS.has(s)) continue;
    if (!byScript.has(s)) byScript.set(s, []);
    byScript.get(s).push(j);
  }
}
for (const [script, jobs] of byScript) {
  if (jobs.length < 2) continue;
  groups.push({ label: `${script} (same package script in ${jobs.length} jobs)`, jobs });
}

// ── Compare ─────────────────────────────────────────────────────────────────
let problems = 0;
let waived = 0;

for (const group of groups) {
  for (const key of COMPARED_KEYS) {
    const seen = group.jobs.map((j) => ({ job: j, entry: j.keys[key] }));
    const values = new Set(seen.map((s) => s.entry?.value ?? "<unset>"));
    if (values.size <= 1) continue;

    const waivers = seen
      .filter((s) => s.entry)
      .map((s) => ({ job: s.job, text: findWaiver(linesByFile[s.job.file], s.job, s.entry.line) }))
      .filter((w) => w.text);

    const detail = seen
      .map((s) => `      ${s.job.file}:${s.job.id} → ${key} = ${s.entry?.value ?? "<unset>"}`)
      .join("\n");

    if (waivers.length > 0) {
      waived++;
      console.log(`${TAG} WAIVED  ${group.label} — ${key} diverges\n${detail}`);
      for (const w of waivers) console.log(`      waiver (${w.job.file}:${w.job.id}): ${w.text}`);
      continue;
    }

    problems++;
    fail(
      `UNDECLARED DIVERGENCE — ${group.label}\n${detail}\n` +
        `      Two jobs run the same work under different ${key} and nothing records why.\n` +
        `      Either align them, or add an adjacent comment in the diverging job:\n` +
        `        # workflow-parity-waiver: <why this one differs, with the FIX id>`,
    );
  }
}

const summary =
  `${TAG} ${groups.length} comparison group(s), ${allJobs.length} job(s) across ${parsed.length} workflow(s); ` +
  `${waived} waived divergence(s), ${problems} undeclared.`;
if (problems > 0) {
  console.error(summary);
  process.exit(1);
}
console.log(summary);
