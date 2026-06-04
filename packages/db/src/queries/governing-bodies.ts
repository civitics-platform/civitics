import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
type GoverningBodyType = Database["public"]["Tables"]["governing_bodies"]["Row"]["type"];

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["governing_bodies"]["Row"];

/**
 * The `officials.tier` value that marks a sitting member of a governing body.
 *
 * `tier` defaults to `'elected'` at the column level; only `fec-bulk/candidates.ts`
 * (FIX-246) sets a different value (`'candidate'`), parking every candidate on the
 * body it runs for. So `tier='elected'` cleanly isolates the FEC candidate pollution
 * from real members on the federal legislatures (US House/Senate) and the Presidency.
 */
export const CURRENT_MEMBER_TIER = "elected" as const;

/**
 * Current-member predicate for governing-body display surfaces (FIX-470).
 *
 * A "current member" of a governing body = `is_active = true AND tier = 'elected'`.
 * Candidates (`tier='candidate'`, parked on the body they run for by the FEC bulk
 * pipeline, FIX-246) are NOT members and must be excluded from rosters, party
 * balance, and member counts — otherwise a legislature page counts the entire
 * candidate field as members (prod: US House showed 8,880 instead of 436).
 *
 * Mirrors the scope-by-intrinsic-signal precedent of `get_institution_recent_votes`
 * v2 (FIX-439): don't trust the polluted `governing_body_id` FK alone. Shared so every
 * consumer (the institutions page, FIX-468 graph group-expansion) uses one definition
 * instead of re-hardcoding `.eq('tier','elected')`.
 *
 * NOTE: because `tier` defaults to `'elected'`, this does NOT exclude the Legistar
 * municipal-council over-attachment (those rows are `tier='elected'` too — see FIX-471).
 * It removes only the FEC candidate pollution, which is the federal-legislature
 * display bug this predicate targets.
 *
 * Generic over any chainable PostgREST filter builder so it composes with `select`
 * chains on either `createServerClient` or `createAdminClient`.
 */
export function currentGoverningBodyMembers<
  T extends { eq(column: string, value: unknown): T },
>(query: T): T {
  return query.eq("is_active", true).eq("tier", CURRENT_MEMBER_TIER);
}

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
