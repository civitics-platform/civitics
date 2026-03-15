import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type AgencyType = Database["public"]["Tables"]["agencies"]["Row"]["agency_type"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["agencies"]["Row"];

/** All active top-level agencies (no parent) for a jurisdiction. */
export async function listAgenciesByJurisdiction(
  db: DB,
  jurisdictionId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("agencies")
    .select("*")
    .eq("jurisdiction_id", jurisdictionId)
    .is("parent_agency_id", null)
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return data;
}

/** Sub-agencies (children) of a parent agency. */
export async function listSubAgencies(
  db: DB,
  parentAgencyId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("agencies")
    .select("*")
    .eq("parent_agency_id", parentAgencyId)
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return data;
}

/** Look up by acronym (e.g. "EPA", "FTC"). */
export async function getAgencyByAcronym(
  db: DB,
  acronym: string
): Promise<Row | null> {
  const { data, error } = await db
    .from("agencies")
    .select("*")
    .ilike("acronym", acronym)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Filter by agency type. */
export async function listAgenciesByType(
  db: DB,
  type: AgencyType
): Promise<Row[]> {
  const { data, error } = await db
    .from("agencies")
    .select("*")
    .eq("agency_type", type)
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return data;
}

/** Single agency by ID. */
export async function getAgency(db: DB, id: string): Promise<Row | null> {
  const { data, error } = await db
    .from("agencies")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}
