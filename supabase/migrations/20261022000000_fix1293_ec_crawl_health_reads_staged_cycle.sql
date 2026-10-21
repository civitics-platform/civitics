-- FIX-1293 — get_ec_crawl_health reads the crawl's staged cycle instead of
-- counting financial_relationships on every status roll (cc-241).
--
-- WHY. cc-238 read 8: status_snapshot.section_times.ec_crawl_health read
-- 8.2-17.0 s and the tile was null on 45 of 45 */30 rolls from Sun 10-18
-- 21:31Z (a landing in progress) to Mon 10-19 20:01Z. The dirty-set statement
-- (20261010030000:86-93) — count(*), count(DISTINCT from_id) over the FR
-- donation rows above the EC watermark, LIMIT 100001 — ran as an Index Scan on
-- the FIX-1297 partial: 17,462 qualifying rows, shared hit 2,851 / read 14,185,
-- 14.3 s. A heap fetch per qualifying row on a cache-starved box, and
-- service_role's 8 s cancels it. The LIMIT bounds nothing below the cap
-- (cc-211's reopen note), and the cost is in the rows that DO qualify.
--
-- WHAT THIS DOES (D-a). The crawl already computes this exact set, once per
-- cycle, when it stages it: rebuild_ec_donations_incr_prepare()
-- (20260903010000:2560-2598) fills ec_donations_incr_dirty with the DISTINCT
-- from_id, from_type above since_at up to the horizon-clamped target_at, and
-- writes pipeline_state.entity_connections_donations.cycle =
-- {since_at, target_at, staged_at, dirty_donors}. The close clears the key
-- (20260819060000). This body reads that key; the count is gone, and the status
-- roll never touches financial_relationships again. dirty_set becomes
--   {rows: null, donors: <cycle.dirty_donors or 0>, capped: false,
--    source: 'crawl_cycle' | 'caught_up', since_at, target_at, staged_at}
-- rows / donors / capped keep their keys, so no reader's shape changes. Nothing
-- in apps/, packages/ or scripts/ reads them (cc-241 read 5; the RPC is
-- computed in every snapshot and rendered nowhere — dispatcher-tile.test.ts).
-- v_signal still uses only the lag and the backoff rate. Everything else in the
-- body (the firings joins, FIX-1114b/c, the lag, the return) is byte-identical
-- to 20261010030000; ec-crawl-health-1293.test.ts proves it by a line diff.
-- It does not count ec_donations_incr_dirty either: that would be a second
-- source of the same number, and the key is the summary the crawl wrote.
--
-- SEMANTICS, for the tile's reader. Between a landing and the next cycle open
-- (<= ~10 min on ec-crawl's stale_after 10 minutes; up to ~2 h on FIX-1330's
-- ladder) the staged set is the PREVIOUS cycle's, or 0 when caught up, while
-- watermark.age_days already grows. The lag is the freshness signal; the
-- staged count is "what the crawl is working through", and staged_at says how
-- old that count is. The old count was a lower bound that was null whenever it
-- mattered. A no-op cycle (target <= since) reads source 'crawl_cycle', donors 0.
--
-- WHY NOT A COVERING INDEX (D-b). cc-238 suggested (updated_at) INCLUDE
-- (from_id) for an index-only scan. An index-only scan still fetches the heap
-- for every tuple on a page that is not all-visible, and the dirty rows are the
-- freshly landed ones: their pages are exactly the ones the visibility map has
-- not marked yet. FR is 100 % all-visible again only after fr's dispatched
-- VACUUM (~03:25Z). The tile was null in the landing → vacuum window, which is
-- the window such an index cannot cover. It would also carry no B-tree
-- deduplication (INCLUDE indexes never do), so ~5-8x the 75 MB partial.
-- Rejected; no index is built or changed here. The FIX-1297 partial stays (the
-- crawl's prepare and the MAX probe read it).
--
-- The header (SECURITY DEFINER, search_path = public, cron, pg_temp) and the
-- grants are copied verbatim from 20261010030000. No SET statement_timeout
-- (FIX-1128; check:proconfig).
--
-- ROLLBACK: scripts/fix1293-revert-ec-crawl-health-to-bounded-count.sql — the
-- 20261010030000 body verbatim (md5 7c837519c78b25f38a550cde4bb3947a).

-- ---------------------------------------------------------------------------
-- get_ec_crawl_health — copied from 20261010030000_fix1293_ec_crawl_health_bounded_dirty_set.sql; grants as last stated there
-- ---------------------------------------------------------------------------
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
$$;

REVOKE ALL ON FUNCTION public.get_ec_crawl_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ec_crawl_health() TO service_role;

-- ---------------------------------------------------------------------------
-- Read-back: the header as stated, one call, the dirty_set shape, the md5.
-- A plain SELECT function, so calling it here writes nothing.
-- ---------------------------------------------------------------------------
DO $fix1293$
DECLARE
  v_def  boolean;
  v_cfg  text[];
  v_md5  text;
  v_out  jsonb;
  v_ds   jsonb;
BEGIN
  SELECT prosecdef, proconfig, md5(prosrc) INTO v_def, v_cfg, v_md5
    FROM pg_proc WHERE oid = 'public.get_ec_crawl_health()'::regprocedure;
  IF v_def IS DISTINCT FROM true THEN
    RAISE EXCEPTION '[fix1293] get_ec_crawl_health is not SECURITY DEFINER';
  END IF;
  IF v_cfg IS DISTINCT FROM ARRAY['search_path=public, cron, pg_temp'] THEN
    RAISE EXCEPTION '[fix1293] proconfig is %, want {search_path=public, cron, pg_temp}', v_cfg;
  END IF;

  v_out := public.get_ec_crawl_health();
  v_ds  := v_out->'dirty_set';
  IF NOT (v_out ?& ARRAY['generated_at','watermark','dirty_set','firings_7d','backoff_rate_7d',
                         'skips_cumulative','cycles_last5','last_cycle_closed_at','open_cycle',
                         'config','signal','decision_rule']) THEN
    RAISE EXCEPTION '[fix1293] section keys missing: %', (SELECT array_agg(k) FROM jsonb_object_keys(v_out) k);
  END IF;
  IF NOT (v_ds ?& ARRAY['rows','donors','capped','source','since_at','target_at','staged_at']) THEN
    RAISE EXCEPTION '[fix1293] dirty_set keys missing: %', v_ds;
  END IF;
  IF (v_ds->>'source') IS NULL OR (v_ds->>'source') NOT IN ('crawl_cycle', 'caught_up') THEN
    RAISE EXCEPTION '[fix1293] dirty_set.source is %, want crawl_cycle or caught_up', v_ds->>'source';
  END IF;

  RAISE NOTICE '[fix1293] read-back ok: dirty_set %', v_ds;
  RAISE NOTICE '[fix1293] watermark % signal %', v_out->'watermark', v_out->>'signal';
  RAISE NOTICE '[fix1293] md5 get_ec_crawl_health %', v_md5;
END
$fix1293$;
