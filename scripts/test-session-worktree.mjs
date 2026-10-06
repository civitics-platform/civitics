#!/usr/bin/env node
// scripts/test-session-worktree.mjs
//
// Unit test for the FIX-480 containment guard in scripts/session-worktree.mjs.
// The guard decides whether the fs.rm fallback in done() is allowed to delete a
// path — it must accept ONLY paths strictly inside the sibling
// civitics-worktrees dir, and reject anything that climbs out via ../, lands on
// the repo itself, or resolves to a different drive.
//
// FIX-1276: also parseWorktreeList + worktreeDisposition — a REGISTERED tree
// that git reports `prunable` (its .git file gone) takes the FIX-879 orphan
// path instead of being refused as dirty; a registered tree whose status merely
// fails to read is still refused. Runs in CI (fixes-integrity.yml) and in
// `pnpm fixes:test`.
//
// Run:   pnpm session:worktree:test
// Exit:  0 on pass, 1 on fail.

import { resolve } from "node:path";
import { isContainedWorktreePath, parseWorktreeList, worktreeDisposition } from "./session-worktree.mjs";

const ROOT = resolve("/repos/civitics/App");          // pretend repo root
const WT_BASE = resolve(ROOT, "..", "civitics-worktrees");

const failures = [];
function assert(label, actual, expected) {
  if (actual !== expected) {
    failures.push(`  ✗ ${label}\n     expected: ${expected}\n     actual:   ${actual}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

console.log("isContainedWorktreePath:");

// Contained — the normal create() target shape.
assert("fix-123 worktree is contained", isContainedWorktreePath(resolve(WT_BASE, "fix-123"), ROOT), true);
assert("fix-480abc worktree is contained", isContainedWorktreePath(resolve(WT_BASE, "fix-480abc"), ROOT), true);
assert("nested path under base is contained", isContainedWorktreePath(resolve(WT_BASE, "fix-1", "sub"), ROOT), true);

// Rejected — the base dir itself (would nuke ALL worktrees).
assert("base dir itself is NOT contained", isContainedWorktreePath(WT_BASE, ROOT), false);

// Rejected — climbs out of the base with ../.
assert("../ escape is NOT contained", isContainedWorktreePath(resolve(WT_BASE, "..", "App"), ROOT), false);
assert("repo root is NOT contained", isContainedWorktreePath(ROOT, ROOT), false);
assert("arbitrary sibling is NOT contained", isContainedWorktreePath(resolve(ROOT, "..", "something-else"), ROOT), false);

// Rejected — a raw ../ suffix that a Bash string-prefix rule would miss.
assert(
  "civitics-worktrees/../escape is NOT contained",
  isContainedWorktreePath(resolve(WT_BASE, "fix-1", "..", "..", "App"), ROOT),
  false,
);

// Rejected — absolute path outside the tree entirely.
assert("absolute /tmp is NOT contained", isContainedWorktreePath(resolve("/tmp/whatever"), ROOT), false);

// FIX-1276 fixtures — the porcelain shapes quoted by cc-201 read 2, git 2.53.0.
const PRIMARY = "C:/Users/Craig/Documents/Civitics/App";
const LIVE_PATH = "C:/Users/Craig/Documents/Civitics/civitics-worktrees/fix-1276";
const PRUNABLE_PATH = "C:/Users/Craig/Documents/Civitics/civitics-worktrees/civitics-worktrees/fix-9999";
const LIVE_BLOCK = [
  `worktree ${LIVE_PATH}`,
  "HEAD 82abe5b3db1e596b274f9b1a9fe56780413a355c",
  "branch refs/heads/feature/fix-1276",
  "",
].join("\n");
const PRUNABLE_BLOCK = [
  `worktree ${PRUNABLE_PATH}`,
  "HEAD 82abe5b3db1e596b274f9b1a9fe56780413a355c",
  "branch refs/heads/feature/fix-9999",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");
const MAIN_BLOCK = [
  `worktree ${PRIMARY}`,
  "HEAD 82abe5b3db1e596b274f9b1a9fe56780413a355c",
  "branch refs/heads/main",
  "",
].join("\n");

console.log("\nparseWorktreeList:");

const live = parseWorktreeList(LIVE_BLOCK);
assert("live block → one entry", live.length, 1);
assert("live block → path", live[0]?.path, LIVE_PATH);
assert("live block → branch", live[0]?.branch, "refs/heads/feature/fix-1276");
assert("live block → not detached", live[0]?.detached, false);
assert("live block → prunable null", live[0]?.prunable, null);

const prunable = parseWorktreeList(PRUNABLE_BLOCK);
assert("prunable block → one entry", prunable.length, 1);
assert(
  "prunable block → reason captured verbatim",
  prunable[0]?.prunable,
  "gitdir file points to non-existent location",
);

const two = parseWorktreeList(MAIN_BLOCK + "\n" + PRUNABLE_BLOCK);
assert("main + prunable → two entries", two.length, 2);
assert("main + prunable → main first", two[0]?.path, PRIMARY);
assert("main + prunable → main not prunable", two[0]?.prunable, null);
assert("main + prunable → prunable second", two[1]?.path, PRUNABLE_PATH);
assert("main + prunable → second is prunable", two[1]?.prunable, "gitdir file points to non-existent location");

const crlf = parseWorktreeList((MAIN_BLOCK + "\n" + LIVE_BLOCK).replace(/\n/g, "\r\n"));
assert("CRLF text → two entries", crlf.length, 2);

const detached = parseWorktreeList(`worktree ${LIVE_PATH}\nHEAD 82abe5b3\ndetached\n`);
assert("detached block → detached true", detached[0]?.detached, true);
assert("detached block → no branch", detached[0]?.branch, undefined);

console.log("\nworktreeDisposition:");

const both = parseWorktreeList(MAIN_BLOCK + "\n" + LIVE_BLOCK + "\n" + PRUNABLE_BLOCK);

// Registered, status unreadable, NOT prunable → today's refusal stands: a
// live tree whose status git cannot read is not assumed clean.
let d = worktreeDisposition({ entries: both, wtDir: LIVE_PATH, statusOk: false, statusOut: "" });
assert("registered + status failed + not prunable → registered", d.registered, true);
assert("registered + status failed + not prunable → orphan false", d.orphan, false);
assert("registered + status failed + not prunable → NOT clean (refused)", d.cleanIgnoringArtifacts, false);

// Registered, status unreadable, PRUNABLE → the FIX-1276 case: orphan path.
d = worktreeDisposition({ entries: both, wtDir: PRUNABLE_PATH, statusOk: false, statusOut: "" });
assert("registered + status failed + prunable → registered", d.registered, true);
assert("registered + status failed + prunable → prunable", d.prunable, true);
assert("registered + status failed + prunable → orphan true", d.orphan, true);
assert("registered + status failed + prunable → clean (orphan path)", d.cleanIgnoringArtifacts, true);

// Not registered at all → the FIX-879 orphan, unchanged.
d = worktreeDisposition({
  entries: parseWorktreeList(MAIN_BLOCK),
  wtDir: PRUNABLE_PATH,
  statusOk: false,
  statusOut: "",
});
assert("not registered → registered false", d.registered, false);
assert("not registered → prunable false", d.prunable, false);
assert("not registered → orphan true", d.orphan, true);
assert("not registered → clean (orphan path)", d.cleanIgnoringArtifacts, true);

// Registered, status ok + empty → clean, not an orphan.
d = worktreeDisposition({ entries: both, wtDir: LIVE_PATH, statusOk: true, statusOut: "" });
assert("registered + status clean → orphan false", d.orphan, false);
assert("registered + status clean → clean", d.cleanIgnoringArtifacts, true);

// Registered, status ok + dirty → refused.
d = worktreeDisposition({ entries: both, wtDir: LIVE_PATH, statusOk: true, statusOut: " M package.json" });
assert("registered + status dirty → NOT clean (refused)", d.cleanIgnoringArtifacts, false);

// The prunable path still ends in the contained fs.rm — the containment guard
// stays the gate. Assert it on the fixture's own shape: from the worktree it
// ran in, the nested throwaway is inside that root's sibling base; from the
// primary checkout, a canonical slot is.
assert(
  "prunable fixture path is contained (root = the worktree it was created from)",
  isContainedWorktreePath(resolve(PRUNABLE_PATH), resolve(LIVE_PATH)),
  true,
);
assert(
  "canonical slot is contained (root = primary checkout)",
  isContainedWorktreePath(resolve("C:/Users/Craig/Documents/Civitics/civitics-worktrees/fix-9999"), resolve(PRIMARY)),
  true,
);
assert(
  "primary checkout is NOT contained (an orphan verdict never reaches it)",
  isContainedWorktreePath(resolve(PRIMARY), resolve(PRIMARY)),
  false,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\n✓ all session-worktree cases pass");
