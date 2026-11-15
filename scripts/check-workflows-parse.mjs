#!/usr/bin/env node
// check-workflows-parse.mjs — FIX-1414
//
// WHY THIS EXISTS. GitHub does not run a workflow file it cannot parse. It
// records a zero-second "workflow file issue" failure on every push instead,
// and the file's `on.schedule` never fires, because the schedule lives inside
// the file it could not read. fa3a54cd (cc-278, FIX-1400) wrote irs990.yml's
// Deflate64 step as a plain scalar,
//
//     run: unzip -v | grep -i deflate64 || echo "unzip: no Deflate64 line (or no unzip binary)"
//
// and the ": " inside the echoed text made YAML read a mapping (100:57). 19
// pushes failed that way in about a day, and the Monday slot that was FIX-1400's
// receipt would not have run. Nothing caught it: check:workflow-parity reads
// two FEC workflows with its own narrow parser, by design (no YAML parser was
// installed at the root then), and nothing else read the workflow files at
// all.
//
// WHAT IT CHECKS. Every .github/workflows/*.yml (or .yaml) goes through a real
// YAML parser, js-yaml (a root devDependency at the version the lockfile
// already carried). A file fails when it does not parse (bad indentation, a
// mapping inside a plain scalar, a duplicate key, more than one document) or
// when its top level is not a mapping with a `jobs` key. It stops at the first
// failure and prints `file:line:col: message`.
//
// WHAT IT IS NOT. It does not lint expressions (`${{ }}`), action inputs or
// cron strings; actionlint does that, and it is not installed. A file can pass
// here and still be refused by GitHub for a reason only GitHub's schema knows.
//
// USAGE
//   node scripts/check-workflows-parse.mjs                 # every workflow file
//   node scripts/check-workflows-parse.mjs path/to/a.yml   # just these files
//   pnpm check:workflows
//
// Not in the pre-push hook: a worktree that has not re-installed since the
// devDependency landed has no js-yaml, and a hook that cannot import its
// parser would refuse that session's push. tests.yml runs it after install.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = join(ROOT, ".github", "workflows");
const TAG = "[check:workflows]";

/**
 * Parse one workflow file's text. Returns `{ ok: true, jobs }` or
 * `{ ok: false, line, col, message }` (1-based; line/col are null when the
 * failure is the document's shape rather than its syntax).
 */
export function checkWorkflowText(text, load) {
  let doc;
  try {
    doc = load(text);
  } catch (e) {
    const line = e.mark ? e.mark.line + 1 : null;
    const col = e.mark ? e.mark.column + 1 : null;
    return { ok: false, line, col, message: e.reason ?? e.message };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, line: null, col: null, message: "top level is not a mapping" };
  }
  if (!Object.prototype.hasOwnProperty.call(doc, "jobs")) {
    return { ok: false, line: null, col: null, message: "no top-level `jobs` key" };
  }
  return { ok: true, jobs: doc.jobs && typeof doc.jobs === "object" ? Object.keys(doc.jobs).length : 0 };
}

/** The workflow files under .github/workflows, sorted, as absolute paths. */
export function workflowFiles(dir = WF_DIR) {
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

async function main() {
  let load;
  try {
    ({ load } = await import("js-yaml"));
  } catch {
    console.error(`${TAG} cannot import js-yaml — run \`pnpm install\` at the repo root.`);
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map((a) => (isAbsolute(a) ? a : resolve(process.cwd(), a)))
    : workflowFiles();
  if (!files.length) {
    console.error(`${TAG} no workflow files found under ${relative(ROOT, WF_DIR)}`);
    process.exit(1);
  }
  for (const file of files) {
    const shown = file.startsWith(ROOT) ? relative(ROOT, file).replace(/\\/g, "/") : file;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      console.error(`${TAG} ${shown}: cannot read (${e.code ?? e.message})`);
      process.exit(1);
    }
    const r = checkWorkflowText(text, load);
    if (!r.ok) {
      const at = r.line === null ? shown : `${shown}:${r.line}:${r.col}`;
      console.error(`${TAG} ✗ ${at}: ${r.message}`);
      console.error(`${TAG} GitHub cannot run a file that does not parse: every push records a`);
      console.error(`${TAG} zero-second "workflow file issue" failure and its schedule never fires.`);
      process.exit(1);
    }
    console.log(`${TAG} ✓ ${shown} (${r.jobs} job${r.jobs === 1 ? "" : "s"})`);
  }
  console.log(`${TAG} ${files.length} workflow file${files.length === 1 ? "" : "s"} parse.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
