#!/usr/bin/env node
// scripts/test-fix-add.mjs
//
// Tiny assertion harness for the fix:add id allocator (scripts/fix-add.mjs).
// Covers the pure, git-free helpers: `markerIds` (FIX-368 markers-only rule),
// `looseIds` (done.log orphan blocking), and `computeNextId` (the FIX-771
// origin/main fold-in + divergence signal). The git-dependent wrapper
// (readOriginMainFixes/allocateNextId) is exercised for real every time
// `pnpm fix:add` runs; this guards the logic that decides the number.
//
// Run:   pnpm fix:add:test
// Exit:  0 on pass, 1 on fail with expected-vs-actual.

import { markerIds, looseIds, computeNextId } from "./fix-add.mjs";

const failures = [];
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`  ✗ ${label}\n     expected: ${e}\n     actual:   ${a}`);
  else console.log(`  ✓ ${label}`);
}

console.log("markerIds — markers only (FIX-368):");
// A forward-ref [[FIX-999]] and a prose "FIX-998" must NOT count — only the
// canonical <!--id:FIX-NNN--> marker does. This is the exact regression that
// burned FIX-362 under the old loose /FIX-\d{3}/g.
assertEq("ignores [[FIX-NNN]] + prose mentions",
  markerIds("- [ ] body [[FIX-999]] refs FIX-998 <!--id:FIX-767-->"), [767]);
assertEq("counts every marker", markerIds("<!--id:FIX-100--> … <!--id:FIX-205-->"), [100, 205]);
assertEq("no markers → []", markerIds("plain text, [[FIX-500]] only"), []);
assertEq("4-digit future-proof", markerIds("<!--id:FIX-1000-->"), [1000]);

console.log("\nlooseIds — done.log real allocations block reuse:");
assertEq("bare + referenced ids", looseIds("FIX-766 | abc123 | note about FIX-700"), [766, 700]);

console.log("\ncomputeNextId — max across every source (FIX-771):");
// origin/main ahead of a stale worktree FIXES.md: origin wins so the id can't
// collide with a concurrent hand-add on main.
assertEq("origin ahead of local wins",
  computeNextId({ fixes: "<!--id:FIX-760-->", origin: "<!--id:FIX-766-->" }),
  { nextId: "FIX-767", localMax: 760, originMax: 766 });
// Mid-wave worktree: local (with freshly-filed bullets) ahead of origin.
assertEq("local ahead of origin",
  computeNextId({ fixes: "<!--id:FIX-772-->", origin: "<!--id:FIX-766-->" }),
  { nextId: "FIX-773", localMax: 772, originMax: 766 });
// done.log / archive still block reuse even when FIXES.md is behind them.
assertEq("done.log orphan blocks reuse",
  computeNextId({ fixes: "<!--id:FIX-700-->", done: "FIX-800 | reopen" }).nextId, "FIX-801");
assertEq("archive marker blocks reuse",
  computeNextId({ fixes: "<!--id:FIX-700-->", archive: "<!--id:FIX-850-->" }).nextId, "FIX-851");
// Offline / no-origin degrades to the working tree alone (origin === "").
assertEq("no origin → working tree alone",
  computeNextId({ fixes: "<!--id:FIX-766-->", origin: "" }),
  { nextId: "FIX-767", localMax: 766, originMax: 0 });
assertEq("empty everything → FIX-001", computeNextId({ fixes: "" }).nextId, "FIX-001");

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\n✓ All fix-add allocator assertions passed.");
