/**
 * FIX-701 — recipient-committee scope axis (FEC_INDIV_RECIPIENT_CMTES).
 *
 * A third surgical axis alongside FEC_INDIV_TX_TYPES / FEC_INDIV_STAGES. When an
 * allow-list is set, the indiv stage captures ONLY donations whose recipient
 * committee is in the list (both the candidate-attribution map and the
 * non-candidate committee set are narrowed to it), and the run is "scoped" so the
 * writers skip entity-aggregate overwrite. Empty ⇒ unset ⇒ full-run behavior.
 *
 * Runs via:  tsx --test src/pipelines/fec-bulk/recipient-scope.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRecipientCmtes,
  isRecipientScoped,
  applyRecipientCmteScope,
} from "./indiv";

test("FIX-701 parseRecipientCmtes: empty/unset ⇒ empty set", () => {
  assert.equal(parseRecipientCmtes("").size, 0);
  assert.equal(parseRecipientCmtes(undefined).size, 0);
  assert.equal(parseRecipientCmtes("  , ,").size, 0);
});

test("FIX-701 parseRecipientCmtes: trims + uppercases + de-dupes", () => {
  const set = parseRecipientCmtes(" c00010003 , C00010004 ,c00010003");
  assert.deepEqual([...set].sort(), ["C00010003", "C00010004"]);
});

test("FIX-701 isRecipientScoped: true only when the allow-list is non-empty", () => {
  assert.equal(isRecipientScoped(parseRecipientCmtes("")), false);
  assert.equal(isRecipientScoped(parseRecipientCmtes("C00010003")), true);
});

test("FIX-701 applyRecipientCmteScope: empty allow-list is a no-op (full run)", () => {
  const cmteToCand = new Map([["C00000001", "H0AA00000"], ["C00000002", "S0BB00000"]]);
  const nonCand    = new Set(["C00010003", "C00010004", "C00010005"]);
  const { candKept, nonCandKept } = applyRecipientCmteScope(cmteToCand, nonCand, new Set());
  assert.equal(candKept, 2);
  assert.equal(nonCandKept, 3);
  assert.equal(cmteToCand.size, 2);
  assert.equal(nonCand.size, 3);
});

test("FIX-701 applyRecipientCmteScope: narrows BOTH maps to only the allow-listed recipients", () => {
  const cmteToCand = new Map([["C00000001", "H0AA00000"], ["C00000002", "S0BB00000"]]);
  const nonCand    = new Set(["C00010003", "C00010004", "C00010005"]);
  // Allow-list: one candidate committee + two non-candidate (a D + a B).
  const allow = parseRecipientCmtes("C00000001,C00010003,C00010004");

  const { candKept, nonCandKept } = applyRecipientCmteScope(cmteToCand, nonCand, allow);

  // Candidate path: only C00000001 survives.
  assert.equal(candKept, 1);
  assert.ok(cmteToCand.has("C00000001"));
  assert.ok(!cmteToCand.has("C00000002"), "unlisted candidate committee dropped");

  // Committee path: only the two allow-listed D/B committees survive.
  assert.equal(nonCandKept, 2);
  assert.ok(nonCand.has("C00010003"));
  assert.ok(nonCand.has("C00010004"));
  assert.ok(!nonCand.has("C00010005"), "unlisted non-cand committee dropped");

  // And this makes the run scoped.
  assert.equal(isRecipientScoped(allow), true);
});

test("FIX-701 applyRecipientCmteScope: a D/B-only allow-list strips the entire candidate path", () => {
  // The 2024 D/B re-capture shape: the allow-list is all non-candidate D/B
  // committees, so the candidate-attribution map empties out entirely.
  const cmteToCand = new Map([["C00000001", "H0AA00000"]]);
  const nonCand    = new Set(["C00010003", "C00010004"]);
  const allow = parseRecipientCmtes("C00010003,C00010004");

  const { candKept, nonCandKept } = applyRecipientCmteScope(cmteToCand, nonCand, allow);
  assert.equal(candKept, 0);
  assert.equal(nonCandKept, 2);
});
