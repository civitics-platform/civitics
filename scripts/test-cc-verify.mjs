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

import { parseFrontMatter, verifyReport, loadReportFrontMatter, PASS, FAIL, UNCHECKED } from "./cc-verify.mjs";
import { renderSidecar } from "./cc-report-json.mjs";
import { readPrompt, markerBody, teardownLine } from "./cc-prompt.mjs";
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

// -- 3. the cc-<n>.json sidecar --------------------------------------------
// The sidecar is generated from the .md (`pnpm cc:json`), so the only way the
// two can disagree is a hand edit to one of them — which is exactly the report
// a verifier must not pass. Both directions are exercised: a disagreement FAILs,
// and a report with no sidecar at all still verifies from the .md.
console.log("\n.json sidecar:");

const SIDECAR_MD = "/fake/docs/cc/reports/cc-999.md";
const SIDECAR_JSON = "/fake/docs/cc/reports/cc-999.json";

// A tiny injected fs so the loader is exercised without touching disk.
const io = (files) => ({
  existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
  readFileSync: (p) => {
    if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
    return files[p];
  },
});

// (a) agreeing sidecar — read from the .json, no drift
const agreeing = JSON.stringify(parseFrontMatter(FM_TEXT), null, 2);
const okLoad = loadReportFrontMatter(SIDECAR_MD, io({ [SIDECAR_MD]: FM_TEXT, [SIDECAR_JSON]: agreeing }));
assertEq("agreeing sidecar → source json", okLoad.source, "json");
assertEq("agreeing sidecar → no drift", okLoad.drift, null);
assertEq(
  "agreeing sidecar → PASS",
  verdictFor(
    verifyReport(okLoad.fm, { ...ctx, frontMatterSource: okLoad.source, frontMatterDrift: okLoad.drift }),
    "cc-<n>.json agrees",
  ),
  PASS,
);

// (b) the two DISAGREE — the .json still names an old head. FAIL.
const stale = JSON.stringify({ ...parseFrontMatter(FM_TEXT), head_after: "0000000f" }, null, 2);
const driftLoad = loadReportFrontMatter(SIDECAR_MD, io({ [SIDECAR_MD]: FM_TEXT, [SIDECAR_JSON]: stale }));
assertTrue("disagreeing sidecar → drift is reported", driftLoad.drift !== null, `drift was ${driftLoad.drift}`);
assertTrue(
  "disagreeing sidecar → drift names the key",
  String(driftLoad.drift).includes("head_after"),
  `drift was ${driftLoad.drift}`,
);
assertEq(
  "disagreeing sidecar → FAIL",
  verdictFor(
    verifyReport(driftLoad.fm, { ...ctx, frontMatterSource: driftLoad.source, frontMatterDrift: driftLoad.drift }),
    "cc-<n>.json agrees",
  ),
  FAIL,
);

// (c) no sidecar at all — fall back to the .md and still PASS.
const mdOnly = loadReportFrontMatter(SIDECAR_MD, io({ [SIDECAR_MD]: FM_TEXT }));
assertEq("no sidecar → source md", mdOnly.source, "md");
assertEq("no sidecar → no drift", mdOnly.drift, null);
assertEq("no sidecar → front matter still parsed", mdOnly.fm.head_after, "dddddddd");
assertEq(
  "no sidecar → PASS via fallback",
  verdictFor(
    verifyReport(mdOnly.fm, { ...ctx, frontMatterSource: mdOnly.source, frontMatterDrift: mdOnly.drift }),
    "front matter read from the .md",
  ),
  PASS,
);

// (d) an unparseable sidecar is drift, not a crash.
const brokenLoad = loadReportFrontMatter(SIDECAR_MD, io({ [SIDECAR_MD]: FM_TEXT, [SIDECAR_JSON]: "{not json" }));
assertEq("unparseable sidecar → falls back to the .md", brokenLoad.source, "md");
assertTrue("unparseable sidecar → reported as drift", String(brokenLoad.drift).includes("not valid JSON"));

// (e) the generator's output is exactly what the loader expects to agree with.
assertEq("renderSidecar round-trips through the loader", renderSidecar(FM_TEXT).trim(), agreeing.trim());

// -- 5. lane / project / owed (FIX-1242) --------------------------------------
// Each field is exercised with the shape that should PASS and the wrong-but-
// green shapes a report could plausibly carry (rule 105): a lane the config
// does not list, a project with no plan file, an owed entry that looks like a
// claim and checks nothing.
console.log("\nlane / project / owed (FIX-1242):");

const PLANS = new Set(["paced-ops", "cc-loop"]);
const laneCtx = { ...ctx, lanes: ["ops", "fec", "app", "hygiene", "design"], projectExists: (s) => PLANS.has(s) };
const withFm = (lines, base = FM_TEXT) => parseFrontMatter(base.replace("ci: green", ["ci: green", ...lines].join("\n")));

// The parser carries the owed shape unchanged — a colon inside `after`'s
// instant does not split the pair (splitMapPairs keys on `, word:`, and a
// pair splits on its FIRST colon).
const owedFm = withFm([
  "lane: hygiene",
  "project: cc-loop",
  "owed:",
  '  - {fix: FIX-969, after: 2026-09-29T15:00Z, what: "jobid 17 crawl, then: a colon"}',
  "  - {fix: FIX-1189, what: a week of rows, after: 2026-10-06}",
]);
assertEq("owed inline map — after survives its colons", owedFm.owed[0].after, "2026-09-29T15:00Z");
assertEq("owed inline map — a quoted what keeps its comma and colon", owedFm.owed[0].what, "jobid 17 crawl, then: a colon");
assertEq("owed inline map — key order does not matter", owedFm.owed[1].after, "2026-10-06");

const good5 = verifyReport(owedFm, laneCtx);
assertEq("a well-formed lane/project/owed report has no FAILs", good5.filter((r) => r.verdict === FAIL).map((r) => r.claim), []);
assertEq("lane: hygiene passes", verdictFor(good5, "lane: hygiene"), PASS);
assertEq("project naming a plan file passes", verdictFor(good5, "project cc-loop names a plan file"), PASS);
assertEq("owed[0] passes", verdictFor(good5, "owed[0] FIX-969"), PASS);

assertEq(
  "a lane the config does not list FAILs (lane: fec2)",
  verdictFor(verifyReport(withFm(["lane: fec2"]), laneCtx), "is a report lane"),
  FAIL,
);
assertEq(
  "a report in the plan-only design lane FAILs",
  verdictFor(verifyReport(withFm(["lane: design"]), laneCtx), "is a report lane"),
  FAIL,
);
assertEq(
  "a project with no plan file FAILs",
  verdictFor(verifyReport(withFm(["lane: ops", "project: nope"]), laneCtx), "project nope names a plan file"),
  FAIL,
);
assertEq(
  "a project that is not a slug FAILs",
  verdictFor(verifyReport(withFm(["lane: ops", "project: ../../etc"]), laneCtx), "names a plan file"),
  FAIL,
);
assertEq(
  "a project with no lookup available is UNCHECKED, never a silent pass",
  verdictFor(verifyReport(withFm(["lane: ops", "project: paced-ops"]), { ...laneCtx, projectExists: undefined }), "names a plan file"),
  UNCHECKED,
);
assertEq(
  "owed entry with a fix that is not FIX-NNN FAILs",
  verdictFor(verifyReport(withFm(["lane: ops", "owed:", "  - {fix: 969, after: 2026-09-29, what: x}"]), laneCtx), "owed[0] is well-formed"),
  FAIL,
);
assertEq(
  "owed entry whose after is not a date FAILs",
  verdictFor(verifyReport(withFm(["lane: ops", "owed:", "  - {fix: FIX-969, after: Tuesday, what: x}"]), laneCtx), "owed[0] is well-formed"),
  FAIL,
);
assertEq(
  "owed entry with a zoneless instant FAILs (it would shift by the writer's offset)",
  verdictFor(verifyReport(withFm(["lane: ops", "owed:", "  - {fix: FIX-969, after: 2026-09-29T15:00, what: x}"]), laneCtx), "owed[0] is well-formed"),
  FAIL,
);
assertEq(
  "owed entry with no after FAILs",
  verdictFor(verifyReport(withFm(["lane: ops", "owed:", "  - {fix: FIX-969, what: x}"]), laneCtx), "owed[0] is well-formed"),
  FAIL,
);
assertEq(
  "owed as a scalar (owed: none) FAILs",
  verdictFor(verifyReport(withFm(["lane: ops", "owed: none"]), laneCtx), "owed is a list"),
  FAIL,
);
assertEq("owed: [] passes", verdictFor(verifyReport(withFm(["lane: ops", "owed: []"]), laneCtx), "nothing owed"), PASS);
assertEq(
  "pre-172 report with no lane is UNCHECKED (no lane — pre-FIX-1242)",
  verdictFor(verifyReport(fm, laneCtx), "lane stated"),
  UNCHECKED,
);
assertTrue(
  "…and says why",
  /pre-FIX-1242/.test(verifyReport(fm, laneCtx).find((r) => r.claim === "lane stated")?.detail ?? ""),
);
assertEq(
  "cc-172 with no lane FAILs",
  verdictFor(verifyReport(parseFrontMatter(FM_TEXT.replace("cc: 122", "cc: 172")), laneCtx), "lane stated"),
  FAIL,
);

// -- 6. the prompt reader (`pnpm cc:prompt`, /cc Step 1) -----------------------
console.log("\nreadPrompt (cc:prompt):");
const PROMPT_FM = [
  "---",
  "cc: 171",
  "lane: hygiene",
  "project: cc-loop",
  "when: any",
  "attended: unattended-ok",
  "posture: code-only",
  "concurrent_with: [168, 170]",
  "---",
  "",
  "# cc-171 — the lane board",
  "",
  "body",
].join("\n");
const pOpts = { n: 171, lanes: laneCtx.lanes, projectExists: (s) => PLANS.has(s) };
const p1 = readPrompt(PROMPT_FM, pOpts);
assertEq("prompt front matter parses with the one reader", p1.front_matter?.lane, "hygiene");
assertEq("concurrent_with parses as a list (of strings)", p1.front_matter?.concurrent_with, ["168", "170"]);
assertEq("a well-formed prompt has no problems", p1.problems, []);
assertEq("…and no abort", p1.abort, null);
assertEq("title is the first heading after the front matter, cc prefix dropped", p1.title, "the lane board");
assertTrue(
  "a cc: that disagrees with the filename aborts, naming both numbers",
  /cc: 171.*172/.test(readPrompt(PROMPT_FM, { ...pOpts, n: 172 }).abort ?? ""),
);
const legacy = readPrompt("# cc-120 — an old prompt\n\nbody\n", pOpts);
assertEq("a prompt with no front matter reads (null), it does not throw", legacy.front_matter, null);
assertEq("…and does not abort", legacy.abort, null);
assertTrue("…and says why", /no front matter/.test(legacy.problems.join(" ")));
assertEq("…title still found", legacy.title, "an old prompt");
const badPrompt = readPrompt(
  PROMPT_FM.replace("lane: hygiene", "lane: fec2").replace("when: any", "when: Tuesday").replace("posture: code-only", "posture: yolo"),
  pOpts,
);
assertEq("prompt problems: lane, when, posture", badPrompt.problems.length, 3);
assertEq("prompt problems do not abort", badPrompt.abort, null);
assertTrue(
  "a long title is trimmed to 160 chars",
  readPrompt(`# ${"x".repeat(400)}\n`, pOpts).title.length === 160,
);
assertEq(
  "marker body is the D4 shape",
  JSON.parse(markerBody({ n: "171", startedAt: "2026-09-28T03:43:00Z", worktree: "/w", prompt: "p.md" })),
  { cc: 171, started_at: "2026-09-28T03:43:00Z", worktree: "/w", prompt: "p.md" },
);

console.log("\nteardownLine (cc:prompt --done, cc-190):");
const MAIN = "C:/Users/Craig/Documents/Civitics/App";
assertEq(
  "a slot marker → the session:worktree:done line, run from the primary",
  teardownLine("C:/Users/Craig/Documents/Civitics/civitics-worktrees/fix-1271", MAIN),
  `teardown next (two calls; the second must START outside the tree): cd "${MAIN}"   then   pnpm session:worktree:done 1271`,
);
assertEq(
  "Windows separators and a trailing slash resolve the same slot",
  teardownLine("C:\\Users\\Craig\\Documents\\Civitics\\civitics-worktrees\\fix-1263-land\\", MAIN),
  `teardown next (two calls; the second must START outside the tree): cd "${MAIN}"   then   pnpm session:worktree:done 1263-land`,
);
assertTrue(
  "a marker naming the primary checkout records no slot (cc-191 ran --start there)",
  /primary checkout.*records no slot/.test(teardownLine("c:/users/craig/documents/civitics/app/", MAIN)),
);
assertTrue("no marker → tear down by name", /tear down by name/.test(teardownLine(null, MAIN)));
assertTrue(
  "a path that is not a slot is left to a human, never torn down",
  /not a session:worktree slot/.test(teardownLine("D:/elsewhere/tree", MAIN)),
);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\ncc:verify:test — all assertions passed.");
