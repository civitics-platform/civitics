-- 20260514000000_cross_source_resolution.sql
-- FIX-271 — Cross-source entity resolution foundation.
--
-- Strategy D from docs/CROSS_SOURCE_RESOLUTION_INVESTIGATION.md §5.2.
-- Two pieces in this migration; the destructive backfill is its sibling
-- (20260514000001_cross_source_backfill.sql).
--
--   1. entity_cluster_id UUID column on financial_entities — generic-named
--      per investigation §8 so FIX-239 Layer 2 (multi-ZIP fragmentation)
--      can share the same column with a different rule set. Stays NULL
--      until a cluster-rebuild job runs (no populating job in this
--      migration; this just adds the column + index + comment).
--   2. resolve_entity_by_canonical() — exact-canonical lookup helper.
--      Returns the financial_entities.id if exactly one row matches the
--      (canonical_name, entity_type, state) shape; NULL on miss or
--      ambiguity. Used by Sessions 2/3 ingest patches (LittleSis / IRS
--      990 / EDGAR) and by future cross-source ingests as the single
--      source of truth for "is this entity already in the DB?".
--
-- No application code reads either yet. The donor profile page, search,
-- and graph rebuild key on financial_entities.id and pick up the merged
-- row identity from the sibling backfill automatically.

-- ── 1. entity_cluster_id (shared with FIX-239 Layer 2 plan) ───────────────

ALTER TABLE public.financial_entities
  ADD COLUMN IF NOT EXISTS entity_cluster_id UUID;

CREATE INDEX IF NOT EXISTS financial_entities_entity_cluster
  ON public.financial_entities (entity_cluster_id)
  WHERE entity_cluster_id IS NOT NULL;

COMMENT ON COLUMN public.financial_entities.entity_cluster_id IS
  'FIX-271 + FIX-239 Layer 2 shared. Derived cross-source / multi-ZIP cluster id. NULL until a cluster rebuild runs (no populating job in 20260514000000). Group by this for entity-level rollups; individual rows still carry their own donor_fingerprint / external_source_refs for audit.';

-- ── 2. resolve_entity_by_canonical helper ─────────────────────────────────

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
  v_id    UUID;
  v_count INT;
BEGIN
  IF p_canonical_name IS NULL OR length(trim(p_canonical_name)) = 0 THEN
    RETURN NULL;
  END IF;

  IF p_entity_type = 'individual' THEN
    SELECT count(*), max(id) INTO v_count, v_id
    FROM public.financial_entities
    WHERE canonical_name = p_canonical_name
      AND entity_type = 'individual'
      AND donor_fingerprint IS NOT NULL
      AND (p_state IS NULL OR metadata->>'state' = p_state);
  ELSIF p_entity_type IS NULL THEN
    SELECT count(*), max(id) INTO v_count, v_id
    FROM public.financial_entities
    WHERE canonical_name = p_canonical_name;
  ELSE
    SELECT count(*), max(id) INTO v_count, v_id
    FROM public.financial_entities
    WHERE canonical_name = p_canonical_name
      AND entity_type = p_entity_type;
  END IF;

  IF v_count = 1 THEN
    RETURN v_id;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.resolve_entity_by_canonical(TEXT, TEXT, TEXT) IS
  'FIX-271. Single-canonical exact-match resolver. Returns financial_entities.id iff exactly one row matches (canonical_name + optional entity_type + optional state for individuals); NULL on miss or ambiguity. Used by cross-source ingest paths (LittleSis / IRS 990 / EDGAR / future) before INSERT to avoid creating cross-source duplicates.';
