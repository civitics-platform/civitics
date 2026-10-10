-- FIX-1293 — get_ec_crawl_health bounds its dirty-set count at 100,000 rows (cc-211).
--
-- WHY. The RPC counted count(*), count(DISTINCT from_id) over every
-- financial_relationships donation / ie row with updated_at past the
-- entity_connections_donations watermark — unbounded. Behind a large FR landing
-- (the 10-08 USASpending run, FIX-1291) that is a scan plus a sort of the whole
-- backlog on every */30 status tick: status_snapshot.section_times.ec_crawl_health
-- read 8,130-8,935 ms on every tick from 17:38Z 10-08 — service_role's 8 s
-- statement_timeout — and the ec_crawl_health tile read null exactly when the
-- crawl's lag was large (docs/audits/2026-10-07-burst-census.md §3.4, §3.7).
--
-- WHAT THIS DOES. ONE change, at the count (20260828000200:66-72): it runs over
-- a LIMIT 100001 subquery, issued through EXECUTE ... USING v_wm, so whichever
-- access path that call's plan picks stops at 100,001 matching rows, and the
-- DISTINCT is over at most that many uuids. dirty_set gains one key, `capped` — true when
-- the count hit the bound, and then `rows` / `donors` are LOWER BOUNDS. The
-- other keys are unchanged. Nothing in apps/, packages/ or scripts/ reads
-- dirty_set.rows / .donors (cc-203's census); v_signal uses only the lag and
-- the backoff rate. database.ts types the return as Json — no TS change.
--
-- THE CLONE PROOF (local prod-clone, the watermark rewound in a rolled-back
-- transaction so the dirty set exceeds 100k):
--   watermark 2026-07-26 (4.02M dirty rows), cold: the OLD count 48.4 s
--     (Bitmap Heap Scan, 346k blocks read; the function whole 3.2 s warm).
--     The NEW function: 0.44 s cold, then 0.17-0.26 s; capped true, rows
--     100,001 (donors is a lower bound and varies with the scan's start).
--   watermark 2026-08-10 (38,134 dirty rows, UNDER the cap), 8 calls in one
--     session: 0.92 s cold, then 34-51 ms every call; capped false, exact.
--
-- WHY EXECUTE ... USING, not a static subquery. The static form was measured
-- first. Under the cap, its plpgsql-cached GENERIC plan (from a session's 6th
-- call; PostgREST's pooled sessions get there) is Seq Scan + LIMIT, which never
-- reaches 100,001 rows and so reads all of financial_relationships: 7.1 s cold,
-- 1.6 s warm on the clone, ~x1.48 by pages on prod — the 8 s timeout again.
-- ORDER BY updated_at pins the index instead but cost 5.2 s cold when capped.
-- EXECUTE ... USING plans every call with v_wm's value: seq-scan + LIMIT for a
-- dense backlog, the bitmap index scan for a small one.
--
-- The body is copied from 20260828000200_fix1114c_crawl_health_symmetric_join.sql
-- (= prod's prosrc by md5, read 2026-10-10 04:22Z) with ONLY those lines changed;
-- work-mem-allowances.test.ts proves it by a line diff. The header (SECURITY
-- DEFINER, search_path = public, cron, pg_temp) is unchanged. Grants re-stated
-- from 20260828000200:184-185. The cap is a dial: LIMIT 100001 / > 100000.
--
-- ROLLBACK: re-apply the CREATE OR REPLACE from 20260828000200 (the unbounded
-- count, no `capped` key).

-- ---------------------------------------------------------------------------
-- get_ec_crawl_health — copied from 20260828000200_fix1114c_crawl_health_symmetric_join.sql; grants as last stated at 20260828000200:184-185
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
    -- FIX-1293: bounded, and planned per call with v_wm's value. A cached generic
    -- plan for "updated_at > $1" under LIMIT is a Seq Scan, and below the cap it
    -- reads all of financial_relationships (cc-211 clone: 7.1 s from the 6th call).
    EXECUTE 'SELECT count(*), count(DISTINCT from_id)
      FROM (SELECT from_id
              FROM public.financial_relationships
             WHERE relationship_type IN (''donation'',''ie_support'',''ie_oppose'')
               AND updated_at > $1
             LIMIT 100001) s'
      INTO v_dirty_rows, v_dirty_dons
      USING v_wm;
    v_dirty_capped := v_dirty_rows > 100000;   -- then rows/donors are LOWER BOUNDS
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
    'dirty_set',      jsonb_build_object('rows', v_dirty_rows, 'donors', v_dirty_dons, 'capped', v_dirty_capped),
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
