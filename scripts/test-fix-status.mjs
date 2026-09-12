#!/usr/bin/env node
// scripts/test-fix-status.mjs
//
// Assertion harness for scripts/lib/fix-status.mjs — THE derivation of FIX
// status from docs/done.log (FIX-1016 D1) — and for the bullet-shape rules in
// scripts/lib/fixes-md.mjs that replaced the checkbox as the discriminator.
//
// Run:   pnpm fixes:status:test   (also runs as part of `pnpm fixes:test`)
// Exit:  0 on pass, 1 on fail with expected-vs-actual.
//
// Playbook rule E10: every case here can fail. The reopen cases are paired with
// their re-close so a derivation that ignored row order — or one that treated
// "has ever been reopened" as permanently open, the real FIX-041/042 bug —
// fails at least one of them.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDoneLog, deriveStatus, statusFromDoneLog, statusOf } from "./lib/fix-status.mjs";
import { parseFixBullet, walkFixBullets, titleOf, formatFixBullet, detectEol } from "./lib/fixes-md.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

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

// -- 1. parseDoneLog — the tolerances ---------------------------------------
console.log("parseDoneLog:");
const FIXTURE = [
  "# docs/done.log — header comment, skipped",
  "#   indented continuation, skipped",
  "",
  "2026-01-01 | FIX-100 | aaaaaaa1 | local+prod | one close",
  "2026-01-02 | FIX-101 | backfill | historical backfill row (legacy 4-column)",
  "2026-01-03 | FIX-102 | bbbbbbb1 | prod-only | closed",
  "2026-01-04 | FIX-102 | reopen | reopen | reopened by hand",
  "2026-01-05 | FIX-103 | ccccccc1 | local-only | closed",
  "2026-01-06 | FIX-103 | reopen | reopen | regression",
  "2026-01-07 | FIX-103 | ddddddd1 | local+prod | closed again",
  "2026-01-08 | FIX-104 | eeeeeee1 | stranded on PR#1, code never reached main | prose in column 4",
  "2026-01-09 | FIX-105 | fffffff1 | local+prod | note with a | pipe inside it",
  "2026-01-10 | FIX-100 | aaaaaaa1 | local+prod | duplicate (id, sha) row",
  "not a row",
].join("\n");

const rows = parseDoneLog(FIXTURE);
assertEq("skips header + blank + short lines", rows.length, 10);
assertEq("5-column row splits on vocabulary", [rows[0].id, rows[0].sha, rows[0].verified, rows[0].note],
  ["FIX-100", "aaaaaaa1", "local+prod", "one close"]);
assertEq("legacy 4-column row -> verified=unverified, col4 is the note",
  [rows[1].sha, rows[1].verified, rows[1].note],
  ["backfill", "unverified", "historical backfill row (legacy 4-column)"]);
assertEq("prose in column 4 is folded into the note, never read as status",
  [rows[7].sha, rows[7].verified, rows[7].note],
  ["eeeeeee1", "unverified", "stranded on PR#1, code never reached main | prose in column 4"]);
assertEq("a pipe inside the note is rejoined", rows[8].note, "note with a | pipe inside it");
assertEq("a reopen row keeps `reopen` in column 3", [rows[3].id, rows[3].sha], ["FIX-102", "reopen"]);
assertEq("rows keep file order", rows.map((r) => r.id),
  ["FIX-100", "FIX-101", "FIX-102", "FIX-102", "FIX-103", "FIX-103", "FIX-103", "FIX-104", "FIX-105", "FIX-100"]);

console.log("\nparseDoneLog — CRLF input:");
const crlfRows = parseDoneLog(FIXTURE.replace(/\n/g, "\r\n"));
assertEq("CRLF parses identically to LF", JSON.stringify(crlfRows), JSON.stringify(rows));

// -- 2. deriveStatus — THE rule ---------------------------------------------
console.log("\nderiveStatus:");
const st = deriveStatus(rows);
assertEq("no rows at all -> OPEN", statusOf(st, "FIX-999"), "open");
assertEq("one close -> CLOSED", statusOf(st, "FIX-100"), "closed");
assertEq("a `backfill` sentinel closes", statusOf(st, "FIX-101"), "closed");
assertEq("close -> reopen -> OPEN", statusOf(st, "FIX-102"), "open");
assertEq("close -> reopen -> close -> CLOSED", statusOf(st, "FIX-103"), "closed");
assertEq("prose in column 4 does not affect status", statusOf(st, "FIX-104"), "closed");
assertEq("duplicate (id, sha) rows do not change the answer", statusOf(st, "FIX-100"), "closed");
assertEq("lastRow is the LAST row for the id, not the first",
  st.get("FIX-103").lastRow.sha, "ddddddd1");
assertEq("rows[] carries every row for the id in order",
  st.get("FIX-103").rows.map((r) => r.sha), ["ccccccc1", "reopen", "ddddddd1"]);
assertEq("statusFromDoneLog(text) agrees with the two-step form",
  [...statusFromDoneLog(FIXTURE)].map(([k, v]) => [k, v.status]).sort(),
  [...st].map(([k, v]) => [k, v.status]).sort());

// Order sensitivity as its own case: move FIX-103's reopen AFTER its last close
// and the answer MUST flip. A derivation keyed on "a reopen row exists
// somewhere" — or one that collected rows into a Set — passes every case above
// and fails this one.
const swapped = parseDoneLog(
  FIXTURE.split("\n")
    .filter((l) => !/FIX-103 \| reopen/.test(l))
    .concat("2026-01-11 | FIX-103 | reopen | reopen | reopened after the close")
    .join("\n"),
);
assertEq("order decides: a reopen AFTER the close -> OPEN", statusOf(deriveStatus(swapped), "FIX-103"), "open");

// -- 3. The live log — the premise the strip rests on -----------------------
console.log("\nlive docs/done.log:");
const liveRows = parseDoneLog(readFileSync(resolve(REPO_ROOT, "docs/done.log"), "utf8"));
const liveStatus = deriveStatus(liveRows);
assertTrue("parses > 1000 rows", liveRows.length > 1000, `got ${liveRows.length}`);
assertTrue("every row names a FIX id", liveRows.every((r) => /^FIX-\d+$/.test(r.id)),
  `offenders: ${liveRows.filter((r) => !/^FIX-\d+$/.test(r.id)).slice(0, 3).map((r) => `L${r.lineNo} ${r.id}`).join(", ")}`);
assertTrue("at least one id derives OPEN via a trailing reopen",
  [...liveStatus.values()].some((v) => v.status === "open" && v.lastRow.sha === "reopen"));

// -- 4. fixes-md — the shape rules that replaced the checkbox ---------------
console.log("\nfixes-md bullet shape:");
assertEq("new shape parses", parseFixBullet("- \u{1F7E0} M — **t** — b <!--id:FIX-900-->")?.id, "FIX-900");
assertEq("legacy [x] shape still parses (the archive is history)",
  parseFixBullet("- [x] \u{1F7E0} M — **t** — b <!--id:FIX-901-->")?.box, "x");
assertEq("legacy [ ] shape still parses", parseFixBullet("- [ ] \u{1F7E0} M — **t** <!--id:FIX-902-->")?.box, " ");
assertEq("marker with no emoji qualifies", parseFixBullet("- plain body <!--id:FIX-903-->")?.id, "FIX-903");
assertEq("emoji with no marker qualifies (fixes:housekeep's input)",
  parseFixBullet("- \u{1F7E1} S — **untagged** — needs an id")?.id, null);
assertEq("neither marker nor emoji is not a bullet", parseFixBullet("- just some prose"), null);
assertEq("INDENTED continuation prose is not a bullet (archive bodies)",
  parseFixBullet("  - **Investigation outcome (2026-04-28):** ..."), null);
assertEq("a line outside any section is not a bullet (the priority key)",
  parseFixBullet("- \u{1F534} Critical — Bug that breaks or blocks real functionality", { inSection: false }), null);
assertEq("titleOf reads the bold title", titleOf("\u{1F7E0} M — **the title** — body <!--id:FIX-1-->"), "the title");
assertEq("titleOf falls back to a truncated prefix", titleOf("no bold here <!--id:FIX-1-->"), "no bold here");
assertEq("formatFixBullet emits NO checkbox",
  formatFixBullet({ severity: "\u{1F7E0}", size: "S", title: "t", body: "b.", id: "FIX-904" }),
  "- \u{1F7E0} S — **t** — b. <!--id:FIX-904-->");
assertEq("detectEol — CRLF", detectEol("a\r\nb"), "\r\n");
assertEq("detectEol — LF", detectEol("a\nb"), "\n");

console.log("\nwalkFixBullets over the live docs/FIXES.md:");
const liveFixes = readFileSync(resolve(REPO_ROOT, "docs/FIXES.md"), "utf8");
const liveBullets = walkFixBullets(liveFixes);
assertTrue("finds bullets", liveBullets.length > 0, `got ${liveBullets.length}`);
assertTrue("every live bullet carries an id marker",
  liveBullets.every((b) => b.id),
  `missing: ${liveBullets.filter((b) => !b.id).slice(0, 3).map((b) => `L${b.lineNo}`).join(", ")}`);
assertTrue("no bullet is attributed to the preamble",
  liveBullets.every((b) => b.section !== null));
assertTrue("the priority key is NOT picked up as backlog",
  !liveBullets.some((b) => /Bug that breaks or blocks real functionality/.test(b.rest)));

// Every live bullet's derived status against the file's own claim. BEFORE the
// strip this is the migration assertion (derived == checkbox, the whole premise
// of FIX-1016); AFTER it, the boxes are gone and it degrades to "no live bullet
// claims a status of its own", which is the invariant D2 buys.
console.log("\nderived status vs the markdown:");
const boxed = liveBullets.filter((b) => b.box !== null);
if (boxed.length === 0) {
  assertTrue("no live bullet carries a checkbox (post-strip invariant)", true);
} else {
  const mismatches = boxed.filter(
    (b) => (b.box.toLowerCase() === "x") !== (statusOf(liveStatus, b.id) === "closed"),
  );
  assertEq(`derived == checkbox for all ${boxed.length} live bullets`, mismatches.map((b) => b.id), []);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nfixes:status:test — all assertions passed.");
