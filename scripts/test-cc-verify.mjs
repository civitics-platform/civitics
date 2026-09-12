#!/usr/bin/env node
// scripts/test-cc-verify.mjs
//
// Assertion harness for scripts/cc-verify.mjs (FIX-1175) — the front-matter
// parser and the claim checks.
//
// Run:   pnpm cc:verify:test
// Exit:  0 on pass, 1 on fail.
//
// Playbook rule E10: a verifier that cannot fail is not a verifier. Every
// check below is exercised twice — once with a report that should PASS and once
// with the same report holding a claim the injected tree contradicts. The
// context is injected (no git, no fs), so the checks are exercised directly
// rather than through a scratch repo.

import { parseFrontMatter, verifyReport, PASS, FAIL, UNCHECKED } from "./cc-verify.mjs";
import { parseDoneLog, deriveStatus } from "./lib/fix-status.mjs";

const failures = [];
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`  x ${label}\n     expected: ${e}\n     actual:   ${a}`);
  else console.log(`  ok ${label}`);
}
function assertTrue(label, cond, detail = "") {
  if (cond) console.log(`  ok ${label}`);
  else failures.push(`  x ${label}${detail ? `\n     ${detail}` : ""}`);
}

// -- 1. front-matter parser -------------------------------------------------
console.log("parseFrontMatter:");
const FM_TEXT = [
  "---",
  "cc: 122",
  "prompt: cc-prompt-122-something.md",
  "started_at: 2026-09-12T04:00:00Z",
  "head_before: aaaaaaa1",
  "head_after: dddddddd",
  "commits:",
  "  - {sha: aaaaaaa1, subject: first commit, with a comma}",
  "  - {sha: bbbbbbb2, subject: second}",
  "fixes_closed: [FIX-100, FIX-101]",
  "fixes_filed: [FIX-200]",
  "fixes_reopened: [FIX-300]",
  "migrations_pushed: []",
  "prod_writes: none",
  "ci: green",
  "stopped_items:",
  "  - item four refused because the tree disagreed",
  "---",
  "",
  "# body",
].join("\n");

const fm = parseFrontMatter(FM_TEXT);
assertEq("scalar", fm.cc, "122");
assertEq("inline list", fm.fixes_closed, ["FIX-100", "FIX-101"]);
assertEq("empty inline list", fm.migrations_pushed, []);
assertEq("block list of maps — count", fm.commits.length, 2);
assertEq("map keys", fm.commits[0].sha, "aaaaaaa1");
assertTrue(
  "a comma INSIDE a map value does not split the entry",
  fm.commits[0].subject === "first commit, with a comma",
  `got ${JSON.stringify(fm.commits[0].subject)}`,
);
assertEq("block list of scalars", fm.stopped_items, ["item four refused because the tree disagreed"]);
assertEq("CRLF front matter parses", parseFrontMatter(FM_TEXT.replace(/\n/g, "\r\n")).ci, "green");
let threw = null;
try {
  parseFrontMatter("# no front matter\n");
} catch (e) {
  threw = e;
}
assertTrue("a report with no front matter throws", threw !== null);

// -- 2. the checks, against an injected tree --------------------------------
// aaaaaaa1 + bbbbbbb2 are on trunk. ccccccc3 exists but is NOT (an unmerged
// branch — the FIX-461 shape). eeeeeee5 does not exist at all.
const ON_TRUNK = new Set(["aaaaaaa1", "bbbbbbb2", "dddddddd"]);
const EXISTS = new Set([...ON_TRUNK, "ccccccc3"]);

const DONE_LOG = [
  "2026-09-12 | FIX-100 | aaaaaaa1 | local-only | closed by this run",
  "2026-09-12 | FIX-101 | bbbbbbb2 | local+prod | also closed by this run",
  "2026-01-01 | FIX-102 | 99999999 | local-only | closed MONTHS ago by someone else",
  "2026-09-12 | FIX-300 | aaaaaaa1 | local-only | closed",
  "2026-09-12 | FIX-300 | reopen | reopen | reopened by bbbbbbb2 it came back",
  "2026-09-12 | FIX-301 | aaaaaaa1 | local-only | closed and never reopened",
].join("\n");

const ctx = {
  statusMap: deriveStatus(parseDoneLog(DONE_LOG)),
  fixesText: "- 🟠 M — **filed** — body <!--id:FIX-200-->",
  archiveText: "",
  trunkRef: "origin/main",
  resolveSha: (sha) => (EXISTS.has(sha) ? sha : null),
  isAncestor: (sha) => ON_TRUNK.has(sha),
  fileOnTrunk: (rel) => rel === "supabase/migrations/20260912000000_real.sql",
  ghCi: { status: "completed", conclusion: "success", headSha: "dddddddd", displayTitle: "t" },
};

const verdictFor = (results, needle) =>
  results.find((r) => r.claim.includes(needle))?.verdict ?? "(no such claim)";

console.log("\nverifyReport — the good report:");
const good = verifyReport(fm, ctx);
assertEq("no FAILs", good.filter((r) => r.verdict === FAIL).map((r) => r.claim), []);
assertEq("commit on trunk passes", verdictFor(good, "commit aaaaaaa1 is on"), PASS);
assertEq("head_after on trunk passes", verdictFor(good, "head_after is on"), PASS);
assertEq("close attributed to this run passes", verdictFor(good, "FIX-100 closed by this run"), PASS);
assertEq("filed marker passes", verdictFor(good, "FIX-200 filed"), PASS);
assertEq("reopen passes", verdictFor(good, "FIX-300 reopened"), PASS);
assertEq("empty migrations passes", verdictFor(good, "migrations_pushed[] empty"), PASS);
assertEq("prod_writes: none passes", verdictFor(good, "prod_writes: none"), PASS);
assertEq("ci green cross-checked against gh", verdictFor(good, "ci: green"), PASS);

// -- 3. THE FIXTURE THE PROMPT ASKS FOR: one wrong sha, one wrong close -----
console.log("\nverifyReport — one wrong sha, one wrong close (must FAIL FAIL):");
const badFm = parseFrontMatter(
  FM_TEXT
    // ccccccc3 exists but is off-trunk — the stranded-PR shape.
    .replace("{sha: bbbbbbb2, subject: second}", "{sha: ccccccc3, subject: second}")
    // FIX-102 is genuinely closed, but by a commit that is not this run's.
    .replace("fixes_closed: [FIX-100, FIX-101]", "fixes_closed: [FIX-100, FIX-102]"),
);
const bad = verifyReport(badFm, ctx);
assertEq("off-trunk commit FAILs", verdictFor(bad, "commit ccccccc3 is on"), FAIL);
assertEq("close not attributable to this run FAILs", verdictFor(bad, "FIX-102 closed by this run"), FAIL);
assertEq("exactly two FAILs", bad.filter((r) => r.verdict === FAIL).length, 2);
assertTrue(
  "the off-trunk FAIL says why",
  /NOT an ancestor/.test(bad.find((r) => r.claim.includes("ccccccc3"))?.detail ?? ""),
);
assertTrue(
  "the close FAIL names the rows it did find",
  /99999999/.test(bad.find((r) => r.claim.includes("FIX-102"))?.detail ?? ""),
);

// -- 4. the remaining failure modes, one case each ---------------------------
console.log("\nverifyReport — the other ways a claim can be wrong:");
const mk = (repl) => parseFrontMatter(repl.reduce((t, [a, b]) => t.replace(a, b), FM_TEXT));

assertEq(
  "a sha that does not exist at all FAILs",
  verdictFor(verifyReport(mk([["{sha: aaaaaaa1", "{sha: eeeeeee5"]]), ctx), "commit eeeeeee5 exists"),
  FAIL,
);
assertEq(
  "claiming a close with no done.log row FAILs",
  verdictFor(verifyReport(mk([["[FIX-100, FIX-101]", "[FIX-999]"]]), ctx), "FIX-999 closed"),
  FAIL,
);
assertEq(
  "claiming a file for an id with no marker FAILs",
  verdictFor(verifyReport(mk([["fixes_filed: [FIX-200]", "fixes_filed: [FIX-201]"]]), ctx), "FIX-201 filed"),
  FAIL,
);
assertEq(
  "claiming a reopen for an id that derives CLOSED FAILs",
  verdictFor(verifyReport(mk([["fixes_reopened: [FIX-300]", "fixes_reopened: [FIX-301]"]]), ctx), "FIX-301 reopened"),
  FAIL,
);
assertEq(
  "a migration file not on trunk FAILs",
  verdictFor(verifyReport(mk([["migrations_pushed: []", "migrations_pushed: [20260101000000_ghost.sql]"]]), ctx),
    "migration 20260101000000_ghost.sql is on"),
  FAIL,
);
assertEq(
  "a migration file that IS on trunk passes",
  verdictFor(verifyReport(mk([["migrations_pushed: []", "migrations_pushed: [20260912000000_real.sql]"]]), ctx),
    "migration 20260912000000_real.sql is on"),
  PASS,
);
assertEq(
  "...but whether it reached Pro is UNCHECKED, never a silent pass",
  verdictFor(verifyReport(mk([["migrations_pushed: []", "migrations_pushed: [20260912000000_real.sql]"]]), ctx),
    "applied to Pro"),
  UNCHECKED,
);
assertEq(
  "omitting prod_writes FAILs",
  verdictFor(verifyReport(mk([["prod_writes: none", "prod_writes:"]]), ctx), "prod_writes stated"),
  FAIL,
);
assertEq(
  "describing prod writes is UNCHECKED (a human reads it)",
  verdictFor(verifyReport(mk([["prod_writes: none", "prod_writes: one rebuild on prod"]]), ctx), "prod_writes described"),
  UNCHECKED,
);
assertEq(
  "omitting ci FAILs",
  verdictFor(verifyReport(mk([["ci: green", "ci:"]]), ctx), "ci stated"),
  FAIL,
);
assertEq(
  "ci: green while gh says failure FAILs",
  verdictFor(verifyReport(fm, { ...ctx, ghCi: { status: "completed", conclusion: "failure" } }), "ci: green"),
  FAIL,
);
assertEq(
  "ci: green with gh unavailable is UNCHECKED, not PASS",
  verdictFor(verifyReport(fm, { ...ctx, ghCi: null }), "ci: green"),
  UNCHECKED,
);
assertEq(
  "a missing head_after FAILs",
  verdictFor(verifyReport(mk([["head_after: dddddddd", "head_after:"]]), ctx), "front matter has `head_after`"),
  FAIL,
);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\ncc:verify:test — all assertions passed.");
