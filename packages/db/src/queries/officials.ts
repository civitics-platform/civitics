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

/**
 * FIX-939 — the merge-stub marker keys, in ONE place.
 *
 * A FIX-933 merge neutralises a same-person duplicate: the money moves to the
 * elected survivor and the candidate row keeps its retired FEC id purely as
 * provenance. What is left is a $0 official whose only distinguishing feature
 * is that it duplicates a real person — prod 2026-09-05 carries 86 of them, all
 * `tier='candidate'`, all `is_active`, all `total_received_cents = 0`, and all
 * 86 were being surfaced by search, typeahead and the browse facets as if they
 * were people you could look up.
 *
 * THREE keys, not one, and PRESENCE is the test, not equality:
 *   - `merged_fec_candidate_id`  — the legacy scalar (86 prod rows today)
 *   - `merged_fec_candidate_ids` — the FIX-956 array every writer now emits
 *   - `merged_into`              — the survivor POINTER, written by a later
 *                                  data pass; accepted here already so nothing
 *                                  needs changing when it lands.
 *
 * The SQL mirror of this predicate lives in `rebuild_entity_search_index`,
 * which is what covers typeahead / browse rows / browse facets (all three read
 * `entity_search_index`). This TS copy is for the readers that hit `officials`
 * directly.
 */
export const MERGE_STUB_MARKER_KEYS = [
  "merged_fec_candidate_id",
  "merged_fec_candidate_ids",
  "merged_into",
] as const;

/** FIX-939 — is this `officials.source_ids` that of a merged-away duplicate? */
export function isMergeStubSourceIds(sourceIds: unknown): boolean {
  if (!sourceIds || typeof sourceIds !== "object" || Array.isArray(sourceIds)) return false;
  const o = sourceIds as Record<string, unknown>;
  return MERGE_STUB_MARKER_KEYS.some((k) => o[k] !== undefined && o[k] !== null);
}
