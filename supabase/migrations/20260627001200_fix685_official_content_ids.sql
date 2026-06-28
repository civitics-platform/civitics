-- =============================================================================
-- 20260627001200_fix685_official_content_ids.sql
-- FIX-685 — materialize the content-bearing official-id set so the officials
-- sitemap segment (pulled in FIX-683) can be re-added cheaply.
--
-- Root cause: enumerating content-bearing officials at request time runs
-- official_is_content_bearing() over 26,861 active officials ≈ 3s COLD on the
-- 256MB-shared_buffers Pro Small, tripping anon's 3s statement_timeout
-- (500 / 57014) — the exact canceling-statement noise FIX-683 set out to cut.
-- Warm local clone hides it (72ms); it only shows cold on prod.
--
-- Fix = the materialization pattern (packages/db/CLAUDE.md). A tiny id-only
-- membership table refreshed on the nightly entity_connections tail; the public
-- accessor (get_sitemap_official_ids) reads it by index instead of computing the
-- predicate live. The predicate itself is NOT re-derived — refresh reuses the
-- exact public.official_is_content_bearing(id) (FIX-683) so the set can't drift.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Membership table — id-only (no payload), lighter than the *_page_cache
--    tables it mirrors. RLS-private: the accessor function (def 3) reads it as
--    DEFINER, so anon never needs a direct table grant.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.official_content_ids (
  official_id uuid PRIMARY KEY
    REFERENCES public.officials(id) ON DELETE CASCADE,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.official_content_ids ENABLE ROW LEVEL SECURITY;
-- No SELECT policy for anon/authenticated by design — the only read path is the
-- SECURITY DEFINER get_sitemap_official_ids() wrapper (owner bypasses RLS).

-- ---------------------------------------------------------------------------
-- 2. refresh_official_content_ids() — REPLACE the set (not upsert-only). An
--    official loses content-bearing status when entity_connections is rebuilt
--    (its last edge can disappear), so stale members MUST be removed or the
--    sitemap would keep advertising now-empty officials. TRUNCATE+INSERT in the
--    function's single implicit txn is atomic (other txns see the old set until
--    commit) and computes the predicate ONCE. This deliberately does NOT copy
--    the upsert-only jurisdiction_page_cache shape, which never shrinks.
--
--    The set is `is_active AND official_is_content_bearing(id)` — same predicate
--    the FIX-683 sitemap query used (inactive officials shouldn't be advertised).
--    SECURITY DEFINER + generous own cap; the proconfig statement_timeout is not
--    honored through the session pooler (FIX-500), so the nightly hook ALSO sets
--    a session statement_timeout on the direct-pg path.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_official_content_ids()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '600s'
AS $$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.official_content_ids;

  INSERT INTO public.official_content_ids (official_id, refreshed_at)
  SELECT o.id, now()
  FROM public.officials o
  WHERE o.is_active
    AND public.official_is_content_bearing(o.id);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_official_content_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_official_content_ids() TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Repoint get_sitemap_official_ids(int) to read the TABLE (was: compute
--    official_is_content_bearing live over all officials — the 3s-cold path).
--    Same signature + single-jsonb-array return shape, so sitemap.ts is
--    unchanged. Switched to SECURITY DEFINER so anon can call it without a table
--    grant (the table stays RLS-private). Kept as ONE jsonb array on purpose: a
--    row-based .from("official_content_ids").select() would hit the PostgREST
--    1000-row cap and silently return only 1000 of ~10k ids.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sitemap_official_ids(p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT COALESCE(jsonb_agg(x.official_id ORDER BY x.official_id), '[]'::jsonb)
  FROM (
    SELECT official_id
    FROM public.official_content_ids
    ORDER BY official_id
    LIMIT GREATEST(p_limit, 0)
  ) x;
$$;

REVOKE ALL ON FUNCTION public.get_sitemap_official_ids(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_sitemap_official_ids(integer)
  TO anon, authenticated, service_role;
