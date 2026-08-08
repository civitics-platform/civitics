#!/usr/bin/env node
// scripts/fixes-clean.mjs
//
// Move completed ([x]) bullets out of live sections in docs/FIXES.md
// and into `## COMPLETED` at the bottom, grouped by origin section as
// `### SECTION NAME` subsections. Live section headers and `---`
// separators are preserved even when the section becomes empty.
//
// Guardrails:
//   - Before moving anything, run a sync check against done.log. If any
//     [x] bullet lacks a matching completion record, we refuse to move
//     it (pass --force to override).
//   - The STRATEGIC PILLARS section and the existing `## COMPLETED`
//     block are never touched as sources (PILLARS is non-checkable;
//     COMPLETED is the destination).
//   - Writes produce a single well-shaped commit when you run them —
//     commit immediately so any VS Code editor collision is resolvable
//     from git.
//
// Usage:
//   node scripts/fixes-clean.mjs            apply in place
//   node scripts/fixes-clean.mjs --dry-run  preview, write nothing
//   node scripts/fixes-clean.mjs --force    skip done.log consistency check

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const DONE_PATH = resolve(REPO_ROOT, "docs/done.log");

const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

const BULLET_RE = /^(\s*- \[)([ xX])(\] )(.*)$/;
const ID_RE = /<!--\s*id:\s*(FIX-\d+)\s*-->/;
const SECTION_RE = /^##\s+(.+?)\s*$/;
const STRATEGIC_RE = /^##\s+STRATEGIC PILLARS\b/i;
const COMPLETED_RE = /^##\s+COMPLETED\b/i;

function loadCompletedFromDoneLog() {
  // Per-ID last-write-wins: walking lines in chronological (append) order, a
  // `reopen` line clears the completed status, and any subsequent non-reopen
  // line restores it. Earlier code had `else if (!reopened.has(id))` which
  // permanently disqualified an ID once reopened — that broke FIX-041/042
  // which were reopened then re-completed.
  const completed = new Set();
  if (!existsSync(DONE_PATH)) return completed;
  // FIX-361: tolerate CRLF on files saved by a misconfigured editor.
  const text = readFileSync(DONE_PATH, "utf8").replace(/\r\n/g, "\n");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;
    const [, id, sha] = parts;
    if (sha === "reopen") {
      completed.delete(id);
    } else {
      completed.add(id);
    }
  }
  return completed;
}

// ── parse FIXES.md into structured blocks ────────────────────────────
// FIX-361: tolerate CRLF on read; writes stay LF via .join("\n") downstream.
const content = readFileSync(FIXES_PATH, "utf8").replace(/\r\n/g, "\n");
const lines = content.split("\n");

// Blocks: { kind: 'preamble' | 'section', name?, headerIdx, bodyLines[] }
const blocks = [];
let currentBlock = { kind: "preamble", headerIdx: -1, bodyLines: [] };
lines.forEach((line, idx) => {
  const m = line.match(SECTION_RE);
  if (m) {
    blocks.push(currentBlock);
    currentBlock = { kind: "section", name: m[1], headerLine: line, headerIdx: idx, bodyLines: [] };
  } else {
    currentBlock.bodyLines.push(line);
  }
});
blocks.push(currentBlock);

// Identify the COMPLETED destination block (create one if absent).
const completedIdx = blocks.findIndex((b) => b.kind === "section" && COMPLETED_RE.test(b.headerLine || ""));
const hasCompleted = completedIdx !== -1;

// ── collect completed bullets from live sections ─────────────────────
const doneLogCompleted = loadCompletedFromDoneLog();
const moved = []; // { section, bullet }
const missingTrailer = []; // [x] in FIXES but not in done.log
const cleanedBlocks = blocks.map((b, i) => {
  if (b.kind !== "section") return b;
  if (STRATEGIC_RE.test(b.headerLine)) return b;
  if (COMPLETED_RE.test(b.headerLine)) return b;

  const kept = [];
  for (const line of b.bodyLines) {
    const bm = line.match(BULLET_RE);
    if (!bm) {
      kept.push(line);
      continue;
    }
    const [, , box, , rest] = bm;
    if (box.toLowerCase() !== "x") {
      kept.push(line);
      continue;
    }
    const idMatch = rest.match(ID_RE);
    const id = idMatch ? idMatch[1] : null;
    if (id && !doneLogCompleted.has(id) && !FORCE) {
      missingTrailer.push({ section: b.name, id, snippet: rest.slice(0, 70) });
      kept.push(line); // don't move it
      continue;
    }
    moved.push({ section: b.name, bullet: line, id });
  }
  return { ...b, bodyLines: kept };
});

if (missingTrailer.length && !FORCE) {
  console.error("fixes:clean — REFUSED");
  console.error(
    `\n${missingTrailer.length} [x] bullet(s) have no matching entry in done.log.\n` +
      "Either run `pnpm fixes:sync` first, add a backfill line to done.log, or pass --force.\n"
  );
  for (const m of missingTrailer.slice(0, 10)) {
    console.error(`  ${m.id ?? "(no id)"} [${m.section}] — ${m.snippet}…`);
  }
  if (missingTrailer.length > 10) console.error(`  …and ${missingTrailer.length - 10} more`);
  process.exit(1);
}

// ── build/update COMPLETED section ───────────────────────────────────
//
// Layout within COMPLETED:
//   ## COMPLETED (archive, don't delete — useful reference)
//
//   _Completed items moved here by `pnpm fixes:clean`. `pnpm fixes:archive` moves them to `docs/archive/fixes-archive.md`._
//
//   ### SECTION ONE
//   - [x] ... <!--id:FIX-NNN-->
//
//   ### SECTION TWO
//   - [x] ...
//
//   ### Legacy (pre-FIX-NNN)
//   - [x] old untagged items
//
// We preserve any existing subsections and merge new moves into them.

function parseCompletedBlock(block) {
  // Returns: { intro: string[], subsections: Map<name, lines[]>, legacyLines: [] }
  // Subsection headers are `### NAME`. Anything before the first ### is intro.
  if (!block) return { intro: [], subsections: new Map() };
  const intro = [];
  const subsections = new Map();
  let current = null;
  for (const line of block.bodyLines) {
    const sub = line.match(/^###\s+(.+?)\s*$/);
    if (sub) {
      current = sub[1];
      if (!subsections.has(current)) subsections.set(current, []);
      continue;
    }
    if (current === null) {
      intro.push(line);
    } else {
      subsections.get(current).push(line);
    }
  }
  return { intro, subsections };
}

const completedBlock = hasCompleted ? cleanedBlocks[completedIdx] : null;
const { intro: existingIntro, subsections: existingSubs } = parseCompletedBlock(completedBlock);

// Collect legacy untagged bullets already sitting directly under COMPLETED
// (pre-FIX-NNN archive lines). Keep them under a `### Legacy` subsection.
const legacyLines = [];
const cleanedIntro = [];
if (completedBlock) {
  for (const line of existingIntro) {
    const bm = line.match(BULLET_RE);
    if (bm && !ID_RE.test(bm[4])) {
      legacyLines.push(line);
    } else {
      cleanedIntro.push(line);
    }
  }
}
if (legacyLines.length) {
  const prior = existingSubs.get("Legacy (pre-FIX-NNN)") || [];
  existingSubs.set("Legacy (pre-FIX-NNN)", [...prior, ...legacyLines]);
}

// Merge moved bullets into subsections keyed by origin section name.
for (const { section, bullet } of moved) {
  const key = section;
  if (!existingSubs.has(key)) existingSubs.set(key, []);
  existingSubs.get(key).push(bullet);
}

// Render the new COMPLETED block body.
function renderCompletedBody(introLines, subs) {
  const introDefault = [
    "",
    "_Completed items moved here by `pnpm fixes:clean`. `pnpm fixes:archive` moves them to `docs/archive/fixes-archive.md`._",
    "",
  ];
  const intro = introLines.some((l) => l.trim().startsWith("_Completed"))
    ? introLines
    : introDefault;
  const out = [...intro];
  // Stable order: live-section order first, then extras alphabetically, Legacy last.
  const liveOrder = cleanedBlocks
    .filter((b) => b.kind === "section")
    .map((b) => b.name)
    .filter((n) => !STRATEGIC_RE.test(`## ${n}`) && !COMPLETED_RE.test(`## ${n}`));
  const seen = new Set();
  const ordered = [];
  for (const name of liveOrder) {
    if (subs.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  const extras = [...subs.keys()].filter((k) => !seen.has(k) && k !== "Legacy (pre-FIX-NNN)").sort();
  ordered.push(...extras);
  if (subs.has("Legacy (pre-FIX-NNN)")) ordered.push("Legacy (pre-FIX-NNN)");

  for (const name of ordered) {
    const body = subs.get(name).filter((l) => l !== "");
    if (body.length === 0) continue;
    out.push(`### ${name}`);
    out.push("");
    out.push(...body);
    out.push("");
  }
  return out;
}

const newCompletedBody = renderCompletedBody(cleanedIntro, existingSubs);
const completedHeader = hasCompleted
  ? completedBlock.headerLine
  : "## COMPLETED (archive, don't delete — useful reference)";

// ── reassemble file ──────────────────────────────────────────────────
const finalBlocks = cleanedBlocks.filter((_, i) => i !== completedIdx);

function renderBlock(b) {
  if (b.kind === "preamble") return b.bodyLines.join("\n");
  return [b.headerLine, ...b.bodyLines].join("\n");
}

const mainBody = finalBlocks.map(renderBlock).join("\n");
const completedRendered = [completedHeader, ...newCompletedBody].join("\n");
const finalText = mainBody.replace(/\n+$/, "\n") + "\n" + completedRendered.replace(/\n+$/, "") + "\n";

if (!DRY) writeFileSync(FIXES_PATH, finalText);

console.log("fixes:clean —", DRY ? "DRY RUN" : "APPLIED");
console.table({
  bulletsMoved: moved.length,
  subsectionsUsed: new Set(moved.map((m) => m.section)).size,
  missingTrailerRefused: missingTrailer.length,
});

if (moved.length) {
  console.log("\nMoved to COMPLETED:");
  const grouped = new Map();
  for (const m of moved) {
    if (!grouped.has(m.section)) grouped.set(m.section, []);
    grouped.get(m.section).push(m.id ?? "(no id)");
  }
  for (const [section, ids] of grouped) {
    console.log(`  [${section}] ${ids.join(", ")}`);
  }
}
