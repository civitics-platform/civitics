#!/usr/bin/env node
// scripts/test-session-check.mjs
//
// Fixtures for session:check's one write (FIX-1345 D8): the primary checkout's
// guarded `git pull --ff-only origin main`. Each case builds a bare "origin",
// a "primary" clone, and a second clone that advances origin, in a temp dir,
// then runs the REAL scripts/session-check.mjs in a child process from the
// primary (or from a linked worktree of it) and reads the result off git.
//
// Run:   pnpm session:check:test   (also part of pnpm fixes:test)
// Exit:  0 on pass, 1 on fail.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "session-check.mjs");

const failures = [];
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`  ✗ ${label}\n     expected: ${e}\n     actual:   ${a}`);
  else console.log(`  ✓ ${label}`);
}
function assertTrue(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else failures.push(`  ✗ ${label}${detail ? `\n     ${detail}` : ""}`);
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function configure(dir, root) {
  git(dir, ["config", "user.email", "t@example.invalid"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  // A throwaway repo must not inherit the root `prepare` script's hooks.
  git(dir, ["config", "core.hooksPath", join(root, "no-hooks")]);
}

const roots = [];
/** origin.git (bare) + primary (clone, on main, 1 commit) + other (clone). */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "session-check-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const primary = join(root, "primary");
  const other = join(root, "other");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin], { stdio: "ignore" });
  execFileSync("git", ["clone", "-q", origin, primary], { stdio: "ignore" });
  configure(primary, root);
  git(primary, ["switch", "-q", "-c", "main"]);
  writeFileSync(join(primary, "a.txt"), "one\n");
  git(primary, ["add", "a.txt"]);
  git(primary, ["commit", "-q", "-m", "seed"]);
  git(primary, ["push", "-q", "-u", "origin", "main"]);
  execFileSync("git", ["clone", "-q", origin, other], { stdio: "ignore" });
  configure(other, root);
  return { root, origin, primary, other };
}

/** Land one commit on origin/main from the other clone; returns its sha. */
function advanceOrigin({ other }, name = "b.txt") {
  writeFileSync(join(other, name), `${name}\n`);
  git(other, ["add", name]);
  git(other, ["commit", "-q", "-m", `add ${name}`]);
  git(other, ["push", "-q", "origin", "main"]);
  return git(other, ["rev-parse", "HEAD"]);
}

function runCheck(cwd, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", timeout: 120_000 });
  return (r.stdout ?? "") + (r.stderr ?? "");
}
const head = (dir) => git(dir, ["rev-parse", "HEAD"]);
/** The ATTENTION bullets of the summary, or [] when the summary is OK. */
const attentionOf = (out) => {
  const i = out.indexOf("⚠ ATTENTION:");
  return i === -1 ? [] : out.slice(i).split("\n").filter((l) => l.startsWith("  • "));
};

try {
  console.log("behind and clean, on main, in the primary:");
  {
    const f = fixture();
    const target = advanceOrigin(f);
    const out = runCheck(f.primary);
    assertEq("HEAD advanced to origin/main", head(f.primary), target);
    assertTrue("prints `primary: pulled 1 commit(s) → <sha>`", out.includes(`primary: pulled 1 commit(s) → ${target.slice(0, 8)}`), out);
  }

  console.log("\nup to date:");
  {
    const f = fixture();
    const before = head(f.primary);
    const out = runCheck(f.primary);
    assertEq("HEAD unchanged", head(f.primary), before);
    assertTrue("prints `primary: up to date`", out.includes("primary: up to date"), out);
  }

  console.log("\ndirty (a modified tracked file):");
  {
    const f = fixture();
    const before = head(f.primary);
    advanceOrigin(f);
    writeFileSync(join(f.primary, "a.txt"), "craig is mid-edit\n");
    const out = runCheck(f.primary);
    assertEq("HEAD unchanged", head(f.primary), before);
    assertEq("the edit is untouched", readFileSync(join(f.primary, "a.txt"), "utf8"), "craig is mid-edit\n");
    assertTrue("prints `primary NOT pulled: 1 uncommitted path(s)`", out.includes("primary NOT pulled: 1 uncommitted path(s)"), out);
    assertTrue(
      "…and lists it under ATTENTION",
      attentionOf(out).some((l) => l.includes("primary NOT pulled: 1 uncommitted path(s)")),
      attentionOf(out).join("\n"),
    );
  }

  console.log("\non a branch other than main:");
  {
    const f = fixture();
    git(f.primary, ["switch", "-q", "-c", "side"]);
    const before = head(f.primary);
    advanceOrigin(f);
    const out = runCheck(f.primary);
    assertEq("HEAD unchanged", head(f.primary), before);
    assertTrue("prints `primary NOT pulled: on side, not main`", out.includes("primary NOT pulled: on side, not main"), out);
    assertTrue("no `pulled` line", !out.includes("primary: pulled"), out);
  }

  console.log("\nin a linked worktree:");
  {
    const f = fixture();
    const wt = join(f.root, "wt");
    git(f.primary, ["worktree", "add", "-q", "-b", "feature/x", wt]);
    const wtBefore = head(wt);
    const primaryBefore = head(f.primary);
    advanceOrigin(f);
    const out = runCheck(wt);
    assertEq("the worktree's HEAD unchanged", head(wt), wtBefore);
    assertEq("the primary's HEAD unchanged", head(f.primary), primaryBefore);
    assertTrue("no `primary` line at all", !/^primary[: ]/m.test(out), out);
  }

  console.log("\nahead (a local commit) and behind:");
  {
    const f = fixture();
    advanceOrigin(f);
    writeFileSync(join(f.primary, "c.txt"), "local\n");
    git(f.primary, ["add", "c.txt"]);
    git(f.primary, ["commit", "-q", "-m", "local work"]);
    const before = head(f.primary);
    const out = runCheck(f.primary);
    assertEq("HEAD unchanged", head(f.primary), before);
    assertTrue("prints `primary NOT pulled: 1 local commit(s) ahead`", out.includes("primary NOT pulled: 1 local commit(s) ahead of origin/main"), out);
    assertTrue(
      "the existing ahead signal is still under ATTENTION",
      attentionOf(out).some((l) => l.includes("1 commit(s) ahead of origin/main (unpushed)")),
      attentionOf(out).join("\n"),
    );
  }

  console.log("\n--no-pull:");
  {
    const f = fixture();
    const before = head(f.primary);
    advanceOrigin(f);
    const out = runCheck(f.primary, ["--no-pull"]);
    assertEq("HEAD unchanged", head(f.primary), before);
    assertTrue("prints what it would have done", out.includes("primary: would pull 1 commit(s) — skipped (--no-pull)"), out);
  }

  console.log("\norigin unreachable (fetch fails):");
  {
    const f = fixture();
    const before = head(f.primary);
    advanceOrigin(f);
    git(f.primary, ["remote", "set-url", "origin", join(f.root, "no-such-origin.git")]);
    const out = runCheck(f.primary);
    assertEq("HEAD unchanged", head(f.primary), before);
    assertTrue("the existing degrade path fires", out.includes("git fetch origin failed"), out);
    assertTrue("no pull attempted", out.includes("primary NOT pulled: git fetch failed") && !out.includes("primary: pulled"), out);
  }
} finally {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {}
  }
}

if (failures.length) {
  console.error("\nFAIL:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\nsession:check:test — all assertions passed.");
