#!/usr/bin/env node
// test-check-workflows-parse.mjs — FIX-1414
//
// Fixture suite for scripts/check-workflows-parse.mjs. No database, no network;
// its one dependency is the parser the check itself uses. Same shape as the
// other scripts/test-*.mjs suites.
//
// The kill proof is the real failure: irs990.yml as fa3a54cd (cc-278) wrote
// it, read out of git history, must fail at line 100, and the same file as it
// stands now must pass. That case needs fa3a54cd in the clone, so it does not
// run in a depth-1 CI checkout; the inline cases below it carry the same
// class without history.
//
// Fixtures go to one fixed directory under the OS temp dir, overwritten on
// each run and never deleted (the path is printed).

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCRIPT = join(HERE, "check-workflows-parse.mjs");
const TMP = join(tmpdir(), "civitics-check-workflows-test");
const BROKEN_SHA = "fa3a54cd";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

function run(...files) {
  const r = spawnSync(process.execPath, [SCRIPT, ...files], { encoding: "utf8", cwd: ROOT });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function fixture(name, text) {
  const p = join(TMP, name);
  writeFileSync(p, text);
  return p;
}

mkdirSync(TMP, { recursive: true });
console.log(`check:workflows — fixtures (in ${TMP})`);

// ── the kill proof: the file that broke, and the file that fixed it ─────────
{
  let broken = null;
  try {
    broken = execFileSync("git", ["show", `${BROKEN_SHA}:.github/workflows/irs990.yml`], { cwd: ROOT, encoding: "utf8" });
  } catch {
    // Falls through to a failed check: a missing kill proof must not read as a pass.
  }
  check(`${BROKEN_SHA}:.github/workflows/irs990.yml is readable from history`, broken !== null,
    `git show ${BROKEN_SHA} failed — a shallow clone? Run this suite in a full clone.`);
  if (broken !== null) {
    const r = run(fixture(`irs990-${BROKEN_SHA}.yml`, broken));
    check(`irs990.yml as ${BROKEN_SHA} wrote it FAILS (exit 1)`, r.code === 1, `exit ${r.code}: ${r.out}`);
    check("…at line 100, column 57", /irs990-fa3a54cd\.yml:100:57:/.test(r.out), r.out);
  }
  const r = run(join(ROOT, ".github", "workflows", "irs990.yml"));
  check("irs990.yml as it stands PASSES (exit 0)", r.code === 0, `exit ${r.code}: ${r.out}`);
}

// ── the class without history ───────────────────────────────────────────────
const JOB = `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n`;
{
  const r = run(fixture("plain-scalar-colon.yml",
    `name: t\non: push\n${JOB}      - name: echo\n        run: echo "note: a colon-space in a plain scalar"\n`));
  check("a plain-scalar run: with a colon-space FAILS", r.code === 1, `exit ${r.code}: ${r.out}`);
  check("…with file:line:col", /plain-scalar-colon\.yml:8:\d+:/.test(r.out), r.out);
}
{
  const r = run(fixture("block-scalar-colon.yml",
    `name: t\non: push\n${JOB}      - name: echo\n        run: |\n          echo "note: a colon-space in a block scalar"\n`));
  check("the same command in a | block scalar PASSES", r.code === 0, `exit ${r.code}: ${r.out}`);
}
{
  const r = run(fixture("no-jobs.yml", `name: t\non: push\nenv:\n  A: "1"\n`));
  check("a file with no top-level jobs key FAILS", r.code === 1, `exit ${r.code}: ${r.out}`);
  check("…and says so", r.out.includes("no top-level `jobs` key"), r.out);
}
{
  const r = run(fixture("duplicate-key.yml", `name: t\non: push\nname: u\n${JOB}      - run: true\n`));
  check("a duplicate top-level key FAILS", r.code === 1, `exit ${r.code}: ${r.out}`);
}
{
  const r = run(fixture("top-list.yml", `- jobs: {}\n`));
  check("a top level that is a list, not a mapping, FAILS", r.code === 1, `exit ${r.code}: ${r.out}`);
}
{
  const good = fixture("good.yml", `name: t\non: push\n${JOB}      - run: true\n`);
  const bad = fixture("no-jobs-2.yml", `name: t\non: push\n`);
  const r = run(good, bad, good);
  check("several paths: exit 1, stopping at the first failure",
    r.code === 1 && (r.out.match(/✓/g) ?? []).length === 1, `exit ${r.code}: ${r.out}`);
}

// ── the tree ────────────────────────────────────────────────────────────────
{
  const n = readdirSync(join(ROOT, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f)).length;
  const r = run();
  check("every workflow file in the tree PASSES (no arguments)", r.code === 0, r.out);
  check(`…and the count printed is the directory's (${n})`,
    r.out.includes(`${n} workflow file${n === 1 ? "" : "s"} parse.`), r.out);
}

console.log(`\ncheck:workflows fixtures — ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
