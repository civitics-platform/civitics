#!/usr/bin/env node
// scripts/test-pre-push-hook.mjs
//
// Assertion harness for .githooks/pre-push (FIX-1199) — the scope of the
// trunk-ancestry gate.
//
// Run:   pnpm hook:test
// Exit:  0 on pass, 1 on fail.
//
// Playbook rule E10: a guard that cannot fail is not a guard. The hook grew a
// skip path (CI + shallow ⇒ ancestry is not decidable ⇒ step aside), and a skip
// path is exactly the kind of edit that silently widens until the gate is gone.
// So every case below asserts BOTH which gates ran and what the hook exited —
// the negative cases (gate still enforced) matter more than the positive one.
//
// The hook shells out to `pnpm`, so the fixtures put a recording stub first on
// PATH: it logs its argv to $PNPM_LOG and exits with a code the case chooses.
// No monorepo, no network, no real typecheck.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, ".githooks", "pre-push");

const failures = [];
function assertTrue(label, cond, detail = "") {
  if (cond) console.log(`  ok ${label}`);
  else failures.push(`  x ${label}${detail ? `\n     ${detail}` : ""}`);
}

// -- 1. syntax ---------------------------------------------------------------
console.log("shell syntax:");
try {
  execFileSync("sh", ["-n", HOOK], { stdio: "pipe" });
  assertTrue("sh -n .githooks/pre-push parses", true);
} catch (e) {
  assertTrue("sh -n .githooks/pre-push parses", false, String(e.stderr || e));
}

// -- 2. fixtures -------------------------------------------------------------
// A throwaway git repo + a recording `pnpm` stub. `shallow: true` writes the
// .git/shallow marker naming the repo's own root commit, which is the same
// thing `git clone --depth=1` leaves behind and what --is-shallow-repository
// reads.
const tmpRoot = mkdtempSync(join(tmpdir(), "cc136-hook-"));
const cleanups = [];

const STUB = [
  "#!/bin/sh",
  'echo "$*" >> "$PNPM_LOG"',
  'case "$*" in',
  "  *typecheck*) exit ${FAKE_TYPECHECK_EXIT:-0} ;;",
  "  *fixes:check:trunk*) exit ${FAKE_TRUNK_EXIT:-0} ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

function makeFixture({ shallow = false, trunk = true } = {}) {
  const dir = mkdtempSync(join(tmpRoot, "repo-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.invalid"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(dir, "f.txt"), "x\n");
  git(["add", "f.txt"]);
  git(["commit", "-qm", "root"]);
  const root = git(["rev-parse", "HEAD"]).trim();
  if (trunk) {
    git(["update-ref", "refs/remotes/origin/main", root]);
  } else {
    // No origin/main and no local main: nothing for the guard to compare to.
    git(["checkout", "-q", "-b", "detached-work"]);
    git(["branch", "-qD", "main"]);
  }
  if (shallow) writeFileSync(join(dir, ".git", "shallow"), `${root}\n`);

  const binDir = join(dir, "_bin");
  mkdirSync(binDir);
  const log = join(dir, "_pnpm.log");
  const stub = join(binDir, "pnpm");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  cleanups.push(dir);
  return { dir, binDir, log };
}

function runHook(fx, env = {}) {
  let status = 0;
  let out = "";
  try {
    out = execFileSync("sh", [HOOK], {
      cwd: fx.dir,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${fx.binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
        PNPM_LOG: fx.log,
        GITHUB_ACTIONS: "",
        FAKE_TYPECHECK_EXIT: "",
        FAKE_TRUNK_EXIT: "",
        ...env,
      },
    });
  } catch (e) {
    status = typeof e.status === "number" ? e.status : 1;
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  const calls = existsSync(fx.log) ? readFileSync(fx.log, "utf8") : "";
  return { status, out, calls };
}

// -- 3. the skip path --------------------------------------------------------
console.log("CI + shallow ⇒ trunk gate steps aside:");
{
  const fx = makeFixture({ shallow: true });
  const r = runHook(fx, { GITHUB_ACTIONS: "true" });
  assertTrue("exits 0", r.status === 0, `status=${r.status}\n${r.out}`);
  assertTrue("says SKIPPED with a reason", /fixes:check:trunk SKIPPED.*shallow checkout/.test(r.out), r.out);
  assertTrue("typecheck gate STILL ran", /typecheck/.test(r.calls), `calls=${JSON.stringify(r.calls)}`);
  assertTrue("trunk gate did NOT run", !/fixes:check:trunk/.test(r.calls), `calls=${JSON.stringify(r.calls)}`);
}

console.log("CI + no trunk ref ⇒ trunk gate steps aside:");
{
  const fx = makeFixture({ shallow: false, trunk: false });
  const r = runHook(fx, { GITHUB_ACTIONS: "true" });
  assertTrue("exits 0", r.status === 0, `status=${r.status}\n${r.out}`);
  assertTrue("names the no-trunk-ref reason", /no trunk ref/.test(r.out), r.out);
  assertTrue("trunk gate did NOT run", !/fixes:check:trunk/.test(r.calls), `calls=${JSON.stringify(r.calls)}`);
}

// -- 4. the negative cases: the gate is still a gate --------------------------
console.log("the gate still runs everywhere else:");
{
  const fx = makeFixture({ shallow: false, trunk: true });
  const r = runHook(fx, { GITHUB_ACTIONS: "true" });
  assertTrue("CI + FULL checkout ⇒ gate runs", /fixes:check:trunk/.test(r.calls), `calls=${JSON.stringify(r.calls)}`);
  assertTrue("CI + FULL checkout ⇒ exits 0 when clean", r.status === 0, r.out);
}
{
  const fx = makeFixture({ shallow: true, trunk: true });
  const r = runHook(fx, {}); // no GITHUB_ACTIONS — a human with a shallow clone
  assertTrue("shallow but NOT CI ⇒ gate runs", /fixes:check:trunk/.test(r.calls), `calls=${JSON.stringify(r.calls)}`);
  assertTrue("shallow but NOT CI ⇒ no SKIPPED line", !/SKIPPED/.test(r.out), r.out);
}
{
  const fx = makeFixture({ shallow: false, trunk: true });
  const r = runHook(fx, { FAKE_TRUNK_EXIT: "1" });
  assertTrue("a real trunk violation still aborts the push", r.status === 1, `status=${r.status}\n${r.out}`);
  assertTrue("prints the abort reason", /fixes:check:trunk failed/.test(r.out), r.out);
}
{
  const fx = makeFixture({ shallow: true, trunk: true });
  const r = runHook(fx, { GITHUB_ACTIONS: "true", FAKE_TYPECHECK_EXIT: "1" });
  assertTrue("typecheck gate is NOT skipped by the CI+shallow path", r.status === 1, `status=${r.status}\n${r.out}`);
  assertTrue("prints the typecheck abort", /typecheck failed/.test(r.out), r.out);
}

// -- 5. teardown -------------------------------------------------------------
for (const d of cleanups) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
}
try {
  rmSync(tmpRoot, { recursive: true, force: true });
} catch {}

console.log("");
if (failures.length) {
  console.error(`✗ ${failures.length} assertion(s) failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("✓ pre-push hook scope suite passed.");
