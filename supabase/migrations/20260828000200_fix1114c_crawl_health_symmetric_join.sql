-- =============================================================================
-- FIX-1114c — the firing-to-unit join window has to be SYMMETRIC.
--
-- FIX-1114b widened the join from exact equality to a 5-second window, but kept
-- it one-sided: `l.started_at >= d.start_time`. That assumed the procedure's
-- data_sync_log row is always written AFTER pg_cron stamps start_time. It is
-- not. Measured across all 41 unit rows on prod, the delta between the log row
-- and its own firing runs BOTH ways:
--
--   08-27 01:45:00.048  log row   vs  01:45:00.090998  cron start_time   (-43 ms)
--   08-27 01:30:00.093  log row   vs  01:30:00.090998  cron start_time   (+ 2 ms)
--
-- pg_cron's start_time is not a hard "job began" instant — it carries tens of
-- milliseconds of jitter relative to the transaction the job opens, in either
-- direction. The one-sided window therefore silently dropped five crawl
-- firings and reported them as skips.
--
-- ⚠ THE LESSON, because this is the second time the same metric shipped wrong:
-- both 1114a (exact equality) and 1114b (one-sided window) were verified by
-- eye against timestamps printed to SECOND precision, where every pair looked
-- identical. The millisecond fields are what decide the join, and they were
-- never looked at until the metric returned an obviously absurd number.
--
-- Now measured rather than assumed. Over the 41 unit rows in the window, the
-- nearest-firing delta spans -34.97 s to +518.53 s, and EXACTLY the two
-- outliers are the FIX-1110 supervised drain's hand-driven units — every one
-- of the 39 crawl units falls inside +/- 5 s. Firings are 15 minutes apart, so
-- there is no adjacent firing for a symmetric window to steal from.
--
-- CORROBORATION, independent of this join: 87 firings - 39 units = 48 skips,
-- and pipeline_state.ec_crawl.skips.cycle_cooldown reads 48. Two counters that
-- do not share a code path agreeing exactly is the check that was missing.
--
-- Everything else in the function is unchanged from FIX-1114b.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_ec_crawl_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, pg_temp
AS $$
DECLARE
  v_cfg        jsonb;
  v_wm         timestamptz;
  v_dirty_rows bigint := 0;
  v_dirty_dons bigint := 0;
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

  IF v_wm IS NOT NULL THEN
    SELECT count(*), count(DISTINCT from_id)
      INTO v_dirty_rows, v_dirty_dons
      FROM public.financial_relationships
     WHERE relationship_type IN ('donation','ie_support','ie_oppose')
       AND updated_at > v_wm;
  END IF;

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
    'dirty_set',      jsonb_build_object('rows', v_dirty_rows, 'donors', v_dirty_dons),
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
$$;

ALTER FUNCTION public.get_ec_crawl_health() OWNER TO postgres;

-- CREATE OR REPLACE preserves the ACL, but re-assert it anyway: the standing
-- rule is that every routine a migration creates or recreates leaves with an
-- explicit grant posture, and FIX-1111 is the precedent for a recreate silently
-- re-opening one.
REVOKE ALL ON FUNCTION public.get_ec_crawl_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ec_crawl_health() TO service_role;

NOTIFY pgrst, 'reload schema';
