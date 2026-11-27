/**
 * FIX-1462 (cc-332 B1–B7) — the bill-details fill on the bill page. The counts
 * printed are the source's; an empty answer from a failed read is never "no
 * cosponsors"; nothing here is fetched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOT_COLLECTED_LINE,
  actionLines,
  actionText,
  actionsCountLine,
  billHeading,
  cosponsorCountLine,
  cosponsorRecordLine,
  detailStatus,
  earlierActionsLabel,
  isCongressMeasure,
  notCollectedLine,
  orderCosponsors,
  policyArea,
  sponsorLine,
  sponsorTag,
  withdrawnLabel,
  type ActionRow,
  type CongressDetail,
  type CosponsorRow,
} from "./bill-record";

// HR 1 of the 119th, as the walker stamped it (bill-119-hr-1-detail.json; prod read 4).
const HR1: CongressDetail = {
  fetched_at: "2026-11-27T10:48:06.407Z",
  sponsor: { bioguide: "A000375", name: "Rep. Arrington, Jodey C. [R-TX-19]", party: "R", state: "TX", district: 19 },
  sponsor_official_id: "0f0f0f0f-0000-4000-8000-000000000019",
  short_title: "One Big Beautiful Bill Act",
  policy_area: "Economics and Public Finance",
  cosponsor_count: 0,
  action_count: 59,
};

test("B1: only a federal bill or resolution makes the three reads", () => {
  assert.equal(isCongressMeasure({ bill_number: "HR 1", congress_number: 119 }), true);
  assert.equal(isCongressMeasure({ bill_number: "HJRES 1", congress_number: 119 }), true);
  assert.equal(isCongressMeasure({ bill_number: "SCONRES 7", congress_number: 118 }), true);
  // A nomination carries a congress_gov ref too; the walker does not read it.
  assert.equal(isCongressMeasure({ bill_number: "PN 858", congress_number: 119 }), false);
  // OpenStates and Legistar measures carry no Congress; a regulation no bill_details.
  assert.equal(isCongressMeasure({ bill_number: "SB 185", congress_number: null }), false);
  assert.equal(isCongressMeasure({ bill_number: "CB 119913", congress_number: null }), false);
  assert.equal(isCongressMeasure(null), false);
  assert.equal(isCongressMeasure(undefined), false);
});

test("B1/B7: the ref's state — failed, none, not collected, a 404, collected", () => {
  assert.deepEqual(detailStatus(null), { kind: "failed" });
  assert.deepEqual(detailStatus([]), { kind: "no_ref" });
  // A nomination's ref is not a bill ref.
  assert.deepEqual(detailStatus([{ external_id: "PN858-119", detail: null }]), { kind: "no_ref" });
  assert.deepEqual(detailStatus([{ external_id: "119-HR-2", detail: null }]), { kind: "not_collected" });
  assert.deepEqual(
    detailStatus([{ external_id: "119-HR-2", detail: { fetched_at: "2026-11-27T00:00:00Z", not_found: true } }]),
    { kind: "not_found" },
  );
  const s = detailStatus([{ external_id: "119-HR-1", detail: HR1 }]);
  assert.equal(s.kind, "collected");
  // A stamped ref wins over an unstamped one for the same measure.
  assert.equal(detailStatus([{ external_id: "119-HR-1", detail: null }, { external_id: "119-HR-1", detail: HR1 }]).kind, "collected");
});

test("B7: an unstamped ref prints the sentence; a 404 stamp, a failed read and no ref print nothing", () => {
  assert.equal(notCollectedLine({ kind: "not_collected" }), NOT_COLLECTED_LINE);
  assert.equal(
    NOT_COLLECTED_LINE,
    "Sponsor, cosponsors and actions have not been collected from Congress.gov for this measure yet.",
  );
  for (const kind of ["not_found", "failed", "no_ref"] as const) assert.equal(notCollectedLine({ kind }), null, kind);
  assert.equal(notCollectedLine({ kind: "collected", detail: HR1 }), null);
});

test("B2: the short title is the heading when it is the shorter, with the official title under it", () => {
  // 119 HR 1834 (cc-332 prompt).
  const h = billHeading(
    "To advance policy priorities in the national interest, and for other purposes.",
    "Breaking the Gridlock Act",
  );
  assert.deepEqual(h, {
    heading: "Breaking the Gridlock Act",
    sub: { label: "Official title", text: "To advance policy priorities in the national interest, and for other purposes." },
  });
  // HR 1 on prod (read 5c).
  assert.equal(billHeading("An act to provide for reconciliation pursuant to title II of H. Con. Res. 14.", HR1.short_title).heading, "One Big Beautiful Bill Act");
});

test("B2: a stored title shorter than the short title stays the heading, the short title under it", () => {
  // 119 HR 10326.
  assert.deepEqual(billHeading("PROOF Act", "Preventing Rip-offs and Obtaining Oversight of Fraud Act"), {
    heading: "PROOF Act",
    sub: { label: "Short title, per Congress.gov", text: "Preventing Rip-offs and Obtaining Oversight of Fraud Act" },
  });
});

test("B2: equal but for case, spaces and punctuation, or no short title — today's heading, nothing added", () => {
  assert.deepEqual(billHeading("Protecting America’s Seniors Act", "Protecting America's  seniors act."), {
    heading: "Protecting America’s Seniors Act",
    sub: null,
  });
  assert.deepEqual(billHeading("HR 2312", null), { heading: "HR 2312", sub: null });
  assert.deepEqual(billHeading("Some Act", "  "), { heading: "Some Act", sub: null });
});

test("B3: the sponsor resolved — linked full name and the source's party, state, district", () => {
  const l = sponsorLine(HR1, { id: HR1.sponsor_official_id!, full_name: "Jodey C. Arrington" });
  assert.deepEqual(l, { name: "Jodey C. Arrington", href: `/officials/${HR1.sponsor_official_id}`, tag: "R-TX-19" });
});

test("B3: the sponsor unresolved — the source's own name, unlinked, its bracket tag not doubled", () => {
  assert.deepEqual(sponsorLine({ ...HR1, sponsor_official_id: null }, null), {
    name: "Rep. Arrington, Jodey C.",
    href: null,
    tag: "R-TX-19",
  });
  // bill_details names a different official than the source's sponsor: not linked.
  assert.equal(sponsorLine(HR1, { id: "another-official", full_name: "Someone Else" })?.href, null);
  // A senator has no district; an at-large seat is district 0.
  assert.equal(sponsorTag({ name: "Sen. Scott, Tim [R-SC]", party: "R", state: "SC" }), "R-SC");
  assert.equal(sponsorTag({ name: null, party: "R", state: "WY", district: 0 }), "R-WY-At Large");
  // No single sponsor named → no line.
  assert.equal(sponsorLine({ ...HR1, sponsor: null }, null), null);
});

function cos(over: Partial<CosponsorRow> & { name?: string; party?: string | null } = {}): CosponsorRow {
  const { name = "A Member", party = "democrat", ...rest } = over;
  return {
    official_id: `o-${name}`,
    is_original_cosponsor: false,
    date_added: "2025-03-01",
    date_withdrawn: null,
    official: { id: `o-${name}`, full_name: name, party, district_name: null, role_title: null },
    ...rest,
  };
}

test("B4: the count is the source's; under it the stored rows' party split, and 'N of M' only when fewer", () => {
  const rows = [
    ...Array.from({ length: 150 }, (_, i) => cos({ name: `D${i}`, party: "democrat" })),
    ...Array.from({ length: 147 }, (_, i) => cos({ name: `R${i}`, party: "republican" })),
    cos({ name: "Gone", party: "republican", date_withdrawn: "2025-06-01" }),
  ];
  assert.equal(cosponsorCountLine({ cosponsor_count: 302 }), "302 cosponsors, per Congress.gov");
  // under
  assert.equal(cosponsorRecordLine(302, rows), "297 of 302 on record here, by party: D 150 · R 147");
  // equal — the withdrawn row is never counted
  assert.equal(cosponsorRecordLine(297, rows), "On record here, by party: D 150 · R 147");
  // over: the source's count with no "of"
  assert.equal(cosponsorRecordLine(290, rows), "On record here, by party: D 150 · R 147");
  // none resolved
  assert.equal(cosponsorRecordLine(5, []), "0 of 5 on record here");
  assert.equal(cosponsorCountLine({ cosponsor_count: 1 }), "1 cosponsor, per Congress.gov");
});

test("B4: 'No cosponsors' only when the source's count is 0; no detail, no line", () => {
  assert.equal(cosponsorCountLine(HR1), "No cosponsors, per Congress.gov");
  assert.equal(cosponsorCountLine({}), null);
  assert.equal(cosponsorCountLine(null), null);
  assert.equal(cosponsorCountLine(undefined), null);
  assert.equal(cosponsorRecordLine(0, []), null);
});

test("B4: originals first, then by date added; withdrawn rows last as 'withdrew <date>'", () => {
  const rows = [
    cos({ name: "Late", date_added: "2025-05-01" }),
    cos({ name: "Withdrew", date_added: "2025-02-01", date_withdrawn: "2025-04-10" }),
    cos({ name: "Original B", is_original_cosponsor: true, date_added: "2025-01-03" }),
    cos({ name: "Early", date_added: "2025-02-15" }),
    cos({ name: "Original A", is_original_cosponsor: true, date_added: "2025-01-03" }),
  ];
  const o = orderCosponsors(rows);
  assert.deepEqual(o.active.map((r) => r.official?.full_name), ["Original A", "Original B", "Early", "Late"]);
  assert.deepEqual(o.withdrawn.map((r) => r.official?.full_name), ["Withdrew"]);
  assert.equal(withdrawnLabel(o.withdrawn[0]!), "withdrew April 10, 2025");
});

function act(over: Partial<ActionRow>): ActionRow {
  return { action_at: "2025-07-03T18:31:40Z", description: "x", action_date: "2025-07-03", action_time: null, system: "2", ...over };
}

test("B5: a cross-system duplicate prints once; a date-only copy beside a timed one prints once", () => {
  // HR 1's actions (bill-119-hr-1-actions.json): the House and the Library of Congress both list it.
  const lines = actionLines([
    act({ action_at: "2025-07-04T04:00:00Z", action_date: "2025-07-04", description: "Became Public Law No: 119-21.", system: "9" }),
    act({ action_at: "2025-07-04T04:00:00Z", action_date: "2025-07-04", description: "Became Public Law No: 119-21.", system: "9" }),
    act({ action_at: "2025-07-03T18:00:00Z", description: "Presented to President.", system: "2", action_time: "14:00:00" }),
    act({ action_at: "2025-07-03T04:00:00Z", description: "Presented to President.", system: "9" }),
  ]);
  assert.deepEqual(lines.map(actionText), [
    "July 4, 2025 · Became Public Law No: 119-21.",
    "July 3, 2025 · Presented to President.",
  ]);
});

test("B5: a repeat inside one source system at distinct times is a real repetition — × N", () => {
  // cc-332 read 5(b): "The House resolved into Committee of the Whole…", three times in a day.
  const text = "The House resolved into Committee of the Whole House on the state of the Union for further consideration.";
  const lines = actionLines([
    act({ action_at: "2025-07-02T20:45:37Z", action_date: "2025-07-02", description: text, action_time: "16:45:37", system: "2" }),
    act({ action_at: "2025-07-02T20:04:28Z", action_date: "2025-07-02", description: text, action_time: "16:04:28", system: "2" }),
    act({ action_at: "2025-07-02T16:19:46Z", action_date: "2025-07-02", description: text, action_time: "12:19:46", system: "2" }),
    act({ action_at: "2025-07-02T04:00:00Z", action_date: "2025-07-02", description: "Referred to the Committee on the Budget.", system: "2" }),
  ]);
  assert.deepEqual(lines.map(actionText), [
    `July 2, 2025 · ${text} × 3`,
    "July 2, 2025 · Referred to the Committee on the Budget.",
  ]);
  // A same-system repeat with no time apart (two action codes, or one row per committee) is one event.
  const once = actionLines([
    act({ description: "Signed by President.", system: "9" }),
    act({ description: "Signed by President.", system: "9" }),
  ]);
  assert.deepEqual(once.map((l) => l.times), [null]);
});

test("B5: the section's count is the source's; the rest behind 'N earlier actions'", () => {
  assert.equal(actionsCountLine(HR1), "59 actions, per Congress.gov");
  assert.equal(actionsCountLine({ action_count: 1 }), "1 action, per Congress.gov");
  assert.equal(actionsCountLine({}), null);
  assert.equal(earlierActionsLabel(51), "51 earlier actions");
  assert.equal(earlierActionsLabel(1), "1 earlier action");
  // A row with no description has nothing to print.
  assert.deepEqual(actionLines([act({ description: null }), act({ description: "  " })]), []);
});

test("B6: the policy area, when the source gives one", () => {
  assert.equal(policyArea(HR1), "Economics and Public Finance");
  assert.equal(policyArea({}), null);
});
