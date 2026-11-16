#!/usr/bin/env node
// scripts/test-phase-goals.mjs
//
// Pins scripts/lib/phase-goals.mjs to the parser /dashboard actually uses,
// apps/civitics/src/lib/phase-goals.ts (FIX-1243 D3; re-pointed from the route
// by FIX-1415). That file is TypeScript, which this dependency-free script
// cannot import, so the board carries a copy of the regex — and this test reads
// the app file's SOURCE and fails when the two literals differ. A copy nobody
// checks is how two parsers drift apart; FIX-1078 was the route alone dropping
// a header shape.
//
// It also pins each header's token to the checkbox ratio (FIX-1415 D3). This
// suite runs in fixes-integrity.yml, which fires on docs-only commits; the
// app's own phase-goals.test.ts does not (tests.yml ignores docs/**), and a
// checkbox edit is a docs-only commit.
//
// Run:   node scripts/test-phase-goals.mjs   (part of `pnpm board:test`)
// Exit:  0 on pass, 1 on fail.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_HEADER_RE, parsePhaseHeaders, parseGoal, countPhaseBullets } from "./lib/phase-goals.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

// -- 1. the copy IS the app parser's regex ------------------------------------
console.log("pinned to apps/civitics/src/lib/phase-goals.ts:");
const appParser = readFileSync(resolve(REPO_ROOT, "apps/civitics/src/lib/phase-goals.ts"), "utf8");
const lit = /export const PHASE_HEADER_RE =\s*\/(.+)\/([a-z]*);/.exec(appParser);
assertTrue("the app parser still declares `export const PHASE_HEADER_RE = /…/flags;`", !!lit, "the app's parser moved — re-pin this test");
if (lit) {
  assertEq("same pattern source", PHASE_HEADER_RE.source, lit[1]);
  assertEq("same flags", PHASE_HEADER_RE.flags, lit[2]);
}

// -- 2. the three header shapes the route documents ---------------------------
console.log("\nthe three header shapes:");
const SHAPES = [
  "## Phase 0 — Scaffold ✓ `Weeks 1–2` `100% complete`",
  "## Phase 1 — MVP `Weeks 3–10` `~88% complete` ← **current**",
  "## Phase 2 — Growth `Weeks 11–22` `Planned`",
].join("\n\n");
const shapes = parsePhaseHeaders(SHAPES);
assertEq(
  "name · label · pct · done — what the route returns",
  shapes.map((p) => [p.name, p.label, p.pct, p.done]),
  [["Phase 0", "Scaffold", 100, true], ["Phase 1", "MVP", 88, false], ["Phase 2", "Growth", 0, false]],
);
assertEq("the token is the document's own word, verbatim", shapes.map((p) => p.token), ["100%", "~88%", "Planned"]);
assertEq("no match on a header missing its token", parsePhaseHeaders("## Phase 9 — Nope `Weeks 1–2`"), []);

// -- 3. goal groups -----------------------------------------------------------
console.log("\ngoal groups:");
const groups = parsePhaseHeaders(
  ["## Phase 1 — MVP `W` `~9% complete`", "### Infrastructure", "- [ ] x", "## Not a phase", "### Stray", "## Phase 2 — Growth `W` `Planned`", "### Accountability Tools"].join("\n"),
);
assertEq("### groups belong to the phase above them, and a non-phase ## ends it", groups.map((p) => p.groups), [["Infrastructure"], ["Accountability Tools"]]);

// -- 4. the live document -----------------------------------------------------
console.log("\nlive docs/PHASE_GOALS.md:");
const liveMd = readFileSync(resolve(REPO_ROOT, "docs/PHASE_GOALS.md"), "utf8");
const live = parsePhaseHeaders(liveMd);
assertEq("six phases, 0–5", live.map((p) => p.n), [0, 1, 2, 3, 4, 5]);
// (Until FIX-1415 the labels were also checked against the route's static
// fallback list. There is no fallback any more: the card shows what the file
// parses to, or nothing.)
assertTrue("every token is `N%`, `~N%` or `Planned`", live.every((p) => /^(~?\d+%|Planned)$/.test(p.token)), live.map((p) => p.token).join(", "));

// -- 5. the counter, and the header token pinned to it (FIX-1415 D3) ----------
console.log("\nthe checkbox counter:");
const FIXTURE = [
  "## Phase 0 — Done ✓ `W` `100% complete`",
  "### Group",
  "- [x] one",
  "  - [ ] an indented sub-bullet does not count",
  "- [X] two",
  "## Phase 1 — Mid `W` `~50% complete`",
  "- [x] done",
  "- [ ] open — with a note",
  "- [ ] parked — was FIX-123; re-open when it happens",
  "- a plain bullet does not count",
  "## Not a phase",
  "- [x] outside every phase",
  "## Phase 2 — Later `W` `Planned`",
  "## Phase 3 — Empty `W` `Planned`",
].join("\r\n");
assertEq(
  "checked · open · parked · pct per phase (CRLF, sub-bullet, parked, non-phase ##, no bullets)",
  countPhaseBullets(FIXTURE).map((p) => [p.name, p.checked, p.open, p.parked, p.pct]),
  [["Phase 0", 2, 0, 0, 100], ["Phase 1", 1, 1, 1, 50], ["Phase 2", 0, 0, 0, 0], ["Phase 3", 0, 0, 0, 0]],
);

console.log("\neach live header's token agrees with its checkbox ratio:");
const counts = countPhaseBullets(liveMd);
const headerLines = liveMd.replace(/\r\n/g, "\n").split("\n").filter((l) => l.startsWith("## Phase "));
assertEq("the counter sees the same six phases", counts.map((c) => c.name), live.map((p) => p.name));
for (const p of live) {
  const c = counts.find((x) => x.name === p.name);
  if (!c) continue;
  const ratio = `${c.checked} checked, ${c.open} open, ${c.parked} parked → ${c.pct}%`;
  if (p.token === "Planned") {
    assertTrue(`${p.name} \`Planned\` → nothing checked`, c.checked === 0, ratio);
  } else {
    assertTrue(`${p.name} \`${p.token}\` within 1 point of the ratio`, Math.abs(p.pct - c.pct) <= 1, `${ratio} — the header token is Craig's to change, or a box is`);
  }
  if (headerLines.find((l) => l.startsWith(`## ${p.name} `))?.includes("✓")) {
    assertTrue(`${p.name} \`✓\` → 100%`, c.pct === 100, ratio);
  }
}

// -- 6. goal: ------------------------------------------------------------------
console.log("\ngoal: on a plan file:");
assertEq("`P2 · Accountability Tools`", parseGoal("P2 · Accountability Tools"), { phase: 2, group: "Accountability Tools" });
assertEq("`P1 · Data Quality`", parseGoal("P1 · Data Quality"), { phase: 1, group: "Data Quality" });
assertEq("`P1` alone", parseGoal("P1"), { phase: 1, group: "" });
assertEq("no P<N> prefix → null", parseGoal("Accountability Tools"), null);
assertEq("empty → null", parseGoal(""), null);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nphase-goals:test — all assertions passed.");
