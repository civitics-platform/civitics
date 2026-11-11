-- =============================================================================
-- FIX-1293 — get_ec_crawl_health() reads the crawl's firings from
-- dispatch_log, not cron.job_run_details. cc-267, 2026-11-11 (D15, Craig 11-09
-- 20:39 PST "2b"). Class P: one CREATE OR REPLACE. Not a pin.
--
-- WHY (cc-266, reopened). The function itself was the cost: 13 of 18 status
-- ticks >= 1 s through the 11-08 landing, one 57014 at 04:01Z (the tile null),
-- pg_stat_statements mean 1,046 ms. cc-267 read 14 (prod, 00:12Z, quiet):
-- 731 calls, mean 1,055.5 ms, max 7,780.9 ms; one call 98.6 ms / 6,780
-- buffers, of which the two 7-day cron.job_run_details statements are 47 ms /
-- 2,874 buffers EACH: a Seq Scan of 147,171 rows (26 MB; the only index is
-- the runid pkey), 121,325 removed by the start_time filter.
--
-- SHAPE (a), FROM THE ROWS (read 14). Both statements join
-- cron.job j ON j.jobname = 'ec-crawl'. That job (jobid 45, */15) is INACTIVE
-- with 0 runs in 7 d: the crawl has fired as the dispatcher's one-shots
-- (disp-ec-crawl-<epoch>, 114 arms in 7 d, all reaped `succeeded: CALL`)
-- since E1 (10-18). So both counts read a dead source — firings_7d.total,
-- units_run, failed read 0 and backoff_rate_7d NULL — and paid two seq scans
-- for it. Shape (b) (one pass bounded on runid) would keep reading the dead
-- job. Repointed:
--   total / failed  ec-crawl ARMS in dispatch_log over 7 d (its ticked_at
--                   index) / those whose first reap is not 'succeeded …' or is
--                   a 'missed' (the dispatch_log_armed_jobid_idx probe);
--   units_run       arms with an entity_connections_rebuild data_sync_log row
--                   carrying units, started in [armed_for − 5 s, armed_for +
--                   60 s): the FIX-1114c symmetric clock window, widened on
--                   the late side because a one-shot starts late under load
--                   (114 arms: start − armed_for p99 0.33 s, max 5.32 s).
-- skipped and units_out_of_band are derived from those exactly as before.
-- The returned key set is unchanged (dispatcher-r16.test.ts compares it on
-- the clone): backoff_rate_7d, config, cycles_last5, decision_rule, dirty_set, firings_7d, generated_at, last_cycle_closed_at, open_cycle, signal, skips_cumulative, watermark; firings_7d {backoff, failed, skipped, total, units_out_of_band, units_run}.
-- The readers (apps/civitics/app/api/claude/status/_lib/sections.ts
-- getEcCrawlHealth → the status snapshot's ec_crawl_health) pass the jsonb
-- through whole. No index is added on cron.job_run_details (an extension
-- table postgres does not own).
--
-- The body is prod's pg_get_functiondef (LF) plus the two statement hunks;
-- e6741c018c5b771343f2fb11e015a341 → 0365316a209dd5b5db80f81e9364b2b0. The COMMENT says what moved.
--
-- ROLLBACK: scripts/fix1293-revert-ec-crawl-health-firings.sql (the body
-- back, md5-verified). IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE proname = 'get_ec_crawl_health' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM 'e6741c018c5b771343f2fb11e015a341' AND v_md5 IS DISTINCT FROM '0365316a209dd5b5db80f81e9364b2b0' THEN
    RAISE EXCEPTION '[fix1293] get_ec_crawl_health md5 % is neither prod''s e6741c018c5b771343f2fb11e015a341 nor this file''s — rebuild this file on the live body',
      COALESCE(v_md5, '(no function)');
  END IF;
  RAISE NOTICE '[fix1293] guard: get_ec_crawl_health %', v_md5;
END $$;

CREATE OR REPLACE FUNCTION public.get_ec_crawl_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, pg_temp
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

  -- FIX-1293 (cc-267): the crawl fires as the dispatcher's one-shots
  -- (disp-ec-crawl-<epoch>, E1 10-18); cron.job 'ec-crawl' is parked and fires
  -- nothing. So a firing is an ec-crawl ARM in dispatch_log (its ticked_at
  -- index) and a failure is that arm's reap not 'succeeded ...', or a 'missed'.
  -- The two 7-day cron.job_run_details scans (no index but runid) are gone.
  SELECT count(*),
         count(*) FILTER (WHERE r.decision = 'missed'
                             OR (r.decision = 'reaped' AND r.reason NOT LIKE 'succeeded%'))
    INTO v_fire_total, v_fire_fail
    FROM public.dispatch_log a
    LEFT JOIN LATERAL (SELECT x.decision, x.reason FROM public.dispatch_log x
                        WHERE x.armed_jobid = a.armed_jobid
                          AND x.decision IN ('reaped', 'missed')
                        ORDER BY x.id LIMIT 1) r ON true
   WHERE a.job = 'ec-crawl'
     AND a.decision = 'armed'
     AND a.armed_jobid IS NOT NULL
     AND a.ticked_at >= now() - interval '7 days';

  -- Units run BY THE CRAWL. Counted through the arms, not straight off
  -- data_sync_log, because the FIX-1110 drain wrapper drives the same CALL and
  -- writes an indistinguishable row. FIX-1293 (cc-267): the window opens 5 s
  -- before the arm's armed_for (FIX-1114c: the clocks differ by tens of ms in
  -- either direction) and closes 60 s after it, because a one-shot starts late
  -- under load (114 arms in 7 d: p99 0.33 s, max 5.32 s).
  SELECT count(*) INTO v_units_7d
    FROM public.dispatch_log a
   WHERE a.job = 'ec-crawl'
     AND a.decision = 'armed'
     AND a.armed_jobid IS NOT NULL
     AND a.ticked_at >= now() - interval '7 days'
     AND EXISTS (
       SELECT 1 FROM public.data_sync_log l
        WHERE l.pipeline = 'entity_connections_rebuild'
          AND l.started_at >  a.armed_for - interval '5 seconds'
          AND l.started_at <  a.armed_for + interval '60 seconds'
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

REVOKE ALL ON FUNCTION public.get_ec_crawl_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ec_crawl_health() TO service_role;

COMMENT ON FUNCTION public.get_ec_crawl_health() IS
  'FIX-1114 — health/lag instrument for the FIX-1111 EC crawl. Returns ONE jsonb: watermark age, dirty set, '
  'trailing-7d firing census, units per cycle for the last 5 closed cycles, and the live ec_crawl config. Read '
  'by the status-snapshot payload (section ec_crawl_health). SECURITY DEFINER (it read cron.job_run_details '
  'until cc-267; kept so the grant surface does not move). The tier-vs-ingest decision rule it serves is '
  'carried in the returned decision_rule key and in migration 20260828000000. FIX-1293 (cc-267): firings_7d '
  'reads dispatch_log (the ec-crawl arms and their reaps), not cron.job_run_details: the crawl fires as '
  'disp-ec-crawl-<epoch> one-shots and cron.job ''ec-crawl'' is parked. The returned keys are unchanged.';

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_md5     text;
  v_src     text;
  v_cfg     text;
  v_h       jsonb;
  v_keys    text[];
  v_fkeys   text[];
  v_t0      timestamptz;
  v_ms      numeric;
BEGIN
  SELECT md5(prosrc), prosrc, array_to_string(proconfig, ',') INTO v_md5, v_src, v_cfg
    FROM pg_proc WHERE proname = 'get_ec_crawl_health' AND pronamespace = 'public'::regnamespace;
  IF v_md5 IS DISTINCT FROM '0365316a209dd5b5db80f81e9364b2b0' THEN
    v_missing := v_missing || format('get_ec_crawl_health md5 %s, expected 0365316a209dd5b5db80f81e9364b2b0', v_md5)::text;
  END IF;
  IF v_cfg IS DISTINCT FROM 'search_path=public, cron, pg_temp' THEN
    v_missing := v_missing || format('get_ec_crawl_health proconfig %L', v_cfg)::text;
  END IF;
  IF position('job_run_details' IN regexp_replace(v_src, '--[^\n]*', '', 'g')) > 0 THEN
    v_missing := v_missing || 'get_ec_crawl_health still reads cron.job_run_details'::text;
  END IF;

  v_t0 := clock_timestamp();
  v_h  := public.get_ec_crawl_health();
  v_ms := round(EXTRACT(epoch FROM (clock_timestamp() - v_t0)) * 1000, 1);
  SELECT array_agg(k ORDER BY k) INTO v_keys  FROM jsonb_object_keys(v_h) k;
  SELECT array_agg(k ORDER BY k) INTO v_fkeys FROM jsonb_object_keys(v_h->'firings_7d') k;
  IF v_keys IS DISTINCT FROM ARRAY['backoff_rate_7d', 'config', 'cycles_last5', 'decision_rule', 'dirty_set', 'firings_7d', 'generated_at', 'last_cycle_closed_at', 'open_cycle', 'signal', 'skips_cumulative', 'watermark']::text[] THEN
    v_missing := v_missing || format('get_ec_crawl_health keys %s', v_keys)::text;
  END IF;
  IF v_fkeys IS DISTINCT FROM ARRAY['backoff', 'failed', 'skipped', 'total', 'units_out_of_band', 'units_run']::text[] THEN
    v_missing := v_missing || format('get_ec_crawl_health firings_7d keys %s', v_fkeys)::text;
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1293] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1293] read-back ok: get_ec_crawl_health % (was e6741c018c5b771343f2fb11e015a341); one call % ms; firings_7d %; backoff_rate_7d %',
    v_md5, v_ms, v_h->'firings_7d', v_h->'backoff_rate_7d';
END $$;
