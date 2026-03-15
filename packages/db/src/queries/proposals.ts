import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type ProposalStatus = Database["public"]["Tables"]["proposals"]["Row"]["status"];
type ProposalType = Database["public"]["Tables"]["proposals"]["Row"]["type"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["proposals"]["Row"];

/** All proposals in a jurisdiction, newest first. */
export async function listProposalsByJurisdiction(
  db: DB,
  jurisdictionId: string,
  limit = 50,
  offset = 0
): Promise<Row[]> {
  const { data, error } = await db
    .from("proposals")
    .select("*")
    .eq("jurisdiction_id", jurisdictionId)
    .order("introduced_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}

/** Proposals currently open for public comment. */
export async function listOpenForComment(
  db: DB,
  jurisdictionId?: string
): Promise<Row[]> {
  let query = db
    .from("proposals")
    .select("*")
    .eq("status", "open_comment" satisfies ProposalStatus)
    .gt("comment_period_end", new Date().toISOString())
    .order("comment_period_end");

  if (jurisdictionId) {
    query = query.eq("jurisdiction_id", jurisdictionId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** Filter by status. */
export async function listProposalsByStatus(
  db: DB,
  status: ProposalStatus,
  jurisdictionId?: string,
  limit = 50
): Promise<Row[]> {
  let query = db
    .from("proposals")
    .select("*")
    .eq("status", status)
    .order("last_action_at", { ascending: false })
    .limit(limit);

  if (jurisdictionId) {
    query = query.eq("jurisdiction_id", jurisdictionId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** Filter by type within a governing body. */
export async function listProposalsByType(
  db: DB,
  type: ProposalType,
  governingBodyId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("proposals")
    .select("*")
    .eq("type", type)
    .eq("governing_body_id", governingBodyId)
    .order("introduced_at", { ascending: false });
  if (error) throw error;
  return data;
}

/** Single proposal by ID. */
export async function getProposal(db: DB, id: string): Promise<Row | null> {
  const { data, error } = await db
    .from("proposals")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

/** Look up by regulations.gov docket ID. */
export async function getProposalByRegulationsGovId(
  db: DB,
  regulationsGovId: string
): Promise<Row | null> {
  const { data, error } = await db
    .from("proposals")
    .select("*")
    .eq("regulations_gov_id", regulationsGovId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Full-text search using the stored tsvector.
 * For Phase 3+ replace with Typesense; this covers Phase 1-2.
 */
export async function searchProposals(
  db: DB,
  query: string,
  limit = 20
): Promise<Row[]> {
  const { data, error } = await db
    .from("proposals")
    .select("*")
    .textSearch("search_vector", query, {
      type: "websearch",
      config: "english",
    })
    .limit(limit);
  if (error) throw error;
  return data;
}

/** Proposals updated after a timestamp — for institutional API `?updated_after=`. */
export async function listProposalsUpdatedAfter(
  db: DB,
  after: string,
  limit = 100,
  offset = 0
): Promise<Row[]> {
  const { data, error } = await db
    .from("proposals")
    .select("*")
    .gt("updated_at", after)
    .order("updated_at")
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}
