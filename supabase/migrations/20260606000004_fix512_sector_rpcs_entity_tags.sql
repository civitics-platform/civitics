-- =============================================================================
-- FIX-512 — rewrite the two dead sector RPCs onto entity_tags
--
-- get_group_sector_totals() and get_crossgroup_sector_totals() (defined in
-- 20260422000008_restore_chord_treemap_rpcs.sql) both filtered on
-- financial_relationships.metadata->>'sector'. That key was populated only by
-- the pac-classify pipeline, which was deleted in post-cutover cleanup
-- (FIX-111). The column is permanently empty, so both RPCs match ~0 rows and
-- return [] on every call — the chord "group" / "cross-group" modes and the
-- sunburst donation_industries ring all render empty.
--
-- Fix: derive sector from entity_tags(tag_category='industry') on the donor
-- financial_entity, exactly as chord_sector_vote_for_officials,
-- chord_industry_flows_for_official, and the chord_industry_flows_mv already
-- do post-cutover. Backfilling metadata->>'sector' is not an option (no
-- pipeline produces it); entity_tags is the live source (21,630 financial
-- entities carry industry tags locally, and the enrichment drain keeps adding).
--
-- SCOPE CORRECTION vs the FIXES.md bullet: the bullet also names
-- chord_sector_vote_for_officials as dead — it is NOT. That function
-- (20260509000003:78-96) already reads industry off entity_tags. Left alone.
--
-- Conventions matched to the existing chord views (consistency across chord
-- modes beats local perfection):
--   * Multi-tag donors are NOT deduped. ~750 of the 21,630 tagged FEs carry 2+
--     industry tags; their dollars are counted under EACH sector. This matches
--     chord_industry_flows_mv and chord_sector_vote_for_officials, neither of
--     which dedupes. A donor's amount appears once per tag it carries.
--   * Untagged donors are excluded entirely (et.tag IS NOT NULL), matching
--     chord_sector_vote_for_officials' `WHERE s.sector != 'untagged'`, so no
--     single giant "Untagged" arc dominates. (The old RPCs excluded 'Other'.)
--   * Return shape is unchanged (sector TEXT + the usd columns); the `sector`
--     value is now the tag's display_label (human-readable, e.g. "Finance"),
--     preserving the old display semantics and the SECTOR_ICONS lookup in the
--     chord/sunburst routes with zero caller changes. GROUP BY is on the tag
--     slug with MIN(display_label) to collapse label variants for one tag
--     (same trick chord_industry_flows_mv uses).
--
-- The PAC/Committee junk-rollup display_name exclusion from the originals is
-- preserved. amount_cents > 0, the LIMIT 12, and HAVING/min_usd semantics are
-- preserved. The entity_tags ON clause keeps entity_type in the join so it
-- hits idx_entity_tags_entity(entity_type, entity_id).
--
-- These two now do real join+aggregate work where before they scanned and
-- returned nothing, so each gets a 15s statement_timeout (the new-RPC rule).
-- This pre-empts 2 of FIX-505's 14 RPCs. The durable home for the chamber-cohort
-- latency is the FIX-506 per-official sector MV; correctness ships now behind
-- this timeout + the routes' existing withDbTimeout.
-- =============================================================================

-- ── get_group_sector_totals(uuid[], numeric) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_group_sector_totals(
  p_member_ids UUID[],
  p_min_usd    NUMERIC DEFAULT 0
)
RETURNS TABLE(sector TEXT, total_usd NUMERIC)
LANGUAGE sql STABLE
AS $$
  SELECT
    MIN(COALESCE(et.display_label, et.tag)) AS sector,
    SUM(fr.amount_cents) / 100.0            AS total_usd
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
  LEFT JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type = 'official'
    AND fr.to_id = ANY(p_member_ids)
    AND fr.amount_cents > 0
    AND et.tag IS NOT NULL
    AND (fe.display_name IS NULL OR fe.display_name NOT ILIKE '%PAC/Committee%')
  GROUP BY et.tag
  HAVING SUM(fr.amount_cents) / 100.0 >= p_min_usd
  ORDER BY total_usd DESC
  LIMIT 12;
$$;

GRANT EXECUTE ON FUNCTION public.get_group_sector_totals(UUID[], NUMERIC) TO anon, authenticated, service_role;

ALTER FUNCTION public.get_group_sector_totals(UUID[], NUMERIC) SET statement_timeout = '15s';

-- ── get_crossgroup_sector_totals(uuid[], uuid[]) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_crossgroup_sector_totals(
  p_group1_ids UUID[],
  p_group2_ids UUID[]
)
RETURNS TABLE(sector TEXT, group1_usd NUMERIC, group2_usd NUMERIC)
LANGUAGE sql STABLE
AS $$
  WITH agg AS (
    SELECT
      et.tag                                  AS sector_tag,
      MIN(COALESCE(et.display_label, et.tag)) AS sector_label,
      SUM(CASE WHEN fr.to_id = ANY(p_group1_ids) THEN fr.amount_cents / 100.0 ELSE 0 END) AS group1_usd,
      SUM(CASE WHEN fr.to_id = ANY(p_group2_ids) THEN fr.amount_cents / 100.0 ELSE 0 END) AS group2_usd
    FROM public.financial_relationships fr
    JOIN public.financial_entities fe
      ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
    LEFT JOIN public.entity_tags et
      ON et.entity_id    = fe.id
     AND et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type = 'official'
      AND (fr.to_id = ANY(p_group1_ids) OR fr.to_id = ANY(p_group2_ids))
      AND fr.amount_cents > 0
      AND et.tag IS NOT NULL
      AND (fe.display_name IS NULL OR fe.display_name NOT ILIKE '%PAC/Committee%')
    GROUP BY et.tag
  )
  SELECT sector_label AS sector, group1_usd, group2_usd
  FROM agg
  ORDER BY (group1_usd + group2_usd) DESC
  LIMIT 12;
$$;

GRANT EXECUTE ON FUNCTION public.get_crossgroup_sector_totals(UUID[], UUID[]) TO anon, authenticated, service_role;

ALTER FUNCTION public.get_crossgroup_sector_totals(UUID[], UUID[]) SET statement_timeout = '15s';
