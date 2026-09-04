import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database";
import { fetchChunkedByIds } from "../read-helpers";

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
  // FIX-1037: was a hand-rolled loop at BATCH = 100 with its own derivation of
  // the URI bound. Same bound, one owner now -- `ID_CHUNK_SIZE` (200, the value
  // FIX-772/FIX-509 measured the 414 at) lives beside the helper, so the next
  // person to change it changes it once. `strict` preserves this function's
  // throw-on-error contract: a dropped chunk here renders as an untagged donor,
  // which is indistinguishable from a genuinely untagged one.
  const { rows } = await fetchChunkedByIds<{
    entity_id: string; tag: string; display_label: string | null;
  }>(
    entityIds,
    (chunk) => db
      .from("entity_tags")
      .select("entity_id, tag, display_label")
      .eq("entity_type", "financial_entity")
      .eq("tag_category", "industry")
      .in("entity_id", chunk),
    { strict: true, label: "entity-industry:tags-by-id" },
  );
  for (const r of rows) {
    if (out.has(r.entity_id)) continue;
    out.set(r.entity_id, { tag: r.tag, display_label: r.display_label ?? r.tag });
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
  // Stay under PostgREST's 1,000-row ceiling per request.
  const PAGE = 1000;
  const out: string[] = [];

  // FIX-984: keyset on `entity_id`. It is unique HERE and only here -- the
  // `entity_tags_entity_type_entity_id_tag_tag_category_key` constraint is
  // UNIQUE on (entity_type, entity_id, tag, tag_category), and all three of the
  // other columns are pinned by the .eq()s above, so no entity_id can repeat.
  // Drop any one of those .eq()s and this key stops being unique.
  //
  // PLAN CAVEAT, measured on prod 2026-09-04 -- this is the one converted walk
  // whose plan still carries a Sort. The planner estimates 124 rows for
  // (tag='health', tag_category='industry') where the truth is 8,480, a 68x
  // underestimate, so it picks idx_entity_tags_tag and top-N sorts by entity_id
  // instead of range-scanning entity_tags_fe_industry_content, which is
  // (entity_id, tag) WHERE entity_type='financial_entity' AND
  // tag_category='industry' -- i.e. exactly this page. Forcing that index
  // (enable_sort=off) gives an Index Only Scan at 351 buffers / 69.9 ms against
  // the sort plan's 1,540 / 821 ms. Keyset is still the right shape and still
  // strictly better than OFFSET here: the top-N sort is bounded at PAGE rows
  // per page, where OFFSET's grew to offset+PAGE and re-sorted deeper every
  // page. Closing the rest needs a statistics target on entity_tags(tag), which
  // is an ANALYZE of a 2.7 GB table -- filed, not done here.
  let after: string | null = null;
  for (;;) {
    let q = db
      .from("entity_tags")
      .select("entity_id")
      .eq("entity_type", "financial_entity")
      .eq("tag_category", "industry")
      .eq("tag", tag)
      .order("entity_id", { ascending: true })
      .limit(PAGE);
    if (after !== null) q = q.gt("entity_id", after);
    const { data, error } = await q;
    if (error) throw error;

    const rows = data ?? [];
    for (const r of rows) out.push(r.entity_id as string);
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1]!.entity_id as string;
  }

  return out;
}
