/**
 * FIX-950 — the nightly's hold truth table.
 *
 * The whole point of nightly-hold.ts is that `index.ts` cannot be unit-tested
 * (it pulls createAdminClient and the ai-tagger's module-level createAiClient()
 * at import time), so the predicates live apart and get asserted here — the
 * same split fec-hold.ts and weekly-gate.ts already use.
 *
 * What matters most: `sessionHeld: false` must be byte-identical to
 * pre-FIX-950 behaviour at EVERY call site. A hold mechanism that changes the
 * unheld path is a regression in 364 nights out of 365.
 *
 * Runs via:  tsx --test src/pipelines/nightly-hold.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fecChainHeld,
  nightlyPhaseStatus,
  phaseFullyHeld,
  probeRecords,
  prodSessionHoldBanner,
  prodSessionHoldReason,
  writersRun,
} from "./nightly-hold";
import type { NightlyPhase } from "./index";

const FREE = { sessionHeld: false };
const HELD = { sessionHeld: true };

const PHASES: NightlyPhase[] = [
  "fec",
  "enrichment",
  "enrichment-heavy",
  "enrichment-light",
  "enrichment-tail",
  "all",
];

// ---------------------------------------------------------------------------
// The unheld path is untouched
// ---------------------------------------------------------------------------

test("unheld: writersRun is exactly the phase gate", () => {
  assert.equal(writersRun(true, FREE), true);
  assert.equal(writersRun(false, FREE), false);
});

test("unheld: the fec chain's held is exactly the FIX-998 flag", () => {
  assert.equal(fecChainHeld(false, FREE), false);
  assert.equal(fecChainHeld(true, FREE), true);
});

test("unheld: no phase closes `skipped`", () => {
  for (const phase of PHASES) {
    assert.equal(phaseFullyHeld(phase, FREE), false, phase);
    assert.equal(nightlyPhaseStatus({ phase, hold: FREE, hasErrors: false }), "complete", phase);
    assert.equal(nightlyPhaseStatus({ phase, hold: FREE, hasErrors: true }), "partial", phase);
  }
});

// ---------------------------------------------------------------------------
// Under a hold
// ---------------------------------------------------------------------------

test("held: a selected writer block does NOT run", () => {
  assert.equal(writersRun(true, HELD), false);
});

test("held: an unselected writer block is still unselected (the gate is an AND)", () => {
  assert.equal(writersRun(false, HELD), false);
});

test("held: the fec chain is held whether or not the FIX-998 flag is set", () => {
  assert.equal(fecChainHeld(false, HELD), true);
  assert.equal(fecChainHeld(true, HELD), true);
});

test("held: D3a — the FEC drop probe STILL records", () => {
  // The whole of D3a. If this ever flips, every supervised session becomes a
  // FIX-1166 `probe-missing` true positive.
  assert.equal(probeRecords(true, HELD), true, "the probe must survive a hold");
  assert.equal(probeRecords(false, HELD), false, "…but the phase gate still applies");
});

test("held: the three enrichment sub-phases and unsplit 'enrichment' close `skipped`", () => {
  for (const phase of ["enrichment", "enrichment-heavy", "enrichment-light", "enrichment-tail"] as const) {
    assert.equal(phaseFullyHeld(phase, HELD), true, phase);
    assert.equal(nightlyPhaseStatus({ phase, hold: HELD, hasErrors: false }), "skipped", phase);
    // Errors do not demote a held phase: it did nothing, so `partial` would be
    // a claim about work that never started.
    assert.equal(nightlyPhaseStatus({ phase, hold: HELD, hasErrors: true }), "skipped", phase);
  }
});

test("held: 'fec' and 'all' do NOT close `skipped` — their daily ingest still runs", () => {
  for (const phase of ["fec", "all"] as const) {
    assert.equal(phaseFullyHeld(phase, HELD), false, phase);
    assert.equal(nightlyPhaseStatus({ phase, hold: HELD, hasErrors: false }), "complete", phase);
    assert.equal(nightlyPhaseStatus({ phase, hold: HELD, hasErrors: true }), "partial", phase);
  }
});

// ---------------------------------------------------------------------------
// The reason string is a cross-mechanism contract
// ---------------------------------------------------------------------------

test("the skip_reason spelling matches what the guarded pg_cron procedures write", () => {
  // FIX-1137 keys on this prefix across BOTH mechanisms; the guard migrations
  // build the same string in SQL. If the two ever drift, the re-fire silently
  // sees half the skipped firings.
  assert.equal(
    prodSessionHoldReason("FIX-954 set 3 apply"),
    "prod session held: FIX-954 set 3 apply",
  );
  assert.equal(prodSessionHoldReason(null), "prod session held: (no label)");
  assert.equal(prodSessionHoldReason(undefined), "prod session held: (no label)");
  assert.equal(prodSessionHoldReason("   "), "prod session held: (no label)");
  assert.ok(prodSessionHoldReason("x").startsWith("prod session held: "));
});

test("the banner carries the reason and says what still runs", () => {
  const b = prodSessionHoldBanner("landing FIX-1106");
  assert.match(b, /prod session held: landing FIX-1106/);
  assert.match(b, /FEC drop probe still records/);
  assert.match(b, /Phase 1\s+daily ingest still runs/);
});
