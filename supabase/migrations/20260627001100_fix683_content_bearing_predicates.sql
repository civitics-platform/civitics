-- =============================================================================
-- 20260627000700_fix683_content_bearing_predicates.sql
-- FIX-683 — stop crawlers cold-reading the ~10k empty leaf jurisdiction/district/
-- county/official pages that drive the get_jurisdiction_page / get_official_page
-- 8s statement-timeout cancels on the cache-starved Pro Small.
--
-- The jurisdiction/district content signal already exists: membership in
-- jurisdiction_page_cache (FIX-663) IS the content-bearing set (the verbatim
-- refresh_jurisdiction_page_cache() predicate). A PK EXISTS on that table is the
-- cheap test the sitemap + per-id noindex use — no new function needed there.
--
-- Officials have NO cache, so this migration adds the equivalent cheap predicate:
--   * official_is_content_bearing(uuid) — true iff the official has >=1 vote OR
--     >=1 financial_relationship (as recipient) OR >=1 entity_connection. EXPLAIN
--     on the cache-starved-shaped local DB: 0.14ms, 13 shared buffers, fully
--     index-backed (votes_official, financial_relationships_to, entity_connections
--     _from/_to) — no new index. 17,086 of 26,861 active officials (64%) are empty
--     by this predicate; entity_connections alone covers 9,768 of the 9,775
--     content-bearing.
--   * get_sitemap_official_ids(int) — the same predicate as a bounded jsonb array
--     of ids for the sitemap (one row, dodges the 1000-row PostgREST cap; the
--     sitemap caps officials at 2500). cap-2500 ordered-by-id: ~72ms local.
--
-- Both SECURITY INVOKER: anon already reads votes/financial_relationships/
-- entity_connections via the existing SECURITY INVOKER get_official_page, so the
-- invoker role has the needed SELECTs. Read-only; no DB writes; no schema change
-- to existing tables.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. official_is_content_bearing(uuid) — cheap per-id emptiness predicate for
--    the /officials/[id] generateMetadata noindex + the page's get_official_page
--    skip (FIX-683 item 3 + 4). STABLE so it can ride the render-path read cache.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.official_is_content_bearing(p_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  SELECT
       EXISTS (SELECT 1 FROM public.votes v WHERE v.official_id = p_id)
    OR EXISTS (
         SELECT 1 FROM public.financial_relationships f
         WHERE f.to_type = 'official' AND f.to_id = p_id
       )
    OR EXISTS (
         SELECT 1 FROM public.entity_connections e
         WHERE (e.from_type = 'official' AND e.from_id = p_id)
            OR (e.to_type   = 'official' AND e.to_id   = p_id)
       );
$$;

REVOKE ALL ON FUNCTION public.official_is_content_bearing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.official_is_content_bearing(uuid)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. get_sitemap_official_ids(int) — content-bearing official ids as a bounded
--    jsonb array for sitemap.ts (FIX-683 item 1). Returns ONE jsonb value
--    (jsonb_agg), so it never trips the 1000-row max_rows cap a SETOF would. The
--    ORDER BY id makes the cap a stable prefix. Runs daily (sitemap revalidate
--    86400) under the sitemap's own 5s Promise.race.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sitemap_official_ids(p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  SELECT COALESCE(jsonb_agg(x.id ORDER BY x.id), '[]'::jsonb)
  FROM (
    SELECT o.id
    FROM public.officials o
    WHERE o.is_active
      AND public.official_is_content_bearing(o.id)
    ORDER BY o.id
    LIMIT GREATEST(p_limit, 0)
  ) x;
$$;

REVOKE ALL ON FUNCTION public.get_sitemap_official_ids(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sitemap_official_ids(integer)
  TO anon, authenticated, service_role;
