#!/usr/bin/env node
// scripts/fixes-clean.mjs
//
// Move CLOSED bullets out of live sections in docs/FIXES.md and into
// `## COMPLETED` at the bottom, grouped by origin section as
// `### SECTION NAME` subsections. Live section headers and `---`
// separators are preserved even when the section becomes empty.
//
// FIX-1016 D6: "closed" is now DERIVED from docs/done.log
// (scripts/lib/fix-status.mjs), not read off a `[x]` in the markdown.
// That retires the old `--force` guardrail — it refused to move an `[x]`
// bullet with no completion row, and there can no longer be one: the log
// IS the predicate, so a bullet with no row simply never gets selected.
//
// Guardrails that remain:
//   - The STRATEGIC PILLARS section and the existing `## COMPLETED`
//     block are never touched as sources (PILLARS is directional, not
//     trackable; COMPLETED is the destination).
//   - The trunk guard. This is still a read-modify-write of a
//     hand-edited file — unlike fixes:sync, which FIX-1016 reduced to an
//     append — so it must still abort if trunk moves under it. The
//     difference is that a human now runs it deliberately, rather than
//     it firing as a side effect of every sync.
//   - Writes produce a single well-shaped commit when you run them —
//     commit immediately so any VS Code editor collision is resolvable
//     from git.
//
// Usage:
//   node scripts/fixes-clean.mjs            apply in place
//   node scripts/fixes-clean.mjs --dry-run  preview, write nothing

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { captureTrunkState, abortOnTrunkMove } from "./lib/trunk-guard.mjs";
import { parseDoneLog, deriveStatus } from "./lib/fix-status.mjs";
import {
  parseFixBullet,
  ID_MARKER_RE,
  SECTION_RE,
  STRATEGIC_RE,
  COMPLETED_RE,
} from "./lib/fixes-md.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const DONE_PATH = resolve(REPO_ROOT, "docs/done.log");

// Concurrent-write guard: snapshot before the read half, re-check before the
// write. See scripts/lib/trunk-guard.mjs.
const TRUNK_BEFORE = captureTrunkState();

const DRY = process.argv.includes("--dry-run");

// FIX-1016 D1: the ONE derivation, shared with fixes:status and fixes:sync.
// This replaces a hand-rolled copy of the same walk that lived here — a second
// implementation of a rule is a second thing that can drift from it.
function loadCompletedFromDoneLog() {
  const completed = new Set();
  if (!existsSync(DONE_PATH)) return completed;
  const status = deriveStatus(parseDoneLog(readFileSync(DONE_PATH, "utf8")));
  for (const [id, v] of status) if (v.status === "closed") completed.add(id);
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
const moved = []; // { section, bullet, id }
const noMarker = []; // bullets with no id — unselectable, reported not moved
const cleanedBlocks = blocks.map((b) => {
  if (b.kind !== "section") return b;
  if (STRATEGIC_RE.test(b.headerLine)) return b;
  if (COMPLETED_RE.test(b.headerLine)) return b;

  const kept = [];
  for (const line of b.bodyLines) {
    const bullet = parseFixBullet(line);
    if (!bullet) {
      kept.push(line);
      continue;
    }
    // A bullet with no <!--id:FIX-NNN--> marker can never be closed (nothing can
    // reference it in a trailer), so it can never be selected. Report it —
    // `pnpm fixes:housekeep` assigns the marker.
    if (!bullet.id) {
      noMarker.push({ section: b.name, snippet: bullet.rest.slice(0, 70) });
      kept.push(line);
      continue;
    }
    if (!doneLogCompleted.has(bullet.id)) {
      kept.push(line);
      continue;
    }
    moved.push({ section: b.name, bullet: line, id: bullet.id });
  }
  return { ...b, bodyLines: kept };
});

// ── build/update COMPLETED section ───────────────────────────────────
//
// Layout within COMPLETED:
//   ## COMPLETED (archive, don't delete — useful reference)
//
//   _Completed items moved here by `pnpm fixes:clean`. `pnpm fixes:archive` moves them to `docs/archive/fixes-archive.md`._
//
//   ### SECTION ONE
//   - 🟠 S — **title** — body <!--id:FIX-NNN-->
//
//   ### SECTION TWO
//   - 🟡 M — ...
//
//   ### Legacy (pre-FIX-NNN)
//   - [x] old untagged items   (historical shape — kept verbatim)
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
    // A top-level bullet with no id marker sitting loose under COMPLETED is a
    // pre-FIX-NNN archive line. `parseFixBullet` requires marker-or-emoji, so
    // test the raw shape here — these predate both conventions.
    if (/^- (?:\[[ xX]\] )?/.test(line) && !ID_MARKER_RE.test(line)) {
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

if (!DRY) {
  abortOnTrunkMove(TRUNK_BEFORE, {
    operation: "fixes:clean (move completed bullets into ## COMPLETED)",
    files: ["docs/FIXES.md"],
  });
  writeFileSync(FIXES_PATH, finalText);
}

console.log("fixes:clean —", DRY ? "DRY RUN" : "APPLIED");
console.table({
  bulletsMoved: moved.length,
  subsectionsUsed: new Set(moved.map((m) => m.section)).size,
  bulletsWithoutIdMarker: noMarker.length,
});

if (noMarker.length) {
  console.log(
    `\n${noMarker.length} live bullet(s) carry no <!--id:FIX-NNN--> marker, so they can never` +
      " be closed or moved. Run `pnpm fixes:housekeep` to assign ids:",
  );
  for (const n of noMarker.slice(0, 10)) console.log(`  [${n.section}] ${n.snippet}…`);
  if (noMarker.length > 10) console.log(`  …and ${noMarker.length - 10} more`);
}

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
