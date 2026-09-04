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
    // OFFSET (FIX-984 exception): `offset` is a CALLER-supplied page number,
    // not a walk cursor -- this is one request, and keyset would change the
    // function's public contract. The `id` tiebreaker is the part that WAS
    // missing: introduced_at is nullable and repeats, so .range() over it alone
    // double-counted or skipped rows across pages.
    .order("introduced_at", { ascending: false })
    .order("id", { ascending: true })
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
    .gt("metadata->>comment_period_end", new Date().toISOString())
    .order("metadata->>comment_period_end");

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
    .eq("metadata->>regulations_gov_id", regulationsGovId)
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
    // OFFSET (FIX-984 exception): caller-supplied page number; see
    // listProposalsByJurisdiction above. `id` added as the unique tiebreaker --
    // updated_at repeats across a bulk write, so pages could overlap.
    .order("updated_at")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}
