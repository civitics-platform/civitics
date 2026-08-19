/**
 * FIX-1064 — the CROSS-PERSON delete-evidence guard.
 *
 * Runs via:  tsx --test src/scripts/fec-orphan-delete-evidence.test.ts
 *
 * THE BUG THIS PINS. audit-fec-orphan-attribution's reference-case guard
 * accepted a case being absent from the suspect population only with positive
 * evidence that its remediation landed. For a "delete" remediation (FIX-934) it
 * demanded `!holds_fec_money && !has_cand_id` — the official row must be
 * completely EMPTY.
 *
 * Shontel M. Brown is a sitting Representative (OH-11). She legitimately carries
 * her own CAND_ID (H2OH11169) and legitimately holds her own donors. FIX-934
 * deleted the rows where her row was bound to SHERROD Brown's money; it did not
 * and must not have emptied her row. So the old predicate described a row that
 * cannot exist for a real person, and from 08-05 the audit exited non-zero on a
 * signal that was CLEAN (0 CROSS suspects, $0, independently corroborated).
 *
 * The replacement asserts the absence of the MIS-BOUND money specifically: the
 * residual overlap against the named twin must no longer clear the classifier's
 * own boundary, and the row must not claim the twin's CAND_ID.
 *
 * Numbers below are measured on prod 2026-08-18 unless noted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteEvidenceCleared } from "./fec-orphan-classify";

/** The boundary the 2026-08-18 audit derived. */
const BOUNDARY = { fracCut: 0.1667, sharedFloor: 146 };

/** Shontel M. Brown, measured on prod after FIX-934. */
const SHONTEL_AFTER = { twinShared: 266, ownRows: 3578, claimsTwinCandId: false };

test("post-remediation reference case passes — residual overlap is below the fraction cut", () => {
  const v = deleteEvidenceCleared(SHONTEL_AFTER, BOUNDARY);
  assert.equal(v.ok, true);
  assert.equal(v.stillOverlapping, false);
  // 266 / 3,578 = 0.0743 — below the 0.1667 cut, so branchOf would now file this
  // row UNIQUE HOLDER rather than CROSS-PERSON MISATTRIBUTION.
  assert.ok(v.frac < BOUNDARY.fracCut, `frac ${v.frac} should be below ${BOUNDARY.fracCut}`);
  assert.equal(v.frac.toFixed(4), "0.0743");
});

test("the old predicate's premise is false — she legitimately holds money and a CAND_ID", () => {
  // Guards the regression directly: an "is the row empty" test would fail here,
  // and that failure was the bug. Both facts are true of her live row.
  const holdsFecMoney = true;
  const hasCandId = true;
  assert.equal(!holdsFecMoney && !hasCandId, false);
  assert.equal(deleteEvidenceCleared(SHONTEL_AFTER, BOUNDARY).ok, true);
});

test("pre-remediation state fails — 42,681 shared pairs clears both cut and floor", () => {
  // The state the 07-29/07-30/07-31 audits recorded, before FIX-934 shipped.
  const before = { twinShared: 42_681, ownRows: 46_259, claimsTwinCandId: false };
  const v = deleteEvidenceCleared(before, BOUNDARY);
  assert.equal(v.ok, false);
  assert.equal(v.stillOverlapping, true);
  assert.ok(v.frac >= BOUNDARY.fracCut);
});

test("claiming the twin's CAND_ID fails even with zero overlap — that claim IS the mis-binding", () => {
  const v = deleteEvidenceCleared(
    { twinShared: 0, ownRows: 3578, claimsTwinCandId: true },
    BOUNDARY,
  );
  assert.equal(v.ok, false);
  assert.equal(v.stillOverlapping, false);
});

test("the conjunction is respected — clearing only ONE of cut/floor is not still-overlapping", () => {
  // High fraction, tiny absolute overlap: the tiny-N corner the floor exists for.
  const highFracLowShared = { twinShared: 3, ownRows: 4, claimsTwinCandId: false };
  assert.equal(deleteEvidenceCleared(highFracLowShared, BOUNDARY).ok, true);

  // Large absolute overlap, low fraction: a high-volume official who genuinely
  // shares donors. This is Shontel's shape, and it must not read as misbinding.
  const lowFracHighShared = { twinShared: 500, ownRows: 40_000, claimsTwinCandId: false };
  assert.equal(deleteEvidenceCleared(lowFracHighShared, BOUNDARY).ok, true);

  // Both cleared -> still misattributed.
  const both = { twinShared: 500, ownRows: 1_000, claimsTwinCandId: false };
  assert.equal(deleteEvidenceCleared(both, BOUNDARY).ok, false);
});

test("the guard tracks the boundary rather than a hardcoded count", () => {
  // Same facts, a boundary loose enough to still call it overlapping.
  const loose = { fracCut: 0.05, sharedFloor: 100 };
  assert.equal(deleteEvidenceCleared(SHONTEL_AFTER, loose).ok, false);
  assert.equal(deleteEvidenceCleared(SHONTEL_AFTER, BOUNDARY).ok, true);
});

test("a row with no donation rows at all does not divide by zero", () => {
  const v = deleteEvidenceCleared(
    { twinShared: 0, ownRows: 0, claimsTwinCandId: false },
    BOUNDARY,
  );
  assert.equal(v.frac, 0);
  assert.equal(v.ok, true);
});
