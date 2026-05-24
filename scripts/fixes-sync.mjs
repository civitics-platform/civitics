#!/usr/bin/env node
// scripts/fixes-sync.mjs
//
// One-way sync between git commit trailers and FIXES.md status.
//
//   1. Scans `git log` for commits whose body contains `Fixes: FIX-NNN[, FIX-MMM]`
//      (code-level fix) or `Closes: FIX-NNN[, FIX-MMM]` (administrative closure
//      for superseded / redirected / recognized prior work / no-op — FIX-314).
//   2. Appends any new (FIX-ID, commit-sha) pairs to docs/done.log.
//      Append-only — existing lines are never rewritten.
//   3. Reads docs/done.log and flips `- [ ]` to `- [x]` for any bullet in FIXES.md
//      whose trailing `<!--id:FIX-NNN-->` marker appears in the log.
//
//   The script NEVER un-checks a bullet. Reopens are a manual operation:
//   hand-uncheck in FIXES.md and add a `reopen` note in done.log.
//
// Usage:
//   node scripts/fixes-sync.mjs            sync + rewrite FIXES.md
//   node scripts/fixes-sync.mjs --dry-run  show what would change, write nothing
//   node scripts/fixes-sync.mjs --check    exit 1 if anything is out of sync (CI)

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const DONE_PATH = resolve(REPO_ROOT, "docs/done.log");

const DRY = process.argv.includes("--dry-run");
const CHECK = process.argv.includes("--check");

// FIX-159: per-environment verification trailer.
//   `Verified: local`           → "local-only"
//   `Verified: prod`            → "prod-only"
//   `Verified: local + prod`    → "local+prod"   (also: `local+prod`, `local & prod`)
//   trailer absent (Fixes:)     → "unverified"
// FIX-314: closure-type vocabulary for `Closes:` trailers (recognition-shaped
// closures). Used when a FIX is closed administratively, not by a code-level
// fix in this commit.
//   `Verified: closes-as-recognized`  → prior work resolved it (default for Closes:)
//   `Verified: closes-as-superseded`  → superseded by another FIX
//   `Verified: closes-as-redirected`  → redirected to a new FIX
//   `Verified: closes-as-no-op`       → investigation found no real bug
//   trailer absent (Closes:)          → "closes-as-recognized"
// done.log gains a 5th column with this status. Lines without the column are
// pre-FIX-159 (4-column) entries — parsed by detecting whether the 4th column
// matches a known verification literal.
const CLOSES_VALUES = new Set([
  "closes-as-superseded",
  "closes-as-redirected",
  "closes-as-recognized",
  "closes-as-no-op",
]);
const VERIFIED_VALUES = new Set([
  "local-only",
  "prod-only",
  "local+prod",
  "unverified",
  ...CLOSES_VALUES,
]);

function normalizeVerified(raw, { trailer = "fixes" } = {}) {
  if (!raw) return trailer === "closes" ? "closes-as-recognized" : "unverified";
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^local\s*[+&]\s*prod$|^local\s+and\s+prod$/i.test(t) || t === "local+prod") return "local+prod";
  if (t === "local" || t === "local-only" || t === "local only") return "local-only";
  if (t === "prod" || t === "prod-only" || t === "prod only") return "prod-only";
  if (CLOSES_VALUES.has(t)) return t;
  // Synonyms — normalize bare nouns into canonical `closes-as-*` form so new
  // rows match the documented vocabulary. Historical one-off rows that used
  // the bare form stay as-is per the append-only rule.
  if (t === "superseded") return "closes-as-superseded";
  if (t === "redirected") return "closes-as-redirected";
  if (t === "recognized") return "closes-as-recognized";
  if (t === "no-op" || t === "noop") return "closes-as-no-op";
  return trailer === "closes" ? "closes-as-recognized" : "unverified";
}

function readDoneLog() {
  if (!existsSync(DONE_PATH)) {
    return { entries: [], keys: new Set(), completedIds: new Set(), reopenedIds: new Set() };
  }
  // FIX-361: tolerate CRLF on files saved by a misconfigured editor.
  // .gitattributes prevents re-introduction at commit, but a one-off
  // working-tree edit shouldn't silently break sync.
  const text = readFileSync(DONE_PATH, "utf8").replace(/\r\n/g, "\n");
  const entries = [];
  const keys = new Set();
  const completedIds = new Set();
  const reopenedIds = new Set();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 3) continue;
    // 5-column (post-FIX-159): date | id | sha | verified | note
    // 4-column (legacy):       date | id | sha | note
    let date, id, sha, verified, note;
    if (parts.length >= 5 && VERIFIED_VALUES.has(parts[3])) {
      [date, id, sha, verified, ...note] = parts;
      note = note.join(" | ");
    } else {
      [date, id, sha, ...note] = parts;
      verified = "unverified";
      note = note.join(" | ");
    }
    entries.push({ date, id, sha, verified, note });
    keys.add(`${id}|${sha}`);
    // Last-write-wins: a `reopen` line clears completion, a subsequent
    // non-reopen line restores it. `reopenedIds` still records every ID that
    // has ever been reopened (used for diagnostics), but it does NOT gate
    // re-completion. Earlier logic permanently disqualified an ID once
    // reopened — that broke FIX-041/042 which were reopened then re-completed.
    if (sha === "reopen") {
      reopenedIds.add(id);
      completedIds.delete(id);
    } else {
      completedIds.add(id);
    }
  }
  return { entries, keys, completedIds, reopenedIds };
}

function scanCommits() {
  // Delimiters: %x00 separates fields within a commit, %x1e between commits.
  const raw = execSync(
    'git log --all --pretty=format:"%H%x00%ad%x00%s%x00%b%x1e" --date=short',
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const blocks = raw.split("\x1e").map((b) => b.trim()).filter(Boolean);
  const fixesRe = /^\s*Fixes:\s*(.+)$/im;
  const closesRe = /^\s*Closes:\s*(.+)$/im;
  const verifiedRe = /^\s*Verified:\s*(.+)$/im;
  const idRe = /FIX-\d{3}/g;
  const completions = [];
  for (const block of blocks) {
    const [sha = "", date = "", subject = "", body = ""] = block.split("\x00");
    const fixesMatch = body.match(fixesRe);
    const closesMatch = body.match(closesRe);
    if (!fixesMatch && !closesMatch) continue;
    const fixesIds = new Set(fixesMatch ? fixesMatch[1].match(idRe) || [] : []);
    const closesIds = new Set(closesMatch ? closesMatch[1].match(idRe) || [] : []);
    // FIX-314: if an ID appears in both trailers in the same commit, Fixes:
    // wins (code-level fix is the stronger signal). Warn so we notice.
    const conflicts = [...closesIds].filter((id) => fixesIds.has(id));
    if (conflicts.length > 0) {
      console.warn(
        `warn: commit ${sha.trim().slice(0, 8)} lists ${conflicts.join(", ")} in both Fixes: and Closes: trailers; Fixes: wins.`
      );
      for (const id of conflicts) closesIds.delete(id);
    }
    const vMatch = body.match(verifiedRe);
    const rawVerified = vMatch ? vMatch[1] : null;
    const shortSha = sha.trim().slice(0, 8);
    const noteText = subject.trim();
    const dateText = date.trim();
    for (const id of fixesIds) {
      completions.push({
        id,
        sha: shortSha,
        date: dateText,
        verified: normalizeVerified(rawVerified, { trailer: "fixes" }),
        note: noteText,
      });
    }
    for (const id of closesIds) {
      completions.push({
        id,
        sha: shortSha,
        date: dateText,
        verified: normalizeVerified(rawVerified, { trailer: "closes" }),
        note: noteText,
      });
    }
  }
  return completions;
}

function appendNewEntries(existing, completions) {
  const seen = existing.keys;
  const newOnes = completions.filter((c) => !seen.has(`${c.id}|${c.sha}`));
  if (newOnes.length === 0) return [];
  // Stable sort: date ascending, then id.
  newOnes.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const lines = newOnes.map(
    (c) => `${c.date} | ${c.id} | ${c.sha} | ${c.verified ?? "unverified"} | ${c.note}`,
  );
  if (!DRY && !CHECK) appendFileSync(DONE_PATH, lines.join("\n") + "\n");
  return newOnes;
}

function syncFixesMd(completedIds) {
  // FIX-361: tolerate CRLF on read (see readDoneLog). Writes stay LF —
  // out.join("\n") below preserves the in-memory LF form.
  const content = readFileSync(FIXES_PATH, "utf8").replace(/\r\n/g, "\n");
  const lines = content.split("\n");
  const flipped = [];
  const missingMarker = [];

  const bulletRe = /^(\s*- \[)([ xX])(\] .+)$/;
  const idRe = /<!--\s*id:\s*(FIX-\d{3})\s*-->/;
  const archiveHeadingRe = /^##\s+COMPLETED\b/i;

  let inArchive = false;
  const out = lines.map((line) => {
    if (archiveHeadingRe.test(line)) inArchive = true;
    const m = line.match(bulletRe);
    if (!m) return line;
    const [, pre, box, rest] = m;
    const idMatch = rest.match(idRe);
    if (!idMatch) {
      if (!inArchive) missingMarker.push(line.slice(0, 80));
      return line;
    }
    const id = idMatch[1];
    const isChecked = box.toLowerCase() === "x";
    const shouldBeChecked = completedIds.has(id);
    if (shouldBeChecked && !isChecked) {
      flipped.push(id);
      return `${pre}x${rest}`;
    }
    return line;
  });

  if (flipped.length > 0 && !DRY && !CHECK) {
    writeFileSync(FIXES_PATH, out.join("\n"));
  }
  return { flipped, missingMarker };
}

// ── main ─────────────────────────────────────────────────────────────
const done = readDoneLog();
const trailerCompletions = scanCommits();
const newEntries = appendNewEntries(done, trailerCompletions);
// Last-write-wins across the existing log + newly-discovered trailer commits.
// Past reopen state does NOT gate re-completion — a fresh commit with a
// `Fixes:` trailer is itself the new "last write".
const allCompleted = new Set(done.completedIds);
for (const c of newEntries) allCompleted.add(c.id);
const { flipped, missingMarker } = syncFixesMd(allCompleted);

const summary = {
  trailersScanned: trailerCompletions.length,
  newLoggedEntries: newEntries.length,
  checkboxesFlipped: flipped.length,
  bulletsMissingIdMarker: missingMarker.length,
};

console.log("fixes:sync —", DRY ? "DRY RUN" : CHECK ? "CHECK MODE" : "APPLIED");
console.table(summary);
if (newEntries.length) {
  console.log("\nNew done.log entries:");
  for (const e of newEntries)
    console.log(`  ${e.date} | ${e.id} | ${e.sha} | ${e.verified ?? "unverified"} | ${e.note}`);
}
if (flipped.length) {
  console.log("\nCheckboxes flipped to [x]:");
  for (const id of flipped) console.log(`  ${id}`);
}
if (missingMarker.length && !CHECK) {
  console.log(`\n${missingMarker.length} bullet(s) without <!--id:FIX-NNN--> marker (first 5):`);
  for (const snip of missingMarker.slice(0, 5)) console.log(`  ${snip}…`);
}

if (CHECK && (newEntries.length > 0 || flipped.length > 0)) {
  console.error("\nFIXES.md is out of sync with commit trailers. Run `pnpm fixes:sync`.");
  process.exit(1);
}
