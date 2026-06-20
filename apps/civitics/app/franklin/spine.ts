// FIX-621 (PR A-extension): the declarative "Follow HB-14" narrative spine.
//
// This is an AUTHORED TOUR SCRIPT over REAL seeded records — the ordering, the
// connective copy, and *which* records are the stops are authored; every live fact
// (titles, statuses, vote counts, evidence-card counts, comment counts) is queried
// by page.tsx at request time. NOTHING factual is hardcoded here. Curation over the
// fixed State-of-Franklin demonstration data is legitimate; fabrication is not — so
// this file carries only natural keys (resolved by the page against anon-readable
// columns: bill_number / title / display_name — NEVER franklin_seed_map, which has
// RLS enabled with zero policies and returns nothing to the anon client) plus the
// editorial copy that threads the records together.
//
// It is intentionally an ordered, declarative list so the future A2 guided-overlay
// (a stepped walkthrough) can drive itself off the same `FRANKLIN_SPINE`. Do NOT
// build that overlay here.

export const FRANKLIN_BILL_NUMBER = "HB-14";

// The PAC the "money" stop curates. The page resolves it by display_name and
// computes its donor inflows + which HB-14 NO-voters it funded — all live.
export const OPPOSITION_PAC_NAME = "Cumberland Energy Action Fund";

// The two cited Ridgeline investigations, resolved by title (anon-readable).
export const RIDGELINE_INVESTIGATION_TITLES = [
  "Who funds the opposition to the Ridgeline Act?",
  "Did the transmission bidder back the Ridgeline Act's supporters?",
];

// The citizen initiative, resolved by title.
export const PLATEAU_INITIATIVE_TITLE = "Fund the Plateau First";

// Which live computation the page runs to fill a stop's `value`/`detail`. The page
// switches on this; A2 can ignore it and just render the authored copy + resolved
// href.
export type SpineMetric =
  | "bill_status"
  | "vote_split"
  | "pac_no_votes"
  | "evidence_count"
  | "comment_count"
  | "initiative";

// How the page resolves the stop's link target to a live record id.
export type SpineTarget =
  | { kind: "proposal"; bill_number: string }
  | { kind: "donor_pac"; display_name: string }
  | { kind: "investigation"; titles: string[] }
  | { kind: "initiative"; title: string };

export type SpineStop = {
  /** Stable handle — the A2 overlay keys steps off this; never reorder-sensitive. */
  id: string;
  /** Authored chip label, e.g. "The bill". */
  kicker: string;
  /** Authored one-line signpost connecting this record to the story. */
  connective: string;
  /** Authored link label. */
  cta: string;
  metric: SpineMetric;
  target: SpineTarget;
};

// The six stops (decision 5). Each resolves to a real record; the page fills in
// the live value/detail and the href.
export const FRANKLIN_SPINE: SpineStop[] = [
  {
    id: "bill",
    kicker: "The bill",
    connective:
      "Ridge-top wind and solar, a 90-mile transmission line, and a just-transition fund for coal counties — open for public comment right now.",
    cta: "Read the bill",
    metric: "bill_status",
    target: { kind: "proposal", bill_number: FRANKLIN_BILL_NUMBER },
  },
  {
    id: "vote",
    kicker: "The floor vote",
    connective:
      "It cleared the Assembly only after the Okafor cost-cap amendment carried — a close, recorded roll call.",
    cta: "See the roll call",
    metric: "vote_split",
    target: { kind: "proposal", bill_number: FRANKLIN_BILL_NUMBER },
  },
  {
    id: "money",
    kicker: "The money",
    connective:
      "The opposition's money ran through one PAC, fed by legacy-energy donors — and it reached the delegates who voted no.",
    cta: "Follow the donations",
    metric: "pac_no_votes",
    target: { kind: "donor_pac", display_name: OPPOSITION_PAC_NAME },
  },
  {
    id: "casefiles",
    kicker: "The case files",
    connective:
      "Two cited investigations trace the pattern card by card — every claim links back to a record you can open.",
    cta: "Open the investigation",
    metric: "evidence_count",
    target: { kind: "investigation", titles: RIDGELINE_INVESTIGATION_TITLES },
  },
  {
    id: "debate",
    kicker: "The debate",
    connective:
      "Citizens argued it out in the Commons — bridge-ranked, so the comments that cross blocs rise to the top.",
    cta: "Read the thread",
    metric: "comment_count",
    target: { kind: "proposal", bill_number: FRANKLIN_BILL_NUMBER },
  },
  {
    id: "initiative",
    kicker: "The citizen response",
    connective:
      "And citizens answered with a measure of their own — redirect the transmission-settlement dollars to the plateau counties.",
    cta: "Open the initiative",
    metric: "initiative",
    target: { kind: "initiative", title: PLATEAU_INITIATIVE_TITLE },
  },
];
