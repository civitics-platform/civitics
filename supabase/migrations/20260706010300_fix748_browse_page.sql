-- =============================================================================
-- 20260706010300_fix748_browse_page.sql
-- FIX-748 — get_browse_page(): one keyset page of entity_search_index.
--
-- Keyset pagination over arbitrary display-name strings is fragile to express as
-- a PostgREST row-value .or() filter (commas/parens/dots in names break the
-- filter grammar and need bespoke quoting). Doing it in SQL — the get_*_page
-- precedent (FIX-634/646/647) — sidesteps that entirely and keeps the (kind,
-- <sort>, entity_id) btrees (FIX-748) driving the scan.
--
-- Contract:
--   p_kind        : kind to scope to, or NULL for all kinds.
--   p_facets      : jsonb; each present key → JSON array of allowed values
--                   (static per-column predicates → index-friendly).
--   p_q           : optional display_name substring (trigram).
--   p_sort        : name_asc | name_desc | connections_desc | amount_desc | recent.
--   p_cursor_value: last row's sort value as TEXT (NULL = NULLS-LAST tail);
--                   IGNORED unless p_cursor_id is provided.
--   p_cursor_id   : last row's entity_id; NULL = page 1 (no keyset predicate).
--   p_limit       : page size.
-- Returns: { "rows": [ <row + facets{} + _sort_value>, ... ], "has_more": bool }.
--
-- NULLS ordering: amount_desc / recent are DESC NULLS LAST; the null tail is paged
-- by passing p_cursor_value = NULL with a non-null p_cursor_id (route encodes this
-- via the cursor codec). Non-nullable sorts (name/connections) never hit that path.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_browse_page(
  p_kind         text,
  p_facets       jsonb DEFAULT '{}'::jsonb,
  p_q            text  DEFAULT NULL,
  p_sort         text  DEFAULT 'connections_desc',
  p_cursor_value text  DEFAULT NULL,
  p_cursor_id    uuid  DEFAULT NULL,
  p_limit        int   DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_order      text;
  v_sortval    text;   -- expression producing the row's _sort_value (text)
  v_keyset     text := 'true';
  v_sql        text;
  v_rows       jsonb;
  v_has_more   boolean;
  v_fetch      int := p_limit + 1;
BEGIN
  IF p_sort NOT IN ('name_asc','name_desc','connections_desc','amount_desc','recent') THEN
    p_sort := 'connections_desc';
  END IF;

  -- Per-sort ORDER BY, _sort_value expression, and keyset predicate.
  IF p_sort = 'name_asc' THEN
    v_order := 'e.display_name ASC, e.entity_id ASC';
    v_sortval := 'e.display_name';
    IF p_cursor_id IS NOT NULL THEN
      v_keyset := '(e.display_name, e.entity_id) > ($1, $2)';
    END IF;
  ELSIF p_sort = 'name_desc' THEN
    v_order := 'e.display_name DESC, e.entity_id ASC';
    v_sortval := 'e.display_name';
    IF p_cursor_id IS NOT NULL THEN
      v_keyset := '(e.display_name < $1 OR (e.display_name = $1 AND e.entity_id > $2))';
    END IF;
  ELSIF p_sort = 'connections_desc' THEN
    v_order := 'e.connection_count DESC, e.entity_id ASC';
    v_sortval := 'e.connection_count::text';
    IF p_cursor_id IS NOT NULL THEN
      v_keyset := '(e.connection_count < $1::bigint OR (e.connection_count = $1::bigint AND e.entity_id > $2))';
    END IF;
  ELSIF p_sort = 'amount_desc' THEN
    v_order := 'e.amount_cents DESC NULLS LAST, e.entity_id ASC';
    v_sortval := 'e.amount_cents::text';
    IF p_cursor_id IS NOT NULL THEN
      IF p_cursor_value IS NULL THEN   -- paging within the NULL tail
        v_keyset := '(e.amount_cents IS NULL AND e.entity_id > $2)';
      ELSE
        v_keyset := '(e.amount_cents < $1::bigint OR e.amount_cents IS NULL OR (e.amount_cents = $1::bigint AND e.entity_id > $2))';
      END IF;
    END IF;
  ELSE  -- recent
    v_order := 'e.activity_at DESC NULLS LAST, e.entity_id ASC';
    v_sortval := 'e.activity_at::text';
    IF p_cursor_id IS NOT NULL THEN
      IF p_cursor_value IS NULL THEN
        v_keyset := '(e.activity_at IS NULL AND e.entity_id > $2)';
      ELSE
        v_keyset := '(e.activity_at < $1::timestamptz OR e.activity_at IS NULL OR (e.activity_at = $1::timestamptz AND e.entity_id > $2))';
      END IF;
    END IF;
  END IF;

  v_sql := format($f$
    WITH page AS (
      SELECT e.*, %s AS _sv
      FROM public.entity_search_index e
      WHERE ($3 IS NULL OR e.kind = $3)
        AND (%s)
        AND ($4->'jurisdiction_level' IS NULL OR e.jurisdiction_level = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'jurisdiction_level'))))
        AND ($4->'state'              IS NULL OR e.state              = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'state'))))
        AND ($4->'party'              IS NULL OR e.party              = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'party'))))
        AND ($4->'chamber'            IS NULL OR e.chamber            = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'chamber'))))
        AND ($4->'status'             IS NULL OR e.status             = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'status'))))
        AND ($4->'proposal_type'      IS NULL OR e.proposal_type      = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'proposal_type'))))
        AND ($4->'agency_type'        IS NULL OR e.agency_type        = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'agency_type'))))
        AND ($4->'financial_type'     IS NULL OR e.financial_type     = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'financial_type'))))
        AND ($4->'industry'           IS NULL OR e.industry           = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'industry'))))
        AND ($4->'initiative_stage'   IS NULL OR e.initiative_stage   = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'initiative_stage'))))
        AND ($4->'institution_type'   IS NULL OR e.institution_type   = ANY(ARRAY(SELECT jsonb_array_elements_text($4->'institution_type'))))
        AND ($5 IS NULL OR $5 = '' OR e.display_name ILIKE '%%' || $5 || '%%')
      ORDER BY %s
      LIMIT $6
    )
    SELECT jsonb_build_object(
      'kind', p.kind, 'entity_id', p.entity_id, 'display_name', p.display_name,
      'secondary_label', p.secondary_label, 'photo_url', p.photo_url,
      'is_synthetic', p.is_synthetic, 'amount_cents', p.amount_cents,
      'amount_label', p.amount_label, 'connection_count', p.connection_count,
      'activity_at', p.activity_at, 'primary_source', p.primary_source,
      'facets', jsonb_strip_nulls(jsonb_build_object(
        'jurisdiction_level', p.jurisdiction_level, 'state', p.state, 'party', p.party,
        'chamber', p.chamber, 'status', p.status, 'proposal_type', p.proposal_type,
        'agency_type', p.agency_type, 'financial_type', p.financial_type,
        'industry', p.industry, 'initiative_stage', p.initiative_stage,
        'institution_type', p.institution_type)),
      '_sort_value', p._sv
    ) AS row_json
    FROM page p
  $f$, v_sortval, v_keyset, v_order);

  EXECUTE 'SELECT COALESCE(jsonb_agg(x.row_json), ''[]''::jsonb) FROM (' || v_sql || ') x'
    INTO v_rows
    USING p_cursor_value, p_cursor_id, p_kind, p_facets, p_q, v_fetch;

  v_has_more := jsonb_array_length(v_rows) > p_limit;
  IF v_has_more THEN
    v_rows := (SELECT jsonb_agg(elem) FROM (
      SELECT elem FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS t(elem, ord)
      WHERE ord <= p_limit
    ) s);
  END IF;

  RETURN jsonb_build_object('rows', COALESCE(v_rows, '[]'::jsonb), 'has_more', v_has_more);
END;
$$;

REVOKE ALL ON FUNCTION public.get_browse_page(text, jsonb, text, text, text, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_browse_page(text, jsonb, text, text, text, uuid, int)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_browse_page(text, jsonb, text, text, text, uuid, int) IS
  'FIX-748 — one keyset page of entity_search_index for /api/browse (FIX-749). '
  'Static facet predicates + optional trigram q + per-sort keyset over the '
  '(kind,<sort>,entity_id) btrees. Returns { rows, has_more }.';
