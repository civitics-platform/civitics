#!/usr/bin/env node
// scripts/fix-add.mjs
//
// pnpm fix:add — atomically append a new FIX bullet to docs/FIXES.md and
// print the allocated FIX-ID to stdout.
//
// Replaces the manual "grep for next free ID, hand-format bullet" recipe
// used by every CC prompt to date. Both Craig and CC call this script so
// bullet shape stays consistent.
//
// Decisions encoded here (see FIX-362):
//   - Args-based interface; no $EDITOR interactive mode in v1.
//   - Next free ID = max(FIXES.md, done.log, fixes-archive.md) + 1 — same
//     allocator as fixes-housekeep.mjs.
//   - Optimistic concurrency: read FIXES.md → hash → format → re-read →
//     write iff hash unchanged. One retry. Then bail (solo-dev scale).
//   - Section match is case-insensitive substring on `^## ` headers.
//     Zero or multiple matches → exit 1 with the section list.
//   - Insertion point is after the last `- ` bullet in the matched section,
//     before the next `^## ` header. Empty sections insert right after the
//     header line.
//   - Bullet shape:
//       - [ ] {severity} {size} — **{title}** — {body} <!--id:FIX-NNN-->
//   - Writes via tmp + atomic rename. Writes LF unconditionally.
//
// Usage:
//   pnpm fix:add \
//     --title "Short title" \
//     --severity "🟠" \
//     --size "S" \
//     --section "INFRASTRUCTURE & PERFORMANCE" \
//     --body "Long markdown body referencing [[FIX-NNN]] cross-refs..."
//
// Output (stdout): the allocated FIX-ID, e.g. "FIX-362". Errors → stderr.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureTrunkState, abortOnTrunkMove } from "./lib/trunk-guard.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const DONE_PATH = resolve(REPO_ROOT, "docs/done.log");
const ARCHIVE_PATH = resolve(REPO_ROOT, "docs/archive/fixes-archive.md");

const ALLOWED_SEVERITY = new Set(["🔴", "🟠", "🟡", "🟢", "⬜"]);
const ALLOWED_SIZE = new Set(["S", "M", "L", "XL"]);

const SECTION_RE = /^##\s+(.+?)\s*$/;
const BULLET_RE = /^\s*- \[/;

function die(msg, code = 1) {
  process.stderr.write(`fix:add — ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      die(`flag --${key} requires a value`);
    }
    out[key] = val;
    i++;
  }
  return out;
}

function usage() {
  process.stderr.write(
    [
      "Usage: pnpm fix:add \\",
      '  --title "Short title" \\',
      '  --severity "🟠" \\',
      '  --size "S" \\',
      '  --section "INFRASTRUCTURE & PERFORMANCE" \\',
      '  --body "Long markdown body..."',
      "",
      "  --severity: one of 🔴 🟠 🟡 🟢 ⬜",
      "  --size:     one of S, M, L, XL",
      "  --section:  case-insensitive substring match on a `^## ` header",
      "",
      "Prints the allocated FIX-ID to stdout on success.",
      "",
    ].join("\n"),
  );
}

function readLf(path) {
  // FIX-361: tolerate CRLF on read; writes stay LF unconditionally.
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function hashOf(s) {
  return createHash("sha256").update(s).digest("hex");
}

// FIX-368: on FIXES.md and fixes-archive.md, count `<!--id:FIX-NNN-->` markers
// ONLY — the canonical handle per CLAUDE.md FIXES Workflow. Cross-refs
// (`[[FIX-NNN]]`) and prose mentions in bullet bodies are decorative and must
// not consume IDs. Bug observed on FIX-363 ship (2026-05-25): `[[FIX-362]]`
// forward-ref in FIX-361's body bumped the counter via the old loose
// `/FIX-\d{3}/g`, burning FIX-362. `\d+` (not `\d{3}`) future-proofs past 999.
export function markerIds(text) {
  const out = [];
  for (const m of text.matchAll(/<!--id:FIX-(\d+)-->/g)) out.push(parseInt(m[1], 10));
  return out;
}

// done.log has no markers — every `FIX-NNN` there is a real allocation (column
// 2 ID or a referenced ID in the note). Keep the loose scan so audit-orphaned
// IDs (logged completions whose live marker has gone missing) still block
// re-allocation.
export function looseIds(text) {
  const out = [];
  for (const m of text.match(/FIX-\d+/g) || []) out.push(parseInt(m.slice(4), 10));
  return out;
}

const maxOf = (nums) => nums.reduce((m, n) => (n > m ? n : m), 0);

/**
 * Pure next-id computation across every id source — no git, no fs, so it is
 * unit-testable. `origin` is the origin/main FIXES.md text (markers only); pass
 * "" when unavailable. Returns { nextId, localMax, originMax } so the caller can
 * warn on divergence.
 */
export function computeNextId({ fixes, done = "", archive = "", origin = "" }) {
  const localMax = maxOf(markerIds(fixes));
  const originMax = maxOf(markerIds(origin));
  const max = Math.max(localMax, maxOf(looseIds(done)), maxOf(markerIds(archive)), originMax);
  return { nextId: `FIX-${String(max + 1).padStart(3, "0")}`, localMax, originMax };
}

// FIX-771: a worktree's working-tree docs/FIXES.md is stale for the whole life
// of the worktree, so allocating from it alone races a concurrent hand-add (or
// another session's fix:add) on main — the FIX-762/766 collision, de-collided
// in dd26c0f0. Fold in origin/main:docs/FIXES.md. Best-effort: a quiet,
// time-bounded fetch then a show; offline / no-origin / detached degrades to
// the working tree alone (prior behavior). Markers only, per FIX-368.
function readOriginMainFixes() {
  try {
    execSync("git fetch origin --quiet", { stdio: "ignore", timeout: 15000 });
  } catch {
    // Offline / no remote — a previously-fetched origin/main may still resolve.
  }
  try {
    return execSync("git show origin/main:docs/FIXES.md", { encoding: "utf8", timeout: 15000 });
  } catch {
    return ""; // no origin/main ref (fresh clone / detached / renamed default)
  }
}

function allocateNextId() {
  const { nextId, localMax, originMax } = computeNextId({
    fixes: readLf(FIXES_PATH),
    done: existsSync(DONE_PATH) ? readLf(DONE_PATH) : "",
    archive: existsSync(ARCHIVE_PATH) ? readLf(ARCHIVE_PATH) : "",
    origin: readOriginMainFixes(),
  });
  if (originMax > localMax) {
    process.stderr.write(
      `fix:add — ⚠ origin/main docs/FIXES.md reaches FIX-${String(originMax).padStart(3, "0")} but this ` +
        `working tree only reaches FIX-${String(localMax).padStart(3, "0")}. Allocating above origin/main ` +
        `to avoid a collision — rebase/pull to sync the working tree.\n`,
    );
  }
  return nextId;
}

function findSectionRange(lines, sectionQuery) {
  // Case-insensitive substring match on `^## ` headers. Skip STRATEGIC
  // PILLARS / COMPLETED — same exclusions other scripts honor.
  const q = sectionQuery.trim().toLowerCase();
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_RE);
    if (!m) continue;
    const name = m[1];
    const lower = name.toLowerCase();
    if (lower.includes(q)) matches.push({ idx: i, name });
  }
  if (matches.length === 0) {
    const all = lines.filter((l) => SECTION_RE.test(l)).map((l) => l.replace(/^##\s+/, "").trim());
    die(
      `no section matches "${sectionQuery}". Available sections:\n  ` +
        all.map((s) => `- ${s}`).join("\n  "),
    );
  }
  if (matches.length > 1) {
    die(
      `ambiguous --section "${sectionQuery}" matches:\n  ` +
        matches.map((m) => `- ${m.name}`).join("\n  "),
    );
  }
  const start = matches[0].idx;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, name: matches[0].name };
}

function findInsertionIdx(lines, start, end) {
  // After the last bullet line in [start+1, end). If none, immediately after
  // the section header (start+1). Skips trailing `---` separator and any
  // trailing blank lines so the new bullet lands adjacent to the existing
  // bullet block rather than dangling at the bottom of the section.
  let lastBullet = -1;
  for (let i = start + 1; i < end; i++) {
    if (BULLET_RE.test(lines[i])) lastBullet = i;
  }
  if (lastBullet === -1) return start + 1;
  return lastBullet + 1;
}

function formatBullet({ severity, size, title, body, id }) {
  // Bullet shape mirrors the existing FIXES.md convention exactly.
  // The trailing `<!--id:FIX-NNN-->` marker is the stable handle the rest
  // of the tooling (commit trailers, fixes:sync) keys on.
  return `- [ ] ${severity} ${size} — **${title}** — ${body} <!--id:FIX-${id.slice(4)}-->`;
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

// ── main ─────────────────────────────────────────────────────────────
// FIX-771: gate the CLI behind a direct-invocation guard so importing this
// module (scripts/test-fix-add.mjs) exercises the pure allocator helpers
// without triggering an allocation/write. Mirrors scripts/fixes-sync.mjs.
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help !== undefined || Object.keys(args).length === 0) {
    usage();
    process.exit(1);
  }

  const required = ["title", "severity", "size", "section", "body"];
  const missing = required.filter((k) => !args[k]);
  if (missing.length) {
    usage();
    die(`missing required flag(s): ${missing.map((k) => `--${k}`).join(", ")}`);
  }

  if (!ALLOWED_SEVERITY.has(args.severity)) {
    die(`--severity must be one of ${[...ALLOWED_SEVERITY].join(" ")} (got "${args.severity}")`);
  }
  if (!ALLOWED_SIZE.has(args.size)) {
    die(`--size must be one of ${[...ALLOWED_SIZE].join(", ")} (got "${args.size}")`);
  }

  const MAX_RETRIES = 1;
  let attempt = 0;
  let writtenId = null;
  while (attempt <= MAX_RETRIES) {
    const before = readLf(FIXES_PATH);
    const beforeHash = hashOf(before);
    const lines = before.split("\n");
    const range = findSectionRange(lines, args.section);
    const id = allocateNextId();
    // Captured AFTER allocateNextId, deliberately: that call runs its own
    // `git fetch origin` and folds origin/main's markers into the allocation
    // (FIX-771), so a trunk advance it consumes is already handled and must not
    // read as a collision. The window this guards is the one that matters —
    // between deciding the ID and writing the bullet.
    const trunkBefore = captureTrunkState();
    const bullet = formatBullet({
      severity: args.severity,
      size: args.size,
      title: args.title,
      body: args.body,
      id,
    });
    const insertAt = findInsertionIdx(lines, range.start, range.end);
    const next = [...lines.slice(0, insertAt), bullet, ...lines.slice(insertAt)].join("\n");

    // Re-read to detect concurrent writers. Hash check beats stat-based mtime
    // because two writes in the same wall-clock millisecond would both look
    // unchanged via mtime.
    const recheck = readLf(FIXES_PATH);
    if (hashOf(recheck) !== beforeHash) {
      attempt++;
      if (attempt > MAX_RETRIES) {
        die(
          "FIXES.md changed between read and write after retry — another writer may be active. Re-run.",
        );
      }
      continue;
    }
    // The hash re-check above catches a concurrent writer that already landed
    // in the working tree; this catches one whose work is in git but not yet in
    // this file — a commit on the shared checkout, or a push another session
    // fetched. Both are needed: neither sees the other's case.
    abortOnTrunkMove(trunkBefore, {
      operation: `fix:add (append ${id} to docs/FIXES.md)`,
      files: ["docs/FIXES.md"],
    });
    writeAtomic(FIXES_PATH, next);
    writtenId = id;
    break;
  }

  process.stdout.write(`${writtenId}\n`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
