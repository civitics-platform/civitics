/**
 * FIX-998 — the nightly fec_bulk hold, and the three-trigger truth table it
 * has to cover.
 *
 * Runs via:  tsx --test src/pipelines/fec-hold.test.ts
 *
 * The load-bearing assertion is the exhaustive one: for EVERY combination of
 * (runFec, isWeekly, resumeStatePresent, dropPending), held ⇒ nothing is
 * evaluated and nothing is invoked. A hold that only covered the branch whose
 * log line was visible would be the FIX-995 defect a second time — the FIX-754
 * resume branch and the FIX-903 drop probe hand off to each other, so clearing
 * the run state to stop one merely arms the other.
 *
 * The mirror assertion is that unset ⇒ byte-identical to pre-FIX-998 behavior,
 * expressed as the literal boolean expressions the orchestrator used before
 * this change, so a future edit to the predicates cannot quietly change the
 * un-held path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldLoadResumeState,
  shouldProbeDrop,
  shouldRunFecBulk,
  fecBulkHeldThisPhase,
  FEC_HOLD_REASON,
  type FecBulkTriggerInputs,
} from "./fec-hold";

const BOOLS = [false, true] as const;

/** Every (runFec, isWeekly, resumeStatePresent, dropPending) combination. */
function* matrix(): Generator<{
  runFec: boolean;
  isWeekly: boolean;
  resumeStatePresent: boolean;
  dropPending: boolean;
}> {
  for (const runFec of BOOLS)
    for (const isWeekly of BOOLS)
      for (const resumeStatePresent of BOOLS)
        for (const dropPending of BOOLS)
          yield { runFec, isWeekly, resumeStatePresent, dropPending };
}

test("held: NO trigger is evaluated and the pipeline is NOT invoked — all 16 combinations", () => {
  for (const { runFec, isWeekly, resumeStatePresent, dropPending } of matrix()) {
    const i: FecBulkTriggerInputs = { runFec, isWeekly, held: true };
    const where = JSON.stringify({ runFec, isWeekly, resumeStatePresent, dropPending });

    // FIX-754 resume-state load — a single-row read, but it is also the thing
    // that ARMS the resume trigger. Held means we don't even look.
    assert.equal(shouldLoadResumeState(i), false, `resume load evaluated while held: ${where}`);
    // FIX-903 drop probe — a network HEAD against FEC. Held means no probe.
    assert.equal(shouldProbeDrop(i, resumeStatePresent), false, `drop probe evaluated while held: ${where}`);
    // The invocation itself, including the Sunday weekly path.
    assert.equal(shouldRunFecBulk(i, resumeStatePresent, dropPending), false, `pipeline invoked while held: ${where}`);
  }
});

test("held on the Sunday weekly path too — the weekly gate is not an escape hatch", () => {
  const i: FecBulkTriggerInputs = { runFec: true, isWeekly: true, held: true };
  assert.equal(shouldRunFecBulk(i, false, false), false);
  assert.equal(fecBulkHeldThisPhase(i), true);
});

test("unset (held=false): identical to the pre-FIX-998 boolean expressions", () => {
  for (const { runFec, isWeekly, resumeStatePresent, dropPending } of matrix()) {
    const i: FecBulkTriggerInputs = { runFec, isWeekly, held: false };
    const where = JSON.stringify({ runFec, isWeekly, resumeStatePresent, dropPending });

    // Literal pre-change expressions from pipelines/index.ts, kept verbatim.
    assert.equal(shouldLoadResumeState(i), runFec && !isWeekly, `resume load drifted: ${where}`);
    assert.equal(
      shouldProbeDrop(i, resumeStatePresent),
      runFec && !isWeekly && !resumeStatePresent,
      `drop probe drifted: ${where}`,
    );
    assert.equal(
      shouldRunFecBulk(i, resumeStatePresent, dropPending),
      runFec && (isWeekly || resumeStatePresent || dropPending),
      `invocation drifted: ${where}`,
    );
  }
});

test("the FIX-903 hand-off the hold has to cover: clearing run state re-arms the drop probe", () => {
  // This is the observed weekday shape (2026-08-05/08-06 ran this way). With
  // no resume state pending, the drop probe is evaluated and can trigger the
  // run on its own — which is why a guard on the resume branch alone is not a
  // guard.
  const unheld: FecBulkTriggerInputs = { runFec: true, isWeekly: false, held: false };
  assert.equal(shouldProbeDrop(unheld, false), true, "probe must fire when no resume state pends");
  assert.equal(shouldRunFecBulk(unheld, false, true), true, "drop probe alone must be able to trigger the run");

  // Same shape, held: both paths dead.
  const held: FecBulkTriggerInputs = { ...unheld, held: true };
  assert.equal(shouldProbeDrop(held, false), false);
  assert.equal(shouldRunFecBulk(held, false, true), false);
});

test("fecBulkHeldThisPhase only fires on a phase that covers fec", () => {
  // An enrichment-phase job (runFec=false) must not log the hold or write a
  // `skipped` fec_bulk row — it was never going to run fec_bulk anyway.
  assert.equal(fecBulkHeldThisPhase({ runFec: false, isWeekly: false, held: true }), false);
  assert.equal(fecBulkHeldThisPhase({ runFec: false, isWeekly: true, held: true }), false);
  assert.equal(fecBulkHeldThisPhase({ runFec: true, isWeekly: false, held: true }), true);
  assert.equal(fecBulkHeldThisPhase({ runFec: true, isWeekly: false, held: false }), false);
});

test("the hold reason names the FIXes and the one-line revert", () => {
  // The reason string lands in the nightly results payload and the log; it is
  // the only thing a future reader has to explain a quiet fec_bulk.
  assert.match(FEC_HOLD_REASON, /FIX-995/);
  assert.match(FEC_HOLD_REASON, /FIX-998/);
  assert.match(FEC_HOLD_REASON, /FEC_NIGHTLY_BULK_DISABLED/);
  assert.match(FEC_HOLD_REASON, /fec-backfill\.yml/);
});
