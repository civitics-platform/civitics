#!/usr/bin/env node
// scripts/fixes-housekeep.mjs
//
// Assign FIX-NNN IDs to unnumbered bullets in docs/FIXES.md and warn on
// formatting drift. Runs against live sections only — skips STRATEGIC
// PILLARS (non-checkable) and everything under ## COMPLETED (archive).
//
// Next free ID is max(existing IDs in FIXES.md, done.log,
// docs/archive/fixes-archive.md) + 1, so reassignment is impossible even
// after a clean/archive has moved old items out.
//
// Usage:
//   node scripts/fixes-housekeep.mjs            apply in place
//   node scripts/fixes-housekeep.mjs --dry-run  preview, write nothing

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { captureTrunkState, abortOnTrunkMove } from "./lib/trunk-guard.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const DONE_PATH = resolve(REPO_ROOT, "docs/done.log");
const ARCHIVE_PATH = resolve(REPO_ROOT, "docs/archive/fixes-archive.md");

// Concurrent-write guard: snapshot before the read half, re-check before the
// write. See scripts/lib/trunk-guard.mjs.
const TRUNK_BEFORE = captureTrunkState();

const DRY = process.argv.includes("--dry-run");

const PRIORITY_EMOJI = ["🔴", "🟠", "🟡", "🟢", "⬜"];
const COMPLEXITY = new Set(["S", "M", "L", "XL"]);

const BULLET_RE = /^(\s*- \[)([ xX])(\] )(.*)$/;
const ID_RE = /<!--\s*id:\s*(FIX-\d+)\s*-->/;
const SECTION_RE = /^##\s+(.+?)\s*$/;
const STRATEGIC_RE = /^##\s+STRATEGIC PILLARS\b/i;
const COMPLETED_RE = /^##\s+COMPLETED\b/i;

function scanAllIds() {
  const ids = new Set();
  // FIX-361: tolerate CRLF on read. ID scan would still work without
  // normalization (no \n anchors), but kept consistent with sibling scripts.
  const readLf = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  // FIX-368: marker-only on FIXES.md + fixes-archive.md so cross-refs
  // (`[[FIX-NNN]]`) and prose mentions don't consume IDs. done.log has no
  // markers — keep loose there so logged completions whose marker is
  // missing from the live file still block re-allocation. See fix-add.mjs
  // `allocateNextId` for the full rationale.
  const pushMarker = (text) => {
    for (const m of text.matchAll(/<!--id:FIX-(\d+)-->/g)) ids.add(`FIX-${m[1]}`);
  };
  const pushLoose = (text) => {
    for (const m of text.match(/FIX-\d+/g) || []) ids.add(m);
  };
  pushMarker(readLf(FIXES_PATH));
  if (existsSync(DONE_PATH)) pushLoose(readLf(DONE_PATH));
  if (existsSync(ARCHIVE_PATH)) pushMarker(readLf(ARCHIVE_PATH));
  return ids;
}

function nextFreeId(usedIds) {
  let max = 0;
  for (const id of usedIds) {
    const n = parseInt(id.slice(4), 10);
    if (n > max) max = n;
  }
  return (n = max + 1) => `FIX-${String(n).padStart(3, "0")}`;
}

function warnFormat(body) {
  const warnings = [];
  if (!PRIORITY_EMOJI.some((e) => body.includes(e))) {
    warnings.push("missing priority emoji");
  }
  // Complexity token: single capitalised letter between two em-dashes or
  // hyphens before the title. Accept S/M/L/XL. Tolerate em-dash or hyphen.
  const complexityMatch = body.match(/\s(S|M|L|XL)\s+[—-]\s+/);
  if (!complexityMatch) warnings.push("missing/unclear complexity (S/M/L/XL)");
  // Malformed dash: naked " - " where " — " is expected around complexity.
  if (/\s(S|M|L|XL)\s-\s/.test(body)) warnings.push("use em-dash (—) not hyphen");
  return warnings;
}

// ── main ─────────────────────────────────────────────────────────────
// FIX-361: tolerate CRLF on read; writes stay LF via .join("\n") downstream.
const content = readFileSync(FIXES_PATH, "utf8").replace(/\r\n/g, "\n");
const lines = content.split("\n");
const usedIds = scanAllIds();
const genId = nextFreeId(usedIds);
let nextCounter = Math.max(...[...usedIds].map((i) => parseInt(i.slice(4), 10))) + 1;

let currentSection = null;
let skipSection = false;
const assigned = [];
const warnings = [];

const out = lines.map((line, idx) => {
  const sectionMatch = line.match(SECTION_RE);
  if (sectionMatch) {
    currentSection = sectionMatch[1];
    skipSection = STRATEGIC_RE.test(line) || COMPLETED_RE.test(line);
    return line;
  }
  if (skipSection) return line;

  const m = line.match(BULLET_RE);
  if (!m) return line;
  const [, pre, box, mid, rest] = m;

  const warns = warnFormat(rest);
  if (warns.length) {
    warnings.push({
      line: idx + 1,
      section: currentSection,
      issue: warns.join(", "),
      snippet: rest.slice(0, 70),
    });
  }

  if (ID_RE.test(rest)) return line;

  const newId = `FIX-${String(nextCounter++).padStart(3, "0")}`;
  assigned.push({ line: idx + 1, section: currentSection, id: newId, snippet: rest.slice(0, 70) });
  const trimmed = rest.replace(/\s*$/, "");
  return `${pre}${box}${mid}${trimmed} <!--id:${newId}-->`;
});

if (assigned.length && !DRY) {
  abortOnTrunkMove(TRUNK_BEFORE, {
    operation: "fixes:housekeep (assign <!--id:FIX-NNN--> markers)",
    files: ["docs/FIXES.md"],
  });
  writeFileSync(FIXES_PATH, out.join("\n"));
}

console.log("fixes:housekeep —", DRY ? "DRY RUN" : "APPLIED");
console.table({
  idsAssigned: assigned.length,
  formatWarnings: warnings.length,
});

if (assigned.length) {
  console.log("\nIDs assigned:");
  for (const a of assigned) {
    console.log(`  line ${a.line} [${a.section}] → ${a.id}  (${a.snippet}…)`);
  }
}

if (warnings.length) {
  console.log("\nFormat warnings (non-blocking):");
  for (const w of warnings.slice(0, 20)) {
    console.log(`  line ${w.line} [${w.section}] ${w.issue} — "${w.snippet}…"`);
  }
  if (warnings.length > 20) console.log(`  …and ${warnings.length - 20} more`);
}
