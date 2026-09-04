import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["jurisdictions"]["Row"];

/** All active jurisdictions for a given country (ISO 3166-1 alpha-2). */
export async function listJurisdictionsByCountry(
  db: DB,
  countryCode: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("jurisdictions")
    .select("*")
    .eq("country_code", countryCode)
    .eq("is_active", true)
    .order("type")
    .order("name");
  if (error) throw error;
  return data;
}

/** Direct children of a jurisdiction node. */
export async function listChildJurisdictions(
  db: DB,
  parentId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("jurisdictions")
    .select("*")
    .eq("parent_id", parentId)
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return data;
}

/** Single jurisdiction by ID. */
export async function getJurisdiction(
  db: DB,
  id: string
): Promise<Row | null> {
  const { data, error } = await db
    .from("jurisdictions")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Jurisdictions updated after a given timestamp.
 * Used by the institutional API `?updated_after=` filter.
 */
export async function listJurisdictionsUpdatedAfter(
  db: DB,
  after: string,
  limit = 100,
  offset = 0
): Promise<Row[]> {
  const { data, error } = await db
    .from("jurisdictions")
    .select("*")
    .gt("updated_at", after)
    // OFFSET (FIX-984 exception): caller-supplied page number, one request.
    // `id` added as the unique tiebreaker for the same reason as
    // listProposalsUpdatedAfter -- a bulk write shares one updated_at.
    .order("updated_at")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data;
}
