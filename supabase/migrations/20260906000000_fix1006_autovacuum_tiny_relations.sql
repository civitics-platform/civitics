-- FIX-1006 — per-relation autovacuum thresholds on six tiny relations.
--
-- Same lever FIX-1003b applied to the four chord matviews and pipeline_state,
-- pointed at six more small, high-churn relations. The autovacuum trigger is
-- `autovacuum_vacuum_threshold + scale_factor x reltuples`. On a relation with
-- tens of live rows the scale-factor term is ~0, so the DEFAULT threshold of 50
-- IS the trigger — and these relations carry 4-58 live rows. A table that is
-- rewritten every 30 minutes therefore sits above its own live-row count in
-- dead tuples for hours at a time.
--
-- Measured on prod 2026-09-06 23:2x UTC, before this migration:
--
--   relation                    live   dead   pages  all-visible
--   platform_alert_state          30     52       2      1  (50.0%)
--   platform_limits               58     33       9      5  (55.6%)
--   platform_usage               172     15      12     12  (100%)
--   supabase_prometheus_state      4     32       1      1  (100%)
--   proposal_popularity_24h        0      2       0      0  (n/a)
--   pipeline_runtime_stats_mv     38      0       1      1  (100%)
--
-- platform_alert_state is the clearest case: 52 dead against 30 live, 50% of
-- its two heap pages un-marked in the visibility map, and it had still not
-- reached the default threshold of 50 + 0.2 x 30 = 56. platform_limits is the
-- status page's own limit table, read on every status render.
--
-- These are hygiene, not a performance claim. Nothing here is on a hot path
-- large enough for the VM decay to cost a measurable index-only scan (the
-- FIX-884 / FIX-943 mechanism needs a big heap to matter). The point is that a
-- 2-page relation should not be allowed to carry twice its live rows in dead
-- ones just because the global threshold was sized for big tables.
--
-- threshold 20 (not 50) with the same scale factors FIX-1003b used, so a
-- relation of this size autovacuums after ~20 dead rows regardless of its
-- live-row count. relkind='m' takes ALTER MATERIALIZED VIEW, not ALTER TABLE.

ALTER TABLE public.platform_alert_state
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);

ALTER TABLE public.platform_limits
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);

ALTER TABLE public.platform_usage
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);

ALTER TABLE public.supabase_prometheus_state
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);

ALTER MATERIALIZED VIEW public.proposal_popularity_24h
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);

ALTER MATERIALIZED VIEW public.pipeline_runtime_stats_mv
  SET (autovacuum_vacuum_threshold = 20, autovacuum_vacuum_scale_factor = 0.05,
       autovacuum_analyze_threshold = 20, autovacuum_analyze_scale_factor = 0.02);
