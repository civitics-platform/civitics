import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
import { fetchIndustryTagsByEntityId } from "./entity-industry";

type DB = SupabaseClient<Database>;
type Row = Database["public"]["Tables"]["financial_relationships"]["Row"];

/** All donations TO a specific official (polymorphic: to_type='official'). */
export async function listDonationsByOfficial(
  db: DB,
  officialId: string,
  cycleYear?: number,
  limit = 100
): Promise<Row[]> {
  let query = db
    .from("financial_relationships")
    .select("*")
    .eq("relationship_type", "donation")
    .eq("to_type", "official")
    .eq("to_id", officialId)
    .order("amount_cents", { ascending: false })
    .limit(limit);

  if (cycleYear !== undefined) {
    query = query.eq("cycle_year", cycleYear);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Top donors to an official — aggregates by from_id (financial_entities row),
 * then joins financial_entities.display_name for labels.
 */
/**
 * FIX-1037 REMOVAL CANDIDATE -- ZERO CALLERS.
 *
 * A repo-wide grep (2026-09-04) finds this name only here and in the
 * `packages/db/src/index.ts` export list. The FIX-902 audit flagged its `.in()`
 * over up to 1,000 donor ids as one of the two highest-value packages/ sites;
 * it was NOT chunked in this pass, deliberately. A function with no callers is
 * not a bug to fix, it is code to delete -- and deleting a public export off
 * @civitics/db is its own decision, not a rider on a pagination sweep. If it is
 * ever wired up, chunk the `.in()` through fetchChunkedByIds first.
 */
export async function getTopDonorsByOfficial(
  db: DB,
  officialId: string,
  cycleYear?: number,
  topN = 20
): Promise<{ donor_name: string; donor_type: string; total_cents: number }[]> {
  const rows = await listDonationsByOfficial(db, officialId, cycleYear, 1000);

  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.from_id, (totals.get(r.from_id) ?? 0) + (r.amount_cents ?? 0));
  }

  if (totals.size === 0) return [];

  const { data: entities, error } = await db
    .from("financial_entities")
    .select("id, display_name, entity_type")
    .in("id", Array.from(totals.keys()));
  if (error) throw error;

  return (entities ?? [])
    .map((e) => ({
      donor_name:  e.display_name,
      donor_type:  e.entity_type as string,
      total_cents: totals.get(e.id) ?? 0,
    }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, topN);
}

/** Donations FROM a named donor (ilike on financial_entities.display_name). */
/**
 * FIX-1037 REMOVAL CANDIDATE -- ZERO CALLERS. See getTopDonorsByOfficial above;
 * same finding, same reasoning. Its `.in("from_id", ids)` is fed by an uncapped
 * `ilike` result and stays unchunked for now.
 */
export async function listDonationsByDonor(
  db: DB,
  donorName: string
): Promise<Row[]> {
  const { data: entities, error: entityErr } = await db
    .from("financial_entities")
    .select("id")
    .ilike("display_name", `%${donorName}%`);
  if (entityErr) throw entityErr;
  const ids = (entities ?? []).map((e) => e.id);
  if (ids.length === 0) return [];

  const { data, error } = await db
    .from("financial_relationships")
    .select("*")
    .eq("relationship_type", "donation")
    .in("from_id", ids)
    .order("amount_cents", { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Donation totals by industry for an official. Industry is sourced from
 * `entity_tags` (FIX-167): the legacy `financial_entities.industry` column
 * was dropped because it had been polluted with FEC `CONNECTED_ORG_NM`
 * values (parent-org / candidate / committee names) by the FEC bulk pipeline.
 */
export async function getDonationsByIndustry(
  db: DB,
  officialId: string,
  cycleYear?: number
): Promise<{ industry: string; total_cents: number }[]> {
  const rows = await listDonationsByOfficial(db, officialId, cycleYear, 5000);
  if (rows.length === 0) return [];

  const donorIds = Array.from(new Set(rows.map((r) => r.from_id)));
  const industryByEntityId = await fetchIndustryTagsByEntityId(db, donorIds);

  const totals = new Map<string, number>();
  for (const r of rows) {
    const key = industryByEntityId.get(r.from_id)?.display_label ?? "Unknown";
    totals.set(key, (totals.get(key) ?? 0) + (r.amount_cents ?? 0));
  }

  return Array.from(totals.entries())
    .map(([industry, total_cents]) => ({ industry, total_cents }))
    .sort((a, b) => b.total_cents - a.total_cents);
}
