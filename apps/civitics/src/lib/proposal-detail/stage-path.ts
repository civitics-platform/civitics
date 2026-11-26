/**
 * FIX-1447 (cc-317 D6) — the stage path a federal bill or resolution shows.
 *
 * Only federal rows (bill_details.congress_number set) of type bill or
 * resolution get one: theirs is the one status vocabulary a rank rule advances
 * (proposal_status_rank / proposals_advance_status, FIX-1257 → 1262). An
 * appointment's status stops at floor_vote, and OpenStates / Legistar rows have
 * no rank rule (bill-status plan s7), so they get no path.
 *
 * The steps follow the measure's kind, read off its number:
 *   a bill or joint resolution (HR, S, HJRES, SJRES) can become law;
 *   a concurrent resolution (HCONRES, SCONRES) ends at passing both chambers;
 *   a simple resolution (HRES, SRES) ends when its one chamber agrees to it.
 * No step carries a date — none is stored. failed, withdrawn and tabled are an
 * end state, not a step, and say nothing about how far the measure got; vetoed
 * is an end state after "Passed both".
 */

export type StageStep = { label: string; reached: boolean; current: boolean };
export type StagePath = { steps: StageStep[]; end: string | null };

const FULL = ["Introduced", "In committee", "Floor", "Passed one chamber", "Passed both", "Law"];
const CONCURRENT = FULL.slice(0, 5);
const SIMPLE = ["Introduced", "In committee", "Floor", "Agreed to"];

/** How far each status reaches on the FULL path (index into FULL). */
const REACH: Readonly<Record<string, number>> = {
  introduced: 0,
  in_committee: 1,
  passed_committee: 1,
  floor_vote: 2,
  passed_chamber: 3,
  passed_both_chambers: 4,
  signed: 5,
  veto_overridden: 5,
  enacted: 5,
};

/** End states: the label printed, and the FULL step the status proves was reached. */
const END: Readonly<Record<string, { label: string; reach: number }>> = {
  vetoed:    { label: "Vetoed",    reach: 4 },
  failed:    { label: "Failed",    reach: 0 },
  withdrawn: { label: "Withdrawn", reach: 0 },
  tabled:    { label: "Tabled",    reach: 0 },
};

export function measureKind(billNumber: string | null | undefined): "full" | "concurrent" | "simple" {
  const prefix = (billNumber ?? "").trim().toUpperCase().replace(/[\s.]/g, "").replace(/\d.*$/, "");
  if (prefix === "HRES" || prefix === "SRES") return "simple";
  if (prefix === "HCONRES" || prefix === "SCONRES") return "concurrent";
  return "full";
}

export function stagePath(p: {
  type: string;
  status: string;
  congressNumber: number | null | undefined;
  billNumber: string | null | undefined;
}): StagePath | null {
  if (p.congressNumber == null) return null;
  if (p.type !== "bill" && p.type !== "resolution") return null;
  const end = END[p.status] ?? null;
  const fullReach = end ? end.reach : REACH[p.status];
  if (fullReach === undefined) return null; // a regulation-only status on a bill row

  const kind = p.type === "resolution" ? measureKind(p.billNumber) : "full";
  const labels = kind === "simple" ? SIMPLE : kind === "concurrent" ? CONCURRENT : FULL;
  // A simple resolution's one chamber agreeing is its last step; past it, clamp.
  const reach = Math.min(fullReach, labels.length - 1);
  return {
    steps: labels.map((label, i) => ({ label, reached: i <= reach, current: !end && i === reach })),
    end: end?.label ?? null,
  };
}
