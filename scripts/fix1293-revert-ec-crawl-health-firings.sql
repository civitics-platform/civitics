-- =============================================================================
-- FIX-1293 (cc-267) ROLLBACK — get_ec_crawl_health() back to the
-- cron.job_run_details firings count.
--
-- The mirror of supabase/migrations/20261111005000_fix1293_get_ec_crawl_health_firings_bounded.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1293-revert-ec-crawl-health-firings.sql
--
-- Restores prod's body as cc-267 read it (e6741c018c5b771343f2fb11e015a341, LF). Refuses unless the
-- body is file F's or its target; idempotent; RAISEs if the md5 misses.
-- =============================================================================

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE proname = 'get_ec_crawl_health' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS NULL OR v_md5 NOT IN ('e6741c018c5b771343f2fb11e015a341', '0365316a209dd5b5db80f81e9364b2b0') THEN
    RAISE EXCEPTION '[fix1293-revert] get_ec_crawl_health md5 % is neither file F''s nor its target — refusing', v_md5;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_ec_crawl_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron', 'pg_temp'
AS $function$
DECLARE
  v_cfg        jsonb;
  v_wm         timestamptz;
  v_dirty_rows bigint := 0;
  v_dirty_dons bigint := 0;
  v_dirty_capped boolean := false;
  v_cycle      jsonb;
  v_dirty_src  text;
  v_cursor     jsonb;
  v_fire_total int := 0;
  v_fire_fail  int := 0;
  v_units_7d   int := 0;
  v_units_all_7d int := 0;
  v_backoff_7d int := 0;
  v_cycles     jsonb := '[]'::jsonb;
  v_last_close timestamptz;
  v_lag_days   numeric;
  v_backoff_r  numeric;
  v_signal     text;
BEGIN
  SELECT value INTO v_cfg     FROM public.pipeline_state WHERE key = 'ec_crawl';
  SELECT value INTO v_cursor  FROM public.pipeline_state
   WHERE key = 'entity_connections_rebuild_cursor';

  SELECT (value->>'last_indexed_at')::timestamptz INTO v_wm
    FROM public.pipeline_state WHERE key = 'entity_connections_donations';

  -- FIX-1293 (cc-241): the dirty set is the crawl's own staged cycle, written by
  -- rebuild_ec_donations_incr_prepare() and cleared at the close. No count.
  SELECT value->'cycle' INTO v_cycle
    FROM public.pipeline_state WHERE key = 'entity_connections_donations';
  IF jsonb_typeof(v_cycle) IS DISTINCT FROM 'object' THEN
    v_cycle := NULL;
  END IF;
  v_dirty_rows   := NULL;
  v_dirty_dons   := COALESCE((v_cycle->>'dirty_donors')::bigint, 0);
  v_dirty_capped := false;
  v_dirty_src    := CASE WHEN v_cycle IS NULL THEN 'caught_up' ELSE 'crawl_cycle' END;

  SELECT count(*),
         count(*) FILTER (WHERE d.status <> 'succeeded')
    INTO v_fire_total, v_fire_fail
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname = 'ec-crawl'
     AND d.start_time >= now() - interval '7 days';

  -- Units run BY THE CRAWL. Counted through the cron rows, not straight off
  -- data_sync_log, because the FIX-1110 drain wrapper drives the same CALL and
  -- writes an indistinguishable row. The window is SYMMETRIC (FIX-1114c) —
  -- pg_cron's start_time and the procedure's now() differ by tens of ms in
  -- EITHER direction, so a one-sided window drops rows. See the header.
  SELECT count(*) INTO v_units_7d
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname = 'ec-crawl'
     AND d.start_time >= now() - interval '7 days'
     AND EXISTS (
       SELECT 1 FROM public.data_sync_log l
        WHERE l.pipeline = 'entity_connections_rebuild'
          AND l.started_at >  d.start_time - interval '5 seconds'
          AND l.started_at <  d.start_time + interval '5 seconds'
          AND COALESCE(jsonb_array_length(l.metadata->'units'), 0) > 0);

  SELECT count(*) INTO v_units_all_7d
    FROM public.data_sync_log
   WHERE pipeline = 'entity_connections_rebuild'
     AND started_at >= now() - interval '7 days'
     AND COALESCE(jsonb_array_length(metadata->'units'), 0) > 0;

  SELECT count(*) INTO v_backoff_7d
    FROM jsonb_array_elements(COALESCE(v_cfg->'recent_units','[]'::jsonb)) e
   WHERE (e.value->>'at')::timestamptz >= now() - interval '7 days'
     AND (e.value->>'outcome') IS DISTINCT FROM 'ok';

  WITH rows AS (
    SELECT started_at, status,
           count(*) FILTER (WHERE status = 'complete')
             OVER (ORDER BY started_at DESC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
      FROM public.data_sync_log
     WHERE pipeline = 'entity_connections_rebuild'
       AND COALESCE(jsonb_array_length(metadata->'units'), 0) > 0
       AND started_at >= now() - interval '30 days'
  ), cycles AS (
    SELECT grp,
           count(*)          AS units,
           min(started_at)   AS first_unit,
           max(started_at)   AS last_unit,
           bool_or(status = 'complete') AS closed
      FROM rows GROUP BY grp
  )
  SELECT jsonb_agg(jsonb_build_object(
           'units',            units,
           'first_unit_at',    first_unit,
           'closed_at',        CASE WHEN closed THEN last_unit END,
           'closed',           closed,
           'span_minutes',     round(EXTRACT(epoch FROM (last_unit - first_unit))::numeric / 60.0, 1)
         ) ORDER BY first_unit DESC)
    INTO v_cycles
    FROM (SELECT * FROM cycles WHERE closed ORDER BY first_unit DESC LIMIT 5) c;

  SELECT max(started_at) INTO v_last_close
    FROM public.data_sync_log
   WHERE pipeline = 'entity_connections_rebuild' AND status = 'complete';

  v_lag_days  := CASE WHEN v_wm IS NULL THEN NULL
                      ELSE round(EXTRACT(epoch FROM (now() - v_wm))::numeric / 86400.0, 2) END;
  v_backoff_r := CASE WHEN v_fire_total = 0 THEN NULL
                      ELSE round(v_backoff_7d::numeric / v_fire_total::numeric, 4) END;

  v_signal := CASE
    WHEN v_lag_days IS NULL          THEN 'unknown'
    WHEN v_lag_days <= 7             THEN 'ok'
    WHEN COALESCE(v_backoff_r,0) > 0.25 THEN 'lag_high_backoff_high'
    ELSE                                  'lag_high_backoff_low'
  END;

  RETURN jsonb_build_object(
    'generated_at',   now(),
    'watermark',      jsonb_build_object('last_indexed_at', v_wm, 'age_days', v_lag_days),
    'dirty_set',      jsonb_build_object('rows', v_dirty_rows, 'donors', v_dirty_dons, 'capped', v_dirty_capped,
                                         'source',    v_dirty_src,
                                         'since_at',  v_cycle->'since_at',
                                         'target_at', v_cycle->'target_at',
                                         'staged_at', v_cycle->'staged_at'),
    'firings_7d',     jsonb_build_object(
                        'total',             v_fire_total,
                        'units_run',         v_units_7d,
                        'skipped',           greatest(v_fire_total - v_units_7d, 0),
                        'units_out_of_band', greatest(v_units_all_7d - v_units_7d, 0),
                        'backoff',           v_backoff_7d,
                        'failed',            v_fire_fail),
    'backoff_rate_7d',      v_backoff_r,
    'skips_cumulative',     COALESCE(v_cfg->'skips','{}'::jsonb),
    'cycles_last5',         COALESCE(v_cycles,'[]'::jsonb),
    'last_cycle_closed_at', v_last_close,
    'open_cycle',           jsonb_build_object(
                              'started_at',     v_cursor->'cycle_started_at',
                              'completed_arms', COALESCE(jsonb_array_length(v_cursor->'completed_arms'), 0)),
    'config',               COALESCE(v_cfg,'{}'::jsonb) - 'recent_units' - 'skips',
    'signal',               v_signal,
    'decision_rule',        'lag>7d for TWO consecutive weeks WITH backoffs on >~25% of firings -> compute-tier; lag>7d with backoffs rare and units/cycle growing -> ingest (delta aggregation / write amplification / replay pacing)'
  );
END;
$function$;

COMMENT ON FUNCTION public.get_ec_crawl_health() IS
  'FIX-1114 — health/lag instrument for the FIX-1111 EC crawl. Returns ONE jsonb: watermark age, dirty set, '
  'trailing-7d firing census, units per cycle for the last 5 closed cycles, and the live ec_crawl config. Read '
  'by the status-snapshot payload (section ec_crawl_health). SECURITY DEFINER because it reads '
  'cron.job_run_details. The tier-vs-ingest decision rule it serves is carried in the returned decision_rule '
  'key and in migration 20260828000000.';

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE proname = 'get_ec_crawl_health' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM 'e6741c018c5b771343f2fb11e015a341' THEN
    RAISE EXCEPTION '[fix1293-revert] get_ec_crawl_health md5 %, expected e6741c018c5b771343f2fb11e015a341', v_md5;
  END IF;
  RAISE NOTICE '[fix1293-revert] restored: get_ec_crawl_health %', v_md5;
END $$;
