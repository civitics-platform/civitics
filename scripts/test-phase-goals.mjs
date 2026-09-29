#!/usr/bin/env node
// scripts/test-phase-goals.mjs
//
// Pins scripts/lib/phase-goals.mjs to the parser /dashboard actually uses,
// apps/civitics/app/api/phases/route.ts (FIX-1243 D3). The route's regex cannot
// be imported (a Next route file exports handlers only, and it pulls in
// next/server), so the board carries a copy — and this test reads the route's
// SOURCE and fails when the two literals differ. A copy nobody checks is how two
// parsers drift apart; FIX-1078 was the route alone dropping a header shape.
//
// Run:   node scripts/test-phase-goals.mjs   (part of `pnpm board:test`)
// Exit:  0 on pass, 1 on fail.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_HEADER_RE, parsePhaseHeaders, parseGoal } from "./lib/phase-goals.mjs";

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

// -- 1. the copy IS the route's regex -----------------------------------------
console.log("pinned to apps/civitics/app/api/phases/route.ts:");
const route = readFileSync(resolve(REPO_ROOT, "apps/civitics/app/api/phases/route.ts"), "utf8");
const lit = /const headerRe =\s*\/(.+)\/([a-z]*);/.exec(route);
assertTrue("the route still declares `const headerRe = /…/flags;`", !!lit, "the route's parser moved — re-pin this test");
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
const live = parsePhaseHeaders(readFileSync(resolve(REPO_ROOT, "docs/PHASE_GOALS.md"), "utf8"));
assertEq("six phases, 0–5", live.map((p) => p.n), [0, 1, 2, 3, 4, 5]);
// The route's fallback mirrors the real labels (FIX-1078); so must we.
const fallback = [...route.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
assertEq("labels match the route's fallback list", live.map((p) => p.label), fallback);
assertTrue("every token is `N%`, `~N%` or `Planned`", live.every((p) => /^(~?\d+%|Planned)$/.test(p.token)), live.map((p) => p.token).join(", "));

// -- 5. goal: ------------------------------------------------------------------
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
