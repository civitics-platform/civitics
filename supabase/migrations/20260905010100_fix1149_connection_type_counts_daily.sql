-- FIX-1149 - the dashboard's edge counts join the daily pass.
--
-- public.connection_type_counts was last refreshed 2026-06-24: 72 days stale as
-- of 2026-09-05, and missing `opposition` entirely. The cause is not a bad
-- rollup - refresh_connection_type_counts() derives its whole row set from a
-- GROUP BY over entity_connections, so it has always been able to mint a new
-- type - it is that NOTHING EVER CALLED IT. This wires it to the one daily
-- procedure that already owns exact platform counts (jobid 48,
-- platform-counts-daily, 03:53 UTC).
--
-- Readers are unchanged: get_connection_type_counts() and the /dashboard and
-- status-payload surfaces that read it keep their shape; they just stop being
-- served June's numbers. connection_type_counts.refreshed_at is what proves it.
--
-- Rule 34: REDEFINITION of a procedure carrying proconfig. Its SET clause
-- (search_path) is restated verbatim below and the GRANT posture re-asserted.

CREATE OR REPLACE PROCEDURE public.refresh_platform_counts()
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_at      timestamptz;
  v_t0      timestamptz;
  v_val     bigint;
  v_rows    bigint;
  v_timings jsonb := '{}'::jsonb;
  r         record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('platform_counts_refresh')::bigint) THEN
    RAISE NOTICE '[platform-counts] advisory lock held — skipping';
    RETURN;
  END IF;

  -- One timestamp for the whole pass: every metric is "as of" the same instant
  -- from the reader's point of view, which is what the page renders.
  v_at := clock_timestamp();

  FOR r IN
    SELECT * FROM (VALUES
      -- The three FIX-1095 headline counts.
      ('officials',               'SELECT count(*) FROM public.officials'),
      ('proposals',               'SELECT count(*) FROM public.proposals'),
      ('votes',                   'SELECT count(*) FROM public.votes'),
      -- The five FIX-206 "estimated" tables. Exact daily is both truer than
      -- reltuples and cheaper than exact-every-30-minutes.
      ('entity_connections',      'SELECT count(*) FROM public.entity_connections'),
      ('financial_relationships', 'SELECT count(*) FROM public.financial_relationships'),
      ('financial_entities',      'SELECT count(*) FROM public.financial_entities'),
      ('entity_tags',             'SELECT count(*) FROM public.entity_tags'),
      ('ai_summary_cache',        'SELECT count(*) FROM public.ai_summary_cache'),
      -- The get_quality_counts() scalars (FIX-333). Bodies copied from that
      -- function verbatim so the numbers cannot drift from what the quality
      -- section rendered before this change.
      ('total_pacs',
         'SELECT count(*) FROM public.financial_entities WHERE entity_type = ''pac'''),
      ('tagged_pacs',
         'SELECT count(*) FROM public.financial_entities fe
           WHERE fe.entity_type = ''pac''
             AND EXISTS (SELECT 1 FROM public.entity_tags et
                          WHERE et.entity_type  = ''financial_entity''
                            AND et.entity_id    = fe.id
                            AND et.tag_category = ''industry'')'),
      -- Still counted directly, NOT read from connection_type_counts. The
      -- rollup is refreshed at the end of this same pass now (FIX-1149), but
      -- reading it here would make this metric one pass staler than the rest
      -- for no saving: both are scans of the same index. The three vote types
      -- below that never appear in the rollup (vote_abstain,
      -- nomination_vote_yes, nomination_vote_no) have zero rows in
      -- entity_connections today, which is why a GROUP BY cannot mint them.
      ('vote_connection_total',
         'SELECT count(*) FROM public.entity_connections
           WHERE connection_type IN (''vote_yes'', ''vote_no'', ''vote_abstain'',
                                     ''nomination_vote_yes'', ''nomination_vote_no'')')
    ) AS t(metric, q)
  LOOP
    v_t0 := clock_timestamp();
    EXECUTE r.q INTO v_val;

    INSERT INTO public.platform_counts (metric, value, counted_at, method)
    VALUES (r.metric, v_val, v_at, 'exact')
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, counted_at = EXCLUDED.counted_at, method = EXCLUDED.method;

    v_timings := v_timings || jsonb_build_object(
      r.metric, ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_t0))::numeric, 3));
  END LOOP;

  -- The one map-valued metric. Delete-then-insert so a category that stops
  -- appearing in proposals stops appearing here too; ON CONFLICT alone would
  -- leave a retired category frozen at its last count forever.
  v_t0 := clock_timestamp();
  DELETE FROM public.platform_counts WHERE metric LIKE 'vote_category:%';
  INSERT INTO public.platform_counts (metric, value, counted_at, method)
  SELECT 'vote_category:' || p.vote_category, count(*)::bigint, v_at, 'exact'
  FROM public.proposals p
  WHERE p.vote_category IS NOT NULL
  GROUP BY p.vote_category;
  v_timings := v_timings || jsonb_build_object(
    'vote_category_counts', ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_t0))::numeric, 3));

  -- FIX-1149 - the dashboard's per-edge-type counts join the daily pass.
  --
  -- refresh_connection_type_counts() has always DERIVED its row set with a
  -- GROUP BY over entity_connections, so it was never missing a vocabulary;
  -- it simply had no caller. Nothing invoked it after 2026-06-24, so
  -- /dashboard and the status payload rendered edge totals 72 days stale, and
  -- `opposition` (4,535 edges on the clone) had never appeared at all because
  -- it did not exist when the table was last written.
  --
  -- Cost measured on the local clone 2026-09-05: 3.15 s over 6,986,000 rows,
  -- a parallel Index Only Scan on entity_connections_type - no heap scan, so
  -- it tracks the index, not the table width. Prod carries 10.5M rows. That is
  -- comfortably inside the callee's own 5 min statement_timeout and a rounding
  -- error against this procedure's existing exact counts.
  --
  -- Last, and before the data_sync_log row is written, so a failure here is
  -- visible as a failed cycle rather than silently costing the ten metrics
  -- already committed. The callee is TRUNCATE + INSERT inside this
  -- transaction, so readers see the old rows or the new ones, never an empty
  -- table.
  v_t0 := clock_timestamp();
  PERFORM public.refresh_connection_type_counts();
  v_timings := v_timings || jsonb_build_object(
    'connection_type_counts', ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_t0))::numeric, 3));

  SELECT count(*) INTO v_rows FROM public.platform_counts;

  -- `source: pg_cron` is load-bearing, not decoration: it is what
  -- list_scheduled_rollup_pipelines() reads to classify the driver and to
  -- time-correlate this pipeline to its cron job. 'complete' is likewise the
  -- only status check_rollup_freshness counts (FIX-1140).
  INSERT INTO public.data_sync_log
    (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES (
    'platform_counts_daily', 'complete', v_started, clock_timestamp(), v_rows,
    jsonb_build_object(
      'source',     'pg_cron',
      'metrics',    v_rows,
      'counted_at', v_at,
      'timings_s',  v_timings));

  RAISE NOTICE '[platform-counts] complete — % metrics, %', v_rows, v_timings;
END;
$procedure$;


-- Rule 34: re-assert the GRANT posture after CREATE OR REPLACE re-runs
-- Supabase's default grants. This procedure is driven by pg_cron only.
REVOKE ALL ON PROCEDURE public.refresh_platform_counts() FROM PUBLIC;
REVOKE ALL ON PROCEDURE public.refresh_platform_counts() FROM anon;
REVOKE ALL ON PROCEDURE public.refresh_platform_counts() FROM authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_platform_counts() TO service_role;

COMMENT ON FUNCTION public.refresh_connection_type_counts() IS
  'Rebuilds public.connection_type_counts from a GROUP BY over entity_connections (TRUNCATE + INSERT, atomic). FIX-1149: called from refresh_platform_counts() as the last step of the daily pass; it had no caller between 2026-06-24 and then, which is why the table was 72 days stale.';
