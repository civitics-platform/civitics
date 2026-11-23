-- 20261122002000_fix1443_conn_windows_upper_bound_index_condition.sql
-- FIX-1443 — rebuild_entity_connection_stats_window() and
-- entity_search_conn_window() bound their index scans on BOTH sides
-- (cc-311; design of record: cc-311's prompt D1–D7 on cc-307 read 3).
--
-- THE FINDING. Both are LANGUAGE sql functions that are never inlined (each
--   carries a SET clause; the stats window is also VOLATILE and writes), and
--   PG 17 plans such a body WITHOUT its argument values. So the optional upper
--   bound `p_hi IS NULL OR from_id < p_hi` cannot fold, and it is a Filter, not
--   an index condition. EXPLAIN (GENERIC_PLAN) of the live bodies on the clone
--   (PG 17.6), both functions, both edge indexes:
--
--     Index Only Scan using entity_connections_from_id_connection_type
--       Index Cond: (from_id >= $1)
--       Filter: (($2 IS NULL) OR (from_id < $2))
--
--   and the stats window's delete reads entity_connection_stats_mv by Seq Scan,
--   Filter: ((entity_id >= $1) AND (($2 IS NULL) OR (entity_id < $2))). Window k
--   of the sixteen therefore reads (17 - k)/16 of each index: a pass is 8.5 full
--   scans of both where one was designed, and sixteen full scans of the stats
--   table. Window 1 under force_generic_plan (cc-311 read 2): 424,514 + 435,240
--   entries returned, 6,549,863 + 6,539,137 removed by filter, of 6,974,377.
--   The 20260828010000 header's rows=425234 was read with literals, where the
--   OR folds. Prod's two cc-307 passes fit the line (least squares of wall on
--   (17 - k)/16: r2 0.93 / 0.96, slopes 160.6 s / 172.0 s against sums of
--   1,264.2 s / 1,277.1 s) — an estimate; prod's plan is unread.
--
-- THE FORM (D1, D2). Each ranged read is written twice and gated by p_hi:
--     WHERE p_hi IS NOT NULL AND id >= p_lo AND id < p_hi   -- windows 1-15
--     WHERE p_hi IS NULL     AND id >= p_lo                 -- window 16
--   joined by UNION ALL (the delete: two gated deletes, `deleted` their sum).
--   `p_hi IS [NOT] NULL` has no column, so the planner makes it a one-time
--   filter on a Result above the scan: the branch that does not apply never
--   starts its scan, and the bounded scan's Index Cond carries both bounds.
--   The two gates are complementary for every p_hi, NULL included, so each
--   input row is read by exactly the branch the old predicate admitted it
--   through; a NULL p_lo still reads nothing. No sentinel uuid stands in for
--   NULL, and no OR joins a bounded and an open arm on one scan.
--
-- MEASURED on the clone (cc-311; one rolled-back transaction, the stats table
--   converged inside it, warm OS cache, shared_buffers 128MB). Each body
--   PREPAREd under plan_cache_mode = force_generic_plan, EXPLAIN (ANALYZE,
--   BUFFERS) EXECUTE, median of 3; entries = index rows returned + removed by
--   filter, both edge indexes:
--                     old wall · entries (removed)          new wall · entries
--     stats  w1       2,831 ms · 13,948,754 (13,089,000)    1,437 ms ·    859,754
--     stats  w9       2,015 ms ·  6,405,900 ( 5,635,464)    1,366 ms ·    770,436
--     stats  w16      1,401 ms ·    824,543 (         0)    1,449 ms ·    824,543
--     stats  pass    33,861 ms · 113,376,669               22,710 ms · 13,948,754
--     search pass    15,158 ms · 113,376,669                5,934 ms · 13,948,754
--   A pass now reads each index once (1/8.13 of the old). The stats delete
--   reads 6,251,089 stats rows a pass, not 51,588,400. Window 16 reads exactly
--   what it read; its gated Result passes each of its 824,543 tuples, which
--   EXPLAIN ANALYZE's per-node timing inflates. Plain calls, median of 9:
--   stats w16 1,286.4 -> 1,290.8 ms, search w16 244.1 -> 231.7 ms.
--   D4: from one perturbed state the sixteen returns are equal pairwise and
--   the stats table equal by 256 ordered-row digests (3,224,272 rows); the
--   search window's rows EXCEPT ALL both ways are 0 (3,224,275 rows).
--
-- WHAT IS UNCHANGED. Both signatures and return types; LANGUAGE sql; the stats
--   window VOLATILE, the search window STABLE; every SET the live proconfig
--   carries, restated (CREATE OR REPLACE drops a SET it does not restate):
--     stats  {"search_path=public, pg_catalog",work_mem=64MB}
--     search {"search_path=public, pg_catalog",work_mem=64MB,max_parallel_workers_per_gather=0}
--   the aggregate, the upsert and its IS DISTINCT FROM guard, the returned
--   {upserted, deleted, groups}; the grants (restated) and the comments (kept by
--   CREATE OR REPLACE). No caller changes: all four pass the sixteen c_bounds
--   slices, NULL only as window 16's p_hi.
--
-- NOT ON PROD. cc-311 built it and held it off main on D5's window-16 row ("any
--   new window's wall exceeds the old one's"); cc-312 landed it on Craig's
--   ruling of 2026-11-22 (D1 as built). Instrumented (EXPLAIN (ANALYZE,
--   BUFFERS), median of 3), window 16 reads the same 824,543 entries, buffers
--   and 7,327 heap fetches, and its wall reads stats 1,401 -> 1,449 ms, search
--   308 -> 345 ms, the gated Result charged per tuple. Plain calls (median of
--   9) put it level: stats 1,286.4 -> 1,290.8 ms, search 244.1 -> 231.7 ms.
--   The guard below refuses a live body that is neither the one this replaces
--   nor this file's.
--
-- ROLLBACK: scripts/fix1443-revert-conn-windows-upper-bound.sql — both old
--   bodies verbatim. It drops nothing.

-- ── 1. Guard — the bodies this replaces, or this file's ───────────────────────

DO $$
DECLARE
  v_s text;
  v_c text;
BEGIN
  SELECT md5(prosrc) INTO v_s FROM pg_proc
   WHERE proname = 'rebuild_entity_connection_stats_window' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_c FROM pg_proc
   WHERE proname = 'entity_search_conn_window' AND pronamespace = 'public'::regnamespace;
  IF v_s IS DISTINCT FROM 'd17a1ba6ea62f552a957f5f2dd639f86' AND v_s IS DISTINCT FROM '0c60c85fd0cc2b83086f8b77b112b9b1' THEN
    RAISE EXCEPTION '[fix1443] rebuild_entity_connection_stats_window md5 % is neither FIX-1115''s d17a1ba6ea62f552a957f5f2dd639f86 nor this file''s 0c60c85fd0cc2b83086f8b77b112b9b1 — the body moved; rebuild this file on the live body',
      COALESCE(v_s, '(no function)');
  END IF;
  IF v_c IS DISTINCT FROM '6ae88578e043e485014b33b933e6956a' AND v_c IS DISTINCT FROM '4f1a3118d34dd424b6cbeda33fb875c4' THEN
    RAISE EXCEPTION '[fix1443] entity_search_conn_window md5 % is neither FIX-1123''s 6ae88578e043e485014b33b933e6956a nor this file''s 4f1a3118d34dd424b6cbeda33fb875c4 — the body moved; rebuild this file on the live body',
      COALESCE(v_c, '(no function)');
  END IF;
  RAISE NOTICE '[fix1443] guard: rebuild_entity_connection_stats_window % · entity_search_conn_window %', v_s, v_c;
END $$;

-- ── 2. rebuild_entity_connection_stats_window() — both bounds are index conditions

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
        -- FIX-1443: the body is planned without its arguments, so each read is
        -- written twice and gated on p_hi (a one-time filter): windows 1-15
        -- carry both bounds in the Index Cond, window 16 its lower bound.
        SELECT from_id AS id, connection_type
          FROM public.entity_connections
         WHERE p_hi IS NOT NULL AND from_id >= p_lo AND from_id < p_hi
        UNION ALL
        SELECT to_id   AS id, connection_type
          FROM public.entity_connections
         WHERE p_hi IS NOT NULL AND to_id   >= p_lo AND to_id   < p_hi
        UNION ALL
        SELECT from_id AS id, connection_type
          FROM public.entity_connections
         WHERE p_hi IS NULL AND from_id >= p_lo
        UNION ALL
        SELECT to_id   AS id, connection_type
          FROM public.entity_connections
         WHERE p_hi IS NULL AND to_id   >= p_lo
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
  -- Orphans: an entity that lost its last edge. Disjoint from `ups` by PK, and
  -- from each other by the gate (only one of the two deletes runs).
  del_bounded AS (
    DELETE FROM public.entity_connection_stats_mv d
     WHERE p_hi IS NOT NULL AND d.entity_id >= p_lo AND d.entity_id < p_hi
       AND NOT EXISTS (SELECT 1 FROM agg a WHERE a.entity_id = d.entity_id)
    RETURNING 1
  ),
  del_open AS (
    DELETE FROM public.entity_connection_stats_mv d
     WHERE p_hi IS NULL AND d.entity_id >= p_lo
       AND NOT EXISTS (SELECT 1 FROM agg a WHERE a.entity_id = d.entity_id)
    RETURNING 1
  )
  SELECT jsonb_build_object(
           'upserted', (SELECT count(*) FROM ups),
           'deleted',  (SELECT count(*) FROM del_bounded) + (SELECT count(*) FROM del_open),
           'groups',   (SELECT count(*) FROM agg));
$$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connection_stats_window(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connection_stats_window(uuid, uuid) TO service_role;

-- ── 3. entity_search_conn_window() — the same form ────────────────────────────

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
      -- respectively, so both branches are Index Only Scans. FIX-1443: gated
      -- on p_hi, so windows 1-15 carry both bounds in the Index Cond.
      SELECT from_id AS id
        FROM public.entity_connections
       WHERE p_hi IS NOT NULL AND from_id >= p_lo AND from_id < p_hi
      UNION ALL
      SELECT to_id   AS id
        FROM public.entity_connections
       WHERE p_hi IS NOT NULL AND to_id   >= p_lo AND to_id   < p_hi
      UNION ALL
      SELECT from_id AS id
        FROM public.entity_connections
       WHERE p_hi IS NULL AND from_id >= p_lo
      UNION ALL
      SELECT to_id   AS id
        FROM public.entity_connections
       WHERE p_hi IS NULL AND to_id   >= p_lo
    ) sub
   GROUP BY sub.id;
$$;

REVOKE ALL ON FUNCTION public.entity_search_conn_window(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.entity_search_conn_window(uuid, uuid) TO service_role;

-- ── 4. Read-back ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_stats_new   CONSTANT text   := '0c60c85fd0cc2b83086f8b77b112b9b1';
  c_stats_old   CONSTANT text   := 'd17a1ba6ea62f552a957f5f2dd639f86';
  c_stats_cfg   CONSTANT text[] := ARRAY['search_path=public, pg_catalog', 'work_mem=64MB'];
  c_search_new  CONSTANT text   := '4f1a3118d34dd424b6cbeda33fb875c4';
  c_search_old  CONSTANT text   := '6ae88578e043e485014b33b933e6956a';
  c_search_cfg  CONSTANT text[] := ARRAY['search_path=public, pg_catalog', 'work_mem=64MB', 'max_parallel_workers_per_gather=0'];
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, md5(p.prosrc) AS d, p.proconfig AS cfg, p.provolatile AS vol,
           CASE p.proname WHEN 'rebuild_entity_connection_stats_window' THEN c_stats_new ELSE c_search_new END AS want,
           CASE p.proname WHEN 'rebuild_entity_connection_stats_window' THEN c_stats_old ELSE c_search_old END AS was,
           CASE p.proname WHEN 'rebuild_entity_connection_stats_window' THEN c_stats_cfg ELSE c_search_cfg END AS want_cfg,
           CASE p.proname WHEN 'rebuild_entity_connection_stats_window' THEN 'v' ELSE 's' END AS want_vol
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('rebuild_entity_connection_stats_window', 'entity_search_conn_window')
  LOOP
    n := n + 1;
    IF r.d IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION '[fix1443] read-back failed: % md5 %, expected % (was %)', r.proname, r.d, r.want, r.was;
    END IF;
    IF r.cfg IS DISTINCT FROM r.want_cfg THEN
      RAISE EXCEPTION '[fix1443] read-back failed: % proconfig %, expected %', r.proname, r.cfg, r.want_cfg;
    END IF;
    IF r.vol IS DISTINCT FROM r.want_vol THEN
      RAISE EXCEPTION '[fix1443] read-back failed: % provolatile %, expected %', r.proname, r.vol, r.want_vol;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '[fix1443] read-back failed: % EXECUTE is not service_role only', r.proname;
    END IF;
    RAISE NOTICE '[fix1443] read-back ok: % % (was %) proconfig %', r.proname, r.d, r.was, r.cfg;
  END LOOP;
  IF n <> 2 THEN
    RAISE EXCEPTION '[fix1443] read-back failed: % of the two functions found', n;
  END IF;
END $$;
