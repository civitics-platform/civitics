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
//
// FIX-1242 adds `lanes` (the five lanes a prompt or report may name) and
// `boardDir` (where `pnpm board` writes board.json + index.html). boardDir is
// OUTSIDE the repo like promptsDir, so it takes the same primary-checkout
// anchor; CIVITICS_CC_BOARD_DIR overrides it. FIX-1243 adds `sectionLanes`,
// the FIXES.md section → lane map for bullets with no lane marker.

import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { DEFAULT_LANES } from "./cc-front-matter.mjs";

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
  const boardRaw = process.env.CIVITICS_CC_BOARD_DIR || cfg.boardDir || "../Claude/civitics/board";
  const lanes =
    Array.isArray(cfg.lanes) && cfg.lanes.length && cfg.lanes.every((l) => typeof l === "string" && l)
      ? cfg.lanes
      : DEFAULT_LANES;
  // FIX-1243: `## ` header text → lane, for bullets with no lane marker. Only
  // string values survive; a value outside lanes ∪ {bugs} is kept (the board
  // shows it as its own row) — correcting the config is a human's call.
  const sectionLanes = {};
  if (cfg.sectionLanes && typeof cfg.sectionLanes === "object" && !Array.isArray(cfg.sectionLanes)) {
    for (const [k, v] of Object.entries(cfg.sectionLanes)) if (typeof v === "string" && v) sectionLanes[k] = v;
  }
  return {
    repoRoot: root,
    mainCheckoutRoot: main,
    configPath: path,
    // Prompts live outside the repo → anchor on the primary checkout.
    promptsDir: isAbsolute(promptsRaw) ? promptsRaw : resolve(main, promptsRaw),
    // Reports are committed → anchor on this worktree.
    reportsDir: isAbsolute(reportsRaw) ? reportsRaw : resolve(root, reportsRaw),
    // The board is written outside the repo too → the same anchor as prompts.
    boardDir: isAbsolute(boardRaw) ? boardRaw : resolve(main, boardRaw),
    // Plan files are committed → this worktree.
    projectsDir: resolve(root, "docs/cc/projects"),
    lanes,
    sectionLanes,
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

/**
 * Every numbered prompt in promptsDir — `cc-prompt-<n>-*.md` — sorted by
 * number, then name. Name order, not mtime, breaks a tie: the board's output
 * must be a function of the tree, and mtimes are not part of it.
 */
export function listPromptFiles({ promptsDir } = loadCcConfig()) {
  if (!existsSync(promptsDir)) return [];
  const re = /^cc-prompt-0*(\d+)-.*\.md$/i;
  return readdirSync(promptsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && re.test(d.name))
    .map((d) => ({ n: Number(re.exec(d.name)[1]), name: d.name, path: resolve(promptsDir, d.name) }))
    .sort((a, b) => a.n - b.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * `<promptsDir>/cc-<n>.running` — written by `/cc` Step 2 before the first
 * read, removed by Step 4 after the report commit is pushed (FIX-1242). A crash
 * leaves it behind; the board renders one older than 24 h as `running · stale?`.
 */
export function runningMarkerPath(n, { promptsDir } = loadCcConfig()) {
  return resolve(promptsDir, `cc-${Number(n)}.running`);
}

/** A plan file's path. The slug is validated by the caller (SLUG_RE). */
export function projectPath(slug, { projectsDir } = loadCcConfig()) {
  return resolve(projectsDir, `${slug}.md`);
}

/** The report path for a run number. */
export function reportPath(n, cfg = loadCcConfig()) {
  return resolve(cfg.reportsDir, `cc-${Number(n)}.md`);
}

/**
 * The .json sidecar beside a report — the report's front matter, generated from
 * the .md by `pnpm cc:json <n>` so a consumer can read a run's claims without
 * staging the whole report or re-implementing the YAML subset.
 *
 * Takes either a run number or a path to the .md, so callers that already hold
 * one (cc-verify's `--file`) need no second config lookup.
 */
export function reportJsonPath(nOrMdPath, cfg) {
  if (typeof nOrMdPath === "string" && /\.md$/i.test(nOrMdPath)) {
    return nOrMdPath.replace(/\.md$/i, ".json");
  }
  return reportPath(nOrMdPath, cfg ?? loadCcConfig()).replace(/\.md$/i, ".json");
}
