#!/usr/bin/env node
// scripts/test-session-worktree.mjs
//
// Unit test for the FIX-480 containment guard in scripts/session-worktree.mjs.
// The guard decides whether the fs.rm fallback in done() is allowed to delete a
// path — it must accept ONLY paths strictly inside the sibling
// civitics-worktrees dir, and reject anything that climbs out via ../, lands on
// the repo itself, or resolves to a different drive.
//
// Run:   pnpm session:worktree:test
// Exit:  0 on pass, 1 on fail.

import { resolve } from "node:path";
import { isContainedWorktreePath } from "./session-worktree.mjs";

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

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\n✓ all containment cases pass");
