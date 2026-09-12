#!/usr/bin/env node
// scripts/fixes-sync.mjs
//
// One-way sync from git commit trailers into docs/done.log.
//
//   1. Scans `git log` for commits whose body contains `Fixes: FIX-NNN[, FIX-MMM]`
//      (code-level fix), `Closes: FIX-NNN[, FIX-MMM]` (administrative closure
//      for superseded / redirected / recognized prior work / no-op — FIX-314),
//      or `Reopens: FIX-NNN` (FIX-1016).
//   2. Appends any new rows to docs/done.log. Append-only — existing lines are
//      never rewritten.
//
//   It does NOT touch docs/FIXES.md (FIX-1016 D4). That file is hand-edited
//   only: prose and an `<!--id:FIX-NNN-->` marker, no status. Status is DERIVED
//   from docs/done.log by scripts/lib/fix-status.mjs and answered by
//   `pnpm fixes:status`. Two files, two writer classes, no overlap — which is
//   what removes the concurrent-write class rather than detecting it. A reopen
//   is `pnpm fix:reopen` or a `Reopens:` trailer; both are appends.
//
// Usage:
//   node scripts/fixes-sync.mjs              scan trailers, append to docs/done.log
//   node scripts/fixes-sync.mjs --dry-run    show what would change, write nothing
//   node scripts/fixes-sync.mjs --check      exit 1 on ANY of: drift (a trailer on trunk
//                                            with no done.log row), a trunk-ancestry
//                                            violation, or a bullet whose checkbox
//                                            contradicts the derived status (FIX-1016 D7).
//                                            Used on PRs, where code + sync commits are
//                                            evaluated against main together. Prints the
//                                            derived open count.
//   node scripts/fixes-sync.mjs --check-trunk exit 1 ONLY on a trunk-ancestry violation;
//                                            ignores drift. Used on push-to-main: the
//                                            standard loop lands the `Fixes:` code commit
//                                            and its follow-up `fixes:sync` commit as two
//                                            separate pushes, so the code-commit push is
//                                            *always* transiently out of sync — failing on
//                                            drift there is guaranteed noise. The dangerous
//                                            case (done.log claims a FIX shipped whose code
//                                            is off-trunk) is still enforced on every push,
//                                            as is the FIX-1016 checkbox assertion.

import { execSync } from "node:child_process";
// No writeFileSync: FIX-1016 D4 left this script with exactly one write, and it
// is an append to docs/done.log.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { captureTrunkState, abortOnTrunkMove } from "./lib/trunk-guard.mjs";
import { deriveStatus } from "./lib/fix-status.mjs";
import { walkFixBullets } from "./lib/fixes-md.mjs";

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
  const cacheKey = `${trunk}\0${sha}`;
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
  // FIX-1016 D5: a reopen can ride the commit that discovered the regression,
  // instead of being a hand edit in two places. Same case-sensitive,
  // multi-line, comma-or-stacked shape as its two siblings.
  const reopensRe = /^\s*Reopens:\s*(.+)$/gm;
  const verifiedRe = /^\s*Verified:\s*(.+)$/m;
  const verifiedPerFixRe = /^\s*Verified\[(FIX-\d+)\]:\s*(.+)$/gm;
  const idRe = /FIX-\d+/g;

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
  const reopensIds = collectIds(reopensRe);

  // FIX-314: if an ID appears in both trailers in the same commit, Fixes:
  // wins (code-level fix is the stronger signal). Warn so we notice.
  const conflicts = [...closesIds].filter((id) => fixesIds.has(id));
  if (conflicts.length > 0) {
    warnings.push(
      `lists ${conflicts.join(", ")} in both Fixes: and Closes: trailers; Fixes: wins.`,
    );
    for (const id of conflicts) closesIds.delete(id);
  }

  // FIX-1016: a commit that both closes and reopens the same id is
  // self-contradictory. Drop the reopen and warn — the closing trailer is the
  // deliberate one (you do not write `Fixes:` by accident), and a reopen is
  // always recoverable with `pnpm fix:reopen`.
  const reopenConflicts = [...reopensIds].filter((id) => fixesIds.has(id) || closesIds.has(id));
  if (reopenConflicts.length > 0) {
    warnings.push(
      `lists ${reopenConflicts.join(", ")} in Reopens: as well as Fixes:/Closes:; the closing trailer wins.`,
    );
    for (const id of reopenConflicts) reopensIds.delete(id);
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
  const allTrailerIds = new Set([...fixesIds, ...closesIds, ...reopensIds]);
  for (const id of perFixVerified.keys()) {
    if (!allTrailerIds.has(id)) {
      warnings.push(
        `has Verified[${id}] but ${id} is not in Fixes: or Closes:; ignoring.`,
      );
      perFixVerified.delete(id);
    }
  }

  return { fixesIds, closesIds, reopensIds, globalVerified, perFixVerified, warnings };
}

// ── done.log dedup key (FIX-1016) ───────────────────────────────────────────
// A closing row is unique by (id, sha) — the same commit re-scanned must not
// append twice. A REOPEN row cannot use that key: its sha column is the literal
// `reopen`, so (id, 'reopen') would collapse every reopen of one id into the
// first, and a second, genuinely-new reopen would be silently dropped. The
// commit sha lives in the note (`reopened by <sha> <subject>`), so the key for a
// reopen row is (id, 'reopen', that sha). Two reopens of one id on different
// commits both land; one commit re-scanned still dedups. Hand-written reopen
// rows — every one of the 22 already in the log — carry no sha in their note and
// therefore key on the note itself, which can never collide with a trailer
// reopen. The done.log FORMAT is unchanged; this is purely a read-side key.
export const REOPEN_NOTE_SHA_RE = /^reopened by ([0-9a-f]{7,40})\b/;

export function doneLogKey(entry) {
  if (entry.sha !== "reopen") return `${entry.id}|${entry.sha}`;
  const m = REOPEN_NOTE_SHA_RE.exec(entry.note ?? "");
  return `${entry.id}|reopen|${m ? m[1] : (entry.note ?? "")}`;
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
    keys.add(doneLogKey({ id, sha, note }));
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
    if (parsed.fixesIds.size === 0 && parsed.closesIds.size === 0 && parsed.reopensIds.size === 0)
      continue;
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
    // FIX-1016 D5: `Reopens:` appends a reopen row — sha column is the literal
    // `reopen` (that is what the derivation reads), and the COMMIT sha is
    // carried in the note so the dedup key can tell two reopens apart.
    // `commitSha` rides on the object for the off-trunk filter only; it is not
    // a column and never reaches the file.
    for (const id of parsed.reopensIds) {
      completions.push({
        id,
        sha: "reopen",
        commitSha: shortSha,
        date: dateText,
        verified: "reopen",
        note: `reopened by ${shortSha} ${noteText}`,
      });
    }
  }
  return completions;
}

function appendNewEntries(existing, completions, { dry }) {
  const seen = existing.keys;
  const newOnes = completions.filter((c) => !seen.has(doneLogKey(c)));
  if (newOnes.length === 0) return [];
  // Stable sort: date ascending, then id.
  newOnes.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const lines = newOnes.map(
    (c) => `${c.date} | ${c.id} | ${c.sha} | ${c.verified ?? "unverified"} | ${c.note}`,
  );
  if (!dry) appendFileSync(DONE_PATH, lines.join("\n") + "\n");
  return newOnes;
}

// FIX-1016 D4: `syncFixesMd` is gone. It read the whole of docs/FIXES.md,
// transformed it in memory and wrote the whole file back on every sync — an
// in-place machine write to a hand-edited file, which is the entire
// concurrent-write class (a hand edit landing in that window was reverted with
// no conflict, no error, and a diff that looked intentional). It also carried
// the CRLF silent no-op: the read normalised CRLF but the bullet regex still had
// to match, and a mismatch was indistinguishable from nothing-to-do.
//
// What replaces it: nothing writes status into the markdown. `readFixesMd`
// below only READS, to report bullets missing an id marker and to run the D7
// detector. docs/FIXES.md is opened for writing by exactly two things now —
// `fix:add` (an append) and the two housekeeping tools a human runs
// deliberately, both still behind the trunk guard.
function readFixesMd() {
  const bullets = walkFixBullets(readFileSync(FIXES_PATH, "utf8"));
  return {
    bullets: bullets.filter((b) => b.id),
    // A live bullet with no `<!--id:FIX-NNN-->` marker cannot be referenced by a
    // commit trailer, so it can never be closed. `pnpm fixes:housekeep` assigns
    // one. (Archived bullets are exempt — the COMPLETED section is a holding
    // pen, and the legacy pre-FIX-NNN entries there never had ids.)
    missingMarker: bullets
      .filter((b) => !b.id && !/^COMPLETED\b/i.test(b.section ?? ""))
      .map((b) => b.line.slice(0, 80)),
  };
}

function main() {
  const DRY = process.argv.includes("--dry-run");
  const CHECK = process.argv.includes("--check");
  const CHECK_TRUNK = process.argv.includes("--check-trunk");
  const anyCheck = CHECK || CHECK_TRUNK;
  const writeMode = !DRY && !anyCheck;

  // Concurrent-write guard: snapshot trunk BEFORE the read half. `scanCommits()`
  // walks all of git log, so the read-to-write window here is seconds wide and
  // spans exactly the moment another session's commit would land. Re-checked
  // immediately before the first write below. Check/dry modes write nothing and
  // therefore need no guard.
  //
  // FIX-1016 narrowed what this protects: the only write left is an APPEND to
  // docs/done.log, which merges rather than reverting. The guard stays because a
  // trunk move still means this run's scan is stale — it would append rows the
  // other session has already appended, and the dedup key only catches that on
  // the NEXT run. A loud refusal beats a duplicated row.
  const trunkBefore = captureTrunkState();

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
      // `commitSha` for a reopen entry, whose own `sha` column is the literal
      // `reopen` and would classify as "unknown" — i.e. a `Reopens:` trailer on
      // an unmerged branch would otherwise sail straight past this filter.
      const judgeSha = c.commitSha ?? c.sha;
      if (classifySha(judgeSha, trunk) === "not-ancestor") {
        droppedOffTrunk.push(`${c.id}|${judgeSha}`);
        return false;
      }
      return true;
    });
  } else {
    console.warn("warn: no trunk ref (origin/main|main) resolved — skipping FIX-461 off-trunk filter + check.");
  }

  if (writeMode) {
    abortOnTrunkMove(trunkBefore, {
      operation: "fixes:sync (append docs/done.log)",
      files: ["docs/done.log"],
    });
  }

  const newEntries = appendNewEntries(done, trailerCompletions, { dry: !writeMode });
  // FIX-1016 D1: ONE derivation, in scripts/lib/fix-status.mjs. Feed it the
  // existing log plus this run's new rows, in that order, so a sync that both
  // records and validates sees the post-sync state. This replaces the
  // open-coded "add every new id to the completed set", which was wrong the
  // moment `Reopens:` existed — a reopen row is a new entry that must REMOVE
  // an id from the completed set, not add it.
  const derived = deriveStatus([...done.entries, ...newEntries]);
  const allCompleted = new Set(
    [...derived].filter(([, v]) => v.status === "closed").map(([id]) => id),
  );
  const { bullets: liveBullets, missingMarker } = readFixesMd();

  // FIX-1016 D7 detector. It licenced the strip: at the moment the checkboxes
  // were removed it asserted that every one of them agreed with the derived
  // status (407 bullets, 0 mismatches, measured twice). Afterwards there are no
  // boxed bullets and it is vacuous BY CONSTRUCTION — which is the point, the
  // information moved into the log instead of being duplicated into two places
  // that can disagree. It is kept, and kept blocking, because it is now the
  // thing that catches a checkbox being hand-reintroduced.
  const boxMismatches = liveBullets
    .filter((b) => b.box !== null)
    .filter((b) => (b.box.toLowerCase() === "x") !== allCompleted.has(b.id))
    .map((b) => ({ id: b.id, box: `[${b.box}]`, derived: allCompleted.has(b.id) ? "closed" : "open" }));

  const summary = {
    trailersScanned: trailerCompletions.length,
    newLoggedEntries: newEntries.length,
    bulletsMissingIdMarker: missingMarker.length,
    liveBullets: liveBullets.length,
    liveBulletsOpen: liveBullets.filter((b) => !allCompleted.has(b.id)).length,
    checkboxesFound: liveBullets.filter((b) => b.box !== null).length,
    checkboxMismatches: boxMismatches.length,
  };

  console.log("fixes:sync —", DRY ? "DRY RUN" : CHECK_TRUNK ? "CHECK MODE (trunk-only)" : CHECK ? "CHECK MODE" : "APPLIED");
  console.table(summary);
  if (newEntries.length) {
    console.log("\nNew done.log entries:");
    for (const e of newEntries)
      console.log(`  ${e.date} | ${e.id} | ${e.sha} | ${e.verified ?? "unverified"} | ${e.note}`);
  }
  if (summary.checkboxesFound > 0) {
    console.warn(
      `\n⚠ ${summary.checkboxesFound} live bullet(s) still carry a \`[ ]\`/\`[x]\` checkbox. ` +
        "Status is derived from docs/done.log (FIX-1016); the box is dead markup and will drift.",
    );
  }
  if (boxMismatches.length) {
    console.error(
      `\n✗ ${boxMismatches.length} bullet(s) whose checkbox disagrees with the status derived ` +
        "from docs/done.log (FIX-1016 D7):",
    );
    for (const m of boxMismatches) console.error(`    ${m.id}  markdown ${m.box}  derived ${m.derived}`);
    console.error(
      "  docs/done.log is the source of truth. Either the bullet was hand-edited, or a\n" +
        "  completion row is missing. Do NOT hand-fix the box — append the row, or run\n" +
        "  `pnpm fix:reopen` — then re-run. (`pnpm fixes:status <id>` shows the log's answer.)",
    );
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

  // Drift = a `Fixes:`/`Closes:`/`Reopens:` trailer on a commit that IS on
  // trunk but has no row in docs/done.log. (`trailerCompletions` is already
  // trunk-filtered, so an unmerged branch's trailer is not drift.) Enforced
  // only by the full `--check` (PRs). On push-to-main (`--check-trunk`) the
  // code commit and its follow-up fixes:sync commit are separate pushes, so the
  // code-commit push is always transiently out of sync — failing on drift there
  // is guaranteed noise (see usage header).
  if (CHECK && !CHECK_TRUNK && newEntries.length > 0) {
    console.error("\ndocs/done.log is out of sync with commit trailers. Run `pnpm fixes:sync`.");
    process.exit(1);
  }
  // FIX-1016 D7: the derived==checkbox assertion is the detector that licences
  // the strip, so it is enforced in BOTH check modes — including on push-to-main,
  // where a divergence means someone hand-edited a box rather than appending a
  // row. Once the boxes are gone there are no boxed bullets and this can only
  // fire on a hand-reintroduced one, which is precisely what it should catch.
  if (anyCheck && boxMismatches.length > 0) {
    console.error(
      "\ndocs/FIXES.md carries checkbox state that contradicts docs/done.log. See above.",
    );
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
