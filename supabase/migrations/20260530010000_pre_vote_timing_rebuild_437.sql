-- =============================================================================
-- FIX-437 (follow-up) — pre_vote_timing tags: full server-side rebuild
--
-- 20260530000000 added get_pre_vote_timing_entities() which returns the ~371k
-- qualifying financial_entity ids as one jsonb array, with the Node tagger then
-- DELETE-ing the old internal tags and upserting one constant tag per id. The
-- aggregation itself is fast (~5s in psql), but the round-trip failed reliably
-- through the local PostgREST/Kong stack: "The upstream server is timing out"
-- after every retry, leaving fe_internal stuck at 1. Shipping 371k UUIDs out to
-- Node only to fan them straight back as IDENTICAL tag rows is wasteful — the
-- tag has no per-entity computed content (constant tag/label/visibility, empty
-- metadata), so the entire authoritative rebuild can run as one server-side
-- statement with nothing crossing the gateway but a row count.
--
-- rebuild_pre_vote_timing_tags() does the whole rebuild in one transaction under
-- a raised statement_timeout: DELETE the prior internal financial_entity rule
-- tags, then INSERT one 'pre_vote_timing' tag per distinct qualifying entity.
-- "Qualifying" is unchanged from 20260530000000: a financial_entity (donation
-- from_id) with ≥1 donation in (0,90] days before any vote by the recipient
-- official, in the SARGABLE range form so votes_official_voted_at applies.
-- Returns the number of tags written.
--
-- PLANNER PIN (the part 20260530000000 got wrong): with default planning this
-- query takes ~269s — the planner under-estimates the join and picks a Parallel
-- Hash Semi Join, which hashes every vote by official_id and applies the
-- voted_at window as a post-hash JOIN FILTER (not an index condition), so the
-- composite index never gets used for the range. Measured: 269s via psql, which
-- blows the local PostgREST/Kong proxy timeout (~60s) → "upstream server is
-- timing out", the exact failure that left fe_internal stuck at 1. Forcing the
-- nested-loop plan (enable_hashjoin/enable_mergejoin = off) makes voted_at an
-- index range condition on votes_official_voted_at and the same query runs ~2s.
-- The GUCs are pinned on the function only (via ALTER FUNCTION SET), so nothing
-- else's planning is affected. This function does exactly one heavy query plus a
-- trivial DELETE, so disabling hash/merge joins for it is safe.
--
-- get_pre_vote_timing_entities() is dropped — nothing calls it after this.
-- =============================================================================

DROP FUNCTION IF EXISTS public.rebuild_pre_vote_timing_tags();
CREATE OR REPLACE FUNCTION public.rebuild_pre_vote_timing_tags()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  -- Authoritative clear of this function's own tag category. Scoped to
  -- tag_category='internal' so the size/industry tags written by the Node
  -- tagFinancialEntities path survive.
  DELETE FROM public.entity_tags
  WHERE entity_type = 'financial_entity'
    AND generated_by = 'rule'
    AND tag_category = 'internal';

  INSERT INTO public.entity_tags (
    entity_type, entity_id, tag, tag_category, display_label, display_icon,
    visibility, confidence, generated_by, pipeline_version, metadata
  )
  SELECT
    'financial_entity', q.entity_id, 'pre_vote_timing', 'internal',
    'Pre-Vote Timing', NULL, 'internal', 1.0, 'rule', 'v1', '{}'::jsonb
  FROM (
    SELECT DISTINCT fr.from_id AS entity_id
    FROM public.financial_relationships fr
    WHERE fr.to_type = 'official'
      AND fr.relationship_type = 'donation'
      AND fr.occurred_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.votes v
        WHERE v.official_id = fr.to_id
          AND v.voted_at >= (fr.occurred_at::timestamp AT TIME ZONE 'UTC') + interval '1 day'
          AND v.voted_at <  (fr.occurred_at::timestamp AT TIME ZONE 'UTC') + interval '91 days'
      )
  ) q
  ON CONFLICT (entity_type, entity_id, tag, tag_category) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER FUNCTION public.rebuild_pre_vote_timing_tags() SET statement_timeout = '300s';
-- Force the index nested-loop plan (see header) — without this the function runs
-- ~269s and times out at the PostgREST gateway; with it, ~2s.
ALTER FUNCTION public.rebuild_pre_vote_timing_tags() SET enable_hashjoin = off;
ALTER FUNCTION public.rebuild_pre_vote_timing_tags() SET enable_mergejoin = off;
GRANT EXECUTE ON FUNCTION public.rebuild_pre_vote_timing_tags() TO service_role;

-- Now unused — its array payload was the failure mode this migration removes.
DROP FUNCTION IF EXISTS public.get_pre_vote_timing_entities();
