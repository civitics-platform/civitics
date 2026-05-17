-- 20260517000000_fix_resolve_entity_by_canonical_max_uuid.sql
-- FIX-280 — Fix max(uuid) bug in resolve_entity_by_canonical().
--
-- Session 1's resolve_entity_by_canonical (migration 20260514000000) used
--   SELECT count(*), max(id) INTO v_count, v_id FROM public.financial_entities ...
-- to detect "single match" and capture the matching uuid in one pass.
-- Postgres 17.6 has no `max(uuid)` aggregate, so the function threw
-- `function max(uuid) does not exist` on every match and never returned a
-- non-NULL uuid. Session 2's IRS 990 + EDGAR ingest patches (FIX-277/278)
-- gracefully degraded to INSERT-everything on RPC error, so the bug was
-- silent — but the patches haven't actually prevented any cross-source
-- duplicates since they shipped. This fix restores the contract: single
-- match returns its uuid, zero or multi-match returns NULL.
--
-- Implementation: LIMIT 2 + array_agg. We don't need to know the row count
-- past 2 — we only care about "exactly 1". array_agg returns NULL on empty,
-- {uuid} on 1 row, {uuid, uuid} on 2 rows; array_length distinguishes them
-- cheaply and avoids the missing UUID aggregate altogether.

CREATE OR REPLACE FUNCTION public.resolve_entity_by_canonical(
  p_canonical_name TEXT,
  p_entity_type    TEXT  DEFAULT NULL,
  p_state          TEXT  DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  IF p_canonical_name IS NULL OR length(trim(p_canonical_name)) = 0 THEN
    RETURN NULL;
  END IF;

  IF p_entity_type = 'individual' THEN
    SELECT array_agg(id) INTO v_ids FROM (
      SELECT id
      FROM public.financial_entities
      WHERE canonical_name = p_canonical_name
        AND entity_type = 'individual'
        AND donor_fingerprint IS NOT NULL
        AND (p_state IS NULL OR metadata->>'state' = p_state)
      LIMIT 2
    ) t;
  ELSIF p_entity_type IS NULL THEN
    SELECT array_agg(id) INTO v_ids FROM (
      SELECT id
      FROM public.financial_entities
      WHERE canonical_name = p_canonical_name
      LIMIT 2
    ) t;
  ELSE
    SELECT array_agg(id) INTO v_ids FROM (
      SELECT id
      FROM public.financial_entities
      WHERE canonical_name = p_canonical_name
        AND entity_type = p_entity_type
      LIMIT 2
    ) t;
  END IF;

  IF coalesce(array_length(v_ids, 1), 0) = 1 THEN
    RETURN v_ids[1];
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.resolve_entity_by_canonical(TEXT, TEXT, TEXT) IS
  'FIX-271 + FIX-280. Single-canonical exact-match resolver. Returns financial_entities.id iff exactly one row matches (canonical_name + optional entity_type + optional state for individuals); NULL on miss or ambiguity. Used by cross-source ingest paths (LittleSis / IRS 990 / EDGAR / future) before INSERT to avoid creating cross-source duplicates.';
