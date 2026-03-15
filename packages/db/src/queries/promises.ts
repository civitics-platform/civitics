import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type PromiseStatus = Database["public"]["Tables"]["promises"]["Row"]["status"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["promises"]["Row"];

/** All promises made by an official. */
export async function listPromisesByOfficial(
  db: DB,
  officialId: string,
  status?: PromiseStatus
): Promise<Row[]> {
  let query = db
    .from("promises")
    .select("*")
    .eq("official_id", officialId)
    .order("made_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/** Promises by status across all officials (for dashboard/scorecard). */
export async function listPromisesByStatus(
  db: DB,
  status: PromiseStatus,
  jurisdictionId?: string,
  limit = 50
): Promise<Row[]> {
  let query = db
    .from("promises")
    .select("*")
    .eq("status", status)
    .order("made_at", { ascending: false })
    .limit(limit);

  if (jurisdictionId) {
    query = query.eq("jurisdiction_id", jurisdictionId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Promise fulfillment summary for an official.
 * Returns counts by status — the core of the "promise tracker" feature.
 */
export async function getPromiseSummary(
  db: DB,
  officialId: string
): Promise<Record<PromiseStatus, number>> {
  const { data, error } = await db
    .from("promises")
    .select("*")
    .eq("official_id", officialId);
  if (error) throw error;

  const summary = {} as Record<PromiseStatus, number>;
  for (const row of data) {
    const s = row.status;
    summary[s] = (summary[s] ?? 0) + 1;
  }
  return summary;
}

/** Promises linked to a specific proposal. */
export async function listPromisesByProposal(
  db: DB,
  proposalId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("promises")
    .select("*")
    .eq("related_proposal_id", proposalId)
    .order("made_at");
  if (error) throw error;
  return data;
}

/** Single promise by ID. */
export async function getPromise(db: DB, id: string): Promise<Row | null> {
  const { data, error } = await db
    .from("promises")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}
