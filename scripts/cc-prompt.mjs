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
//                               Plus `when_status` (FIX-1451) when the prompt
//                               has a valid `when:` — whether its condition
//                               holds now. Exit 0 either way.
//   pnpm cc:prompt 172 --start  Step 2: the same, then write
//                               <promptsDir>/cc-172.running before the first
//                               read. Refuses when the check above fails, and
//                               — writing no marker, exit 1 — when
//                               when_status.ready is false (a dep with no
//                               report, an instant still ahead, a window not
//                               open or already closed).
//   pnpm cc:prompt 172 --start --anyway
//                               Craig said run it early: write the marker and
//                               print the reason it was not ready.
//   pnpm cc:prompt 172 --done   Step 4: remove the marker, AFTER the report
//                               commit is pushed. A missing marker is not an
//                               error (a re-run, or it was never written).
//                               First prints the teardown line for the slot
//                               the marker names (cc-190) — it deletes nothing.
//
// A prompt with no front matter (everything before cc-171) is legal: it prints
// `front_matter: null` and a problem line saying so, and exits 0.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFrontMatter } from "./cc-verify.mjs";
import { loadCcConfig, findPromptFiles, runningMarkerPath, projectPath, reportPath } from "./lib/cc-config.mjs";
import { splitFrontMatter, headingTitle, checkPromptFrontMatter, parseWhen, whenStatus } from "./lib/cc-front-matter.mjs";

/**
 * Read one prompt's text into { front_matter, title, abort, problems, when_status? }.
 * Pure — no fs — so the tests drive it with strings. `when_status` is
 * whenStatus() over the prompt's `when:`, absent when it has none or an
 * invalid one (that is a `problems` line); `reportFinishedMs` is the lookup it
 * takes (see whenStatus).
 */
export function readPrompt(text, { n, lanes, projectExists, nowMs = Date.now(), reportFinishedMs } = {}) {
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
  const out = { front_matter: fm, title: headingTitle(text), abort, problems: [...extra, ...problems] };
  const w = parseWhen(fm?.when);
  const status = w.kind === "none" ? null : whenStatus(w, { nowMs, reportFinishedMs });
  if (status) out.when_status = status;
  return out;
}

/** The marker's body — what the board reads back. */
export function markerBody({ n, startedAt, worktree, prompt }) {
  return `${JSON.stringify({ cc: Number(n), started_at: startedAt, worktree, prompt })}\n`;
}

/**
 * Whether `--start` may write the marker (FIX-1451 D4). Pure: the status in,
 * `{ ok, line, marker }` out — `marker` is the body to write, null on a
 * refusal; `line` is what to print (null when there is nothing to say).
 */
export function startDecision({ status, anyway = false, n, startedAt, worktree, prompt }) {
  const body = () => markerBody({ n, startedAt, worktree, prompt });
  if (!status || status.ready) return { ok: true, line: null, marker: body() };
  if (anyway) return { ok: true, line: `cc:prompt — started early (--anyway): ${status.reason}`, marker: body() };
  return { ok: false, line: `cc:prompt — NOT READY: ${status.reason}`, marker: null };
}

/**
 * The report lookup whenStatus takes, for this checkout (D3): the worktree's
 * reportsDir first, else trunk as this clone last fetched it. No fetch here —
 * a report that landed since is one `git fetch` away, and that is the caller's.
 */
export function checkoutReportFinishedMs(cfg) {
  return (n) => {
    let text;
    const local = reportPath(n, cfg);
    if (existsSync(local)) text = readFileSync(local, "utf8");
    else {
      try {
        text = execFileSync("git", ["show", `origin/main:docs/cc/reports/cc-${Number(n)}.md`], {
          cwd: cfg.repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return undefined;
      }
    }
    try {
      const ms = Date.parse(String(parseFrontMatter(text)?.finished_at ?? ""));
      return Number.isNaN(ms) ? null : ms;
    } catch {
      return null;
    }
  };
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
  // Two calls, not `cd … && …`: the shell a command STARTS in keeps its cwd
  // handle (Git-for-Windows' bash.exe launcher), so a same-command cd still
  // EPERMs the teardown. cc-190 measured it on its own tree.
  return `teardown next (two calls; the second must START outside the tree): cd "${main}"   then   pnpm session:worktree:done ${m[1]}`;
}

function main() {
  const argv = process.argv.slice(2);
  const n = argv.find((a) => /^\d+$/.test(a));
  const start = argv.includes("--start");
  const done = argv.includes("--done");
  const anyway = argv.includes("--anyway");
  if (!n || (start && done)) {
    process.stderr.write("Usage: pnpm cc:prompt <n> [--start [--anyway] | --done]\n");
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
    reportFinishedMs: checkoutReportFinishedMs(cfg),
  });
  const out = { path: file.path, name: file.name, front_matter: read.front_matter, title: read.title, problems: read.problems };
  if (read.when_status) out.when_status = read.when_status;
  console.log(JSON.stringify(out, null, 2));
  if (read.abort) {
    process.stderr.write(`cc:prompt — ABORT: ${read.abort}.\n`);
    return 1;
  }

  if (start) {
    const d = startDecision({
      status: read.when_status,
      anyway,
      n,
      startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      worktree: cfg.repoRoot,
      prompt: basename(file.path),
    });
    if (!d.ok) {
      process.stderr.write(`${d.line}\n`);
      return 1;
    }
    if (d.line) console.log(d.line);
    writeFileSync(marker, d.marker, "utf8");
    console.log(`cc:prompt — wrote ${marker}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
