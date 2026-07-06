-- =============================================================================
-- 20260706010200_fix748_browse_facets_live.sql
-- FIX-748 — get_browse_facets(): live facet counts for a NARROWED browse set.
--
-- browse_facet_counts (the rollup) is computed over the WHOLE kind, so it is only
-- correct for the un-narrowed kind-root browse (decision 3's "zero-query facet
-- counts"). The moment a scope adds a facet (e.g. senate), an explicit facet, or
-- a text query narrows the set, the rollup is wrong for the narrowed subset. This
-- function computes facet counts over the narrowed set directly on the index —
-- cheap because every per-kind subset is ≤ ~110k rows behind the FIX-748 indexes.
--
-- /api/browse (FIX-749) uses the fast rollup path for the pure kind-root case and
-- this function for any narrowing; the response marks which via counts_mode
-- (exact when this returns, omitted when it errors/times out).
--
-- p_facets: jsonb object; each present key maps to a JSON ARRAY of allowed values
--   (the route always sends arrays). A missing key = no constraint on that column.
--   Only the fixed known facet columns are honored (static predicates → index-
--   friendly, no dynamic SQL).
-- p_q: optional case-insensitive substring on display_name.
-- Returns: { "__total__": n, "<facet_key>": { "<value>": count, ... }, ... }.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_browse_facets(
  p_kind   text,
  p_facets jsonb DEFAULT '{}'::jsonb,
  p_q      text  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH filt AS (
    SELECT e.jurisdiction_level, e.state, e.party, e.chamber, e.status,
           e.proposal_type, e.agency_type, e.financial_type, e.industry,
           e.initiative_stage, e.institution_type
    FROM public.entity_search_index e
    WHERE e.kind = p_kind
      AND (p_facets->'jurisdiction_level' IS NULL OR e.jurisdiction_level = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'jurisdiction_level'))))
      AND (p_facets->'state'              IS NULL OR e.state              = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'state'))))
      AND (p_facets->'party'              IS NULL OR e.party              = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'party'))))
      AND (p_facets->'chamber'            IS NULL OR e.chamber            = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'chamber'))))
      AND (p_facets->'status'             IS NULL OR e.status             = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'status'))))
      AND (p_facets->'proposal_type'      IS NULL OR e.proposal_type      = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'proposal_type'))))
      AND (p_facets->'agency_type'        IS NULL OR e.agency_type        = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'agency_type'))))
      AND (p_facets->'financial_type'     IS NULL OR e.financial_type     = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'financial_type'))))
      AND (p_facets->'industry'           IS NULL OR e.industry           = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'industry'))))
      AND (p_facets->'initiative_stage'   IS NULL OR e.initiative_stage   = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'initiative_stage'))))
      AND (p_facets->'institution_type'   IS NULL OR e.institution_type   = ANY(ARRAY(SELECT jsonb_array_elements_text(p_facets->'institution_type'))))
      AND (p_q IS NULL OR p_q = '' OR e.display_name ILIKE '%' || p_q || '%')
  ),
  unpivoted AS (
    SELECT 'jurisdiction_level' AS facet_key, jurisdiction_level AS facet_value FROM filt WHERE jurisdiction_level IS NOT NULL
    UNION ALL SELECT 'state',            state            FROM filt WHERE state IS NOT NULL
    UNION ALL SELECT 'party',            party            FROM filt WHERE party IS NOT NULL
    UNION ALL SELECT 'chamber',          chamber          FROM filt WHERE chamber IS NOT NULL
    UNION ALL SELECT 'status',           status           FROM filt WHERE status IS NOT NULL
    UNION ALL SELECT 'proposal_type',    proposal_type    FROM filt WHERE proposal_type IS NOT NULL
    UNION ALL SELECT 'agency_type',      agency_type      FROM filt WHERE agency_type IS NOT NULL
    UNION ALL SELECT 'financial_type',   financial_type   FROM filt WHERE financial_type IS NOT NULL
    UNION ALL SELECT 'industry',         industry         FROM filt WHERE industry IS NOT NULL
    UNION ALL SELECT 'initiative_stage', initiative_stage FROM filt WHERE initiative_stage IS NOT NULL
    UNION ALL SELECT 'institution_type', institution_type FROM filt WHERE institution_type IS NOT NULL
  ),
  per_value AS (
    SELECT facet_key, facet_value, count(*)::int AS cnt
    FROM unpivoted GROUP BY facet_key, facet_value
  ),
  per_key AS (
    SELECT facet_key, jsonb_object_agg(facet_value, cnt) AS vals
    FROM per_value GROUP BY facet_key
  )
  SELECT jsonb_build_object('__total__', (SELECT count(*) FROM filt))
       || COALESCE((SELECT jsonb_object_agg(facet_key, vals) FROM per_key), '{}'::jsonb);
$$;

REVOKE ALL ON FUNCTION public.get_browse_facets(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_browse_facets(text, jsonb, text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_browse_facets(text, jsonb, text) IS
  'FIX-748 — live facet counts over a narrowed entity_search_index set (scope '
  'facets + explicit facets + q). /api/browse uses the browse_facet_counts rollup '
  'for the un-narrowed kind-root case and this for any narrowing.';
