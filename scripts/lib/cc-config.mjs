#!/usr/bin/env node
// scripts/lib/cc-config.mjs
//
// Where CC prompts and reports live (FIX-1175), resolved so it works from the
// primary checkout AND from a `pnpm session:worktree` sibling dir.
//
// ── Why this is not just a relative path ────────────────────────────────────
// Cowork commits prompts to `Civitics/Claude/civitics/cc-prompt-<n>-*.md`, which
// is `../Claude/civitics` from the primary checkout at `Civitics/App`. But
// agents work in `Civitics/civitics-worktrees/fix-<id>`, where the SAME relative
// path resolves to `Civitics/civitics-worktrees/Claude/civitics` — which does
// not exist. `git rev-parse --show-toplevel` is the worktree, so it is the wrong
// anchor.
//
// `git rev-parse --path-format=absolute --git-common-dir` returns the PRIMARY
// repo's `.git` directory from inside a linked worktree as well as from the
// primary checkout (verified on this repo, both ways). Its parent is therefore a
// stable anchor for a path that points OUTSIDE the repo.
//
// Reports are different: they are committed, so they belong to whichever
// worktree is doing the committing and resolve against `--show-toplevel`.
//
// Absolute paths in the config are taken verbatim. The env vars
// CIVITICS_CC_PROMPTS_DIR / CIVITICS_CC_REPORTS_DIR override either.

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";

function git(args) {
  try {
    return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The current worktree's root — where committed files live. */
export function repoRoot() {
  const r = git("rev-parse --show-toplevel");
  if (!r) throw new Error("not inside a git repository");
  return r;
}

/**
 * The PRIMARY checkout's root — the stable anchor for paths outside the repo.
 * Equals repoRoot() when not in a linked worktree.
 */
export function mainCheckoutRoot() {
  const common = git("rev-parse --path-format=absolute --git-common-dir");
  // A bare-ish fallback: older git without --path-format, or an unusual layout.
  if (!common) return repoRoot();
  return dirname(common.replace(/\/$/, ""));
}

// Config locations, first match wins:
//
//   .claude/cc.config.json   machine-local override. NOT tracked — .gitignore
//                            excludes `.claude/*` and negates only agents/,
//                            commands/, hooks/ and settings.local.json.
//   docs/cc/cc.config.json   the versioned default, next to the reports and the
//                            prompt template it governs.
//
// The versioned copy lives under docs/ rather than .claude/ for exactly that
// gitignore reason: a config in .claude/ would exist on one machine only, which
// is the opposite of what a shared convention needs.
const CONFIG_PATHS = [".claude/cc.config.json", "docs/cc/cc.config.json"];

export function loadCcConfig() {
  const root = repoRoot();
  const main = mainCheckoutRoot();
  const path = CONFIG_PATHS.map((p) => resolve(root, p)).find((p) => existsSync(p)) ?? null;
  let cfg = {};
  if (path) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`${path} is not valid JSON: ${e.message}`);
    }
  }
  const promptsRaw = process.env.CIVITICS_CC_PROMPTS_DIR || cfg.promptsDir || "../Claude/civitics";
  const reportsRaw = process.env.CIVITICS_CC_REPORTS_DIR || cfg.reportsDir || "docs/cc/reports";
  return {
    repoRoot: root,
    mainCheckoutRoot: main,
    configPath: path,
    // Prompts live outside the repo → anchor on the primary checkout.
    promptsDir: isAbsolute(promptsRaw) ? promptsRaw : resolve(main, promptsRaw),
    // Reports are committed → anchor on this worktree.
    reportsDir: isAbsolute(reportsRaw) ? reportsRaw : resolve(root, reportsRaw),
  };
}

/**
 * Find the prompt file(s) for a run number. Returns every match, newest mtime
 * first — the caller refuses on zero and decides what to do with more than one.
 */
export function findPromptFiles(n, { promptsDir } = loadCcConfig()) {
  if (!existsSync(promptsDir)) return [];
  const re = new RegExp(`^cc-prompt-0*${Number(n)}-.*\\.md$`, "i");
  return readdirSync(promptsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && re.test(d.name))
    .map((d) => {
      const full = resolve(promptsDir, d.name);
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        /* unreadable — sorts last */
      }
      return { name: d.name, path: full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** The report path for a run number. */
export function reportPath(n, cfg = loadCcConfig()) {
  return resolve(cfg.reportsDir, `cc-${Number(n)}.md`);
}
