#!/usr/bin/env node
// scripts/test-fixes-clean.mjs
//
// End-to-end fixtures for scripts/fixes-clean.mjs, run the way the weekly bot
// runs it (FIX-1345): the real script, in a child process, against a throwaway
// repo whose docs/FIXES.md + docs/done.log are written here. The grace period
// (`--older-than N`) is the thing under test: a closed bullet moves only when
// its LAST done.log row is dated <= today - N, so the week's closures stay put
// while that week's worktrees are still landing.
//
// Dates are relative to the real UTC today — the same clock the script reads —
// so there is no seam to forget to turn off.
//
// Run:   pnpm fixes:clean:test   (also part of pnpm fixes:test)
// Exit:  0 on pass, 1 on fail.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "fixes-clean.mjs");

const failures = [];
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`  ✗ ${label}\n     expected: ${e}\n     actual:   ${a}`);
  else console.log(`  ✓ ${label}`);
}
function assertTrue(label, cond, detail = "") {
  if (cond) console.log(`  ✓ ${label}`);
  else failures.push(`  ✗ ${label}${detail ? `\n     ${detail}` : ""}`);
}

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

const PILLARS = [
  "## STRATEGIC PILLARS",
  "",
  "- 🟣 L — **pillar, closed long ago** — directional, never a source <!--id:FIX-9001-->",
  "",
].join("\n");

const COMPLETED = [
  "## COMPLETED (archive, don't delete — useful reference)",
  "",
  "_Completed items moved here by `pnpm fixes:clean`. `pnpm fixes:archive` moves them to `docs/archive/fixes-archive.md`._",
  "",
  "### OLD SECTION",
  "",
  "- 🟢 S — **already in COMPLETED** — the destination, never a source <!--id:FIX-9201-->",
  "",
].join("\n");

const LIVE = [
  "## TEST LIVE",
  "",
  "- 🟠 S — **closed 30 d ago** — moves under the grace <!--id:FIX-9101-->",
  "- 🟠 S — **closed 2 d ago** — stays under the grace <!--id:FIX-9102-->",
  "- 🟠 S — **open, no row** — never moves <!--id:FIX-9103-->",
  "- 🟠 S — **reopened** — last row is a reopen, so it is open <!--id:FIX-9104-->",
  "- 🟠 S — **closed exactly 7 d ago** — the boundary is inclusive <!--id:FIX-9105-->",
  "- 🟠 S — **closed 6 d ago** — one day inside the grace <!--id:FIX-9106-->",
  "- 🟡 S — **no marker** — can never be closed, reported not moved",
  "",
].join("\n");

const FIXES = ["# FIXES", "", "Preamble prose.", "", PILLARS, LIVE, "---", "", COMPLETED].join("\n");

const DONE = [
  "# date | id | sha | verified | note",
  `${daysAgo(30)} | FIX-9001 | aaaa0001 | local-only | pillar`,
  `${daysAgo(30)} | FIX-9101 | aaaa9101 | local-only | old close`,
  `${daysAgo(2)} | FIX-9102 | aaaa9102 | local-only | young close`,
  `${daysAgo(40)} | FIX-9104 | aaaa9104 | local-only | closed once`,
  `${daysAgo(35)} | FIX-9104 | reopen | unverified | came back`,
  `${daysAgo(7)} | FIX-9105 | aaaa9105 | local-only | boundary close`,
  `${daysAgo(6)} | FIX-9106 | aaaa9106 | local-only | inside the grace`,
  `${daysAgo(90)} | FIX-9201 | aaaa9201 | local-only | already completed`,
  "",
].join("\n");

function fixtureRepo(fixes = FIXES, done = DONE) {
  const dir = mkdtempSync(join(tmpdir(), "fixes-clean-"));
  const g = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@example.invalid"]);
  g(["config", "user.name", "T"]);
  g(["config", "commit.gpgsign", "false"]);
  // A throwaway repo must not inherit the root `prepare` script's hooks.
  g(["config", "core.hooksPath", join(dir, "no-hooks")]);
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "FIXES.md"), fixes);
  writeFileSync(join(dir, "docs", "done.log"), done);
  g(["add", "docs"]);
  g(["commit", "-q", "-m", "seed"]);
  return dir;
}

function runClean(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const readFixes = (dir) => readFileSync(join(dir, "docs", "FIXES.md"), "utf8");

/** The `## ` section whose body holds `<!--id:ID-->`, or null. */
function sectionOf(text, id) {
  let section = null;
  for (const line of text.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) section = m[1];
    else if (line.includes(`<!--id:${id}-->`)) return section;
  }
  return null;
}
const isCompleted = (s) => /^COMPLETED\b/.test(s ?? "");

/** The text of one `## ` section, header included, up to the next `## `. */
function sectionText(text, headerPrefix) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(headerPrefix));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join("\n").replace(/\n+$/, "");
}

const dirs = [];
try {
  // ── 1. --older-than 7, applied ──────────────────────────────────────────
  console.log("--older-than 7 (applied):");
  {
    const dir = fixtureRepo();
    dirs.push(dir);
    const { code, out } = runClean(dir, ["--older-than", "7"]);
    const text = readFixes(dir);
    assertEq("exits 0", code, 0);
    assertTrue("closed 30 d ago MOVES to COMPLETED", isCompleted(sectionOf(text, "FIX-9101")), `in ${sectionOf(text, "FIX-9101")}`);
    assertTrue("closed exactly 7 d ago MOVES (<= today - 7 is inclusive)", isCompleted(sectionOf(text, "FIX-9105")), `in ${sectionOf(text, "FIX-9105")}`);
    assertEq("closed 2 d ago STAYS in its live section", sectionOf(text, "FIX-9102"), "TEST LIVE");
    assertEq("closed 6 d ago STAYS in its live section", sectionOf(text, "FIX-9106"), "TEST LIVE");
    assertEq("an OPEN bullet (no row) stays", sectionOf(text, "FIX-9103"), "TEST LIVE");
    assertEq("a reopen-last bullet stays", sectionOf(text, "FIX-9104"), "TEST LIVE");
    assertTrue("the no-marker bullet stays in its live section", sectionText(text, "## TEST LIVE").includes("**no marker**"));
    assertTrue("the no-marker bullet is reported", /bulletsWithoutIdMarker\s*│\s*1\b/.test(out) && /can never\s+be closed or moved/.test(out), out);
    assertEq("STRATEGIC PILLARS untouched (byte-equal)", sectionText(text, "## STRATEGIC PILLARS"), sectionText(FIXES, "## STRATEGIC PILLARS"));
    assertTrue("the existing COMPLETED bullet is still there, once", text.split("<!--id:FIX-9201-->").length === 2);
    assertEq("FIX-9201 still under COMPLETED", isCompleted(sectionOf(text, "FIX-9201")), true);
    assertTrue("prints bulletsMoved 2", /bulletsMoved\s*│\s*2\b/.test(out), out);
    assertTrue(
      "prints the deferred set on one line",
      out.includes("left in place: 2 closed bullet(s) younger than 7 d — FIX-9102, FIX-9106"),
      out,
    );
  }

  // ── 2. --older-than 7 --dry-run writes nothing ──────────────────────────
  console.log("\n--older-than 7 --dry-run:");
  {
    const dir = fixtureRepo();
    dirs.push(dir);
    const { code, out } = runClean(dir, ["--older-than", "7", "--dry-run"]);
    assertEq("exits 0", code, 0);
    assertEq("FIXES.md byte-identical", readFixes(dir), FIXES);
    assertTrue("still reports what it would move (2) and defer", /bulletsMoved\s*│\s*2\b/.test(out) && out.includes("left in place: 2"), out);
    assertTrue("says DRY RUN", out.includes("DRY RUN"), out);
  }

  // ── 3. No flag: today's hand-run behaviour, unchanged ───────────────────
  console.log("\nno flag (every closed bullet, any age):");
  {
    const dir = fixtureRepo();
    dirs.push(dir);
    const { code, out } = runClean(dir, []);
    const text = readFixes(dir);
    assertEq("exits 0", code, 0);
    for (const id of ["FIX-9101", "FIX-9102", "FIX-9105", "FIX-9106"]) {
      assertTrue(`${id} moves with no flag`, isCompleted(sectionOf(text, id)), `in ${sectionOf(text, id)}`);
    }
    assertEq("FIX-9103 (open) stays", sectionOf(text, "FIX-9103"), "TEST LIVE");
    assertEq("FIX-9104 (reopened) stays", sectionOf(text, "FIX-9104"), "TEST LIVE");
    assertEq("STRATEGIC PILLARS untouched", sectionText(text, "## STRATEGIC PILLARS"), sectionText(FIXES, "## STRATEGIC PILLARS"));
    assertTrue("no deferred line without the flag", !out.includes("left in place"), out);
  }

  // ── 4. --older-than=0 (the `=` form): closed today or earlier moves ─────
  console.log("\n--older-than=0:");
  {
    const dir = fixtureRepo();
    dirs.push(dir);
    const { code } = runClean(dir, ["--older-than=0"]);
    const text = readFixes(dir);
    assertEq("exits 0", code, 0);
    assertTrue("closed 2 d ago moves at N = 0", isCompleted(sectionOf(text, "FIX-9102")));
  }

  // ── 5. Nothing eligible: the file is not rewritten ──────────────────────
  // The bot skips its commit on an empty diff. A 0-move run that re-rendered
  // whitespace would turn that skip into a "0 bullet(s)" commit.
  console.log("\nnothing eligible under the grace:");
  {
    const youngOnly = [
      "# date | id | sha | verified | note",
      `${daysAgo(30)} | FIX-9001 | aaaa0001 | local-only | pillar`,
      `${daysAgo(2)} | FIX-9101 | aaaa9101 | local-only | young`,
      `${daysAgo(90)} | FIX-9201 | aaaa9201 | local-only | already completed`,
      "",
    ].join("\n");
    const dir = fixtureRepo(FIXES, youngOnly);
    dirs.push(dir);
    const { code, out } = runClean(dir, ["--older-than", "7"]);
    assertEq("exits 0", code, 0);
    assertEq("FIXES.md byte-identical after a non-dry 0-move run", readFixes(dir), FIXES);
    assertTrue("prints bulletsMoved 0", /bulletsMoved\s*│\s*0\b/.test(out), out);
    assertTrue("names the deferred bullet", out.includes("left in place: 1 closed bullet(s) younger than 7 d — FIX-9101"), out);
  }

  // ── 6. A bad --older-than exits 2 and writes nothing ────────────────────
  console.log("\nbad --older-than values:");
  for (const bad of [["--older-than", "x"], ["--older-than", "-1"], ["--older-than", "1.5"], ["--older-than"], ["--older-than="]]) {
    const dir = fixtureRepo();
    dirs.push(dir);
    const { code, out } = runClean(dir, bad);
    assertEq(`${JSON.stringify(bad)} exits 2`, code, 2);
    assertTrue(`${JSON.stringify(bad)} prints a usage line`, /usage: .*--older-than/i.test(out), out);
    assertEq(`${JSON.stringify(bad)} leaves FIXES.md byte-identical`, readFixes(dir), FIXES);
  }
} finally {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}

if (failures.length) {
  console.error("\nFAIL:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\nfixes:clean:test — all assertions passed.");
