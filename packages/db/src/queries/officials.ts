import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type Party = Database["public"]["Tables"]["officials"]["Row"]["party"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["officials"]["Row"];

/** All active officials in a governing body. */
export async function listOfficialsByGoverningBody(
  db: DB,
  governingBodyId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("officials")
    .select("*")
    .eq("governing_body_id", governingBodyId)
    .eq("is_active", true)
    .order("last_name")
    .order("first_name");
  if (error) throw error;
  return data;
}

/** All active officials in a jurisdiction (across all governing bodies). */
export async function listOfficialsByJurisdiction(
  db: DB,
  jurisdictionId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("officials")
    .select("*")
    .eq("jurisdiction_id", jurisdictionId)
    .eq("is_active", true)
    .order("role_title")
    .order("last_name");
  if (error) throw error;
  return data;
}

/** Filter by party within a governing body. */
export async function listOfficialsByParty(
  db: DB,
  governingBodyId: string,
  party: Party
): Promise<Row[]> {
  const { data, error } = await db
    .from("officials")
    .select("*")
    .eq("governing_body_id", governingBodyId)
    .eq("party", party as NonNullable<Party>)
    .eq("is_active", true)
    .order("last_name");
  if (error) throw error;
  return data;
}

/**
 * Officials representing a specific location.
 * Uses the PostGIS stored function — coordinates must be pre-coarsened (~1km).
 */
export async function findOfficialsByLocation(
  db: DB,
  lat: number,
  lng: number
) {
  const { data, error } = await db.rpc("find_representatives_by_location", {
    user_lat: lat,
    user_lng: lng,
  });
  if (error) throw error;
  return data;
}

/** Single official by ID with governing body and jurisdiction joined. */
export async function getOfficial(db: DB, id: string): Promise<Row | null> {
  const { data, error } = await db
    .from("officials")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

/** Look up by an external source ID (bioguide, FEC, etc.). */
export async function getOfficialBySourceId(
  db: DB,
  source: string,
  sourceId: string
): Promise<Row | null> {
  const { data, error } = await db
    .from("officials")
    .select("*")
    .contains("source_ids", { [source]: sourceId })
    .maybeSingle();
  if (error) throw error;
  return data;
}
