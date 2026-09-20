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

import { execFileSync, execSync, spawnSync } from "node:child_process";
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
  // do in this repo — append a done.log row for FIX-001. Without it
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
  "- 🟠 S — **seed bullet** — placeholder. <!--id:FIX-001-->",
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
// spawnSync, not execFileSync: execFileSync RETURNS stdout and throws away
// stderr on success, so a script that exits 0 while printing a warning to
// stderr looked silent from here. FIX-1200's "say why, once" line is exactly
// that shape — a warning on a run that succeeds.
function runScript(script, args, { cwd, env = {} }) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
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

// ── FIX-1200: ancestry is claimed only where trunk is reachable ─────────────
//
// cc-136 §1 reproduced the bug this guards: a depth-1 clone that then fetches a
// SIBLING branch more deeply has the objects and a resolving `origin/main`, so
// the old per-SHA `cat-file -e` escape never fired — but `rev-list origin/main`
// yields ONE commit, so `merge-base --is-ancestor` answered 1 for commits that
// genuinely ARE on trunk, and every landed FIX was accused of being stranded.
// It accused FIX-960 and FIX-962 that way.
//
// The fixture has to be exactly that shape. A plain `--depth 1` clone with no
// sibling fetch would also pass a test that only asserts "no accusation",
// because the SHA's object is absent and the OLD escape hatch already covered
// it — so the test would be green against the pre-change source. The deeper
// sibling fetch is what makes it a wrong-but-green fixture (rule 105): it fails
// against the old `classifySha` and passes against the new one.
console.log("\nFIX-1200 — trunk reachability gates the ancestry claim:");
{
  const repo = newRepoPair();
  // A few more commits on main, each closing a FIX, so done.log has real SHAs
  // that ARE ancestors of trunk — the population the bug falsely accused.
  for (const n of [2, 3, 4]) {
    writeFileSync(join(repo.work, "docs", "FIXES.md"),
      readFileSync(join(repo.work, "docs", "FIXES.md"), "utf8") +
        `- 🟠 S — **bullet ${n}** — placeholder. <!--id:FIX-00${n}-->\n`);
    git(repo.work, ["add", "-A"]);
    git(repo.work, ["commit", "-m", `feat: work ${n}\n\nVerified: local\nFixes: FIX-00${n}`]);
  }
  // The sibling branches off an EARLY commit, not the tip. That is what makes
  // the deeper sibling fetch drag in a commit which IS on trunk but is NOT in
  // the depth-1 `origin/main` — the exact population the bug accused.
  //
  // The fetch depth also has to stay SHORTER than the history, or git decides
  // the repository is complete, deletes `.git/shallow`, and the fixture is a
  // full clone wearing a shallow label. (`--depth 11` against this four-commit
  // repo did precisely that, and every assertion below passed vacuously.)
  const earlySha = git(repo.work, ["rev-parse", "HEAD~2"]);
  git(repo.work, ["checkout", "-q", "-b", "sibling", earlySha]);
  writeFileSync(join(repo.work, "SIBLING.md"), "sibling\n");
  git(repo.work, ["add", "-A"]);
  git(repo.work, ["commit", "-m", "chore: sibling tip"]);
  git(repo.work, ["checkout", "-q", "main"]);
  git(repo.work, ["push", "origin", "main", "sibling"]);

  // Populate done.log from the FULL clone, where ancestry IS judgeable.
  const seeded = runScript(SYNC_SCRIPT, [], { cwd: repo.work });
  assertEq("FIX-1200 — full clone: sync succeeds", seeded.code, 0);
  const doneLog = readFileSync(join(repo.work, "docs", "done.log"), "utf8");
  assertTrue(
    "FIX-1200 — full clone: done.log recorded the on-trunk completions",
    /FIX-004/.test(doneLog),
    `done.log:\n${doneLog}`,
  );

  // The done.log those rows live in has to be ON ORIGIN, or the shallow clone
  // gets the empty seeded one, evaluates nothing, and every assertion below is
  // about a run that never classified a single SHA.
  git(repo.work, ["add", "-A"]);
  git(repo.work, ["commit", "-m", "chore(fixes): sync status"]);
  git(repo.work, ["push", "origin", "main"]);

  // The shallow clone, cc-136's exact shape: depth-1 main + a deeper sibling.
  const shallow = join(repo.root, "shallow");
  // `--depth` is SILENTLY IGNORED for a local-path clone — git hardlinks the
  // object store instead. The file:// URL forces the real transport, which is
  // what actually truncates history. Without it this fixture is a full clone
  // wearing a shallow label and the whole case is vacuous.
  // A Windows path needs the third slash — `file://C:/x` parses `C:` as a HOST
  // and git clones nothing shallow at all, silently.
  const originPath = repo.origin.replace(/\\/g, "/");
  const originUrl = /^[A-Za-z]:/.test(originPath) ? `file:///${originPath}` : `file://${originPath}`;
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", "main", originUrl, shallow], {
    stdio: "ignore",
  });
  git(shallow, ["config", "core.hooksPath", join(repo.root, "no-hooks")]);
  execFileSync("git", ["fetch", "--quiet", "--depth", "2", "origin", "sibling"], {
    cwd: shallow,
    stdio: "ignore",
  });
  assertEq(
    "FIX-1200 — fixture really is shallow",
    git(shallow, ["rev-parse", "--is-shallow-repository"]),
    "true",
  );
  assertEq(
    "FIX-1200 — fixture really does truncate trunk to one commit",
    git(shallow, ["rev-list", "--count", "origin/main"]),
    "1",
  );
  // ...and FIX-002's object IS present — dragged in by the sibling fetch, since
  // the sibling branched from that commit. This is the assertion that makes the
  // fixture wrong-but-green against the OLD code: `cat-file -e` succeeds, so the
  // old per-SHA escape does NOT fire, and `merge-base --is-ancestor` against a
  // one-commit origin/main then answers "not an ancestor" about a commit that
  // is demonstrably on trunk. Drop this and the test would pass either way.
  const shaOf = (id) =>
    doneLog.split("\n").find((l) => l.includes(`| ${id} |`))?.split("|")[2]?.trim();
  const landed = shaOf("FIX-002");
  assertTrue(
    "FIX-1200 — an on-trunk SHA's object IS present in the shallow clone",
    landed !== undefined && git(shallow, ["cat-file", "-t", landed]) === "commit",
    `FIX-002 sha: ${landed ?? "(none found)"} — fixture cannot prove the old escape was bypassed`,
  );
  assertTrue(
    "FIX-1200 — ...but it is NOT in the truncated origin/main",
    git(shallow, ["rev-list", "origin/main"]).split("\n").every((s) => !s.startsWith(landed ?? "\0")),
    "the fixture's origin/main still contains it — nothing would have been accused",
  );

  const shallowCheck = runScript(SYNC_SCRIPT, ["--check-trunk"], { cwd: shallow });
  assertEq("FIX-1200 — shallow clone: ZERO accusations (exit 0)", shallowCheck.code, 0);
  assertTrue(
    "FIX-1200 — shallow clone: says why, once",
    /trunk not judgeable here \(shallow clone\)/.test(shallowCheck.err + shallowCheck.out),
    `output: ${(shallowCheck.err + shallowCheck.out).slice(0, 300) || "(empty)"}`,
  );
  assertTrue(
    "FIX-1200 — shallow clone: never says not-ancestor",
    !/off-trunk/.test(shallowCheck.out + shallowCheck.err),
    `output: ${(shallowCheck.out + shallowCheck.err).slice(0, 300)}`,
  );

  // The inverse — a FULL clone with a SHA genuinely off trunk MUST still accuse.
  // Without this the case above is satisfied by a guard that accuses nobody.
  const full = join(repo.root, "full");
  execFileSync("git", ["clone", "--quiet", repo.origin, full], { stdio: "ignore" });
  git(full, ["config", "core.hooksPath", join(repo.root, "no-hooks")]);
  // A REAL commit that exists here but is not on main: the sibling tip.
  git(full, ["fetch", "--quiet", "origin", "sibling:sibling"]);
  const offTrunk = git(full, ["rev-parse", "sibling"]);
  writeFileSync(join(full, "docs", "FIXES.md"),
    readFileSync(join(full, "docs", "FIXES.md"), "utf8") +
      "- 🟠 S — **off-trunk bullet** — placeholder. <!--id:FIX-099-->\n");
  writeFileSync(join(full, "docs", "done.log"),
    readFileSync(join(full, "docs", "done.log"), "utf8") +
      `2026-09-20 | FIX-099 | ${offTrunk.slice(0, 8)} | local-only | feat: off-trunk work\n`);
  const fullCheck = runScript(SYNC_SCRIPT, ["--check-trunk"], { cwd: full });
  assertEq("FIX-1200 — full clone: an off-trunk SHA still accuses (exit 1)", fullCheck.code, 1);
  assertTrue(
    "FIX-1200 — full clone: names the off-trunk id",
    /FIX-099/.test(fullCheck.out + fullCheck.err),
    `output: ${(fullCheck.out + fullCheck.err).slice(0, 400)}`,
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
