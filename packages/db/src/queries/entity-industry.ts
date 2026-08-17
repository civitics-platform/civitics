import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";

type DB = SupabaseClient<Database>;

export interface IndustryTag {
  tag: string;
  display_label: string;
}

/**
 * Industry tag for each financial entity, sourced from `entity_tags`
 * (`tag_category='industry'`). This replaced the dropped
 * `financial_entities.industry` column, which was being polluted by the FEC
 * bulk pipeline writing CONNECTED_ORG_NM into a column that should have held
 * a sector code.
 */
export async function fetchIndustryTagsByEntityId(
  db: DB,
  entityIds: string[],
): Promise<Map<string, IndustryTag>> {
  if (entityIds.length === 0) return new Map();

  const out = new Map<string, IndustryTag>();
  // BATCH must keep the PostgREST URI under ~4KB. UUIDs are 36 chars; 100 IDs
  // ≈ 3.7KB plus overhead. 300 hit "URI too long" against the local API.
  const BATCH = 100;
  for (let i = 0; i < entityIds.length; i += BATCH) {
    const batch = entityIds.slice(i, i + BATCH);
    const { data, error } = await db
      .from("entity_tags")
      .select("entity_id, tag, display_label")
      .eq("entity_type", "financial_entity")
      .eq("tag_category", "industry")
      .in("entity_id", batch);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ entity_id: string; tag: string; display_label: string | null }>) {
      if (out.has(r.entity_id)) continue;
      out.set(r.entity_id, { tag: r.tag, display_label: r.display_label ?? r.tag });
    }
  }
  return out;
}

/**
 * Resolve the entity_ids that match a given industry tag (canonical form, e.g. 'pharma').
 *
 * PAGINATED ON PURPOSE (FIX-1037). This was a single unranged `.select()`, which
 * PostgREST silently caps at its `db-max-rows` limit of 1,000 — no error, no
 * truncation signal, just a short array. Most industry tags are far above that
 * cap on prod (health 9,059, finance 8,428, agriculture 5,479, real_estate
 * 5,294 — 11 of 12 tags exceed 1,000), so every caller was filtering against an
 * arbitrary first-1,000 slice ordered by whatever the planner returned. The
 * user-visible symptom: `industry_filter=health` returned NO donations for an
 * official with real health-sector money, because that official's PACs sat
 * outside the truncated slice.
 *
 * Same silent-truncation class as FIX-892 / FIX-878. Callers treat the result as
 * a complete id set (`filterPacIds`, `taggedIds`), so a short read is wrong data,
 * not merely a partial one.
 */
export async function fetchEntityIdsByIndustryTag(
  db: DB,
  tag: string,
): Promise<string[]> {
  // Stay under PostgREST's 1,000-row ceiling per request; `.range()` is
  // inclusive on both ends.
  const PAGE = 1000;
  const out: string[] = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("entity_tags")
      .select("entity_id")
      .eq("entity_type", "financial_entity")
      .eq("tag_category", "industry")
      .eq("tag", tag)
      // Deterministic order so page boundaries can't drop or repeat a row.
      .order("entity_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;

    const rows = data ?? [];
    for (const r of rows) out.push(r.entity_id as string);
    if (rows.length < PAGE) break;
  }

  return out;
}
