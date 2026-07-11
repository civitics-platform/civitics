#!/usr/bin/env node
// scripts/session-check.mjs — read-only start-of-session reconciliation.
//
// Run FIRST each session (`pnpm session:check`), before `pnpm fixes:sync`.
// Changes NOTHING — it only fetches and reports. Its job is to surface
// stranded work in the first seconds of a session: the failure mode that let
// a PR sit unmerged while `fixes:sync` recorded its FIXes as shipped (FIX-461),
// and any stray worktree/branch left by a parallel session.
//
// Reports:
//   1. main vs origin/main ahead/behind (after a quiet `git fetch origin`)
//   2. every worktree and the branch it is on
//   3. branches not yet merged into origin/main  ← the stranded-work signal
//   4. open PRs via `gh` (degrades gracefully if gh is absent/unauthenticated)
//   5. latest tests.yml run on main  ← the red-CI signal (FIX-794)
//   6. supabase CLI version vs the pinned sentinel (FIX-530)
//   7. `pnpm fixes:check` result
//   8. an OK / ⚠ ATTENTION summary so strays are obvious at a glance
//
// Matches the dependency-free `scripts/*.mjs` Node convention so it runs the
// same in PowerShell, Git Bash, and CI.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const attention = [];

// Run a command, capture stdout/stderr, never throw. Returns { ok, out, err }.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    // git is a real .exe (no shell needed); pnpm/gh are .cmd shims that do.
    // Scoping shell to non-git avoids Node's DEP0190 warning on every git call.
    shell: process.platform === "win32" && cmd !== "git",
    ...opts,
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    out: (res.stdout || "").trim(),
    err: (res.stderr || "").trim(),
    launchFailed: Boolean(res.error),
  };
}

function git(...args) {
  return run("git", args);
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 56 - title.length))}`);
}

// ── 1. fetch + ahead/behind ──────────────────────────────────────────────
section("Fetch + main vs origin/main");
const fetched = git("fetch", "origin", "--quiet");
if (!fetched.ok) {
  console.log("⚠ git fetch origin failed — reporting against possibly-stale refs.");
  if (fetched.err) console.log(`  ${fetched.err.split("\n")[0]}`);
  attention.push("git fetch failed (offline or auth?) — ahead/behind may be stale");
}

const hasOriginMain = git("rev-parse", "--verify", "--quiet", "origin/main").ok;
if (!hasOriginMain) {
  console.log("⚠ origin/main not found — cannot compute ahead/behind.");
  attention.push("origin/main missing");
} else {
  const counts = git("rev-list", "--left-right", "--count", "origin/main...HEAD");
  if (counts.ok) {
    const [behind, ahead] = counts.out.split(/\s+/).map((n) => parseInt(n, 10));
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").out;
    console.log(`HEAD (${branch}): ${ahead} ahead, ${behind} behind origin/main`);
    if (ahead > 0) attention.push(`local HEAD is ${ahead} commit(s) ahead of origin/main (unpushed)`);
    if (behind > 0) console.log(`  → 'git pull --ff-only' to catch up.`);
  }
}

// ── 2. worktrees ─────────────────────────────────────────────────────────
section("Worktrees");
const wt = git("worktree", "list");
console.log(wt.out || "(none)");
const wtLines = wt.out.split("\n").filter(Boolean);
if (wtLines.length > 1) {
  console.log(`  → ${wtLines.length - 1} added worktree(s) beyond the primary checkout.`);
}

// ── 3. unmerged branches (the stranded-work signal) ──────────────────────
section("Branches NOT merged into origin/main");
if (hasOriginMain) {
  const nm = git("branch", "-a", "--no-merged", "origin/main");
  const branches = nm.out
    .split("\n")
    .map((l) => l.replace(/^[*+]?\s*/, "").trim())
    .filter(Boolean)
    .filter((b) => !/\/?main$/.test(b) && !/\bHEAD\b/.test(b) && !b.includes("-> "));
  if (branches.length === 0) {
    console.log("(none — all branches merged)");
  } else {
    for (const b of branches) console.log(`  • ${b}`);
    attention.push(`${branches.length} branch(es) not merged into origin/main — stranded work?`);
  }
} else {
  console.log("(skipped — origin/main missing)");
}

// ── 4. open PRs ──────────────────────────────────────────────────────────
section("Open PRs (gh)");
const ghVersion = run("gh", ["--version"]);
if (ghVersion.launchFailed || !ghVersion.ok) {
  console.log("(gh not available — skipping PR check)");
} else {
  const prs = run("gh", ["pr", "list", "--state", "open"]);
  if (!prs.ok) {
    console.log("(gh present but `gh pr list` failed — not authenticated or no remote?)");
    if (prs.err) console.log(`  ${prs.err.split("\n")[0]}`);
  } else if (!prs.out) {
    console.log("(no open PRs)");
  } else {
    console.log(prs.out);
    attention.push(`open PR(s) exist — confirm none are stranded vs done.log`);
  }
}

// ── 5. latest tests.yml run on main (FIX-794) ────────────────────────────
// The FIX-793 typecheck breakage sat red on main for 3 runs (~21h): the gate
// fired correctly but nothing pulls CI status into the session loop (no
// branch protection, no failure notifications). WARN only, never block;
// degrades silently when gh is absent/unauthenticated.
section("Latest tests.yml run on main (FIX-794)");
if (ghVersion.launchFailed || !ghVersion.ok) {
  console.log("(gh not available — skipping CI check)");
} else {
  const ci = run("gh", [
    "run", "list", "--workflow", "tests.yml", "--branch", "main", "--limit", "1",
    "--json", "status,conclusion,displayTitle,headSha,url",
  ]);
  let latestRun = null;
  let probeOk = ci.ok;
  if (ci.ok) {
    try {
      latestRun = JSON.parse(ci.out)[0] ?? null;
    } catch {
      probeOk = false;
    }
  }
  if (!probeOk) {
    console.log("(gh present but `gh run list` failed — not authenticated or no remote?)");
    if (ci.err) console.log(`  ${ci.err.split("\n")[0]}`);
  } else if (!latestRun) {
    console.log("(no tests.yml runs found on main)");
  } else {
    const sha = (latestRun.headSha || "").slice(0, 8);
    const title = latestRun.displayTitle || "(untitled)";
    if (latestRun.status !== "completed") {
      console.log(`… ${latestRun.status} — ${sha} ${title}`);
      console.log(`  ${latestRun.url}`);
    } else if (latestRun.conclusion === "success") {
      console.log(`✓ success — ${sha} ${title}`);
    } else {
      console.log(`⚠ ${latestRun.conclusion} — ${sha} ${title}`);
      console.log(`  ${latestRun.url}`);
      attention.push(
        `latest tests.yml run on main is ${latestRun.conclusion} — fix CI before riding new work on it`,
      );
    }
  }
}

// ── 6. supabase CLI version vs pinned sentinel (FIX-530) ─────────────────
// The active CLI is a standalone exe (manual install — never self-updates);
// the sentinel at supabase/.cli-version is the project's expected version. A
// silent CLI bump once shipped a bundled PG17 image against a PG15 volume and
// crash-looped local (multi-hour recovery, 2026-06-08). WARN only, never block.
section("Supabase CLI version (FIX-530 sentinel)");
let pinnedCli = null;
try {
  pinnedCli = readFileSync(new URL("../supabase/.cli-version", import.meta.url), "utf8").trim();
} catch {
  /* sentinel absent — skip below */
}
if (!pinnedCli) {
  console.log("(supabase/.cli-version sentinel missing — skipping)");
} else {
  const ver = run("supabase", ["--version"]);
  // First semver-looking line; the CLI appends an update-nag line on stderr.
  const installedCli = (ver.out + "\n" + ver.err)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^\d+\.\d+\.\d+$/.test(l));
  if (ver.launchFailed || !installedCli) {
    console.log("(supabase CLI not found on PATH — skipping)");
  } else if (installedCli === pinnedCli) {
    console.log(`✓ supabase CLI ${installedCli} matches pinned ${pinnedCli}`);
  } else {
    console.log(`⚠ supabase CLI ${installedCli} ≠ pinned ${pinnedCli} (supabase/.cli-version)`);
    console.log("  → intentional upgrade? Check bundled PG image major vs config.toml");
    console.log("    major_version FIRST, then update the sentinel + root devDependency.");
    attention.push(`supabase CLI ${installedCli} ≠ pinned ${pinnedCli} — see supabase/.cli-version`);
  }
}

// ── 7. fixes:check ───────────────────────────────────────────────────────
section("fixes:check");
const fc = run("pnpm", ["fixes:check"]);
if (fc.out) console.log(fc.out);
if (fc.err) console.log(fc.err);
if (!fc.ok) attention.push("pnpm fixes:check FAILED — FIXES.md/done.log out of sync with trailers");

// ── 8. summary ───────────────────────────────────────────────────────────
section("Summary");
if (attention.length === 0) {
  console.log("✓ OK — tree is tidy. No stranded work detected.");
  process.exit(0);
} else {
  console.log("⚠ ATTENTION:");
  for (const a of attention) console.log(`  • ${a}`);
  // Read-only diagnostic: exit 0 so it never blocks a session; the ⚠ banner is
  // the signal. (The pre-push hook is the hard gate.)
  process.exit(0);
}
