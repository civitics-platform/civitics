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
  const originMainExists = git("rev-parse", "--verify", "--quiet", "origin/main").ok;

  // "merged" = branch is an ancestor of origin/main, i.e. every commit on it has
  // landed, so deleting the branch pointer loses nothing. Drives both the
  // unmerged-work gate and the branch deletion below — which must run even when
  // the dir strands on a lock (the fix for the fix-447 leftover-branch case).
  const merged =
    branchExists && originMainExists
      ? git("merge-base", "--is-ancestor", branch, "origin/main").ok
      : false;

  // Safety block: refuse to tear down unmerged work unless --force.
  if (branchExists && originMainExists && !merged) {
    console.error(`[session:worktree] ✗ ${branch} is NOT an ancestor of origin/main — UNMERGED WORK.`);
    console.error(`[session:worktree]   Land it via the recipe (pnpm session:worktree printed it), or`);
    console.error(`[session:worktree]   pass --force to discard the worktree + local branch anyway.`);
    if (!force) process.exit(1);
    console.warn(`[session:worktree] ⚠ --force given — removing UNMERGED worktree + branch. Work will be lost.`);
  }

  // Set when the dir removal ultimately fails (transient AV/indexer lock on the
  // fresh node_modules). We do NOT die on that: the git side is still cleaned up
  // (merged branch deleted, registry pruned) and we exit non-zero with a clear
  // "re-run later" message rather than half-succeeding silently.
  let dirStranded = false;

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
    // FIX-879: a stranded-then-de-registered ORPHAN. A prior teardown's
    // `git worktree remove` de-registers the tree at the admin level even when the
    // fs.rm below loses to a lock, so a recovery re-run finds the dir on disk but
    // NO longer a registered worktree. `git -C <dir> status` then errors "not a
    // working tree", which the porcelain check must NOT read as a dirty tree —
    // that fail-closed refusal (needing --force) was the FIX-879 gap surfaced by
    // FIX-877's own live teardown test. An orphan has no tracked changes to
    // preserve, and the fs.rm below is still containment-guarded, so treat it as
    // clean-and-removable.
    const isRegistered = git("worktree", "list", "--porcelain")
      .out.split(/\r?\n/)
      .some((line) => {
        const m = line.match(/^worktree (.+)$/);
        return m && resolve(m[1].trim()) === resolve(wtDir);
      });
    const porcelain = git("-C", wtDir, "status", "--porcelain");
    const cleanIgnoringArtifacts = (porcelain.ok && porcelain.out === "") || !isRegistered;
    const forceRemove = force || cleanIgnoringArtifacts;

    if (!forceRemove) {
      console.error(`[session:worktree] ✗ worktree has uncommitted changes (tracked edits or untracked files):`);
      console.error(porcelain.out || "(could not read git status)");
      die(`refusing to remove a dirty worktree. Commit/stash/land it, or pass --force to discard. Worktree left intact: ${wtDir}`);
    }

    // --force is always passed to git here: when porcelain is clean it's the
    // gitignored artifacts that would otherwise block removal; when the caller
    // forced, they've accepted the loss.
    // FIX-879: a de-registered orphan can only ever error "not a working tree"
    // from `git worktree remove` (a permanent failure, not a transient lock), so
    // skip the remove + its backoff entirely and go straight to the contained
    // fs.rm below — avoids ~34s of futile retries on the recovery re-run.
    let rm = isRegistered
      ? git("worktree", "remove", wtDir, "--force")
      : { ok: false, err: "de-registered orphan — skipping git worktree remove" };

    // FIX-480 / FIX-876: on a freshly-built tree, `git worktree remove` loses to
    // a TRANSIENT lock on a just-written node_modules handle — the AV (Defender
    // or a third-party like Bitdefender) and the Windows indexer scanning
    // freshly-hardlinked deps, plus any tsx/esbuild service that has not yet
    // exited. These release within ~a minute. The FIX-480 original retried ONCE
    // after 2s, which was too short: the FIX-841 teardown EPERM'd straight
    // through it and stranded the dir. Retry with a short backoff (≈34s total;
    // each delay is clamped to sleepSync's 10s ceiling) before the heavier fs.rm
    // fallback below. We deliberately do NOT kill esbuild globally here — a
    // parallel session may be mid-build, and esbuild's service exits on its own
    // once its spawning tsx run ends. The durable fix is an AV folder exclusion
    // for ../civitics-worktrees (Bitdefender/Defender); this loop covers the
    // residual indexer window.
    for (const delayMs of [2000, 4000, 8000, 10000, 10000]) {
      if (rm.ok || !isRegistered) break;
      console.warn(
        `[session:worktree] ⚠ git worktree remove failed (${rm.err || "unknown"}); retrying in ${delayMs / 1000}s ...`,
      );
      sleepSync(delayMs);
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
        `[session:worktree] ⚠ ${isRegistered ? "git worktree remove still failing after retry" : "de-registered orphan dir"}; ` +
        `falling back to contained fs.rm of ${wtDir}`,
      );
      let rmFallbackOk = true;
      try {
        rmSync(resolve(wtDir), { recursive: true, force: true });
      } catch (e) {
        // The dir is genuinely locked (AV/indexer/esbuild still holding a handle
        // on the fresh node_modules). Do NOT die here: the git side can still be
        // made clean below (merged-branch deletion + registry prune), and dying
        // now is exactly what stranded fix-447's merged branch. Flag it and carry
        // on; the final message tells the caller to re-run once the lock clears.
        rmFallbackOk = false;
        dirStranded = true;
        console.warn(`[session:worktree] ⚠ fs.rm fallback failed: ${e?.message ?? e}`);
      }
      // Prune the registry regardless: if fs.rm succeeded the entry is now stale;
      // if it failed, git may already have de-registered the tree on the failed
      // `worktree remove`, and prune is a harmless no-op when there's nothing to do.
      const pruned = git("worktree", "prune");
      if (!pruned.ok && pruned.err) {
        console.warn(`[session:worktree] ⚠ git worktree prune reported: ${pruned.err}`);
      }
      if (rmFallbackOk) {
        console.log(
          `[session:worktree] ✓ removed worktree via contained fs.rm + git worktree prune: ${wtDir}`,
        );
      }
    }
  } else {
    console.log(`[session:worktree] (no worktree dir at ${wtDir} — skipping remove)`);
  }

  // Branch deletion runs regardless of the dir outcome above: a branch that is an
  // ancestor of origin/main (merged) is always safe to delete, and the branch
  // pointer — not the disposable build dir — is what pollutes `git branch`.
  // Deleting a MERGED branch even when the dir stranded is the fix for the
  // fix-447 leftover-branch case. Use -D when we've confirmed the branch is
  // landed (a stronger guarantee than -d's local-only "merged into HEAD", which
  // wrongly refuses when the primary checkout's main is behind origin/main).
  if (branchExists) {
    const del = git("branch", merged || force ? "-D" : "-d", branch);
    if (del.ok) {
      console.log(`[session:worktree] ✓ deleted local branch ${branch}`);
    } else if (dirStranded) {
      console.warn(`[session:worktree] ⚠ could not delete local branch ${branch}: ${del.err || del.out}`);
    } else {
      console.error(del.err || del.out);
      die(`could not delete local branch ${branch} (unmerged? pass --force).`);
    }
  }

  // Remote branch deletion is NOT automatic — needs explicit confirmation.
  console.log(
    `[session:worktree] note: the remote branch (if pushed) was left in place.\n` +
    `  To delete it too, run:  git push origin --delete ${branch}`,
  );

  if (dirStranded) {
    const gitSideNote = branchExists
      ? `the merged branch pointer was deleted`
      : `no branch pointer remained`;
    console.error(
      `[session:worktree] ⚠ worktree DIR is LOCKED and was left in place:\n` +
      `    ${wtDir}\n` +
      `  This is a transient AV/indexer lock on the freshly-hardlinked node_modules — it clears within a minute or two.\n` +
      `  The git side is otherwise clean (${gitSideNote}); the leftover dir may still show in \`git worktree list\` until removed.\n` +
      `  To finish teardown once the lock clears, either:\n` +
      `    • re-run  pnpm session:worktree:done ${id}   (fs.rm's the leftover dir + prunes the registry), or\n` +
      `    • delete ${wtDir} by hand, then run  git worktree prune\n` +
      `  (durable fix: keep the AV folder exclusion on ../civitics-worktrees — see FIX-876.)`,
    );
    process.exit(1);
  }

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
