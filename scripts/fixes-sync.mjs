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
//   node scripts/fixes-sync.mjs              sync + rewrite FIXES.md
//   node scripts/fixes-sync.mjs --dry-run    show what would change, write nothing
//   node scripts/fixes-sync.mjs --check      exit 1 on EITHER drift (FIXES.md/done.log
//                                            out of sync with trailers) OR a trunk-ancestry
//                                            violation. Used on PRs, where code + sync
//                                            commits are evaluated against main together.
//   node scripts/fixes-sync.mjs --check-trunk exit 1 ONLY on a trunk-ancestry violation;
//                                            ignores drift. Used on push-to-main: the
//                                            standard loop lands the `Fixes:` code commit
//                                            and its follow-up `fixes:sync` commit as two
//                                            separate pushes, so the code-commit push is
//                                            *always* transiently out of sync — failing on
//                                            drift there is guaranteed noise. The dangerous
//                                            case (done.log claims a FIX shipped whose code
//                                            is off-trunk) is still enforced on every push.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const FIXES_PATH = resolve(REPO_ROOT, "docs/FIXES.md");
const DONE_PATH = resolve(REPO_ROOT, "docs/done.log");

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
// FIX-369: per-trailer override syntax `Verified[FIX-NNN]: <value>`. When a
// single commit has different verification states for different FIX-IDs (e.g.
// `Fixes: FIX-A` verified locally + `Closes: FIX-B` closed-as-redirected), the
// per-FIX form overrides the bare global `Verified:` for that ID. Backwards
// compatible — every existing commit continues to produce the same rows.
// done.log gains a 5th column with this status. Lines without the column are
// pre-FIX-159 (4-column) entries — parsed by detecting whether the 4th column
// matches a known verification literal.
export const CLOSES_VALUES = new Set([
  "closes-as-superseded",
  "closes-as-redirected",
  "closes-as-recognized",
  "closes-as-no-op",
]);
export const VERIFIED_VALUES = new Set([
  "local-only",
  "prod-only",
  "local+prod",
  "unverified",
  ...CLOSES_VALUES,
]);

export function normalizeVerified(raw, { trailer = "fixes" } = {}) {
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

// ── Trunk-ancestry guard (FIX-461) ──────────────────────────────────────────
// Root cause of the silent-zero-sweep-tail incident: a fixes:sync run scanned
// commits that were reachable in the local clone (`git log --all`) but lived on
// an unmerged PR branch, and recorded them as shipped. `git merge-base
// --is-ancestor <sha> origin/main` is false for those SHAs — the code never
// reached prod. These helpers let scanCommits refuse to record off-trunk
// completions (prevention) and let --check fail when done.log already claims a
// FIX is done whose only real commit SHAs are off-trunk (detection).

const SHA_RE = /^[0-9a-f]{7,40}$/;

function git(args) {
  // Returns { code, out }. Never throws — callers branch on code. Avoids
  // `^{commit}` and other shell-meta (cmd.exe on Windows escapes `^`).
  try {
    const out = execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : 1, out: "" };
  }
}

// Resolve the trunk ref to compare against. Prefer the remote-tracking
// origin/main (what actually shipped), fall back to local main. Returns null
// when neither resolves (fresh/shallow clone with no main ref) — callers then
// skip the guard rather than fail spuriously.
export function resolveTrunkRef() {
  for (const ref of ["origin/main", "refs/remotes/origin/main", "main"]) {
    if (git(`rev-parse --verify --quiet ${ref}`).code === 0) return ref;
  }
  return null;
}

// One `git rev-list <trunk>` gives every commit reachable from trunk; we index
// the SHAs by short-prefix so classifySha is an O(1) Set lookup instead of a
// `merge-base --is-ancestor` subprocess per SHA (done.log carries ~400 SHAs —
// ~900 spawns would make `fixes:check` crawl, especially on Windows). Cached
// per trunk ref for the life of the process.
const _trunkAncestorCache = new Map();
function trunkAncestorPrefixes(trunk) {
  if (_trunkAncestorCache.has(trunk)) return _trunkAncestorCache.get(trunk);
  const res = git(`rev-list ${trunk}`);
  const byLen = new Map(); // prefix-length → Set of that-length prefixes
  if (res.code === 0 && res.out) {
    for (const full of res.out.split("\n")) {
      const s = full.trim();
      if (s.length < 7) continue;
      for (const len of [7, 8, 9, 10, 12, 40]) {
        if (s.length < len) continue;
        const key = s.slice(0, len);
        if (!byLen.has(len)) byLen.set(len, new Set());
        byLen.get(len).add(key);
      }
    }
  }
  _trunkAncestorCache.set(trunk, byLen);
  return byLen;
}

// Classify a single SHA against trunk: "ancestor" | "not-ancestor" | "unknown".
// "unknown" = not a real hex SHA (sentinel like `backfill`/`reopen`), or the
// object isn't in this clone (shallow) — neither is a violation. Memoized.
const _shaClassCache = new Map();
function classifySha(sha, trunk) {
  if (!SHA_RE.test(sha)) return "unknown";
  const cacheKey = `${trunk} ${sha}`;
  if (_shaClassCache.has(cacheKey)) return _shaClassCache.get(cacheKey);
  let verdict;
  const byLen = trunkAncestorPrefixes(trunk);
  const set = byLen.get(sha.length);
  if (set && set.has(sha)) {
    verdict = "ancestor";
  } else if (git(`cat-file -e ${sha}`).code !== 0) {
    // Object not in this clone (shallow fetch) — can't judge, don't fail.
    verdict = "unknown";
  } else {
    // Exists locally but not reachable from trunk. Confirm with a real
    // merge-base in case the rev-list prefix index missed an odd SHA length.
    verdict = git(`merge-base --is-ancestor ${sha} ${trunk}`).code === 0 ? "ancestor" : "not-ancestor";
  }
  _shaClassCache.set(cacheKey, verdict);
  return verdict;
}

// Pure decision core (injectable resolver → unit-testable without git).
// A completed FIX-ID is a violation iff it has at least one *resolvable* real
// commit SHA AND none of them are ancestors of trunk. An ID whose SHAs are all
// "unknown" (sentinels / missing objects) is skipped, never failed. An ID with
// any ancestor SHA passes even if it also has off-trunk duplicates (the FIX-435
// orphan-plus-landed case from the same incident).
export function evaluateTrunkViolations({ completedIds, completingShasById, resolve }) {
  const violations = [];
  const skipped = [];
  for (const id of completedIds) {
    const shas = completingShasById.get(id) ?? [];
    const states = shas.map((sha) => ({ sha, state: resolve(sha) }));
    const known = states.filter((s) => s.state !== "unknown");
    if (known.length === 0) {
      if (shas.length > 0) skipped.push({ id, shas });
      continue;
    }
    if (known.some((s) => s.state === "ancestor")) continue;
    violations.push({ id, shas: known.map((s) => s.sha) });
  }
  return { violations, skipped };
}

// Map each FIX-ID → the list of non-reopen completing SHAs ever logged for it.
// Built from done.log entries plus the about-to-be-appended trailer entries so
// the guard sees the post-sync state.
export function buildCompletingShasById(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!e || !e.sha || e.sha === "reopen") continue;
    if (!map.has(e.id)) map.set(e.id, []);
    map.get(e.id).push(e.sha);
  }
  return map;
}

// Pure trailer parser — extracts everything fixes-sync needs from a commit
// body without touching git or the filesystem. Exposed so the test harness
// (scripts/test-fixes-sync.mjs) can exercise the parsing path directly.
export function parseCommitTrailers(body) {
  // FIX-465: case-SENSITIVE. Git trailer keys are always capitalized
  // (`Fixes:`/`Closes:`/`Verified:`); the `i` flag let a wrapped prose line
  // such as "fixes:sync recorded ... (FIX-461)" match as a trailer and — being
  // non-global, first-match-wins and appearing before the real trailer —
  // shadow the actual `Fixes: FIX-NNN`, attributing the commit to the wrong
  // FIX. Surfaced on the FIX-464 commit, which mentioned "fixes:sync" in prose.
  //
  // FIX-874: `/gm` (global) so EVERY `Fixes:`/`Closes:` line contributes its
  // IDs, not just the first. A commit may stack multiple trailer lines instead
  // of the comma form — the 2026-07-20 lens-family commit ccd0f3f3 carried
  // `Fixes: FIX-656` / `FIX-657` / `FIX-658` on three separate lines and the old
  // non-global `body.match()` returned only line one, silently dropping 657/658
  // from done.log (they had to be logged retroactively). Case-sensitivity still
  // guards the prose-shadow case regardless of the global flag.
  const fixesRe = /^\s*Fixes:\s*(.+)$/gm;
  const closesRe = /^\s*Closes:\s*(.+)$/gm;
  const verifiedRe = /^\s*Verified:\s*(.+)$/m;
  const verifiedPerFixRe = /^\s*Verified\[(FIX-\d{3})\]:\s*(.+)$/gm;
  const idRe = /FIX-\d{3}/g;

  const warnings = [];
  // Union the IDs across all matching trailer lines (FIX-874). `matchAll`
  // consumes the whole body per key; each line's capture is still comma-split
  // by `idRe`, so both the stacked-line and the single comma-separated form
  // (`Fixes: FIX-A, FIX-B`) resolve identically.
  const collectIds = (re) => {
    const ids = new Set();
    for (const m of body.matchAll(re)) {
      for (const id of m[1].match(idRe) || []) ids.add(id);
    }
    return ids;
  };
  const fixesIds = collectIds(fixesRe);
  const closesIds = collectIds(closesRe);

  // FIX-314: if an ID appears in both trailers in the same commit, Fixes:
  // wins (code-level fix is the stronger signal). Warn so we notice.
  const conflicts = [...closesIds].filter((id) => fixesIds.has(id));
  if (conflicts.length > 0) {
    warnings.push(
      `lists ${conflicts.join(", ")} in both Fixes: and Closes: trailers; Fixes: wins.`,
    );
    for (const id of conflicts) closesIds.delete(id);
  }

  const vMatch = body.match(verifiedRe);
  const globalVerified = vMatch ? vMatch[1] : null;

  // FIX-369: per-FIX overrides. Multiple `Verified[FIX-NNN]:` lines allowed;
  // last write wins per ID. A line referencing a FIX-ID NOT in Fixes:/Closes:
  // is dropped with a warning — silently applying it would imply a hidden
  // completion record the commit never claimed.
  const perFixVerified = new Map();
  let pm;
  while ((pm = verifiedPerFixRe.exec(body)) !== null) {
    perFixVerified.set(pm[1], pm[2]);
  }
  const allTrailerIds = new Set([...fixesIds, ...closesIds]);
  for (const id of perFixVerified.keys()) {
    if (!allTrailerIds.has(id)) {
      warnings.push(
        `has Verified[${id}] but ${id} is not in Fixes: or Closes:; ignoring.`,
      );
      perFixVerified.delete(id);
    }
  }

  return { fixesIds, closesIds, globalVerified, perFixVerified, warnings };
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
  const completions = [];
  for (const block of blocks) {
    const [sha = "", date = "", subject = "", body = ""] = block.split("\x00");
    const parsed = parseCommitTrailers(body);
    if (parsed.fixesIds.size === 0 && parsed.closesIds.size === 0) continue;
    const shortSha = sha.trim().slice(0, 8);
    const noteText = subject.trim();
    const dateText = date.trim();
    for (const w of parsed.warnings) {
      console.warn(`warn: commit ${shortSha} ${w}`);
    }
    for (const id of parsed.fixesIds) {
      const rawV = parsed.perFixVerified.get(id) ?? parsed.globalVerified;
      completions.push({
        id,
        sha: shortSha,
        date: dateText,
        verified: normalizeVerified(rawV, { trailer: "fixes" }),
        note: noteText,
      });
    }
    for (const id of parsed.closesIds) {
      const rawV = parsed.perFixVerified.get(id) ?? parsed.globalVerified;
      completions.push({
        id,
        sha: shortSha,
        date: dateText,
        verified: normalizeVerified(rawV, { trailer: "closes" }),
        note: noteText,
      });
    }
  }
  return completions;
}

function appendNewEntries(existing, completions, { dry }) {
  const seen = existing.keys;
  const newOnes = completions.filter((c) => !seen.has(`${c.id}|${c.sha}`));
  if (newOnes.length === 0) return [];
  // Stable sort: date ascending, then id.
  newOnes.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const lines = newOnes.map(
    (c) => `${c.date} | ${c.id} | ${c.sha} | ${c.verified ?? "unverified"} | ${c.note}`,
  );
  if (!dry) appendFileSync(DONE_PATH, lines.join("\n") + "\n");
  return newOnes;
}

function syncFixesMd(completedIds, { dry }) {
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

  if (flipped.length > 0 && !dry) {
    writeFileSync(FIXES_PATH, out.join("\n"));
  }
  return { flipped, missingMarker };
}

function main() {
  const DRY = process.argv.includes("--dry-run");
  const CHECK = process.argv.includes("--check");
  const CHECK_TRUNK = process.argv.includes("--check-trunk");
  const anyCheck = CHECK || CHECK_TRUNK;
  const writeMode = !DRY && !anyCheck;

  const done = readDoneLog();
  const scanned = scanCommits();

  // FIX-461 prevention: never record a completion whose commit is not on trunk.
  // `scanCommits` uses `git log --all`, which reaches unmerged PR branches; a
  // commit there is discovered but is NOT shipped. Drop any whose SHA resolves
  // to "not-ancestor" of trunk. When no trunk ref resolves (fresh/shallow
  // clone), skip the filter and fall back to the prior all-refs behavior.
  const trunk = resolveTrunkRef();
  let droppedOffTrunk = [];
  let trailerCompletions = scanned;
  if (trunk) {
    trailerCompletions = scanned.filter((c) => {
      if (classifySha(c.sha, trunk) === "not-ancestor") {
        droppedOffTrunk.push(`${c.id}|${c.sha}`);
        return false;
      }
      return true;
    });
  } else {
    console.warn("warn: no trunk ref (origin/main|main) resolved — skipping FIX-461 off-trunk filter + check.");
  }

  const newEntries = appendNewEntries(done, trailerCompletions, { dry: !writeMode });
  // Last-write-wins across the existing log + newly-discovered trailer commits.
  // Past reopen state does NOT gate re-completion — a fresh commit with a
  // `Fixes:` trailer is itself the new "last write".
  const allCompleted = new Set(done.completedIds);
  for (const c of newEntries) allCompleted.add(c.id);
  const { flipped, missingMarker } = syncFixesMd(allCompleted, { dry: !writeMode });

  const summary = {
    trailersScanned: trailerCompletions.length,
    newLoggedEntries: newEntries.length,
    checkboxesFlipped: flipped.length,
    bulletsMissingIdMarker: missingMarker.length,
  };

  console.log("fixes:sync —", DRY ? "DRY RUN" : CHECK_TRUNK ? "CHECK MODE (trunk-only)" : CHECK ? "CHECK MODE" : "APPLIED");
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
  if (missingMarker.length && !anyCheck) {
    console.log(`\n${missingMarker.length} bullet(s) without <!--id:FIX-NNN--> marker (first 5):`);
    for (const snip of missingMarker.slice(0, 5)) console.log(`  ${snip}…`);
  }

  if (droppedOffTrunk.length) {
    console.warn(
      `\n${droppedOffTrunk.length} trailer completion(s) skipped — commit not an ancestor of ${trunk} ` +
        `(off-trunk / unmerged): ${droppedOffTrunk.join("  ")}`,
    );
  }

  // FIX-461 detection: assert every currently-completed FIX-ID is backed by at
  // least one commit that is actually on trunk. Catches done.log rows that were
  // recorded against off-trunk SHAs before the prevention filter existed (the
  // b68c310f case). Combine the existing log with this run's new rows so a sync
  // that both records and validates sees the post-sync state.
  let trunkViolations = [];
  if (trunk) {
    const combined = [...done.entries, ...newEntries.map((c) => ({ id: c.id, sha: c.sha }))];
    const completingShasById = buildCompletingShasById(combined);
    const res = evaluateTrunkViolations({
      completedIds: allCompleted,
      completingShasById,
      resolve: (sha) => classifySha(sha, trunk),
    });
    trunkViolations = res.violations;
    if (trunkViolations.length) {
      console.error(
        `\n✗ ${trunkViolations.length} completed FIX-ID(s) backed only by off-trunk commits ` +
          `(not ancestors of ${trunk}) — recorded as done but never shipped:`,
      );
      for (const v of trunkViolations) console.error(`    ${v.id}  (SHAs: ${v.shas.join(", ")})`);
      console.error(
        "  Re-land the code on main (cherry-pick → push), then append the real main SHA via a\n" +
          "  `Fixes:` trailer + fixes:sync. See FIX-461 / the silent-zero-sweep-tail incident.",
      );
    }
  }

  // Drift is enforced only by the full `--check` (PRs). On push-to-main
  // (`--check-trunk`) the code commit and its follow-up fixes:sync commit are
  // separate pushes, so the code-commit push is always transiently out of sync
  // — failing on drift there is guaranteed noise (see usage header).
  if (CHECK && !CHECK_TRUNK && (newEntries.length > 0 || flipped.length > 0)) {
    console.error("\nFIXES.md is out of sync with commit trailers. Run `pnpm fixes:sync`.");
    process.exit(1);
  }
  // The trunk-ancestry guard is the dangerous case — enforced on every push.
  if (anyCheck && trunkViolations.length > 0) {
    console.error("\ndone.log claims FIX-IDs shipped whose code is not on trunk. See above.");
    process.exit(1);
  }
}

// Run main only when invoked directly (not when imported by the test harness).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
