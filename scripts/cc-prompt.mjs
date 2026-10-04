#!/usr/bin/env node
// scripts/cc-prompt.mjs — `pnpm cc:prompt <n> [--start | --done]`
//
// `/cc` Steps 1, 2 and 4 as one command (FIX-1242).
//
//   pnpm cc:prompt 172          Step 1: find cc-prompt-172-*.md, parse its front
//                               matter with THE reader (cc-verify's
//                               parseFrontMatter), check it. Prints JSON:
//                               { path, name, front_matter, title, problems }.
//                               Exit 1 on zero matches, on more than one, or on
//                               a front-matter `cc:` that disagrees with the
//                               filename — the three cases /cc must not guess.
//   pnpm cc:prompt 172 --start  Step 2: the same, then write
//                               <promptsDir>/cc-172.running before the first
//                               read. Refuses when the check above fails.
//   pnpm cc:prompt 172 --done   Step 4: remove the marker, AFTER the report
//                               commit is pushed. A missing marker is not an
//                               error (a re-run, or it was never written).
//                               First prints the teardown line for the slot
//                               the marker names (cc-190) — it deletes nothing.
//
// A prompt with no front matter (everything before cc-171) is legal: it prints
// `front_matter: null` and a problem line saying so, and exits 0.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFrontMatter } from "./cc-verify.mjs";
import { loadCcConfig, findPromptFiles, runningMarkerPath, projectPath } from "./lib/cc-config.mjs";
import { splitFrontMatter, headingTitle, checkPromptFrontMatter } from "./lib/cc-front-matter.mjs";

/**
 * Read one prompt's text into { front_matter, title, abort, problems }.
 * Pure — no fs — so the tests drive it with strings.
 */
export function readPrompt(text, { n, lanes, projectExists } = {}) {
  const { hasFrontMatter } = splitFrontMatter(text);
  let fm = null;
  const extra = [];
  if (hasFrontMatter) {
    try {
      fm = parseFrontMatter(text);
    } catch (e) {
      extra.push(`front matter did not parse: ${e.message}`);
    }
  }
  const { abort, problems } = checkPromptFrontMatter(fm, { n, lanes, projectExists });
  return { front_matter: fm, title: headingTitle(text), abort, problems: [...extra, ...problems] };
}

/** The marker's body — what the board reads back. */
export function markerBody({ n, startedAt, worktree, prompt }) {
  return `${JSON.stringify({ cc: Number(n), started_at: startedAt, worktree, prompt })}\n`;
}

/**
 * What `--done` tells the agent to tear down (cc-190 D5). The marker's
 * `worktree` is the root `--start` ran in; a `pnpm session:worktree` slot is
 * `<…>/civitics-worktrees/fix-<slot>`. Pure — the tests drive it with strings.
 *
 * Returns the line to print. Never deletes: the teardown is
 * `pnpm session:worktree:done`, run from the PRIMARY checkout (Windows will not
 * remove a directory that is the shell's cwd), and that script refuses unmerged
 * work by itself.
 */
export function teardownLine(markerWorktree, mainRoot) {
  const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const wt = norm(markerWorktree);
  const main = norm(mainRoot);
  if (!wt) {
    return "cc:prompt — no worktree recorded in the marker; tear down by name any slot this run created.";
  }
  if (wt.toLowerCase() === main.toLowerCase()) {
    return (
      "cc:prompt — the marker names the primary checkout (--start ran there), so it records no slot; " +
      "tear down by name any slot this run created."
    );
  }
  const m = /\/civitics-worktrees\/fix-([^/]+)$/i.exec(wt);
  if (!m) return `cc:prompt — the marker names ${wt}, which is not a session:worktree slot; leave it to a human.`;
  return `teardown next: cd "${main}" && pnpm session:worktree:done ${m[1]}`;
}

function main() {
  const argv = process.argv.slice(2);
  const n = argv.find((a) => /^\d+$/.test(a));
  const start = argv.includes("--start");
  const done = argv.includes("--done");
  if (!n || (start && done)) {
    process.stderr.write("Usage: pnpm cc:prompt <n> [--start | --done]\n");
    return 1;
  }
  const cfg = loadCcConfig();
  const marker = runningMarkerPath(n, cfg);

  if (done) {
    if (!existsSync(marker)) {
      console.log(`cc:prompt — no marker at ${marker} (nothing to remove).`);
      console.log(teardownLine(null, cfg.mainCheckoutRoot));
      return 0;
    }
    // Print the slot BEFORE the marker goes — once it is gone, so is the record
    // of which tree this run worked in.
    let recorded = null;
    try {
      recorded = JSON.parse(readFileSync(marker, "utf8")).worktree ?? null;
    } catch {
      recorded = null;
    }
    console.log(teardownLine(recorded, cfg.mainCheckoutRoot));
    unlinkSync(marker);
    console.log(`cc:prompt — removed ${marker}.`);
    return 0;
  }

  const files = findPromptFiles(n, cfg);
  if (files.length === 0) {
    process.stderr.write(`No cc-prompt-${n}-*.md in ${cfg.promptsDir}. Check the number, or pass the path directly.\n`);
    return 1;
  }
  if (files.length > 1) {
    process.stderr.write(
      `cc:prompt — ${files.length} prompt files for cc-${n}; which one?\n${files.map((f) => `  ${f.path}`).join("\n")}\n`,
    );
    return 1;
  }
  const file = files[0];
  const read = readPrompt(readFileSync(file.path, "utf8"), {
    n: Number(n),
    lanes: cfg.lanes,
    projectExists: (slug) => existsSync(projectPath(slug, cfg)),
  });
  console.log(
    JSON.stringify({ path: file.path, name: file.name, front_matter: read.front_matter, title: read.title, problems: read.problems }, null, 2),
  );
  if (read.abort) {
    process.stderr.write(`cc:prompt — ABORT: ${read.abort}.\n`);
    return 1;
  }

  if (start) {
    const body = markerBody({
      n,
      startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      worktree: cfg.repoRoot,
      prompt: basename(file.path),
    });
    writeFileSync(marker, body, "utf8");
    console.log(`cc:prompt — wrote ${marker}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
