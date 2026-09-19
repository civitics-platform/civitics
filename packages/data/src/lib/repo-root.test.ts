/**
 * FIX-1198 — the contract audit-fec-emit-residue's --out-dir default rests on.
 *
 * The bug was not that the path was wrong-looking; it was that a relative path
 * resolved against the CWD, and the CWD under `pnpm --filter @civitics/data` is
 * `packages/data`. So the assertions that matter are: the resolved path is
 * ABSOLUTE (a relative answer is the bug by definition), it lands under the
 * repo root, and it does NOT land under packages/data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { repoRoot, resolveUnderRepoRoot } from "./repo-root";

test("repoRoot() finds the workspace marker, not the cwd", () => {
  const root = repoRoot("test");
  assert.ok(isAbsolute(root), `repoRoot must be absolute, got ${root}`);
  assert.ok(
    existsSync(join(root, "pnpm-workspace.yaml")),
    `${root} should hold pnpm-workspace.yaml`,
  );
});

test("the --out-dir default resolves absolute, under the repo root, ending in docs/audits", () => {
  // Exactly the expression audit-fec-emit-residue passes when --out-dir is absent.
  const resolved = resolveUnderRepoRoot(join("docs", "audits"), "test");

  assert.ok(isAbsolute(resolved), `default --out-dir must be absolute, got ${resolved}`);
  assert.equal(resolved, join(repoRoot("test"), "docs", "audits"));
  assert.ok(
    resolved.endsWith(join("docs", "audits")),
    `expected a docs/audits tail, got ${resolved}`,
  );

  // The regression itself: never under packages/data, whatever the cwd is.
  assert.ok(
    !resolved.includes(`${sep}packages${sep}data${sep}`),
    `the FIX-1198 bug: ${resolved} is inside packages/data`,
  );
});

test("a relative --out-dir resolves against the repo root, an absolute one is taken verbatim", () => {
  assert.equal(resolveUnderRepoRoot("docs/receipts", "test"), join(repoRoot("test"), "docs/receipts"));

  // An operator who names a directory means that directory.
  const abs = join(repoRoot("test"), "somewhere", "else");
  assert.equal(resolveUnderRepoRoot(abs, "test"), abs);
});

test("resolution does not depend on the cwd — the whole point", () => {
  const before = process.cwd();
  const fromRoot = resolveUnderRepoRoot(join("docs", "audits"), "test");
  try {
    // Stand where `pnpm --filter @civitics/data` stands.
    process.chdir(join(repoRoot("test"), "packages", "data"));
    assert.equal(resolveUnderRepoRoot(join("docs", "audits"), "test"), fromRoot);
  } finally {
    process.chdir(before);
  }
});
