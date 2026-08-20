/**
 * FIX-700 — surgical scope filters for the FEC indiv stage.
 *
 * Companion to the tx-type filter in indiv.ts (parseKeepTxTypes / isIndivTxScoped).
 * This half gates WHICH indiv sub-stages run, via FEC_INDIV_STAGES (a
 * comma-separated allow-list). Unset/empty ⇒ all stages run ⇒ today's behavior.
 *
 * Both axes feed one decision: `isScoped`. A run is scoped when the tx-type set
 * narrows below 15/15E/10 OR the stage allow-list excludes any stage. Scoped
 * runs suppress entity-aggregate overwrite in the writers (writer.ts
 * skipAggregateOverwrite) — a tx-type-10-only run would otherwise clobber a
 * mixed donor's real total_donated_cents with just their super-PAC slice. The
 * authoritative aggregates are re-derived by the `totals` stage afterward.
 *
 * SCOPE = the indiv stage only. cn/weball/pas2 always run in full — a
 * whole-pipeline stage selector is a deliberate non-goal here.
 *
 * Pure functions (no I/O) so they unit-test without a pipeline run.
 */

// Stable stage names, in pipeline order. Each maps to a gated sub-step in
// runFecBulkPipeline(): donor-entity upsert, indiv→candidate rels,
// recipient-committee pre-upsert, indiv→committee rels, the sub-$200 bracket
// rollup, the Schedule-E (independent expenditure) stage, and the end-of-run
// totals recompute(s).
//
// FIX-1068 added `small-dollar-brackets`. It is deliberately NOT in
// run-state.ts's TRACKED_STAGES: it writes a few tens of thousands of rows in
// one delete-then-insert transaction per cycle, so it is idempotent, fast, and
// has nothing worth a resume cursor — the cursor machinery exists for the
// hour-scale writers.
export const INDIV_STAGE_NAMES = [
  "donor-entities",
  "indiv-to-candidate",
  "recipient-entities",
  "indiv-to-committee",
  "small-dollar-brackets",
  "independent-expenditures",
  "totals",
] as const;

export type IndivStageName = (typeof INDIV_STAGE_NAMES)[number];

function isKnownStage(name: string): name is IndivStageName {
  return (INDIV_STAGE_NAMES as readonly string[]).includes(name);
}

/**
 * Parse FEC_INDIV_STAGES into an allow-list Set plus any unrecognized names
 * (returned so the caller can warn). Empty Set ⇒ "all stages enabled".
 */
export function parseIndivStages(raw: string | undefined = process.env.FEC_INDIV_STAGES): {
  set: Set<string>;
  unknown: string[];
} {
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = parts.filter((p) => !isKnownStage(p));
  return { set: new Set(parts), unknown };
}

/** True when `name` should run given the allow-list (empty ⇒ all run). */
export function stageEnabled(stageSet: Set<string>, name: IndivStageName): boolean {
  return stageSet.size === 0 || stageSet.has(name);
}

/** A run is stage-scoped when the allow-list excludes at least one known stage. */
export function isStagesScoped(stageSet: Set<string>): boolean {
  return INDIV_STAGE_NAMES.some((n) => !stageEnabled(stageSet, n));
}
