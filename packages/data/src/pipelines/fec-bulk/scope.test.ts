/**
 * FIX-700 — indiv stage-gating scope filter (FEC_INDIV_STAGES).
 *
 * Pins the pure decision logic in scope.ts: which sub-stages run, and whether a
 * given stage allow-list marks the run "scoped". Combined with indiv.test.ts's
 * tx-type coverage, this covers both scope axes without a pipeline run.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/scope.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIndivStages,
  stageEnabled,
  isStagesScoped,
  INDIV_STAGE_NAMES,
  type IndivStageName,
} from "./scope";

test("FIX-700 default (unset FEC_INDIV_STAGES) enables every stage, not scoped", () => {
  const { set, unknown } = parseIndivStages(undefined);
  assert.equal(set.size, 0, "empty allow-list");
  assert.equal(unknown.length, 0);
  for (const name of INDIV_STAGE_NAMES) {
    assert.ok(stageEnabled(set, name), `${name} enabled by default`);
  }
  assert.equal(isStagesScoped(set), false, "all-stages is not scoped");
});

test("FIX-700 blank FEC_INDIV_STAGES behaves like unset", () => {
  const { set } = parseIndivStages("   ,  ");
  assert.equal(set.size, 0);
  assert.equal(isStagesScoped(set), false);
});

test("FIX-700 a single-stage allow-list disables the rest and is scoped", () => {
  const { set } = parseIndivStages("indiv-to-committee");
  assert.ok(stageEnabled(set, "indiv-to-committee"), "the listed stage runs");
  const disabled: IndivStageName[] = [
    "donor-entities",
    "indiv-to-candidate",
    "recipient-entities",
    "independent-expenditures",
    "totals",
  ];
  for (const name of disabled) {
    assert.ok(!stageEnabled(set, name), `${name} must be skipped`);
  }
  assert.equal(isStagesScoped(set), true, "excluding stages ⇒ scoped");
});

test("FIX-700 a multi-stage allow-list runs exactly the listed stages", () => {
  // The type-10 finish's minimal stage set (if narrowing stages explicitly).
  const { set } = parseIndivStages("donor-entities, recipient-entities, indiv-to-committee, totals");
  assert.ok(stageEnabled(set, "donor-entities"));
  assert.ok(stageEnabled(set, "recipient-entities"));
  assert.ok(stageEnabled(set, "indiv-to-committee"));
  assert.ok(stageEnabled(set, "totals"));
  assert.ok(!stageEnabled(set, "indiv-to-candidate"));
  assert.ok(!stageEnabled(set, "independent-expenditures"));
  assert.equal(isStagesScoped(set), true);
});

test("FIX-700 listing ALL stages explicitly is not scoped", () => {
  const { set } = parseIndivStages(INDIV_STAGE_NAMES.join(","));
  for (const name of INDIV_STAGE_NAMES) assert.ok(stageEnabled(set, name));
  assert.equal(isStagesScoped(set), false, "explicit full list ⇒ not narrowing");
});

test("FIX-700 unknown stage names are surfaced (warn), not silently accepted as valid", () => {
  const { set, unknown } = parseIndivStages("indiv-to-committee, bogus-stage");
  assert.deepEqual(unknown, ["bogus-stage"]);
  // The valid stage still gates correctly; the unknown one just never matches.
  assert.ok(stageEnabled(set, "indiv-to-committee"));
  assert.equal(isStagesScoped(set), true);
});

test("FIX-700 env var wiring: process.env.FEC_INDIV_STAGES is honored", () => {
  const prev = process.env.FEC_INDIV_STAGES;
  try {
    process.env.FEC_INDIV_STAGES = "indiv-to-committee";
    const { set } = parseIndivStages();
    assert.ok(stageEnabled(set, "indiv-to-committee"));
    assert.ok(!stageEnabled(set, "donor-entities"));
    assert.equal(isStagesScoped(set), true);
  } finally {
    if (prev === undefined) delete process.env.FEC_INDIV_STAGES;
    else process.env.FEC_INDIV_STAGES = prev;
  }
});
