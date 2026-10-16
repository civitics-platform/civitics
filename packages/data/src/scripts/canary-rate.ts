/**
 * FIX-1315 — the rate check's tier, given what the rollup registry says about
 * the pipeline.
 *
 * WHY. `check_pipeline_rate_regression()` reads no overrides: it compares a
 * pipeline's last three runs against its own P90 baseline and nothing else. A
 * HELD pipeline stops running, so its recent window freezes on whatever the
 * last three runs were — and if those were slow, the regression is permanent
 * until the pipeline returns. `run_rule_taggers` was parked for the dispatcher
 * cutover (cc-232, FIX-1311) at 6.65 s/1k and escalated every day after it.
 *
 * The FIX-1059 hold already gates the FRESHNESS condition (the fold in
 * `fetchRollupFreshness`). This is the same policy for the rate condition, and
 * like the freshness fold it lives on the TS side: the RPC stays held-blind,
 * and the canary owns what a hold means.
 *
 * A held or retired pipeline's regression is DEMOTED to `report`, never
 * dropped — the meta row still carries it, under the same key, so the day the
 * hold is converted (M1/V1 shape: `held_since` NULL) the next run re-escalates
 * it as a tier change rather than as a new condition.
 *
 * Pure, and a module of its own because `canary-check.ts` exports nothing and
 * runs `main()` on load.
 */

/** The fields of a `check_pipeline_rate_regression()` regression this reads. */
export interface RateRegressionLike {
  pipeline: string;
}

/** The fields of a canary `RollupStatus` this reads. */
export interface RollupHoldLike {
  pipeline: string;
  held: boolean;
  retired: boolean;
  holdReason: string | null;
}

export interface RateClassification<R extends RateRegressionLike> {
  escalate: R[];
  report: Array<{ f: R; why: string }>;
}

/**
 * Splits the regressions by the registry's hold state. A regression whose
 * pipeline has NO rollup row escalates: unknown is not held. Retired wins over
 * held when both are set, the same order the canary's `declared` line uses.
 */
export function classifyRateRegressions<R extends RateRegressionLike>(
  regressions: readonly R[],
  rollups: readonly RollupHoldLike[],
): RateClassification<R> {
  const byPipeline = new Map(rollups.map((r) => [r.pipeline, r]));
  const out: RateClassification<R> = { escalate: [], report: [] };
  for (const f of regressions) {
    const r = byPipeline.get(f.pipeline);
    if (r?.retired) out.report.push({ f, why: "retired" });
    else if (r?.held) out.report.push({ f, why: `held: ${r.holdReason ?? "(no reason)"}` });
    else out.escalate.push(f);
  }
  return out;
}
