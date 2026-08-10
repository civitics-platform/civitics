#!/usr/bin/env node
// scripts/lib/trunk-guard.mjs
//
// Concurrent-write guard for the two files that are BOTH hand-edited and
// machine-edited: docs/FIXES.md and docs/done.log.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// CLAUDE.md's parallel-session rule says agents never commit on the primary
// VSCode checkout, because two sessions sharing one `.git` contend on the index
// and — worse — on these two files. On 2026-08-09 a Cowork prompt overrode that
// rule and two sessions raced on FIXES.md/done.log. Nothing broke, on luck: the
// losing write was an ad-hoc splice script, not the tooling, and it happened to
// land between the other session's read and write rather than across it.
//
// The failure mode is silent by construction. A read-modify-write of FIXES.md
// reads the whole file, transforms it in memory, and writes the whole file back.
// If trunk advanced in between — another session committed, or a fetch pulled in
// a push — the write silently reverts whatever arrived in that window. There is
// no conflict, no error, and the diff looks intentional.
//
// ── What it does ────────────────────────────────────────────────────────────
// Capture the trunk state before the read; re-check immediately before the
// write; ABORT if it moved. It does not merge, retry or rebase — turning a
// silent fast-forward into a loud refusal is the entire point, and anything
// cleverer reintroduces the race it exists to catch.
//
// Two refs are watched, because the two sessions can collide either way round:
//   • origin/main — another session pushed and something fetched it in-window
//     (`fix-add.mjs` fetches mid-run, so this is reachable without user action)
//   • HEAD        — another session committed on this shared checkout in-window
// Neither of these scripts commits or fetches after its own capture point, so a
// move is always somebody else.
//
// ── Using it from an ad-hoc script ──────────────────────────────────────────
// The 2026-08-09 near-miss was an ad-hoc splice, not the tooling, so this module
// is exported for exactly that case. Three lines:
//
//   import { captureTrunkState, assertTrunkUnmoved } from "./lib/trunk-guard.mjs";
//   const before = captureTrunkState();
//   ... read docs/FIXES.md, transform it ...
//   assertTrunkUnmoved(before, { operation: "splice FIX-NNN", files: ["docs/FIXES.md"] });
//   ... write ...
//
// `assertTrunkUnmoved` throws `TrunkMovedError`, whose `.message` is the full
// operator-facing abort text. CLI callers can use `abortOnTrunkMove`, which
// prints it to stderr and exits 1.

import { execSync } from "node:child_process";

// Test-only seam. When set, it replaces the captured trunk SHA, so an
// integration test can spawn the real script and watch the real abort path fire
// against a real repo. It can only make the guard MORE likely to fire — there is
// no value it can take that disables the check.
const TEST_BASELINE_ENV = "CIVITICS_TRUNK_GUARD_TEST_BASELINE";

export class TrunkMovedError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "TrunkMovedError";
    this.details = details;
  }
}

function git(args) {
  try {
    return execSync(`git ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Resolve the trunk ref the same way fixes-sync.mjs does: prefer the
// remote-tracking ref (what actually shipped), fall back to local main. Returns
// null on a fresh/shallow clone with no main ref — the guard then degrades to
// watching HEAD alone rather than failing spuriously.
export function resolveTrunkRef() {
  for (const ref of ["origin/main", "refs/remotes/origin/main", "main"]) {
    if (git(`rev-parse --verify --quiet ${ref}`) !== null) return ref;
  }
  return null;
}

/**
 * Snapshot the refs to compare against. Call this BEFORE the read half of a
 * read-modify-write. Cheap — two `git rev-parse` calls, no network.
 */
export function captureTrunkState() {
  const ref = resolveTrunkRef();
  const trunk = ref ? git(`rev-parse ${ref}`) : null;
  const head = git("rev-parse HEAD");
  // ONE-SHOT: the seam seeds the baseline only. It is consumed on first read so
  // the re-check inside assertTrunkUnmoved always reads real git — otherwise the
  // fake value would appear on both sides and the guard would compare equal,
  // which is precisely the vacuous-pass failure the seam exists to rule out.
  const override = process.env[TEST_BASELINE_ENV];
  if (override) delete process.env[TEST_BASELINE_ENV];
  return {
    ref,
    trunk: override ? override : trunk,
    head,
    seeded: Boolean(override),
  };
}

/**
 * Pure comparison core — no git, no fs, so the abort decision is unit-testable.
 * A ref that was unresolvable at capture time and is still unresolvable is not a
 * move; a ref that appeared or vanished in-window IS one (a clone that gained
 * origin/main mid-operation is exactly the fetch case).
 */
export function evaluateTrunkMove(before, after) {
  const movers = [];
  const cmp = (what, ref, from, to) => {
    if (from === to) return;
    if (from == null && to == null) return;
    movers.push({ what, ref, from, to });
  };
  cmp("trunk", before.ref ?? after.ref ?? "origin/main", before.trunk, after.trunk);
  cmp("HEAD", "HEAD", before.head, after.head);
  return { moved: movers.length > 0, movers };
}

const short = (sha) => (sha ? sha.slice(0, 8) : "(unresolved)");

export function formatTrunkMoveMessage({ operation, files = [], movers }) {
  const what = files.length ? files.join(", ") : "docs/FIXES.md / docs/done.log";
  const lines = [
    `trunk-guard — ABORTED: ${operation}`,
    "",
    `  Git state moved while this operation held ${what} in memory:`,
  ];
  for (const m of movers) {
    lines.push(`    ${m.what} (${m.ref})  ${short(m.from)} → ${short(m.to)}`);
  }
  lines.push(
    "",
    "  Nothing was written. Writing now would have silently reverted whatever",
    "  landed in that window — a read-modify-write of these files replaces the",
    "  whole file, so there would have been no conflict and no error.",
    "",
    "  Recover:",
    "    1. Let the other session finish. Do not run two of these concurrently —",
    "       CLAUDE.md: agents never commit on the primary VSCode checkout.",
    "    2. Re-read the current state:  git status --short docs/",
    "       (rebase or `git pull --ff-only` first if HEAD is behind)",
    "    3. Re-apply your change on top of it and re-run this command. It is",
    "       idempotent — re-running after a successful run is a no-op.",
    "",
    "  This guard never merges, retries or rebases: a silent fast-forward is the",
    "  bug it exists to catch.",
  );
  return lines.join("\n");
}

/**
 * Re-capture and compare. Call IMMEDIATELY before the write or push — the
 * window this closes is exactly capture→assert, so anything between the assert
 * and the write is still exposed. Returns the fresh state on success.
 *
 * @throws {TrunkMovedError}
 */
export function assertTrunkUnmoved(before, { operation = "write", files = [] } = {}) {
  // The seed only ever applies to the baseline; the re-check always reads real
  // git, so a seeded run compares a fake "before" against the true "after".
  const after = captureTrunkState();
  if (before.seeded) after.seeded = false;
  const { moved, movers } = evaluateTrunkMove(before, after);
  if (!moved) return after;
  const message = formatTrunkMoveMessage({ operation, files, movers });
  throw new TrunkMovedError(message, { before, after, movers, operation, files });
}

/**
 * CLI wrapper: print the abort text to stderr and exit 1. Any other error is
 * re-thrown — a broken guard must not read as a passing one.
 */
export function abortOnTrunkMove(before, opts) {
  try {
    return assertTrunkUnmoved(before, opts);
  } catch (e) {
    if (e instanceof TrunkMovedError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}
