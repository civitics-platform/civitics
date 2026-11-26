/**
 * FIX-1447 (cc-317 D8) — one type label, over every proposal_type value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { INDEX_FILTER_TYPES, PROPOSAL_TYPE_LABELS, proposalTypeLabel } from "./labels";
import { enumValues } from "./enums.test-helper";

const WANT: Record<string, string> = {
  regulation:      "Federal Regulation",
  bill:            "Congressional Bill",
  executive_order: "Executive Order",
  treaty:          "Treaty",
  referendum:      "Referendum",
  resolution:      "Resolution",
  appointment:     "Appointment",
  ordinance:       "Ordinance",
  amendment:       "Amendment",
  budget:          "Budget",
  initiative:      "Citizen Initiative",
  other:           "Other",
};

test("D8: every proposal_type value has a plain label; none prints its raw enum", () => {
  const types = enumValues("proposal_type");
  assert.deepEqual([...types].sort(), Object.keys(WANT).sort(), "a new type needs a label here");
  for (const t of types) {
    assert.equal(proposalTypeLabel(t), WANT[t], t);
    assert.equal(PROPOSAL_TYPE_LABELS[t], WANT[t], t);
  }
});

test("D8: the six original labels are unchanged, and the index filter still offers exactly those six", () => {
  assert.deepEqual([...INDEX_FILTER_TYPES], ["regulation", "bill", "executive_order", "treaty", "referendum", "resolution"]);
  assert.deepEqual(
    INDEX_FILTER_TYPES.map((t) => proposalTypeLabel(t)),
    ["Federal Regulation", "Congressional Bill", "Executive Order", "Treaty", "Referendum", "Resolution"],
  );
});

test("D8: an appointment is a Nomination when its number is a PN", () => {
  assert.equal(proposalTypeLabel("appointment", { billNumber: "PN 858" }), "Nomination");
  assert.equal(proposalTypeLabel("appointment", { billNumber: "PN 11-1" }), "Nomination");
  assert.equal(proposalTypeLabel("appointment", { billNumber: "Appt 03170" }), "Appointment");
  assert.equal(proposalTypeLabel("appointment", { billNumber: null }), "Appointment");
});

test("D8: other is a Court opinion with a court, else Legistar's matter type, else Other", () => {
  assert.equal(proposalTypeLabel("other", { metadata: { court: "ca9" } }), "Court opinion");
  assert.equal(
    proposalTypeLabel("other", { metadata: { court: "ca9", legistar_matter_type: "Report" } }),
    "Court opinion",
  );
  assert.equal(proposalTypeLabel("other", { metadata: { legistar_matter_type: "Communication (Comm)" } }), "Communication (Comm)");
  assert.equal(proposalTypeLabel("other", { metadata: { court: "  " } }), "Other");
  assert.equal(proposalTypeLabel("other", { metadata: null }), "Other");
});

test("D8: an unknown type still prints itself", () => {
  assert.equal(proposalTypeLabel("something_new"), "something_new");
});
