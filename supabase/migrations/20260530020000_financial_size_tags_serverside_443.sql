-- FIX-443 — Move the financial-entity SIZE tag build server-side.
--
-- Background: FIX-437's get_financial_entity_donation_totals() returns a single
-- jsonb_agg array with one element per donor entity, derived from prod's ~4.88M
-- 'donation' rows in financial_relationships (vs ~1.9M local). Building that one
-- huge jsonb Datum in the DB and buffering the whole payload through PostgREST
-- OOM'd the Pro instance (postmaster restart 2026-05-30 20:52:17 UTC; FATAL
-- 57P03 "cannot_connect_now" during the ensuing recovery). The size tags are the
-- hazard because they span every donor; the NAICS-industry slice is only the
-- handful of contract/grant entities, and the keyword-industry slice is already
-- paginated client-side.
--
-- Fix mirrors rebuild_pre_vote_timing_tags (migration 20260530010000): do the
-- DELETE + INSERT…SELECT entirely in SQL and return just a row count, so nothing
-- but a bigint crosses the gateway. The size buckets/labels/icons/visibility
-- below are a 1:1 port of the thresholds in
-- packages/data/src/pipelines/tags/rules.ts tagFinancialEntities():
--   < $5,000      -> small_donation  / Small Donation  / (no icon) / internal
--   < $50,000     -> medium_donation / Medium Donation / (no icon) / secondary
--   < $500,000    -> large_donation  / Large Donation  / 💰        / primary
--   >=            -> major_donation  / Major Donation  / 💰💰      / primary
-- (thresholds are in cents: 500_000 / 5_000_000 / 50_000_000). Only entities
-- with ≥1 donation row get a size tag — an entity with no donations was skipped
-- by the Node `if (r.total_cents == null) continue` guard, and here it simply
-- never appears in the `don` CTE.

DROP FUNCTION IF EXISTS public.rebuild_financial_entity_size_tags();
CREATE OR REPLACE FUNCTION public.rebuild_financial_entity_size_tags()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  -- Authoritative clear of just the 'size' category. Industry (keyword + NAICS)
  -- is cleared and rebuilt by the Node path, and 'internal' by
  -- rebuild_pre_vote_timing_tags — both survive this DELETE.
  DELETE FROM public.entity_tags
  WHERE entity_type = 'financial_entity'
    AND generated_by = 'rule'
    AND tag_category = 'size';

  WITH don AS (
    SELECT fr.from_id AS entity_id,
           SUM(COALESCE(fr.amount_cents, 0))::bigint AS total_cents
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
    GROUP BY fr.from_id
  )
  INSERT INTO public.entity_tags (
    entity_type, entity_id, tag, tag_category, display_label, display_icon,
    visibility, confidence, generated_by, pipeline_version, metadata
  )
  SELECT
    'financial_entity',
    d.entity_id,
    CASE WHEN d.total_cents <    500000 THEN 'small_donation'
         WHEN d.total_cents <   5000000 THEN 'medium_donation'
         WHEN d.total_cents <  50000000 THEN 'large_donation'
         ELSE                                'major_donation'  END,
    'size',
    CASE WHEN d.total_cents <    500000 THEN 'Small Donation'
         WHEN d.total_cents <   5000000 THEN 'Medium Donation'
         WHEN d.total_cents <  50000000 THEN 'Large Donation'
         ELSE                                'Major Donation'  END,
    CASE WHEN d.total_cents <   5000000 THEN NULL
         WHEN d.total_cents <  50000000 THEN '💰'
         ELSE                                '💰💰'           END,
    CASE WHEN d.total_cents <    500000 THEN 'internal'
         WHEN d.total_cents <   5000000 THEN 'secondary'
         ELSE                                'primary'         END,
    1.0, 'rule', 'v1',
    jsonb_build_object('total_cents', d.total_cents)
  FROM don d
  ON CONFLICT (entity_type, entity_id, tag, tag_category) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER FUNCTION public.rebuild_financial_entity_size_tags() SET statement_timeout = '300s';
GRANT EXECUTE ON FUNCTION public.rebuild_financial_entity_size_tags() TO service_role;

-- NAICS-only rollup: one row per contract/grant entity carrying a NAICS code
-- (the small slice — the Node NAICS loop maps these to industry tags). This
-- replaces the donation-bearing get_financial_entity_donation_totals() for the
-- industry path so the giant donor array is never fetched again. Returns jsonb
-- (one array) rather than SETOF so the result isn't capped at the 1000-row
-- PostgREST max_rows; the payload here is small (contract/grant NAICS entities,
-- not donors). naics_code is MIN() per entity to match the prior
-- "deterministic arbitrary pick".
DROP FUNCTION IF EXISTS public.get_financial_entity_naics();
CREATE OR REPLACE FUNCTION public.get_financial_entity_naics()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'entity_id',  n.entity_id,
           'naics_code', n.naics_code
         )), '[]'::jsonb)
  FROM (
    SELECT fr.from_id AS entity_id,
           MIN(fr.metadata->>'naics_code') AS naics_code
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type IN ('contract', 'grant')
      AND fr.metadata->>'naics_code' IS NOT NULL
    GROUP BY fr.from_id
  ) n;
$$;

ALTER FUNCTION public.get_financial_entity_naics() SET statement_timeout = '120s';
GRANT EXECUTE ON FUNCTION public.get_financial_entity_naics() TO service_role;

-- get_financial_entity_donation_totals() is left in place but is now unused by
-- the pipeline (FIX-443). It is the OOM hazard; do not reintroduce a caller.
