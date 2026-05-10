-- =============================================================================
-- FIX-233 (part 1) — pipeline_runtime_stats_mv
--
-- data_sync_log captures started_at/completed_at/status per pipeline run but
-- nothing surfaces the trends. As pipelines scale (FEC indiv weekly, USASpending
-- bulk multi-GB), p95 duration per pipeline is the only way to spot creep toward
-- the 60-min GHA job cap before pipelines start timing out.
--
-- Memory columns (max_peak_rss_mb, p95_peak_rss_mb) are present today but
-- populated by Stage 7b instrumentation in part 2; until then they read NULL.
-- Including the columns now means the MV definition does not change when
-- Stage 7b lands — refreshes pick the values up automatically once pipelines
-- start writing process.memoryUsage().rss into metadata.peak_rss_mb.
--
-- Rendered nightly alongside the chord + homepage MVs from FIX-222/223.
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.pipeline_runtime_stats_mv AS
SELECT
  pipeline,
  COUNT(*)::INT
    AS runs_30d,
  COUNT(*) FILTER (WHERE status = 'complete')::INT
    AS successful_runs_30d,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status = 'complete')
         / NULLIF(COUNT(*), 0),
    1
  )::NUMERIC(5,1)
    AS success_rate_pct,
  PERCENTILE_CONT(0.5)  WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
  )::INT AS p50_duration_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
  )::INT AS p95_duration_ms,
  MAX(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::INT
    AS max_duration_ms,
  MAX(started_at) AS last_run_at,

  -- Memory cols — populated by Stage 7b. NULL today; MV refresh picks them up
  -- automatically once pipelines write peak_rss_mb into data_sync_log.metadata.
  MAX((metadata->>'peak_rss_mb')::INT) AS max_peak_rss_mb,
  PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY (metadata->>'peak_rss_mb')::NUMERIC
  )::INT AS p95_peak_rss_mb
FROM public.data_sync_log
WHERE started_at > NOW() - INTERVAL '30 days'
  AND completed_at IS NOT NULL
GROUP BY pipeline;
-- Populated on creation. Subsequent REFRESH MATERIALIZED VIEW CONCURRENTLY
-- calls (from refresh_pipeline_runtime_stats_mv) are then safe — CONCURRENTLY
-- requires the MV to already hold data the first time it's invoked.

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_runtime_stats_mv_pkey
  ON public.pipeline_runtime_stats_mv (pipeline);

GRANT SELECT ON public.pipeline_runtime_stats_mv
  TO anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.refresh_pipeline_runtime_stats_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.pipeline_runtime_stats_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_pipeline_runtime_stats_mv()
  TO authenticated, service_role;
