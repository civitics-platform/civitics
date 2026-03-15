import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type GoverningBodyType = Database["public"]["Tables"]["governing_bodies"]["Row"]["type"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["governing_bodies"]["Row"];

/** All active governing bodies in a jurisdiction. */
export async function listGoverningBodiesByJurisdiction(
  db: DB,
  jurisdictionId: string
): Promise<Row[]> {
  const { data, error } = await db
    .from("governing_bodies")
    .select("*")
    .eq("jurisdiction_id", jurisdictionId)
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return data;
}

/** Filter by body type (e.g. all upper chambers in a jurisdiction). */
export async function listGoverningBodiesByType(
  db: DB,
  jurisdictionId: string,
  type: GoverningBodyType
): Promise<Row[]> {
  const { data, error } = await db
    .from("governing_bodies")
    .select("*")
    .eq("jurisdiction_id", jurisdictionId)
    .eq("type", type)
    .eq("is_active", true)
    .order("name");
  if (error) throw error;
  return data;
}

/** Single governing body by ID. */
export async function getGoverningBody(
  db: DB,
  id: string
): Promise<Row | null> {
  const { data, error } = await db
    .from("governing_bodies")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}
