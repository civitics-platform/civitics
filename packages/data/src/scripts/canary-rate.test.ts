/**
 * FIX-1315 — the rate check honours the rollup registry's hold.
 *
 * Runs via:  tsx --test src/scripts/canary-rate.test.ts
 *
 * The five cases are the whole policy: held → report with the hold named,
 * retired → report, un-held → escalate, no registry row → escalate (unknown is
 * not held), nothing → nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyRateRegressions, type RollupHoldLike } from "./canary-rate";

const HOLD = "parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry";

const reg = (pipeline: string) => ({ pipeline, verdict: "regressed", worst_case_ratio: 2.4 });
const rollup = (pipeline: string, over: Partial<RollupHoldLike> = {}): RollupHoldLike => ({
  pipeline,
  held: false,
  retired: false,
  holdReason: null,
  ...over,
});

test("FIX-1315: a HELD pipeline's regression is demoted to report, and the hold is named", () => {
  const r = classifyRateRegressions([reg("run_rule_taggers")], [rollup("run_rule_taggers", { held: true, holdReason: HOLD })]);
  assert.deepEqual(r.escalate, []);
  assert.equal(r.report.length, 1);
  assert.equal(r.report[0]!.f.pipeline, "run_rule_taggers");
  assert.equal(r.report[0]!.why, "held: " + HOLD);
  // The finding rides through untouched — describeRate still reads its numbers.
  assert.equal(r.report[0]!.f.worst_case_ratio, 2.4);
});

test("FIX-1315: a RETIRED pipeline's regression is demoted to report as retired", () => {
  const r = classifyRateRegressions(
    [reg("old_pipeline")],
    [rollup("old_pipeline", { retired: true, held: true, holdReason: "both set — retired wins" })],
  );
  assert.deepEqual(r.escalate, []);
  assert.deepEqual(r.report.map((x) => x.why), ["retired"]);
});

test("FIX-1315: an un-held pipeline's regression still escalates", () => {
  const r = classifyRateRegressions(
    [reg("refresh_derived_mvs"), reg("run_rule_taggers")],
    [rollup("refresh_derived_mvs"), rollup("run_rule_taggers", { held: true, holdReason: null })],
  );
  assert.deepEqual(r.escalate.map((f) => f.pipeline), ["refresh_derived_mvs"]);
  assert.deepEqual(r.report.map((x) => x.why), ["held: (no reason)"]);
});

test("FIX-1315: a regression whose pipeline has NO rollup row escalates — unknown is not held", () => {
  const r = classifyRateRegressions([reg("not_in_registry")], [rollup("run_rule_taggers", { held: true, holdReason: HOLD })]);
  assert.deepEqual(r.escalate.map((f) => f.pipeline), ["not_in_registry"]);
  assert.deepEqual(r.report, []);
});

test("FIX-1315: no regressions → nothing either way", () => {
  const r = classifyRateRegressions([], [rollup("run_rule_taggers", { held: true, holdReason: HOLD })]);
  assert.deepEqual(r, { escalate: [], report: [] });
});
