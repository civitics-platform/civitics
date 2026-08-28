#!/usr/bin/env node
// scripts/test-drain-ec.mjs
//
// Assertion harness for the EC drain wrapper's cycle-state reporting
// (scripts/drain-ec-donations.mjs), added by FIX-1116.
//
// WHY THIS EXISTS. The wrapper decided "is a cycle still open?" from
// pipeline_state.entity_connections_donations, whose `cycle` key belongs to the
// DONATIONS SUB-CYCLE and is deleted by rebuild_ec_donations_incr_close() the
// moment the sixteenth window lands — while the rebuild cycle carries on through
// ten more arms. So on prod 2026-08-27 23:09 UTC the wrapper printed
// `CYCLE CLOSED. Residual dirty set: 0 rows / 0 donors` with six arms banked and
// five pending. The six-line CYCLE INCOMPLETE branch written specifically to
// stop an operator drawing that conclusion had never once been printed.
//
// A branch that has never executed is a branch nobody has read. These asserts
// are the thing that makes it executable without a live mid-cycle database.
//
// Run:   pnpm drain:test
// Exit:  0 on pass, 1 on fail with expected-vs-actual.

import { readCycleState, finalCycleLines } from "./drain-ec-donations.mjs";

const failures = [];
function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`  ✗ ${label}\n     expected: ${e}\n     actual:   ${a}`);
  else console.log(`  ✓ ${label}`);
}
function assertTrue(label, cond) {
  if (cond) console.log(`  ✓ ${label}`);
  else failures.push(`  ✗ ${label}\n     expected: true\n     actual:   false`);
}

// psql -At -F '|@|' returns rows as arrays of column strings; q() splits them.
const row = (startedAt, arms, mode = "incremental") => [[startedAt, JSON.stringify(arms), mode]];

console.log("readCycleState — the cursor row IS the answer:");

assertEq("no cursor row → cycle closed",
  readCycleState([]),
  { open: false, startedAt: null, mode: null, arms: [], armsBanked: 0 });

assertEq("null rows → cycle closed (q() never returns null today, but the caller is not the contract)",
  readCycleState(null),
  { open: false, startedAt: null, mode: null, arms: [], armsBanked: 0 });

assertEq("a cursor with zero arms banked is still an OPEN cycle",
  readCycleState(row("2026-08-27T22:30:00+00:00", [])),
  { open: true, startedAt: "2026-08-27T22:30:00+00:00", mode: "incremental", arms: [], armsBanked: 0 });

assertEq("arms are counted, not merely detected",
  readCycleState(row("2026-08-27T22:30:00+00:00",
    ["donations_incr_windows", "rebuild_entity_connections_votes",
     "rebuild_entity_connections_cosponsors"])).armsBanked,
  3);

// This is the exact prod state from the FIX-1110 acceptance run: six arms banked,
// five pending, donations sub-cycle already closed. The old probe said "closed".
const prodState = readCycleState(row("2026-08-27T22:30:00+00:00", [
  "donations_incr_windows",
  "rebuild_entity_connections_votes",
  "rebuild_entity_connections_cosponsors",
  "rebuild_entity_connections_appointments",
  "rebuild_entity_connections_oversight",
  "rebuild_entity_connections_holds",
]));
assertTrue("the 2026-08-27 23:09 prod state reads as OPEN (the old probe said closed)", prodState.open);
assertEq("...with its six banked arms", prodState.armsBanked, 6);

assertEq("unparseable completed_arms fails toward OPEN, never toward the all-clear",
  (() => { const s = readCycleState([["2026-08-27T22:30:00+00:00", "{not json", "incremental"]]);
           return { open: s.open, armsBanked: s.armsBanked }; })(),
  { open: true, armsBanked: 0 });

assertEq("a non-array completed_arms is treated as no arms, not as a crash",
  readCycleState([["2026-08-27T22:30:00+00:00", '{"a":1}', "incremental"]]).armsBanked, 0);

console.log("\nfinalCycleLines — the resumption warning is reachable:");

const openLines = finalCycleLines(prodState, null).join("\n");
assertTrue("an open cycle prints CYCLE INCOMPLETE", /CYCLE INCOMPLETE/.test(openLines));
assertTrue("...and never prints CYCLE CLOSED", !/CYCLE CLOSED/.test(openLines));
assertTrue("...and names how many arms banked", /6 arm\(s\) banked/.test(openLines));
assertTrue("...and lists them, so the operator can see WHICH", /rebuild_entity_connections_oversight/.test(openLines));
assertTrue("...and explains the crawl resumes it", /RESUMES it/.test(openLines));
assertTrue("...and disclaims the scalar watermark, which is the whole point of the branch",
  /scalar watermark deliberately does NOT move/.test(openLines));
assertTrue("...and never quotes a residual dirty set, which would be the full backlog mid-cycle",
  !/Residual dirty set/.test(openLines));

const zeroArmLines = finalCycleLines(
  readCycleState(row("2026-08-27T22:30:00+00:00", [])), null).join("\n");
assertTrue("an open cycle with zero arms still warns", /CYCLE INCOMPLETE/.test(zeroArmLines));
assertTrue("...and omits the empty 'banked:' list rather than printing 'banked: '",
  !/banked: \n/.test(zeroArmLines + "\n"));

const closedLines = finalCycleLines(
  readCycleState([]), { rows: 2733, donors: 2518 }).join("\n");
assertTrue("only a MISSING cursor prints CYCLE CLOSED", /CYCLE CLOSED/.test(closedLines));
assertTrue("...and says the cursor is gone, not merely that a flag was false",
  /entity_connections_rebuild_cursor is gone/.test(closedLines));
assertTrue("...and reports the residual dirty set with thousands separators",
  /2,733 rows \/ 2,518 donors/.test(closedLines));
assertTrue("...and never prints the incomplete warning", !/CYCLE INCOMPLETE/.test(closedLines));

assertTrue("a closed cycle with no residual passed still renders (0/0), never NaN",
  /0 rows \/ 0 donors/.test(finalCycleLines(readCycleState([]), null).join("\n")));

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nall drain wrapper cycle-state assertions passed.");
