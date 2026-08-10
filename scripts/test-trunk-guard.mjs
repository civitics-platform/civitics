#!/usr/bin/env node
// scripts/test-trunk-guard.mjs
//
// Test harness for scripts/lib/trunk-guard.mjs — the FIXES.md/done.log
// concurrent-write guard.
//
// Run:   pnpm fixes:test:trunk   (also runs as part of `pnpm fixes:test`)
// Exit:  0 on pass, 1 on fail.
//
// ── Why this test is shaped the way it is ───────────────────────────────────
// Playbook rule E10: an assertion that cannot fail is not evidence. A guard test
// that only checks "the normal path still works" would pass identically with the
// guard deleted, so every case here is paired:
//
//   1. Pure core — evaluateTrunkMove on synthetic before/after states.
//   2. REAL GIT, no seam — a throwaway repo with a real `origin`. Capture,
//      advance origin/main for real, fetch, assert the abort fires. Plus the
//      control: capture, change nothing, assert it does NOT fire. If the two
//      cases agreed, the test would be worthless.
//   3. REAL SCRIPTS — spawn `node scripts/fixes-sync.mjs` and
//      `node scripts/fix-add.mjs` as child processes against a throwaway repo
//      and assert exit 1 + the abort text. This is what proves the guard is
//      WIRED, not merely present. Paired with a control run of the same script
//      in the same repo that must exit 0 and actually write.
//
// Case 3 seeds the captured baseline via CIVITICS_TRUNK_GUARD_TEST_BASELINE,
// because the move has to happen strictly between the child's capture and its
// write and there is no way to interleave with a child process from here. The
// seam can only make the guard fire — there is no value that suppresses it.

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureTrunkState,
  assertTrunkUnmoved,
  evaluateTrunkMove,
  TrunkMovedError,
} from "./lib/trunk-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT = resolve(HERE, "fixes-sync.mjs");
const ADD_SCRIPT = resolve(HERE, "fix-add.mjs");

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

// ── 1. Pure core ────────────────────────────────────────────────────────────
console.log("evaluateTrunkMove (pure):");
const S = (trunk, head) => ({ ref: "origin/main", trunk, head });
assertEq("unchanged → no move", evaluateTrunkMove(S("a1", "b1"), S("a1", "b1")).moved, false);
assertEq("trunk advanced → move", evaluateTrunkMove(S("a1", "b1"), S("a2", "b1")).moved, true);
assertEq("HEAD advanced → move", evaluateTrunkMove(S("a1", "b1"), S("a1", "b2")).moved, true);
assertEq(
  "reports which ref moved",
  evaluateTrunkMove(S("a1", "b1"), S("a2", "b2")).movers.map((m) => m.what),
  ["trunk", "HEAD"],
);
assertEq(
  "no trunk ref on either side is not a move",
  evaluateTrunkMove(S(null, "b1"), S(null, "b1")).moved,
  false,
);
assertEq(
  "a trunk ref appearing mid-operation IS a move (a fetch landed)",
  evaluateTrunkMove(S(null, "b1"), S("a2", "b1")).moved,
  true,
);

// ── temp-repo helpers ───────────────────────────────────────────────────────
const scratch = [];
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function newRepoPair() {
  const root = mkdtempSync(join(tmpdir(), "trunk-guard-"));
  scratch.push(root);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  mkdirSync(origin);
  mkdirSync(work);
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "--initial-branch=main", work], { stdio: "ignore" });
  git(work, ["config", "user.email", "test@example.com"]);
  git(work, ["config", "user.name", "trunk-guard test"]);
  git(work, ["config", "commit.gpgsign", "false"]);
  // core.hooksPath: the repo root `prepare` script points hooks at .githooks;
  // a throwaway repo must not inherit that, so pin it to nothing.
  git(work, ["config", "core.hooksPath", join(root, "no-hooks")]);
  mkdirSync(join(work, "docs"));
  writeFileSync(join(work, "docs", "FIXES.md"), FIXTURE_FIXES_MD);
  writeFileSync(join(work, "docs", "done.log"), "");
  git(work, ["add", "-A"]);
  // The seed commit carries a real trailer, so `fixes:sync` has actual work to
  // do in this repo — append a done.log row and flip FIX-001 to [x]. Without it
  // the "wrote NOTHING" assertion below would pass vacuously (E10).
  git(work, ["commit", "-m", "feat: seed\n\nVerified: local\nFixes: FIX-001"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", "main"]);
  return { root, origin, work };
}
const FIXTURE_FIXES_MD = [
  "# FIXES",
  "",
  "## INFRASTRUCTURE & PERFORMANCE",
  "",
  "- [ ] 🟠 S — **seed bullet** — placeholder. <!--id:FIX-001-->",
  "",
].join("\n");

// Advance origin/main from a second clone, then fetch it into `work` — so
// origin/main in `work` really moves, exactly as it does when another session
// pushes and something fetches.
function advanceOrigin({ root, origin, work }, message) {
  const other = join(root, `other-${Math.abs(message.length * 7919) % 100000}`);
  execFileSync("git", ["clone", "--quiet", origin, other], { stdio: "ignore" });
  git(other, ["config", "user.email", "other@example.com"]);
  git(other, ["config", "user.name", "other session"]);
  git(other, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(other, "OTHER.md"), `${message}\n`);
  git(other, ["add", "-A"]);
  git(other, ["commit", "-m", message]);
  git(other, ["push", "origin", "main"]);
  git(work, ["fetch", "origin", "--quiet"]);
}

// ── 2. Real git, no seam ────────────────────────────────────────────────────
console.log("\nassertTrunkUnmoved against real git:");
{
  const repo = newRepoPair();
  const cwd = process.cwd();
  try {
    process.chdir(repo.work);

    // Control: nothing moves → must NOT throw. Without this the abort case
    // below would be satisfied by a guard that always throws.
    const quietBefore = captureTrunkState();
    let quietThrew = null;
    try {
      assertTrunkUnmoved(quietBefore, { operation: "control", files: ["docs/FIXES.md"] });
    } catch (e) {
      quietThrew = e;
    }
    assertTrue("control — trunk still → no abort", quietThrew === null, String(quietThrew?.message).split("\n")[0]);

    // Abort: origin/main really advances between capture and assert.
    const before = captureTrunkState();
    advanceOrigin(repo, "another session pushed");
    let err = null;
    try {
      assertTrunkUnmoved(before, { operation: "splice FIX-001", files: ["docs/FIXES.md"] });
    } catch (e) {
      err = e;
    }
    assertTrue("origin/main advanced → aborts", err instanceof TrunkMovedError);
    assertTrue(
      "abort names the operation",
      String(err?.message).includes("ABORTED: splice FIX-001"),
      String(err?.message).split("\n")[0],
    );
    assertTrue("abort names which ref moved", String(err?.message).includes("trunk (origin/main)"));
    assertTrue("abort states the recovery", String(err?.message).includes("Recover:"));
    assertEq("abort reports exactly one mover", err?.details?.movers?.map((m) => m.what), ["trunk"]);

    // HEAD moving on the shared checkout is the other half of the race.
    const beforeHead = captureTrunkState();
    writeFileSync(join(repo.work, "LOCAL.md"), "local commit\n");
    git(repo.work, ["add", "-A"]);
    git(repo.work, ["commit", "-m", "another session committed here"]);
    let headErr = null;
    try {
      assertTrunkUnmoved(beforeHead, { operation: "fixes:sync", files: ["docs/done.log"] });
    } catch (e) {
      headErr = e;
    }
    assertTrue("HEAD advanced → aborts", headErr instanceof TrunkMovedError);
    assertEq("abort reports HEAD as the mover", headErr?.details?.movers?.map((m) => m.what), ["HEAD"]);
  } finally {
    process.chdir(cwd);
  }
}

// ── 3. Real scripts, spawned ────────────────────────────────────────────────
// Proves the guard is wired into the write paths, not just importable.
console.log("\nwired into the real scripts (child processes):");
function runScript(script, args, { cwd, env = {} }) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

for (const [label, script, args] of [
  ["fixes:sync", SYNC_SCRIPT, []],
  [
    "fix:add",
    ADD_SCRIPT,
    ["--title", "guard test", "--severity", "🟠", "--size", "S", "--section", "INFRASTRUCTURE", "--body", "body."],
  ],
]) {
  const repo = newRepoPair();
  const fixesPath = join(repo.work, "docs", "FIXES.md");
  const donePath = join(repo.work, "docs", "done.log");
  const beforeText = readFileSync(fixesPath, "utf8");
  const beforeDone = readFileSync(donePath, "utf8");

  // Seeded baseline = "trunk was <bogus> when we started" → the script's own
  // re-check reads the real SHA, sees the mismatch, and must refuse to write.
  const blocked = runScript(script, args, {
    cwd: repo.work,
    env: { CIVITICS_TRUNK_GUARD_TEST_BASELINE: "0".repeat(40) },
  });
  assertEq(`${label} — exits 1 when trunk moved`, blocked.code, 1);
  assertTrue(
    `${label} — prints the abort text`,
    blocked.err.includes("trunk-guard — ABORTED"),
    `stderr: ${blocked.err.slice(0, 200) || "(empty)"}`,
  );
  assertTrue(
    `${label} — wrote NOTHING`,
    readFileSync(fixesPath, "utf8") === beforeText && readFileSync(donePath, "utf8") === beforeDone,
    "docs/FIXES.md or docs/done.log changed despite the abort",
  );

  // Control: same script, same repo, no seeded baseline → must succeed AND
  // actually write. Without the write assertion the case above would prove
  // nothing — a script that never writes trivially "wrote NOTHING".
  const ok = runScript(script, args, { cwd: repo.work });
  assertEq(`${label} — control run succeeds`, ok.code, 0);
  assertTrue(
    `${label} — control run actually writes`,
    readFileSync(fixesPath, "utf8") !== beforeText || readFileSync(donePath, "utf8") !== beforeDone,
    "neither file changed on the control run — the abort case is vacuous",
  );
}

// ── cleanup ─────────────────────────────────────────────────────────────────
for (const dir of scratch) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows can hold a handle briefly; a leaked temp dir is not a failure.
  }
}

if (failures.length) {
  console.error("\nFAIL:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\nfixes:test:trunk — all assertions passed.");
