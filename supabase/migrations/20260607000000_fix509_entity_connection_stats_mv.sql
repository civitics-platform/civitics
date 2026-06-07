-- =============================================================================
-- FIX-509 — per-entity connection-stats MV (treemap aggregate + entities route)
--
-- The treemap aggregate mode and the graph entities search route both computed
-- per-entity connection counts by fetching EVERY entity_connections edge row in
-- 1000-row pages and counting in JS. For the treemap's full filtered official
-- set that was ~2k sequential round-trips per render (2026-06-06 buffer-churn
-- audit). The entities route's version was worse: unpaged, so counts and the
-- hasDonation/hasVote flags silently capped at 1000 edge rows (one site of
-- FIX-510, resolved here).
--
-- entity_connections only changes on rebuild (Sun/Wed `rebuild-entity-connections`
-- workflow), so MV staleness is effectively zero. A live RPC over this workload
-- class proved load-sensitive under prod IOWait (FIX-499: 0.7s warm, 12-25s
-- cold), so materialize — same call the FIX-500/FIX-506 per-entity MVs made.
--
-- Conventions mirror 20260606000005_fix506_official_sector_dollars_mv.sql
-- (MV + unique index + SECURITY DEFINER refresh fn + grants).
--
-- Shape: one row per entity id appearing on EITHER side of entity_connections.
--   connection_count — total edges touching the entity (both directions)
--   vote_count       — edges in the 5-type vote set the treemap uses
--                      (VOTE_CONN_TYPES in treemap/route.ts)
--   has_donation     — any edge with connection_type = 'donation'
--   has_vote         — vote_count > 0
--
-- Both directions: UNION ALL of from-side and to-side, GROUP BY id — mirrors the
-- get_connection_counts(uuid[]) body (20260422000008_restore_chord_treemap_rpcs).
-- get_connection_counts itself is left UNTOUCHED — the connections route still
-- uses it (FIX-503).
-- =============================================================================

-- ── per-entity connection stats rollup ───────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.entity_connection_stats_mv AS
SELECT
  sub.id                                          AS entity_id,
  COUNT(*)::BIGINT                                AS connection_count,
  COUNT(*) FILTER (
    WHERE sub.connection_type IN (
      'vote_yes', 'vote_no', 'vote_abstain',
      'nomination_vote_yes', 'nomination_vote_no'
    )
  )::BIGINT                                       AS vote_count,
  bool_or(sub.connection_type = 'donation')       AS has_donation,
  bool_or(sub.connection_type IN (
    'vote_yes', 'vote_no', 'vote_abstain',
    'nomination_vote_yes', 'nomination_vote_no'
  ))                                              AS has_vote
FROM (
  SELECT from_id AS id, connection_type FROM public.entity_connections
  UNION ALL
  SELECT to_id   AS id, connection_type FROM public.entity_connections
) sub
GROUP BY sub.id;

-- entity_id is the natural PK and is required for REFRESH ... CONCURRENTLY.
-- The same index serves the point reads the routes issue (.in('entity_id', …)).
CREATE UNIQUE INDEX IF NOT EXISTS entity_connection_stats_mv_pk
  ON public.entity_connection_stats_mv (entity_id);

GRANT SELECT ON public.entity_connection_stats_mv TO anon, authenticated, service_role;

-- Refresh helper. Invoked nightly from runNightlySync() alongside the other MV
-- refreshes, and from the entity_connections rebuild post-step (the rebuild is
-- the only thing that changes the source rows). SECURITY DEFINER so it can run
-- as the cron/service role; body fully-qualifies the MV name.
CREATE OR REPLACE FUNCTION public.refresh_entity_connection_stats_mv()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.entity_connection_stats_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_entity_connection_stats_mv() TO authenticated, service_role;
