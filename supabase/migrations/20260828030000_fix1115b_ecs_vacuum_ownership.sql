-- =============================================================================
-- FIX-1115b — entity_connection_stats_mv gets the vacuum ownership every other
--             table in its family already has.
--
-- FOUND WHILE SHIPPING FIX-1115, and it is a real gap rather than tidiness.
-- Prod's cron carries eleven `*-vacuum-analyze` jobs — entity_connections,
-- financial_relationships, financial_entities, officials, donor_party_rollup_mv,
-- official_donor_rollup_mv, official_donor_totals, official_donor_bracket_totals,
-- official_sector_affinity_rollup, official_small_dollar_rollup,
-- treemap_individuals_rollup. entity_connection_stats_mv has NONE, and carries
-- no per-table autovacuum settings either:
--
--     relname                     reloptions
--     entity_connections          {autovacuum_vacuum_scale_factor=0.05, ...}
--     financial_entities          {autovacuum_vacuum_scale_factor=0.05, ...}
--     entity_connection_stats_mv  (null)
--
-- It got away with that because the pre-FIX-1115 rebuild ran twice a week from
-- jobid 16 and, since 2026-08-05, has not run at all. FIX-1115 changes the write
-- pattern in both directions at once:
--
--   * the FIRST pass is a bulk rewrite. Three weeks of drift means the backfill
--     touches most of the table — measured on the prod clone at 1,164,394
--     upserts and 113 deletes across the sixteen windows, against 2.4M rows.
--     That is squarely the CLAUDE.md bulk-rewrite rule's territory, and the
--     FIX-884 mechanism is waiting for it: a heap page loses its all-visible
--     mark if ANY tuple on it is dead, so a few percent dead un-marks most of
--     the heap and every index-only scan over this table silently degrades to
--     per-row heap fetches. The readers are the graph entity and treemap paths.
--   * every LATER pass writes only what changed (the IS DISTINCT FROM guard),
--     so steady state is a trickle rather than a rewrite.
--
-- WHY A CRON JOB AND NOT A VACUUM TAIL IN THE PROCEDURE. VACUUM cannot run
-- inside a transaction block, and a PL/pgSQL procedure is always in one — even
-- immediately after a COMMIT, the next statement opens a new transaction. So
-- the in-body tail that scripts use (drain-ec-donations.mjs) is not available
-- to an in-database arm. The repo's established answer is a separate pg_cron
-- job per table (FIX-943/FIX-975), and this follows it exactly.
--
-- The autovacuum tuning is the part that actually covers the backfill, though:
-- the arm spreads its sixteen windows across ~4 hours of */15 firings, and a
-- once-daily vacuum would let the whole rewrite land before anything ran. At
-- scale_factor 0.05 the threshold is ~50 + 0.05 x 2.4M ≈ 120k dead tuples, so
-- autovacuum fires several times DURING the backfill rather than after it.
-- The cron job is the floor under that, not the primary mechanism.
--
-- 11:20 and 17:20 UTC continue the existing block (…:05, :10, :12, :14, :16,
-- :18 past those hours) rather than opening a new window.
--
-- Cross-ref FIX-1115, FIX-943 (the bulk-rewrite vacuum rule), FIX-884 (the
-- all-visible mechanism), FIX-975 (vacuum ownership), FIX-717 (this table).
-- =============================================================================

ALTER TABLE public.entity_connection_stats_mv
  SET (autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_scale_factor = 0.02);

DO $$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'ecs-vacuum-analyze';
  IF v_jobid IS NULL THEN
    v_jobid := cron.schedule('ecs-vacuum-analyze', '20 11,17 * * *',
                             'VACUUM (ANALYZE) public.entity_connection_stats_mv;');
    RAISE NOTICE '[FIX-1115b] ecs-vacuum-analyze created as jobid % (active)', v_jobid;
  ELSE
    RAISE NOTICE '[FIX-1115b] ecs-vacuum-analyze already exists as jobid % — left alone', v_jobid;
  END IF;
END;
$$;

COMMENT ON TABLE public.entity_connection_stats_mv IS
  'Per-entity connection/vote counts and has_donation/has_vote flags. A TABLE '
  'despite the _mv name (FIX-717 converted it from a materialized view for '
  'incremental maintenance). Written by rebuild_entity_connection_stats_window() '
  'as 16 memory-bounded uuid windows, driven by the ec-crawl as its last arm '
  '(FIX-1115) and gated on entity_connections having changed (FIX-1117); '
  'rebuild_entity_connection_stats() remains as an unscheduled break-glass full '
  'pass. FIX-1115b gives it the autovacuum tuning and the twice-daily '
  'ecs-vacuum-analyze job that every sibling rollup already had — the first '
  'gated pass is a bulk rewrite (measured 1,164,394 upserts on the prod clone) '
  'and this table is read by index-only scans that FIX-884 degrades.';
