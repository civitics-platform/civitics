import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type VoteValue = Database["public"]["Tables"]["votes"]["Row"]["vote"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["votes"]["Row"];

/** All votes cast by a specific official. */
export async function listVotesByOfficial(
  db: DB,
  officialId: string,
  limit = 100,
  offset = 0
): Promise<Row[]> {
  const { data, error } = await db
    .from("votes")
    .select("*")
    .eq("official_id", officialId)
    .order("voted_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}

/** All votes on a specific proposal. */
export async function listVotesByProposal(
  db: DB,
  proposalId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("votes")
    .select("*")
    .eq("proposal_id", proposalId)
    .order("voted_at");
  if (error) throw error;
  return data;
}

/** The single vote record for an official on a proposal. */
export async function getVoteRecord(
  db: DB,
  officialId: string,
  proposalId: string
): Promise<Row | null> {
  const { data, error } = await db
    .from("votes")
    .select("*")
    .eq("official_id", officialId)
    .eq("proposal_id", proposalId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Vote summary for a proposal: counts by vote value.
 * Returns e.g. { yes: 218, no: 212, not_voting: 5 }
 */
export async function getVoteSummary(
  db: DB,
  proposalId: string
): Promise<Record<VoteValue, number>> {
  const { data, error } = await db
    .from("votes")
    .select("*")
    .eq("proposal_id", proposalId);
  if (error) throw error;

  const summary = {} as Record<VoteValue, number>;
  for (const row of data) {
    const v = row.vote;
    summary[v] = (summary[v] ?? 0) + 1;
  }
  return summary;
}

/**
 * Votes that align with the official's top donor industries.
 * Returns vote records where the proposal relates to given industries.
 * Used by the donor-vote correlation analyzer.
 */
export async function listVotesByOfficialAndValue(
  db: DB,
  officialId: string,
  voteValue: VoteValue
): Promise<Row[]> {
  const { data, error } = await db
    .from("votes")
    .select("*")
    .eq("official_id", officialId)
    .eq("vote", voteValue)
    .order("voted_at", { ascending: false });
  if (error) throw error;
  return data;
}
