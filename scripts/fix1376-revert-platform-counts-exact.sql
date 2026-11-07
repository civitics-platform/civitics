-- =============================================================================
-- FIX-1376 (cc-264) ROLLBACK — refresh_platform_counts() and
-- refresh_connection_type_counts() back to their exact counts.
--
-- The mirror of supabase/migrations/20261108002000_fix1376_platform_counts_estimated_four_tables_connection_type_mcv.sql.
-- NOT a migration: a payload for the --call path.
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1376-revert-platform-counts-exact.sql
--
-- The bodies are fix1126's and fix338's (467bd98ff2f4f45358cb9b43ea05376e), verbatim.
-- fix1126's restores as 0c36e1f6231e3188370277c759883eb1, NOT prod's a7fdc22d4da0da94b95ca2f35374a7f4. They are
-- the same text: prod's prosrc has CRLF from the primary's mixed working copy, and
-- .gitattributes (eol=lf) cannot carry that through git. The read-back says so.
--
-- THE COLUMN STAYS: connection_type_counts.method defaults to 'exact', which is
-- what the restored GROUP BY writes by default. Harmless.
--
-- Idempotent: the guard accepts the old md5s too.
-- =============================================================================

DO $$
DECLARE
  v_pc text;
  v_ct text;
BEGIN
  SELECT md5(prosrc) INTO v_pc FROM pg_proc WHERE proname = 'refresh_platform_counts' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_ct FROM pg_proc WHERE proname = 'refresh_connection_type_counts' AND pronamespace = 'public'::regnamespace;
  IF v_pc NOT IN ('0e5c3e7cbddaa50474a25f5f943a9272', 'a7fdc22d4da0da94b95ca2f35374a7f4', '0c36e1f6231e3188370277c759883eb1') THEN
    RAISE EXCEPTION '[fix1376 revert] refresh_platform_counts md5 % is neither this fix''s 0e5c3e7cbddaa50474a25f5f943a9272 nor fix1126''s', v_pc;
  END IF;
  IF v_ct NOT IN ('a188f729dcdcc7a2c32067da436bfbd5', '467bd98ff2f4f45358cb9b43ea05376e') THEN
    RAISE EXCEPTION '[fix1376 revert] refresh_connection_type_counts md5 % is neither this fix''s a188f729dcdcc7a2c32067da436bfbd5 nor fix338''s', v_ct;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.refresh_connection_type_counts()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- TRUNCATE + INSERT inside the function's implicit transaction is
  -- atomic. Readers see either the pre-refresh state or the post-refresh
  -- state, never an empty mid-refresh state.
  TRUNCATE TABLE public.connection_type_counts;
  INSERT INTO public.connection_type_counts (connection_type, total, refreshed_at)
    SELECT connection_type, COUNT(*)::BIGINT, NOW()
    FROM public.entity_connections
    GROUP BY connection_type;
END;
$$;

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
      -- FIX-1126 - the two proposals-by-type counts join the daily pass.
      --
      -- These were the last two live PostgREST counts on the status page's
      -- database section, and the only two that were count:'planned' -- planner
      -- ESTIMATES from pg_class.reltuples scaled by the filter's selectivity,
      -- not counts. FIX-1095 already recorded what reltuples is worth here: it
      -- overstated votes by 31%. A planned count over a filtered subset
      -- compounds that with the planner's selectivity guess on `type`, so the
      -- two tiles have been rendering an estimate of an estimate.
      --
      -- Exact daily replaces both, matching the FIX-1146 disposition for the
      -- other eight: truer than a planner estimate and cheaper than paying it
      -- on every status render. `type` is low-cardinality over a table this
      -- procedure already counts in full one line above, so the marginal cost
      -- is two more scans of the same heap the 'proposals' metric just read.
      ('proposals_bills',
         'SELECT count(*) FROM public.proposals
           WHERE type IN (''bill'', ''resolution'', ''amendment'')'),
      ('proposals_regulations',
         'SELECT count(*) FROM public.proposals WHERE type = ''regulation'''),
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

DO $$
DECLARE
  v_pc text;
  v_ct text;
BEGIN
  SELECT md5(prosrc) INTO v_pc FROM pg_proc WHERE proname = 'refresh_platform_counts' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_ct FROM pg_proc WHERE proname = 'refresh_connection_type_counts' AND pronamespace = 'public'::regnamespace;
  IF v_pc IS DISTINCT FROM '0c36e1f6231e3188370277c759883eb1' OR v_ct IS DISTINCT FROM '467bd98ff2f4f45358cb9b43ea05376e' THEN
    RAISE EXCEPTION '[fix1376 revert] read-back: refresh_platform_counts % / refresh_connection_type_counts %', v_pc, v_ct;
  END IF;
  RAISE NOTICE '[fix1376 revert] done: refresh_platform_counts % · refresh_connection_type_counts %; the method column stays', v_pc, v_ct;
END $$;
