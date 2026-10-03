/**
 * FIX-1257 — a proposal's lifecycle rank and the rule that decides whether a
 * status may replace another. The TS twin of `public.proposal_status_rank()`
 * and `public.proposal_status_advances()` (migration
 * 20261003000000_fix1257_proposal_status_advance.sql); `status-rank.test.ts`
 * parses that migration, so the two cannot drift.
 *
 * The database applies the rule (`proposals_advance_status`); this copy exists
 * so the writers can count what they asked for and the tests can model the RPC
 * without a database.
 */

import type { Database } from "@civitics/db";

export type ProposalStatus = Database["public"]["Enums"]["proposal_status"];

/**
 * The enum's declaration order is NOT a lifecycle rank (failed/withdrawn/tabled
 * sort after enacted; the regulation states sit mid-list), so the rank is
 * explicit. veto_overridden follows vetoed and precedes enacted. The
 * regulation states are ranked for completeness and never written by the
 * congress path.
 */
export const PROPOSAL_STATUS_RANK: Readonly<Record<ProposalStatus, number>> = {
  introduced: 10,
  in_committee: 20,
  passed_committee: 30,
  floor_vote: 40,
  passed_chamber: 50,
  passed_both_chambers: 60,
  vetoed: 65,
  signed: 70,
  veto_overridden: 75,
  enacted: 80,
  failed: 90,
  withdrawn: 90,
  tabled: 90,
  open_comment: 20,
  comment_closed: 30,
  final_rule: 80,
};

/** A real outcome, accepted from any stage unless the current status is a higher terminal. */
export const TERMINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>([
  "vetoed",
  "failed",
  "withdrawn",
  "tabled",
]);

/** The negative terminals a law outcome supersedes (rule (c)). */
export const NEGATIVE_FINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>([
  "failed",
  "withdrawn",
  "tabled",
]);

/**
 * Rule (c): these beat a negative terminal. Every `failed` on a federal bill
 * was set at mint from a failed FIRST roll (a recommit motion, an amendment),
 * so a bill that later becomes law must be able to say so.
 */
export const LAW_OUTCOMES: ReadonlySet<ProposalStatus> = new Set<ProposalStatus>([
  "signed",
  "veto_overridden",
  "enacted",
]);

/**
 * May a proposal at `from` move to `to`? Mirrors `proposal_status_advances()`:
 *   (a) forward by rank;
 *   (b) a terminal from any stage, unless `from` is a HIGHER-ranked terminal;
 *   (c) signed / veto_overridden / enacted beat failed / withdrawn / tabled.
 * A null `to` (the source carried no stage information) never advances.
 */
export function statusAdvances(from: ProposalStatus | null, to: ProposalStatus | null): boolean {
  if (to === null || to === from) return false;
  if (from === null) return true;
  const rf = PROPOSAL_STATUS_RANK[from];
  const rt = PROPOSAL_STATUS_RANK[to];
  if (rt > rf) return true;
  if (TERMINAL_STATUSES.has(to) && !(TERMINAL_STATUSES.has(from) && rf > rt)) return true;
  return NEGATIVE_FINAL_STATUSES.has(from) && LAW_OUTCOMES.has(to);
}
