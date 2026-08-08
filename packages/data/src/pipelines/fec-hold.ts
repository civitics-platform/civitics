/**
 * FIX-998 — pure trigger predicates for the nightly orchestrator's fec_bulk
 * block, including the FIX-995 hold.
 *
 * WHY A MODULE, AND WHY ALL THREE PREDICATES TOGETHER: fec_bulk has three
 * independent triggers in runNightlySync, and two of them HAND OFF TO EACH
 * OTHER. The FIX-903 weekday drop probe is evaluated only when the FIX-754
 * resume-state load came back null, so suppressing the resume trigger (by
 * clearing pipeline_state.fec_bulk_run_state) does not stop fec_bulk from
 * running — it just moves the trigger to FIX-903. A guard on one branch is
 * not a guard. Both hand-offs were observed in production: across the
 * 2026-08-03..08-08 nightlies, 08-03/08-04/08-08 ran via the FIX-754 resume
 * and 08-05/08-06 ran via the FIX-903 drop probe.
 *
 * So the hold is expressed as one `held` input threaded through every
 * predicate, and the predicates live here — pure, no imports, no env reads —
 * so the truth table can be asserted without dragging in index.ts's import
 * graph (createAdminClient, the ai-tagger's module-level createAiClient(), …).
 * Mirrors weekly-gate.ts's computeRunWeekly.
 *
 * `held` itself comes from FLAGS.FEC_NIGHTLY_BULK_ENABLED — feature-flags.ts
 * is the ONE place FEC_NIGHTLY_BULK_DISABLED is parsed.
 */

export interface FecBulkTriggerInputs {
  /** Phase gate: this nightly phase covers fec (`--phase=fec` or `all`). */
  runFec: boolean;
  /** FIX-743 weekly gate (Sunday, or NIGHTLY_FORCE_WEEKLY=true). */
  isWeekly: boolean;
  /** FIX-998: fec_bulk is held on the nightly path (FEC_NIGHTLY_BULK_DISABLED). */
  held: boolean;
}

/**
 * Should the nightly read pipeline_state.fec_bulk_run_state at all (FIX-754)?
 * Sundays resume through the normal weekly invocation without this check.
 */
export function shouldLoadResumeState(i: FecBulkTriggerInputs): boolean {
  return i.runFec && !i.isWeekly && !i.held;
}

/**
 * Should the nightly HEAD the FEC indiv file to check for a new drop (FIX-903)?
 * Only when the resume branch did not already claim the run — hence the
 * hand-off this module exists to make visible.
 */
export function shouldProbeDrop(
  i: FecBulkTriggerInputs,
  resumeStatePresent: boolean,
): boolean {
  return shouldLoadResumeState(i) && !resumeStatePresent;
}

/**
 * Should runFecBulkPipeline() actually be invoked? The hold short-circuits
 * ahead of all three trigger conditions — weekly, resume, drop.
 */
export function shouldRunFecBulk(
  i: FecBulkTriggerInputs,
  resumeStatePresent: boolean,
  dropPending: boolean,
): boolean {
  if (!i.runFec || i.held) return false;
  return i.isWeekly || resumeStatePresent || dropPending;
}

/**
 * True when this nightly is skipping fec_bulk *because of the hold* — i.e. the
 * phase would otherwise have considered it. Distinguishes "deliberately held"
 * from "not this phase's job", so the orchestrator only emits the loud line and
 * the `skipped` result row on the fec phase.
 */
export function fecBulkHeldThisPhase(i: FecBulkTriggerInputs): boolean {
  return i.runFec && i.held;
}

/** One-line operator-facing explanation for the loud hold log + result row. */
export const FEC_HOLD_REASON =
  "fec_bulk held on the nightly path (FIX-995 / FIX-998) — " +
  "FEC_NIGHTLY_BULK_DISABLED=true in .github/workflows/nightly.yml. " +
  "The ingest runs via fec-backfill.yml workflow_dispatch meanwhile. " +
  "Re-enable by deleting that one env line.";
