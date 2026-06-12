/**
 * FIX-548 (FIX-489 arc) — chamber shapes + seat counts for US state-level
 * legislatures: 50 states, DC, and the 5 inhabited territories.
 *
 * One constants module, three consumers:
 *   1. The openstates pipeline's governing-body resolution (Phase 0 in
 *      pipelines/openstates/index.ts) — shape decides whether a jurisdiction
 *      gets an upper+lower pair or a single legislature_unicameral gb, and the
 *      unicameral name/short_name overrides feed the writer's insert so a
 *      fresh seed never re-creates the mis-modeled "X State Senate/House"
 *      pair for DC/NE/GU/VI.
 *   2. The seat_count backfill (scripts/backfill-gb-seat-counts.ts, FIX-496) —
 *      fills NULL seat_count on state-chamber gbs so the FIX-490 roster
 *      canary covers state rosters, not just the federal rows.
 *   3. The unicameral merge script (scripts/merge-unicameral-legislatures.ts,
 *      FIX-489/FIX-548) — conversion targets read the proper names from here.
 *
 * Seat counts are stable public facts (NCSL "Number of Legislators" tables;
 * they change only by statute/constitutional amendment or, rarely,
 * redistricting law). They are deliberately NOT parsed from openstates bulk
 * data (decision 7 of the Wave B design): a static table is auditable and the
 * numbers move on a years-scale. AS's lower house is 21 (20 elected + the
 * non-voting Swains Island delegate); PR's Senate/House are the 27/51 base
 * sizes (the at-large minority-party add-on seats of PR's constitution can
 * push the sworn roster above this — the canary multiplies by 1.2 before
 * warning, so that slack is absorbed).
 */

export type ChamberShape = "bicameral" | "unicameral";

export interface LegislatureShape {
  shape: ChamberShape;
  /** Statutory seat counts per chamber kind. Keys mirror governing_body_type
   *  suffixes: upper/lower for bicameral, unicameral for single-chamber. */
  seats: { upper?: number; lower?: number; unicameral?: number };
  /** Proper name for the single chamber — unicameral jurisdictions only.
   *  Without it the writer falls back to "<State> State Legislature". */
  unicameralName?: string;
  /** Short name for the single chamber; drives the slug (slug RPC prefers
   *  short_name). */
  unicameralShortName?: string;
}

/** Keyed by the STATE_DATA abbreviation (us-states.ts). */
export const LEGISLATURE_SHAPES: Record<string, LegislatureShape> = {
  AL: { shape: "bicameral", seats: { upper: 35, lower: 105 } },
  AK: { shape: "bicameral", seats: { upper: 20, lower: 40 } },
  AZ: { shape: "bicameral", seats: { upper: 30, lower: 60 } },
  AR: { shape: "bicameral", seats: { upper: 35, lower: 100 } },
  CA: { shape: "bicameral", seats: { upper: 40, lower: 80 } },
  CO: { shape: "bicameral", seats: { upper: 35, lower: 65 } },
  CT: { shape: "bicameral", seats: { upper: 36, lower: 151 } },
  DE: { shape: "bicameral", seats: { upper: 21, lower: 41 } },
  DC: {
    shape: "unicameral",
    seats: { unicameral: 13 },
    unicameralName: "Council of the District of Columbia",
    unicameralShortName: "DC Council",
  },
  FL: { shape: "bicameral", seats: { upper: 40, lower: 120 } },
  GA: { shape: "bicameral", seats: { upper: 56, lower: 180 } },
  HI: { shape: "bicameral", seats: { upper: 25, lower: 51 } },
  ID: { shape: "bicameral", seats: { upper: 35, lower: 70 } },
  IL: { shape: "bicameral", seats: { upper: 59, lower: 118 } },
  IN: { shape: "bicameral", seats: { upper: 50, lower: 100 } },
  IA: { shape: "bicameral", seats: { upper: 50, lower: 100 } },
  KS: { shape: "bicameral", seats: { upper: 40, lower: 125 } },
  KY: { shape: "bicameral", seats: { upper: 38, lower: 100 } },
  LA: { shape: "bicameral", seats: { upper: 39, lower: 105 } },
  ME: { shape: "bicameral", seats: { upper: 35, lower: 151 } },
  MD: { shape: "bicameral", seats: { upper: 47, lower: 141 } },
  MA: { shape: "bicameral", seats: { upper: 40, lower: 160 } },
  MI: { shape: "bicameral", seats: { upper: 38, lower: 110 } },
  MN: { shape: "bicameral", seats: { upper: 67, lower: 134 } },
  MS: { shape: "bicameral", seats: { upper: 52, lower: 122 } },
  MO: { shape: "bicameral", seats: { upper: 34, lower: 163 } },
  MT: { shape: "bicameral", seats: { upper: 50, lower: 100 } },
  NE: {
    shape: "unicameral",
    seats: { unicameral: 49 },
    unicameralName: "Nebraska Legislature",
    unicameralShortName: "NE Legislature",
  },
  NV: { shape: "bicameral", seats: { upper: 21, lower: 42 } },
  NH: { shape: "bicameral", seats: { upper: 24, lower: 400 } },
  NJ: { shape: "bicameral", seats: { upper: 40, lower: 80 } },
  NM: { shape: "bicameral", seats: { upper: 42, lower: 70 } },
  NY: { shape: "bicameral", seats: { upper: 63, lower: 150 } },
  NC: { shape: "bicameral", seats: { upper: 50, lower: 120 } },
  ND: { shape: "bicameral", seats: { upper: 47, lower: 94 } },
  OH: { shape: "bicameral", seats: { upper: 33, lower: 99 } },
  OK: { shape: "bicameral", seats: { upper: 48, lower: 101 } },
  OR: { shape: "bicameral", seats: { upper: 30, lower: 60 } },
  PA: { shape: "bicameral", seats: { upper: 50, lower: 203 } },
  RI: { shape: "bicameral", seats: { upper: 38, lower: 75 } },
  SC: { shape: "bicameral", seats: { upper: 46, lower: 124 } },
  SD: { shape: "bicameral", seats: { upper: 35, lower: 70 } },
  TN: { shape: "bicameral", seats: { upper: 33, lower: 99 } },
  TX: { shape: "bicameral", seats: { upper: 31, lower: 150 } },
  UT: { shape: "bicameral", seats: { upper: 29, lower: 75 } },
  VT: { shape: "bicameral", seats: { upper: 30, lower: 150 } },
  VA: { shape: "bicameral", seats: { upper: 40, lower: 100 } },
  WA: { shape: "bicameral", seats: { upper: 49, lower: 98 } },
  WV: { shape: "bicameral", seats: { upper: 34, lower: 100 } },
  WI: { shape: "bicameral", seats: { upper: 33, lower: 99 } },
  WY: { shape: "bicameral", seats: { upper: 31, lower: 62 } },
  AS: { shape: "bicameral", seats: { upper: 18, lower: 21 } },
  GU: {
    shape: "unicameral",
    seats: { unicameral: 15 },
    unicameralName: "Guam Legislature (I Liheslaturan Guåhan)",
    unicameralShortName: "GU Legislature",
  },
  MP: { shape: "bicameral", seats: { upper: 9, lower: 20 } },
  PR: { shape: "bicameral", seats: { upper: 27, lower: 51 } },
  VI: {
    shape: "unicameral",
    seats: { unicameral: 15 },
    unicameralName: "Legislature of the Virgin Islands",
    unicameralShortName: "VI Legislature",
  },
};

/** Shape for a jurisdiction; unknown abbreviations default to bicameral with
 *  no seat data — the safe pre-FIX-548 behavior. */
export function legislatureShapeFor(abbr: string): LegislatureShape {
  return LEGISLATURE_SHAPES[abbr] ?? { shape: "bicameral", seats: {} };
}

/** The four jurisdictions whose State Senate/House pair the FIX-489/FIX-548
 *  merge converts to a single legislature_unicameral gb. */
export const UNICAMERAL_ABBRS = Object.entries(LEGISLATURE_SHAPES)
  .filter(([, s]) => s.shape === "unicameral")
  .map(([abbr]) => abbr);
