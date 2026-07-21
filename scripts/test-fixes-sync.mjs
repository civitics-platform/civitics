#!/usr/bin/env node
// scripts/test-fixes-sync.mjs
//
// Tiny assertion harness for the trailer parser in scripts/fixes-sync.mjs.
// Reads scripts/__fixtures__/fixes-sync-mixed-verified.txt (everything below
// the `---FIXTURE---` marker is the synthetic commit body), runs it through
// `parseCommitTrailers` + `normalizeVerified`, and asserts the per-FIX
// overrides land correctly.
//
// Run:   pnpm fixes:test
// Exit:  0 on pass, 1 on fail with a diff of expected vs actual.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCommitTrailers,
  normalizeVerified,
  evaluateTrunkViolations,
  buildCompletingShasById,
} from "./fixes-sync.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "__fixtures__/fixes-sync-mixed-verified.txt");

function extractBody(text) {
  const marker = "---FIXTURE---";
  const idx = text.indexOf(marker);
  if (idx === -1) throw new Error(`fixture missing ${marker} marker`);
  return text.slice(idx + marker.length).replace(/^\r?\n/, "");
}

const failures = [];
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`  ✗ ${label}\n     expected: ${e}\n     actual:   ${a}`);
  else console.log(`  ✓ ${label}`);
}

const body = extractBody(readFileSync(FIXTURE, "utf8"));
const parsed = parseCommitTrailers(body);

console.log("parseCommitTrailers(fixture):");
assertEq("fixesIds", [...parsed.fixesIds].sort(), ["FIX-901", "FIX-903"]);
assertEq("closesIds", [...parsed.closesIds].sort(), ["FIX-902"]);
assertEq("globalVerified", parsed.globalVerified?.trim(), "local + prod");
assertEq(
  "perFixVerified",
  Object.fromEntries([...parsed.perFixVerified.entries()].sort()),
  { "FIX-902": "closes-as-redirected" },
);
assertEq("warnings", parsed.warnings, []);

console.log("\nverified values after normalize():");
const verifiedFor = (id, trailer) => {
  const raw = parsed.perFixVerified.get(id) ?? parsed.globalVerified;
  return normalizeVerified(raw, { trailer });
};
assertEq("FIX-901 (Fixes)", verifiedFor("FIX-901", "fixes"), "local+prod");
assertEq("FIX-902 (Closes, per-FIX override)", verifiedFor("FIX-902", "closes"), "closes-as-redirected");
assertEq("FIX-903 (Fixes, global fallback)", verifiedFor("FIX-903", "fixes"), "local+prod");

// Negative case — a Verified[FIX-NNN] line that references an ID NOT in
// Fixes:/Closes: should warn and be dropped.
const strayBody = [
  "subject",
  "",
  "Verified: local",
  "Verified[FIX-999]: closes-as-redirected",
  "Fixes: FIX-901",
  "",
].join("\n");
const strayParsed = parseCommitTrailers(strayBody);
console.log("\nstray Verified[FIX-NNN] guard:");
assertEq("perFixVerified (stray dropped)", [...strayParsed.perFixVerified.keys()], []);
assertEq("warnings (one)", strayParsed.warnings.length, 1);

// FIX-465: a wrapped prose line beginning with a lowercase "fixes:" (e.g.
// "fixes:sync recorded ... (FIX-461)") must NOT be parsed as a trailer. Before
// the case-sensitive fix, the `i` flag + first-match-wins let it shadow the
// real `Fixes: FIX-464` and attribute the commit to FIX-461.
const proseShadowBody = [
  "[skip vercel] chore(tooling): collision guards (FIX-464)",
  "",
  "fixes:sync recorded as shipped while the code sat unmerged (FIX-461), stale",
  "index.lock, and a corrupted .git/config line.",
  "",
  "Verified: local",
  "Fixes: FIX-464",
  "",
].join("\n");
const proseParsed = parseCommitTrailers(proseShadowBody);
console.log("\nprose-shadow guard (FIX-465):");
assertEq("fixesIds (real trailer wins, not prose)", [...proseParsed.fixesIds], ["FIX-464"]);
assertEq("closesIds (none)", [...proseParsed.closesIds], []);

// FIX-874: STACKED trailer lines. A commit may put each FIX on its own `Fixes:`
// line rather than the comma form; the old non-global regex returned only the
// first line and silently dropped the rest (the ccd0f3f3 lens-family incident:
// FIX-656/657/658 stacked, only 656 logged). Union every matching line's IDs.
const stackedBody = [
  "feat(lens): unify + persist + extend the constituent lens",
  "",
  "Longer body prose that happens to mention fixes:sync in passing.",
  "",
  "Verified: local + prod",
  "Fixes: FIX-656",
  "Fixes: FIX-657",
  "Fixes: FIX-658",
  "Closes: FIX-659",
  "Closes: FIX-660",
  "",
].join("\n");
const stackedParsed = parseCommitTrailers(stackedBody);
console.log("\nstacked-trailer union (FIX-874):");
assertEq("fixesIds (all three stacked lines)", [...stackedParsed.fixesIds].sort(), ["FIX-656", "FIX-657", "FIX-658"]);
assertEq("closesIds (both stacked lines)", [...stackedParsed.closesIds].sort(), ["FIX-659", "FIX-660"]);
assertEq("stacked warnings (none)", stackedParsed.warnings, []);

// FIX-874: mixed form — a stacked `Fixes:` line AND a comma-separated line in
// the same commit. Every ID from both shapes must survive.
const mixedFormBody = [
  "chore: land several fixes at once",
  "",
  "Verified: local",
  "Fixes: FIX-800, FIX-801",
  "Fixes: FIX-802",
  "",
].join("\n");
const mixedFormParsed = parseCommitTrailers(mixedFormBody);
assertEq(
  "mixed stacked+comma Fixes (FIX-874)",
  [...mixedFormParsed.fixesIds].sort(),
  ["FIX-800", "FIX-801", "FIX-802"],
);

// FIX-461: trunk-ancestry guard decision core. `evaluateTrunkViolations` and
// `buildCompletingShasById` are pure (git is injected via `resolve`), so the
// silent-zero-sweep-tail failure mode is exercised here without touching a repo.
console.log("\nFIX-461 trunk-ancestry guard:");
const doneEntries = [
  // FIX-700: shipped — single on-trunk SHA.
  { id: "FIX-700", sha: "aaaaaaa" },
  // FIX-701: the incident shape — recorded against an off-trunk branch SHA,
  // then reopened, then re-landed on trunk. ANY on-trunk SHA ⇒ passes.
  { id: "FIX-701", sha: "bbbbbbb" },
  { id: "FIX-701", sha: "reopen" },
  { id: "FIX-701", sha: "ccccccc" },
  // FIX-702: STILL stranded — only off-trunk SHAs. This is the violation.
  { id: "FIX-702", sha: "ddddddd" },
  // FIX-703: orphan-plus-landed (FIX-435 shape) — one off-trunk dup + one landed.
  { id: "FIX-703", sha: "eeeeeee" },
  { id: "FIX-703", sha: "fffffff" },
  // FIX-704: closed administratively via a sentinel SHA — skipped, never failed.
  { id: "FIX-704", sha: "superseded-by-fix-999" },
];
const ancestorShas = new Set(["aaaaaaa", "ccccccc", "fffffff"]);
const offTrunkExists = new Set(["bbbbbbb", "ddddddd", "eeeeeee"]);
const fakeResolve = (sha) => {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return "unknown"; // sentinel
  if (ancestorShas.has(sha)) return "ancestor";
  if (offTrunkExists.has(sha)) return "not-ancestor";
  return "unknown"; // missing object (shallow clone)
};
const shasById = buildCompletingShasById(doneEntries);
assertEq("buildCompletingShasById skips reopen", shasById.get("FIX-701"), ["bbbbbbb", "ccccccc"]);
assertEq("buildCompletingShasById FIX-704 keeps sentinel", shasById.get("FIX-704"), ["superseded-by-fix-999"]);
const { violations, skipped } = evaluateTrunkViolations({
  completedIds: new Set(["FIX-700", "FIX-701", "FIX-702", "FIX-703", "FIX-704"]),
  completingShasById: shasById,
  resolve: fakeResolve,
});
assertEq("violations = only the still-stranded FIX-702", violations.map((v) => v.id), ["FIX-702"]);
assertEq("FIX-702 violation reports its off-trunk SHA", violations[0].shas, ["ddddddd"]);
assertEq("FIX-704 (sentinel-only) is skipped, not failed", skipped.map((s) => s.id), ["FIX-704"]);

if (failures.length) {
  console.error("\nFAIL:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\nfixes:test — all assertions passed.");
