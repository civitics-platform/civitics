/**
 * FIX-1433 — a vote edge's tier, read off the entity_connections row.
 *
 * Since FIX-1409 the rule that writes an official → bill vote edge lives in
 * SQL (supabase/migrations/20261117000000_fix1409_vote_edge_question_rule.sql):
 * the member's latest `final`-class roll on the bill writes the edge at
 * strength 0.500; a pair with no final roll but an `advance` roll (cloture, a
 * motion to proceed or to discharge) writes it at 0.250; `other` rolls write
 * nothing. The graph's "procedural votes" toggle is exactly the advance tier,
 * so /api/graph/connections reads it here instead of re-reading `votes`.
 *
 * Pure (no next/* import) so the app's tsx unit suite loads it directly.
 */

/**
 * A votes-sourced vote_yes / vote_no edge below this strength is advance-tier.
 * The migration writes exactly 0.500 (final) and 0.250 (advance), so any value
 * between them separates the two; graph-vote-tier.test.ts pins both literals.
 */
export const VOTE_TIER_FINAL_MIN_STRENGTH = 0.5;

export type VoteEdgeTier = "final" | "advance";

/** Every vote-type connection_type the graph renders. */
export const VOTE_EDGE_TYPES = [
  "vote_yes", "vote_no", "vote_abstain",
  "nomination_vote_yes", "nomination_vote_no",
] as const;

const VOTE_EDGE_TYPE_SET = new Set<string>(VOTE_EDGE_TYPES);

/** The two types the FIX-1409 rule tiers. */
const TIERED_TYPES = new Set(["vote_yes", "vote_no"]);

/**
 * `advance` for a vote_yes / vote_no edge whose evidence_source is `votes` and
 * whose strength is below VOTE_TIER_FINAL_MIN_STRENGTH; `final` for every
 * other vote edge; null for an edge that is not a vote.
 */
export function voteEdgeTier(row: {
  connection_type: string;
  evidence_source: string | null;
  strength: number | string;
}): VoteEdgeTier | null {
  if (!VOTE_EDGE_TYPE_SET.has(row.connection_type)) return null;
  if (
    TIERED_TYPES.has(row.connection_type) &&
    row.evidence_source === "votes" &&
    Number(row.strength) < VOTE_TIER_FINAL_MIN_STRENGTH
  ) {
    return "advance";
  }
  return "final";
}
