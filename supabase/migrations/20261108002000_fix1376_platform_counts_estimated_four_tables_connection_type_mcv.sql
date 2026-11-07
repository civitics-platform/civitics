-- =============================================================================
-- FIX-1376 — refresh_platform_counts() estimates the four big tables, and
-- refresh_connection_type_counts() reads pg_stats. cc-264, 2026-11-07.
--
-- DESIGN: docs/audits/2026-11-02-io-budget-census.md §4. Prompt: cc-prompt-264-…, D4.
-- FIX-1376's value 'approx' would be refused: platform_counts.method is
-- CHECK (method IN ('exact','estimated','planned')) (fix1146), so it is 'estimated'.
--
-- WHY. Cron 48 (`53 3 * * *`) reads ~3.2 GB a run for headline numbers (pgss since
-- 10-25: 7 runs, 22.5 GB shared reads, hit 13.7 %). count(*) on entity_connections
-- and its connection_type GROUP BY are Seq Scans, and entity_tags' is too once the
-- visibility map decays. On 11-02 the run landed inside the throttle and was
-- cancelled at 2,066 s, rolling back the whole pass. A quiet day reads 12–27 s.
--
-- WHAT:
--   entity_connections, financial_relationships, financial_entities, entity_tags
--     pg_class.reltuples, method 'estimated'. reltuples < 0 (never analyzed)
--     falls back to the exact count with a NOTICE.
--   connection_type_counts (the EC Seq Scan)
--     most_common_freqs × reltuples from pg_stats, method 'estimated'. No MCV list
--     falls back to the exact GROUP BY.
--   vote_connection_total
--     the sum of the five vote types in the rollup just written, so it moved after
--     the refresh. Its method follows theirs.
--   EXACT, unchanged: officials, proposals, proposals_bills, proposals_regulations,
--     votes, ai_summary_cache, total_pacs, tagged_pacs, vote_category:*.
--   data_sync_log.metadata.method_mix = {estimated: [...], exact: [...]}.
--   ADD COLUMN connection_type_counts.method (it had none), CHECK as platform_counts'.
--
-- A TYPE OUTSIDE THE MCV LIST. pg_stats cannot enumerate one, and on this column
-- the prompt's residual form has nothing to share: prod's n_distinct 12 = 12 MCVs
-- and Σfreqs ≈ 1, so `reltuples × (1 − Σfreqs) / n_distinct_remaining` is 0 / 0
-- (revolving_door, 1 row, cc-264 read 5). Printing 0 would be a wrong number. So the
-- refresh is an upsert, not a TRUNCATE: a type outside the list KEEPS its last
-- total, its own refreshed_at and its method, with a NOTICE naming it. A dated
-- reading, not an invented one. Its error is bounded: anything the sample would see
-- often enough is in the list. A brand-new rare type stays absent until a sample
-- sees it; a retired type lingers with an old refreshed_at. The exact path still
-- TRUNCATEs.
--
-- HONESTY. Estimates age with the stats: counted_at is the estimate's time, and
-- pg_stat_user_tables.last_analyze / last_autoanalyze is its freshness. ANALYZE
-- cadence is autovacuum's and the VACUUM (ANALYZE) rows'; this adds none.
-- The per-type numbers are coarser than the four totals. The sample is 30,000 rows
-- (default_statistics_target 100), so one sampled row is ~353 edges. Against the
-- 11-07 03:53Z exact rows, prod's stats read: the four totals within 0.11 %; donation
-- -0.5 %, vote_yes +5.2 %, vote_no +1.5 %, lobbying +15.1 %, opposition +12.3 %, and
-- vote_connection_total +4.1 %. They also move on every ANALYZE. /dashboard's edge
-- totals carry that noise from the first 03:53Z after this push.
--
-- TWO MD5S FOR ONE BODY. fix1126 is committed LF (.gitattributes eol=lf), but prod
-- and the clone took it from the primary's mixed working copy, so their prosrc has
-- CRLF and hashes a7fdc22d4da0da94b95ca2f35374a7f4. The committed text hashes 0c36e1f6231e3188370277c759883eb1. The guard
-- accepts both; a database built from the repo carries the second.
--
-- ON PROD THE APPLY CHANGES NO ROW: both bodies run first at cron 48's 03:53Z. The
-- ADD COLUMN stamps today's rows 'exact', which they are.
--
-- CLASS: P. One ADD COLUMN on a 13-row table, two CREATE OR REPLACE, the comments,
-- a read-back that writes nothing.
--
-- ROLLBACK: scripts/fix1376-revert-platform-counts-exact.sql (both bodies back; the
-- column stays, harmless: its default is the exact path's value).
-- =============================================================================

DO $$
DECLARE
  v_pc text;
  v_ct text;
BEGIN
  SELECT md5(prosrc) INTO v_pc FROM pg_proc
   WHERE proname = 'refresh_platform_counts' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_ct FROM pg_proc
   WHERE proname = 'refresh_connection_type_counts' AND pronamespace = 'public'::regnamespace;
  IF v_pc IS DISTINCT FROM 'a7fdc22d4da0da94b95ca2f35374a7f4' AND v_pc IS DISTINCT FROM '0c36e1f6231e3188370277c759883eb1' AND v_pc IS DISTINCT FROM '0e5c3e7cbddaa50474a25f5f943a9272' THEN
    RAISE EXCEPTION '[fix1376] refresh_platform_counts md5 % is none of fix1126''s a7fdc22d4da0da94b95ca2f35374a7f4, its LF twin 0c36e1f6231e3188370277c759883eb1 or this file''s — rebuild this file on the live body',
      COALESCE(v_pc, '(no routine)');
  END IF;
  IF v_ct IS DISTINCT FROM '467bd98ff2f4f45358cb9b43ea05376e' AND v_ct IS DISTINCT FROM 'a188f729dcdcc7a2c32067da436bfbd5' THEN
    RAISE EXCEPTION '[fix1376] refresh_connection_type_counts md5 % is neither fix338''s 467bd98ff2f4f45358cb9b43ea05376e nor this file''s — rebuild this file on the live body',
      COALESCE(v_ct, '(no routine)');
  END IF;
  RAISE NOTICE '[fix1376] guards: refresh_platform_counts % · refresh_connection_type_counts %', v_pc, v_ct;
END $$;

ALTER TABLE public.connection_type_counts
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'exact'
    CONSTRAINT connection_type_counts_method_check CHECK (method IN ('exact', 'estimated', 'planned'));

COMMENT ON COLUMN public.connection_type_counts.method IS
  'FIX-1376 — how total was read: estimated (most_common_freqs × reltuples) or exact (the GROUP BY fallback). A row outside the MCV list keeps its last method and refreshed_at.';

CREATE OR REPLACE FUNCTION public.refresh_connection_type_counts()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_reltuples real;
  v_vals      text[];
  v_freqs     real[];
  v_kept      text[];
BEGIN
  SELECT c.reltuples INTO v_reltuples
    FROM pg_catalog.pg_class c WHERE c.oid = 'public.entity_connections'::regclass;
  SELECT s.most_common_vals::text::text[], s.most_common_freqs
    INTO v_vals, v_freqs
    FROM pg_catalog.pg_stats s
   WHERE s.schemaname = 'public' AND s.tablename = 'entity_connections' AND s.attname = 'connection_type';

  -- No MCV list (never analyzed, or a role that cannot read the column's stats):
  -- the exact GROUP BY, as before. TRUNCATE + INSERT inside the function's
  -- implicit transaction is atomic, so readers never see it empty.
  IF v_vals IS NULL OR v_reltuples < 0 THEN
    RAISE NOTICE '[connection-type-counts] no MCV list for entity_connections.connection_type (reltuples %) — counting exactly', v_reltuples;
    TRUNCATE TABLE public.connection_type_counts;
    INSERT INTO public.connection_type_counts (connection_type, total, refreshed_at, method)
      SELECT connection_type, COUNT(*)::BIGINT, NOW(), 'exact'
      FROM public.entity_connections
      GROUP BY connection_type;
    RETURN;
  END IF;

  -- FIX-1376: most_common_freqs × reltuples, through float8 (real::numeric keeps
  -- six significant digits). An upsert, not a TRUNCATE: a type outside the MCV
  -- list keeps its row, its total and its own refreshed_at.
  INSERT INTO public.connection_type_counts (connection_type, total, refreshed_at, method)
    SELECT m.val, round(m.freq::float8 * v_reltuples::float8)::bigint, NOW(), 'estimated'
      FROM unnest(v_vals, v_freqs) AS m(val, freq)
  ON CONFLICT (connection_type) DO UPDATE
    SET total = EXCLUDED.total, refreshed_at = EXCLUDED.refreshed_at, method = EXCLUDED.method;

  SELECT array_agg(c.connection_type ORDER BY c.connection_type) INTO v_kept
    FROM public.connection_type_counts c
   WHERE NOT (c.connection_type = ANY (v_vals));
  IF v_kept IS NOT NULL THEN
    RAISE NOTICE '[connection-type-counts] % not in the MCV list — left at their last reading', v_kept;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.refresh_connection_type_counts() IS
  'FIX-1376: upserts public.connection_type_counts from pg_stats (most_common_freqs × reltuples, method estimated); a type outside the MCV list keeps its last reading and refreshed_at. No MCV list falls back to the exact GROUP BY (TRUNCATE + INSERT, atomic). FIX-1149: called from refresh_platform_counts() as the last step of the daily pass; it had no caller between 2026-06-24 and then, which is why the table was 72 days stale.';

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
  -- FIX-1376: the method of each metric, and the mix the sync row reports.
  v_method    text;
  v_reltuples real;
  v_estimated text[] := '{}';
  v_exact     text[] := '{}';
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
      ('officials',               'SELECT count(*) FROM public.officials', NULL::text),
      ('proposals',               'SELECT count(*) FROM public.proposals', NULL),
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
           WHERE type IN (''bill'', ''resolution'', ''amendment'')', NULL),
      ('proposals_regulations',
         'SELECT count(*) FROM public.proposals WHERE type = ''regulation''', NULL),
      ('votes',                   'SELECT count(*) FROM public.votes', NULL),
      -- FIX-1376: the four big tables read pg_class.reltuples (the third column
      -- names the relation), method 'estimated'. Their exact counts were ~3.2 GB
      -- of reads a run, and on 11-02 a 2,066 s cancel that rolled the whole pass
      -- back. The query stays as the fallback for a never-analyzed table.
      ('entity_connections',      'SELECT count(*) FROM public.entity_connections', 'public.entity_connections'),
      ('financial_relationships', 'SELECT count(*) FROM public.financial_relationships', 'public.financial_relationships'),
      ('financial_entities',      'SELECT count(*) FROM public.financial_entities', 'public.financial_entities'),
      ('entity_tags',             'SELECT count(*) FROM public.entity_tags', 'public.entity_tags'),
      ('ai_summary_cache',        'SELECT count(*) FROM public.ai_summary_cache', NULL),
      -- The get_quality_counts() scalars (FIX-333). Bodies copied from that
      -- function verbatim so the numbers cannot drift from what the quality
      -- section rendered before this change.
      ('total_pacs',
         'SELECT count(*) FROM public.financial_entities WHERE entity_type = ''pac''', NULL),
      ('tagged_pacs',
         'SELECT count(*) FROM public.financial_entities fe
           WHERE fe.entity_type = ''pac''
             AND EXISTS (SELECT 1 FROM public.entity_tags et
                          WHERE et.entity_type  = ''financial_entity''
                            AND et.entity_id    = fe.id
                            AND et.tag_category = ''industry'')', NULL)
    ) AS t(metric, q, est_rel)
  LOOP
    v_t0 := clock_timestamp();
    v_method := 'exact';
    v_val := NULL;
    IF r.est_rel IS NOT NULL THEN
      SELECT c.reltuples INTO v_reltuples FROM pg_catalog.pg_class c WHERE c.oid = r.est_rel::regclass;
      IF v_reltuples >= 0 THEN
        v_val := v_reltuples::bigint;
        v_method := 'estimated';
      ELSE
        RAISE NOTICE '[platform-counts] % was never analyzed (reltuples %) — counting it exactly', r.metric, v_reltuples;
      END IF;
    END IF;
    IF v_val IS NULL THEN
      EXECUTE r.q INTO v_val;
    END IF;

    INSERT INTO public.platform_counts (metric, value, counted_at, method)
    VALUES (r.metric, v_val, v_at, v_method)
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, counted_at = EXCLUDED.counted_at, method = EXCLUDED.method;

    IF v_method = 'estimated' THEN
      v_estimated := v_estimated || r.metric;
    ELSE
      v_exact := v_exact || r.metric;
    END IF;

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
  -- FIX-1376: the callee now reads pg_stats, with no scan of entity_connections
  -- unless the column has no MCV list, so this step costs a catalog read.
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

  -- FIX-1376: vote_connection_total sums the rollup just written, so the two
  -- cannot disagree and this metric stops paying for its own Seq Scan. It moved
  -- out of the loop above because it must run after the refresh. vote_abstain and
  -- the two nomination types have zero rows today, so no row and no share of the
  -- sum; a row would count.
  v_t0 := clock_timestamp();
  INSERT INTO public.platform_counts (metric, value, counted_at, method)
  SELECT 'vote_connection_total', COALESCE(sum(c.total), 0)::bigint, v_at,
         CASE WHEN bool_and(c.method = 'exact') THEN 'exact' ELSE 'estimated' END
    FROM public.connection_type_counts c
   WHERE c.connection_type IN ('vote_yes', 'vote_no', 'vote_abstain',
                               'nomination_vote_yes', 'nomination_vote_no')
  ON CONFLICT (metric) DO UPDATE
    SET value = EXCLUDED.value, counted_at = EXCLUDED.counted_at, method = EXCLUDED.method;
  v_timings := v_timings || jsonb_build_object(
    'vote_connection_total', ROUND(EXTRACT(epoch FROM (clock_timestamp() - v_t0))::numeric, 3));
  SELECT CASE WHEN p.method = 'estimated' THEN v_estimated || 'vote_connection_total'::text ELSE v_estimated END,
         CASE WHEN p.method = 'estimated' THEN v_exact ELSE v_exact || 'vote_connection_total'::text END
    INTO v_estimated, v_exact
    FROM public.platform_counts p WHERE p.metric = 'vote_connection_total';
  SELECT CASE WHEN bool_or(c.method = 'estimated') THEN v_estimated || 'connection_type_counts'::text ELSE v_estimated END,
         CASE WHEN bool_or(c.method = 'estimated') THEN v_exact ELSE v_exact || 'connection_type_counts'::text END
    INTO v_estimated, v_exact
    FROM public.connection_type_counts c;

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
      'timings_s',  v_timings,
      'method_mix', jsonb_build_object('estimated', to_jsonb(v_estimated), 'exact', to_jsonb(v_exact))));

  RAISE NOTICE '[platform-counts] complete — % metrics, %', v_rows, v_timings;
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.refresh_platform_counts() FROM PUBLIC;
REVOKE ALL ON PROCEDURE public.refresh_platform_counts() FROM anon;
REVOKE ALL ON PROCEDURE public.refresh_platform_counts() FROM authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_platform_counts() TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- read-back — RAISE on any miss; it writes nothing
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_pc      text;
  v_ct      text;
  v_config  text[];
  v_ct_conf text[];
  v_method  text;
  v_mix     text;
  v_preview text;
BEGIN
  SELECT md5(prosrc), proconfig INTO v_pc, v_config FROM pg_proc
   WHERE proname = 'refresh_platform_counts' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc), proconfig INTO v_ct, v_ct_conf FROM pg_proc
   WHERE proname = 'refresh_connection_type_counts' AND pronamespace = 'public'::regnamespace;
  IF v_pc IS DISTINCT FROM '0e5c3e7cbddaa50474a25f5f943a9272' THEN
    v_missing := v_missing || format('refresh_platform_counts md5 %s (expected 0e5c3e7cbddaa50474a25f5f943a9272)', v_pc);
  END IF;
  IF v_ct IS DISTINCT FROM 'a188f729dcdcc7a2c32067da436bfbd5' THEN
    v_missing := v_missing || format('refresh_connection_type_counts md5 %s (expected a188f729dcdcc7a2c32067da436bfbd5)', v_ct);
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] OR v_ct_conf IS NOT NULL THEN
    v_missing := v_missing || format('proconfig %s / %s (expected the procedure''s search_path, nothing on the function)', v_config, v_ct_conf);
  END IF;
  SELECT pg_get_constraintdef(oid)::text INTO v_method FROM pg_constraint
   WHERE conrelid = 'public.connection_type_counts'::regclass AND conname = 'connection_type_counts_method_check';
  IF v_method IS NULL OR v_method NOT LIKE '%estimated%' THEN
    v_missing := v_missing || format('connection_type_counts.method CHECK reads %s', v_method);
  END IF;
  SELECT string_agg(x.method || ' ' || x.n::text, ', ' ORDER BY x.method) INTO v_mix
    FROM (SELECT c.method, count(*) AS n FROM public.connection_type_counts c GROUP BY c.method) x;

  -- What the next 03:53Z will write, beside the last exact rows. Catalog reads only.
  SELECT string_agg(format('%s %s vs %s', c.relname, c.reltuples::bigint::text, p.value::text), ' · ' ORDER BY c.relname)
    INTO v_preview
    FROM pg_catalog.pg_class c
    JOIN public.platform_counts p ON p.metric = c.relname
   WHERE c.oid IN ('public.entity_connections'::regclass, 'public.financial_relationships'::regclass,
                   'public.financial_entities'::regclass, 'public.entity_tags'::regclass);

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1376] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1376] read-back ok: refresh_platform_counts md5 % (was a7fdc22d4da0da94b95ca2f35374a7f4); refresh_connection_type_counts md5 % (was 467bd98ff2f4f45358cb9b43ea05376e); connection_type_counts.method rows %; next pass, reltuples vs the last row: %',
    v_pc, v_ct, COALESCE(v_mix, '(empty)'), COALESCE(v_preview, '(no rows)');
END $$;
