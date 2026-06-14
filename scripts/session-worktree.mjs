#!/usr/bin/env node
// scripts/session-worktree.mjs — per-FIX git worktree lifecycle.
//
//   pnpm session:worktree <fix-id>               → create + `pnpm install` (default)
//   pnpm session:worktree <fix-id> --no-install  → create, skip the install
//   pnpm session:worktree:done <fix-id>          → teardown (this file, subcommand "done")
//
// WHY (the model these enforce — see CLAUDE.md "Parallel sessions"):
// VSCode is always open on the primary checkout, so any agent committing there
// contends with VSCode's git extension on one `.git` (stale index.lock,
// corrupted config, the FIX-461 stranded-PR class). So: the primary checkout
// stays parked on `main` as the human view and agents NEVER commit in it. Each
// FIX an agent works gets its OWN added worktree on its OWN branch, named for
// the FIX — the FIX id is the unique slot, so two parallel sessions need zero
// coordination. `main` only advances by fast-forward from a rebased branch.
//
// The worktree lives in a SIBLING dir OUTSIDE the repo
// (../civitics-worktrees/fix-<id>) so VSCode/git never track it as files.
// A fresh worktree has neither `.env.local` (gitignored), so create seeds both
// to LOCAL Docker — a fresh worktree must never silently inherit prod.
//
// Dependency-free Node, shell-agnostic (PowerShell / Git Bash / CI alike).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// Dependency-free synchronous sleep (the teardown path below is sync). Atomics
// blocks the thread without a busy-spin; ms is clamped to a sane ceiling.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 10000));
}

// FIX-480 containment guard: the fs.rm fallback in done() must only ever delete
// a path STRICTLY inside the sibling civitics-worktrees dir. path.relative gives
// us real path resolution (unlike a Bash string-prefix rule, which a `../` in
// the suffix can escape): a contained target yields a relative path that is
// non-empty, does not climb out with "..", and isn't absolute (a different
// Windows drive resolves to an absolute relative). Exported for unit testing.
export function isContainedWorktreePath(wtDir, root) {
  const base = resolve(root, "..", "civitics-worktrees");
  const rel = relative(base, resolve(wtDir));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

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
const git = (...args) => run("git", args);

function die(msg) {
  console.error(`[session:worktree] ✗ ${msg}`);
  process.exit(1);
}

// fix-id → canonical token. Accept "FIX-123", "fix-123", "123", "FIX-123abc".
function normalizeId(raw) {
  if (!raw) die("missing <fix-id> argument (e.g. FIX-123 or 123)");
  const token = String(raw)
    .trim()
    .replace(/^fix[-_]?/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (!token) die(`could not parse a fix id from "${raw}"`);
  return token; // e.g. "123"
}

function repoRoot() {
  const r = git("rev-parse", "--show-toplevel");
  if (!r.ok) die("not inside a git repository");
  return r.out;
}

function readEnvUrl(file) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^NEXT_PUBLIC_SUPABASE_URL=(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}

// ── create ────────────────────────────────────────────────────────────────
function create(rawId, argv = []) {
  const install = !argv.includes("--no-install");
  const id = normalizeId(rawId);
  const root = repoRoot();
  const branch = `feature/fix-${id}`;
  const wtDir = resolve(root, "..", "civitics-worktrees", `fix-${id}`);

  if (existsSync(wtDir)) die(`worktree dir already exists: ${wtDir}`);
  if (git("rev-parse", "--verify", "--quiet", branch).ok) {
    die(`branch ${branch} already exists — pick a fresh fix id or clean it up first.`);
  }

  console.log(`[session:worktree] fetching origin ...`);
  if (!git("fetch", "origin", "--quiet").ok) {
    console.warn("[session:worktree] ⚠ git fetch failed — branching off possibly-stale origin/main.");
  }
  const base = git("rev-parse", "--verify", "--quiet", "origin/main").ok ? "origin/main" : "main";

  console.log(`[session:worktree] git worktree add -b ${branch} ${wtDir} ${base}`);
  const add = git("worktree", "add", "-b", branch, wtDir, base);
  if (!add.ok) {
    if (add.out) console.log(add.out);
    if (add.err) console.error(add.err);
    die(`git worktree add failed.`);
  }

  // Seed both .env.local files to LOCAL Docker (both are gitignored → absent in
  // a fresh worktree). Source: the primary checkout's .env.local.dev template.
  const tmpl = join(root, ".env.local.dev");
  const seeds = [
    join(wtDir, ".env.local"),
    join(wtDir, "apps", "civitics", ".env.local"),
  ];
  if (!existsSync(tmpl)) {
    console.warn(`[session:worktree] ⚠ ${tmpl} not found — could not seed .env.local. Seed it manually to LOCAL before any data run.`);
  } else {
    const body = readFileSync(tmpl, "utf8");
    for (const dest of seeds) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body);
      const url = readEnvUrl(dest) || "(NEXT_PUBLIC_SUPABASE_URL not found)";
      console.log(`[session:worktree] seeded ${dest}`);
      console.log(`[session:worktree]   NEXT_PUBLIC_SUPABASE_URL=${url}`);
    }
    console.log("[session:worktree] ✓ both .env.local seeded to LOCAL Docker. Confirm the URL above before any pipeline/data run.");
  }

  // Dependency install runs by DEFAULT (pass --no-install to skip). pnpm's
  // shared content-addressed store hardlinks into the fresh worktree, so this is
  // ~40s, not a cold install. Without it the worktree has no node_modules and
  // tsx/pnpm build fail until the caller installs by hand — and a by-hand
  // `pnpm install` is denied to agents (settings.local.json), so default-on is
  // what makes a fresh worktree usable out of the box.
  //
  // --frozen-lockfile is the load-bearing guardrail: it makes the install
  // provably unable to add a package or mutate pnpm-lock.yaml — new third-party
  // code can still only enter via `pnpm add` / `npm i` / `yarn add`, which stay
  // denied. --prefer-offline leans on the shared store to keep it fast.
  if (install) {
    console.log(`\n[session:worktree] installing deps — 'pnpm install --frozen-lockfile' in ${wtDir} (~40s, shared-store hardlinks; --no-install to skip) ...`);
    const res = run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: wtDir, stdio: "inherit" });
    if (res.ok) {
      console.log(`[session:worktree] ✓ pnpm install complete — worktree is buildable.`);
    } else {
      const outdatedLockfile =
        /ERR_PNPM_OUTDATED_LOCKFILE/i.test(res.err) || /lockfile.*(out of date|outdated)/i.test(res.err);
      if (outdatedLockfile) {
        console.warn(
          `[session:worktree] ⚠ pnpm install --frozen-lockfile failed: pnpm-lock.yaml is OUT OF SYNC ` +
          `with the package manifests (ERR_PNPM_OUTDATED_LOCKFILE). NOT retrying without --frozen-lockfile — ` +
          `a drifted lockfile is worth knowing about. Fix the lockfile on main (an unfrozen 'pnpm install' there, ` +
          `committed), then re-run; or run 'pnpm -C ${wtDir} install --frozen-lockfile' by hand once it's in sync.`,
        );
      } else {
        console.warn(
          `[session:worktree] ⚠ pnpm install failed (${res.err || "see output above"}). ` +
          `Worktree is created; run 'pnpm -C ${wtDir} install --frozen-lockfile' by hand before building.`,
        );
      }
    }
  }

  console.log(`\n[session:worktree] ✓ worktree ready at ${wtDir} on ${branch}`);
  console.log(landingRecipe(id, install));
}

function landingRecipe(id, installed = false) {
  const wt = `../civitics-worktrees/fix-${id}`;
  return [
    "",
    "── Landing recipe (run from INSIDE the worktree) ─────────────────────",
    `  cd ${wt}`,
    ...(installed
      ? []
      : [`  pnpm install --frozen-lockfile          # deps skipped via --no-install; install runs by default at create time`]),
    "  git fetch origin",
    "  git rebase origin/main                  # replay on latest main, resolve here in isolation",
    "  pnpm build && pnpm typecheck && pnpm lint   # verify ON the branch, still isolated",
    `  git push origin feature/fix-${id}:main  # ff main on the remote (rejected if someone landed first → rebase & retry)`,
    "  git fetch origin && git rebase origin/main",
    "  pnpm fixes:sync                         # POST-merge ONLY — edits FIXES.md/done.log",
    `  git commit -am "chore(fixes): sync after FIX-${id}" && git push origin HEAD:main`,
    `  pnpm session:worktree:done ${id}        # teardown (blocks if somehow unmerged)`,
    "",
    "Migrations from a worktree apply to the SHARED local Docker DB — point the CLI at",
    `the worktree's migration dir explicitly (cd is not required):`,
    `  supabase --workdir ${wt} migration up --local`,
    "",
    "The primary VSCode checkout just runs `git pull --ff-only` to catch up — it never commits.",
    "(Assumes `main` is push-able. If branch protection is later enabled, the `:main`",
    " push becomes a PR-merge step.)",
  ].join("\n");
}

// ── done ────────────────────────────────────────────────────────────────────
function done(rawId, argv) {
  const force = argv.includes("--force");
  const id = normalizeId(rawId);
  const root = repoRoot();
  const branch = `feature/fix-${id}`;
  const wtDir = resolve(root, "..", "civitics-worktrees", `fix-${id}`);

  console.log(`[session:worktree] fetching origin ...`);
  git("fetch", "origin", "--quiet");

  const branchExists = git("rev-parse", "--verify", "--quiet", branch).ok;

  // Safety block: refuse to tear down unmerged work unless --force.
  if (branchExists && git("rev-parse", "--verify", "--quiet", "origin/main").ok) {
    const merged = git("merge-base", "--is-ancestor", branch, "origin/main").ok;
    if (!merged) {
      console.error(`[session:worktree] ✗ ${branch} is NOT an ancestor of origin/main — UNMERGED WORK.`);
      console.error(`[session:worktree]   Land it via the recipe (pnpm session:worktree printed it), or`);
      console.error(`[session:worktree]   pass --force to discard the worktree + local branch anyway.`);
      if (!force) process.exit(1);
      console.warn(`[session:worktree] ⚠ --force given — removing UNMERGED worktree + branch. Work will be lost.`);
    }
  }

  if (existsSync(wtDir)) {
    // `git worktree remove` refuses a tree with ANY local changes without
    // --force — but a *built* worktree is always "dirty" with gitignored
    // artifacts (node_modules, .next, the seeded .env.local copies), so the
    // bare merged-but-built case used to die half-done (FIX-I). Split the two
    // meanings of force: `git status --porcelain` ignores gitignored files, so
    // an EMPTY porcelain means nothing removable is unique to this tree (only
    // disposable ignored artifacts remain) → safe to force automatically. A
    // NON-empty porcelain means real tracked edits or untracked files → refuse
    // unless the caller passed --force (the unmerged-work gate above is
    // separate and untouched).
    const porcelain = git("-C", wtDir, "status", "--porcelain");
    const cleanIgnoringArtifacts = porcelain.ok && porcelain.out === "";
    const forceRemove = force || cleanIgnoringArtifacts;

    if (!forceRemove) {
      console.error(`[session:worktree] ✗ worktree has uncommitted changes (tracked edits or untracked files):`);
      console.error(porcelain.out || "(could not read git status)");
      die(`refusing to remove a dirty worktree. Commit/stash/land it, or pass --force to discard. Worktree left intact: ${wtDir}`);
    }

    // --force is always passed to git here: when porcelain is clean it's the
    // gitignored artifacts that would otherwise block removal; when the caller
    // forced, they've accepted the loss.
    let rm = git("worktree", "remove", wtDir, "--force");

    // FIX-480: on a freshly-built tree, `git worktree remove` can lose to a
    // transient lock on a just-written node_modules handle (Windows AV/indexer
    // still holding it) — the Wave-477 failure looked exactly like this. Retry
    // once after a short pause before reaching for the heavier fallback.
    if (!rm.ok) {
      console.warn(
        `[session:worktree] ⚠ git worktree remove failed (${rm.err || "unknown"}); retrying once in 2s ...`,
      );
      sleepSync(2000);
      rm = git("worktree", "remove", wtDir, "--force");
    }

    if (rm.ok) {
      const autoForced = cleanIgnoringArtifacts && !force;
      console.log(
        `[session:worktree] ✓ removed worktree ${wtDir}` +
        (autoForced ? ` (auto-forced: only ignored build artifacts present)` : ``),
      );
    } else {
      // Still failing → in-process recursive delete, HARD-guarded by the
      // containment check. The settings deny-list keeps Bash(rm -rf*) (deny
      // beats allow, and a string-prefix Bash rule can be escaped by a ../ in
      // the suffix); fs.rm with real path resolution under the already-approved
      // pnpm command cannot. Refuse and die if wtDir is not strictly inside the
      // civitics-worktrees sibling dir.
      if (!isContainedWorktreePath(wtDir, root)) {
        if (rm.err) console.error(rm.err);
        die(
          `git worktree remove failed AND ${resolve(wtDir)} is not strictly inside ` +
          `${resolve(root, "..", "civitics-worktrees")} — refusing fs.rm fallback. ` +
          `Worktree left intact.`,
        );
      }
      console.warn(
        `[session:worktree] ⚠ git worktree remove still failing after retry; ` +
        `falling back to contained fs.rm of ${wtDir}`,
      );
      try {
        rmSync(resolve(wtDir), { recursive: true, force: true });
      } catch (e) {
        die(`fs.rm fallback failed: ${e?.message ?? e}. Worktree left intact: ${wtDir}`);
      }
      // git's worktree registry still lists the (now-deleted) entry → prune it
      // so `git worktree list` and a future create on the same slot stay clean.
      const pruned = git("worktree", "prune");
      if (!pruned.ok && pruned.err) {
        console.warn(`[session:worktree] ⚠ git worktree prune reported: ${pruned.err}`);
      }
      console.log(
        `[session:worktree] ✓ removed worktree via contained fs.rm + git worktree prune: ${wtDir}`,
      );
    }
  } else {
    console.log(`[session:worktree] (no worktree dir at ${wtDir} — skipping remove)`);
  }

  if (branchExists) {
    const del = git("branch", force ? "-D" : "-d", branch);
    if (!del.ok) {
      console.error(del.err || del.out);
      die(`could not delete local branch ${branch} (unmerged? pass --force).`);
    }
    console.log(`[session:worktree] ✓ deleted local branch ${branch}`);
  }

  // Remote branch deletion is NOT automatic — needs explicit confirmation.
  console.log(
    `[session:worktree] note: the remote branch (if pushed) was left in place.\n` +
    `  To delete it too, run:  git push origin --delete ${branch}`,
  );
  console.log(`[session:worktree] ✓ teardown complete for FIX-${id}.`);
}

// ── dispatch ────────────────────────────────────────────────────────────────
// Only dispatch when run directly (so importing this module for unit tests
// doesn't trigger the CLI). Mirrors the main-guard in scripts/fixes-sync.mjs.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const [sub, rawId, ...rest] = process.argv.slice(2);
  if (sub === "create") {
    create(rawId, rest);
  } else if (sub === "done") {
    done(rawId, rest);
  } else {
    console.error("Usage:");
    console.error("  pnpm session:worktree <fix-id> [--no-install]  # create a per-FIX worktree (installs deps by default)");
    console.error("  pnpm session:worktree:done <fix-id>    # tear it down (--force to override safety)");
    process.exit(1);
  }
}
