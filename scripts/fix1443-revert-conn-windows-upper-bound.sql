-- scripts/fix1443-revert-conn-windows-upper-bound.sql
-- FIX-1443 ROLLBACK (cc-311) — puts back rebuild_entity_connection_stats_window()
-- and entity_search_conn_window() as they ran before
-- 20261122002000_fix1443_conn_windows_upper_bound_index_condition.sql:
--   the stats window: 20260828010000_fix1115_1117_ec_stats_arm_and_source_gate.sql
--     §1 VERBATIM (md5(prosrc) d17a1ba6ea62f552a957f5f2dd639f86, LOCAL at cc-311 read 0);
--   the search window: 20260901000000_fix1123_search_index_bounded_conn_windows.sql
--     §1 VERBATIM (md5(prosrc) 6ae88578e043e485014b33b933e6956a, LOCAL at cc-311 read 0);
-- prod's two are read by the push prompt. Each header restates the live
-- proconfig (CREATE OR REPLACE drops a SET it does not restate); the grants are
-- the ones FIX-1443 restated.
--
-- It DROPS NOTHING and writes no data: the next stats pass under the old body
-- reads to the end of both indexes again. It refuses a live body that is
-- neither FIX-1443's nor the one it puts back.
--
-- Apply:  node scripts/db-query.mjs --local --file scripts/fix1443-revert-conn-windows-upper-bound.sql
-- (prod: only under a supervised session, through the primary checkout).

DO $$
DECLARE
  v_s text;
  v_c text;
BEGIN
  SELECT md5(prosrc) INTO v_s FROM pg_proc
   WHERE proname = 'rebuild_entity_connection_stats_window' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_c FROM pg_proc
   WHERE proname = 'entity_search_conn_window' AND pronamespace = 'public'::regnamespace;
  IF v_s IS DISTINCT FROM '0c60c85fd0cc2b83086f8b77b112b9b1' AND v_s IS DISTINCT FROM 'd17a1ba6ea62f552a957f5f2dd639f86' THEN
    RAISE EXCEPTION '[fix1443 revert] rebuild_entity_connection_stats_window md5 % is neither FIX-1443''s 0c60c85fd0cc2b83086f8b77b112b9b1 nor FIX-1115''s d17a1ba6ea62f552a957f5f2dd639f86',
      COALESCE(v_s, '(no function)');
  END IF;
  IF v_c IS DISTINCT FROM '4f1a3118d34dd424b6cbeda33fb875c4' AND v_c IS DISTINCT FROM '6ae88578e043e485014b33b933e6956a' THEN
    RAISE EXCEPTION '[fix1443 revert] entity_search_conn_window md5 % is neither FIX-1443''s 4f1a3118d34dd424b6cbeda33fb875c4 nor FIX-1123''s 6ae88578e043e485014b33b933e6956a',
      COALESCE(v_c, '(no function)');
  END IF;
END $$;

-- ── rebuild_entity_connection_stats_window() — 20260828010000 §1 ──────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connection_stats_window(
  p_lo uuid,
  p_hi uuid          -- NULL = open-ended (the last window)
)
RETURNS jsonb
LANGUAGE sql
SET search_path = public, pg_catalog
SET work_mem = '64MB'
AS $$
  WITH agg AS MATERIALIZED (
    SELECT sub.id                                          AS entity_id,
           COUNT(*)::bigint                                AS connection_count,
           COUNT(*) FILTER (
             WHERE sub.connection_type IN (
               'vote_yes', 'vote_no', 'vote_abstain',
               'nomination_vote_yes', 'nomination_vote_no')
           )::bigint                                       AS vote_count,
           bool_or(sub.connection_type = 'donation')       AS has_donation,
           bool_or(sub.connection_type IN (
             'vote_yes', 'vote_no', 'vote_abstain',
             'nomination_vote_yes', 'nomination_vote_no')) AS has_vote
      FROM (
        -- Both branches are covered by (from_id, connection_type) and
        -- (to_id, connection_type) respectively, so both are Index Only Scans.
        SELECT from_id AS id, connection_type
          FROM public.entity_connections
         WHERE from_id >= p_lo AND (p_hi IS NULL OR from_id < p_hi)
        UNION ALL
        SELECT to_id   AS id, connection_type
          FROM public.entity_connections
         WHERE to_id   >= p_lo AND (p_hi IS NULL OR to_id   < p_hi)
      ) sub
     GROUP BY sub.id
  ),
  ups AS (
    INSERT INTO public.entity_connection_stats_mv AS t
          (entity_id, connection_count, vote_count, has_donation, has_vote)
    SELECT entity_id, connection_count, vote_count, has_donation, has_vote
      FROM agg
    ON CONFLICT (entity_id) DO UPDATE
       SET connection_count = EXCLUDED.connection_count,
           vote_count       = EXCLUDED.vote_count,
           has_donation     = EXCLUDED.has_donation,
           has_vote         = EXCLUDED.has_vote
     -- Do not write a row whose four values are already right. This is the
     -- 64%-of-writes-avoided measurement in the header.
     WHERE t.connection_count IS DISTINCT FROM EXCLUDED.connection_count
        OR t.vote_count       IS DISTINCT FROM EXCLUDED.vote_count
        OR t.has_donation     IS DISTINCT FROM EXCLUDED.has_donation
        OR t.has_vote         IS DISTINCT FROM EXCLUDED.has_vote
    RETURNING 1
  ),
  del AS (
    -- Orphans: an entity that lost its last edge. Disjoint from `ups` by PK.
    DELETE FROM public.entity_connection_stats_mv d
     WHERE d.entity_id >= p_lo AND (p_hi IS NULL OR d.entity_id < p_hi)
       AND NOT EXISTS (SELECT 1 FROM agg a WHERE a.entity_id = d.entity_id)
    RETURNING 1
  )
  SELECT jsonb_build_object(
           'upserted', (SELECT count(*) FROM ups),
           'deleted',  (SELECT count(*) FROM del),
           'groups',   (SELECT count(*) FROM agg));
$$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connection_stats_window(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connection_stats_window(uuid, uuid) TO service_role;

-- ── entity_search_conn_window() — 20260901000000 §1 ───────────────────────────

CREATE OR REPLACE FUNCTION public.entity_search_conn_window(
  p_lo uuid,
  p_hi uuid                      -- NULL = open-ended (the last window)
)
RETURNS TABLE (entity_id uuid, c int)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
SET work_mem = '64MB'
SET max_parallel_workers_per_gather = 0
AS $$
  SELECT sub.id, count(*)::int
    FROM (
      -- Covered by (from_id, connection_type) and (to_id, connection_type)
      -- respectively, so both branches are Index Only Scans.
      SELECT from_id AS id
        FROM public.entity_connections
       WHERE from_id >= p_lo AND (p_hi IS NULL OR from_id < p_hi)
      UNION ALL
      SELECT to_id   AS id
        FROM public.entity_connections
       WHERE to_id   >= p_lo AND (p_hi IS NULL OR to_id   < p_hi)
    ) sub
   GROUP BY sub.id;
$$;

REVOKE ALL ON FUNCTION public.entity_search_conn_window(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.entity_search_conn_window(uuid, uuid) TO service_role;

DO $$
DECLARE
  v_s  text;
  v_c  text;
  v_sc text[];
  v_cc text[];
BEGIN
  SELECT md5(prosrc), proconfig INTO v_s, v_sc FROM pg_proc
   WHERE proname = 'rebuild_entity_connection_stats_window' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc), proconfig INTO v_c, v_cc FROM pg_proc
   WHERE proname = 'entity_search_conn_window' AND pronamespace = 'public'::regnamespace;
  IF v_s IS DISTINCT FROM 'd17a1ba6ea62f552a957f5f2dd639f86'
     OR v_sc IS DISTINCT FROM ARRAY['search_path=public, pg_catalog', 'work_mem=64MB'] THEN
    RAISE EXCEPTION '[fix1443 revert] read-back failed: rebuild_entity_connection_stats_window md5 % proconfig %, expected d17a1ba6ea62f552a957f5f2dd639f86', v_s, v_sc;
  END IF;
  IF v_c IS DISTINCT FROM '6ae88578e043e485014b33b933e6956a'
     OR v_cc IS DISTINCT FROM ARRAY['search_path=public, pg_catalog', 'work_mem=64MB', 'max_parallel_workers_per_gather=0'] THEN
    RAISE EXCEPTION '[fix1443 revert] read-back failed: entity_search_conn_window md5 % proconfig %, expected 6ae88578e043e485014b33b933e6956a', v_c, v_cc;
  END IF;
  RAISE NOTICE '[fix1443 revert] read-back ok: rebuild_entity_connection_stats_window % · entity_search_conn_window %', v_s, v_c;
END $$;
