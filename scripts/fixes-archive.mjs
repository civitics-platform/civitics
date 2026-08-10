#!/usr/bin/env node
// scripts/fixes-archive.mjs
//
// Move everything currently under `## COMPLETED` in docs/FIXES.md into
// docs/archive/fixes-archive.md under a dated header, then leave the
// COMPLETED section in FIXES.md empty (header + intro preserved).
//
// Rationale: `fixes:clean` keeps the live file tidy; `fixes:archive`
// keeps `fixes:clean` from growing the live file over time. Run this
// periodically (e.g. once per phase or when COMPLETED gets long).
//
// The archive file is append-only. Each run adds a new `## Archived
// YYYY-MM-DD` block — old blocks are never rewritten.
//
// Usage:
//   node scripts/fixes-archive.mjs            apply in place
//   node scripts/fixes-archive.mjs --dry-run  preview, write nothing

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { captureTrunkState, abortOnTrunkMove } from "./lib/trunk-guard.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const ARCHIVE_PATH = resolve(REPO_ROOT, "docs/archive/fixes-archive.md");

// Concurrent-write guard: snapshot before the read half, re-check before the
// write. See scripts/lib/trunk-guard.mjs.
const TRUNK_BEFORE = captureTrunkState();

const DRY = process.argv.includes("--dry-run");

const SECTION_RE = /^##\s+(.+?)\s*$/;
const COMPLETED_RE = /^##\s+COMPLETED\b/i;
const BULLET_RE = /^(\s*- \[)([ xX])(\] )(.*)$/;

// FIX-361: tolerate CRLF on read; writes stay LF via .join("\n") downstream.
const content = readFileSync(FIXES_PATH, "utf8").replace(/\r\n/g, "\n");
const lines = content.split("\n");

// Split into blocks by ## heading (same parser shape as fixes-clean).
const blocks = [];
let current = { kind: "preamble", headerLine: null, bodyLines: [] };
lines.forEach((line) => {
  const m = line.match(SECTION_RE);
  if (m) {
    blocks.push(current);
    current = { kind: "section", name: m[1], headerLine: line, bodyLines: [] };
  } else {
    current.bodyLines.push(line);
  }
});
blocks.push(current);

const completedIdx = blocks.findIndex(
  (b) => b.kind === "section" && COMPLETED_RE.test(b.headerLine || "")
);
if (completedIdx === -1) {
  console.log("fixes:archive — nothing to do: no ## COMPLETED section in FIXES.md");
  process.exit(0);
}

const completedBlock = blocks[completedIdx];

// Partition COMPLETED bodyLines:
//   - intro lines (before the first ### subsection or bullet) stay in FIXES.md
//   - everything from the first ### or first bullet onwards is archived
const bodyLines = completedBlock.bodyLines;
let cutIdx = -1;
for (let i = 0; i < bodyLines.length; i++) {
  const l = bodyLines[i];
  if (/^###\s+/.test(l) || BULLET_RE.test(l)) {
    cutIdx = i;
    break;
  }
}

if (cutIdx === -1) {
  console.log("fixes:archive — nothing to do: COMPLETED section is already empty");
  process.exit(0);
}

const introLines = bodyLines.slice(0, cutIdx);
const archivedLines = bodyLines.slice(cutIdx);

// Count what we're archiving for the summary.
const bulletCount = archivedLines.filter((l) => BULLET_RE.test(l)).length;
const subsectionCount = archivedLines.filter((l) => /^###\s+/.test(l)).length;

// ── build the dated archive block ────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const archiveHeader = `## Archived ${today}`;
const archiveBody = [archiveHeader, "", ...archivedLines].join("\n").replace(/\n+$/, "") + "\n";

// Prepend to archive file so the newest block is at the top (easiest to scan).
// File preamble (first ##-free prelude) is preserved.
let archiveText;
if (existsSync(ARCHIVE_PATH)) {
  const existing = readFileSync(ARCHIVE_PATH, "utf8");
  // Split existing into preamble (everything before first `## `) and rest.
  const firstHeading = existing.search(/^##\s+/m);
  if (firstHeading === -1) {
    archiveText = existing.replace(/\n+$/, "\n") + "\n" + archiveBody;
  } else {
    const preamble = existing.slice(0, firstHeading).replace(/\n+$/, "\n");
    const rest = existing.slice(firstHeading);
    archiveText = `${preamble}\n${archiveBody}\n${rest}`;
  }
} else {
  archiveText =
    `# FIXES Archive\n\n` +
    `Historical archive of completed FIX-NNN items, moved out of \`docs/FIXES.md\` ` +
    `by \`pnpm fixes:archive\`. Append-only — newest block on top.\n\n` +
    archiveBody;
}

// ── update FIXES.md: keep header + intro, empty out the rest ─────────
const newCompletedBlock = {
  ...completedBlock,
  bodyLines: introLines.length ? introLines : ["", ""],
};

function renderBlock(b) {
  if (b.kind === "preamble") return b.bodyLines.join("\n");
  return [b.headerLine, ...b.bodyLines].join("\n");
}

const newBlocks = blocks.map((b, i) => (i === completedIdx ? newCompletedBlock : b));
const newFixes = newBlocks.map(renderBlock).join("\n").replace(/\n+$/, "\n");

if (!DRY) {
  abortOnTrunkMove(TRUNK_BEFORE, {
    operation: "fixes:archive (move ## COMPLETED into docs/archive/fixes-archive.md)",
    files: ["docs/FIXES.md", "docs/archive/fixes-archive.md"],
  });
  mkdirSync(dirname(ARCHIVE_PATH), { recursive: true });
  writeFileSync(ARCHIVE_PATH, archiveText);
  writeFileSync(FIXES_PATH, newFixes);
}

console.log("fixes:archive —", DRY ? "DRY RUN" : "APPLIED");
console.table({
  bulletsArchived: bulletCount,
  subsectionsArchived: subsectionCount,
  archiveFile: ARCHIVE_PATH.replace(REPO_ROOT, ".").replace(/\\/g, "/"),
  archiveBlockDate: today,
});
