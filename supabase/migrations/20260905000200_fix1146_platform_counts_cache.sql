-- 20260905000200_fix1146_platform_counts_cache.sql
-- FIX-1146 — the status page's headline count family leaves the request path.
--
-- ── THE BILL ────────────────────────────────────────────────────────────────
-- /api/claude/status recomputes every headline count on every tick, and since
-- FIX-1127 that tick is every 30 minutes. From pg_stat_statements on prod,
-- window 2026-08-29 08:05 → 2026-09-04 (7 days):
--
--   shape                              calls   mean        total
--   ─────────────────────────────────  ─────   ─────────   ────────
--   get_quality_counts()                 240   15,148.7ms   3,636 s
--   votes         count exact            154    4,746.0ms     731 s
--   proposals     count exact            246    2,941.4ms     724 s
--   officials     count exact            273      617.8ms     169 s
--   financial_entities  count estimated  272      585.1ms     159 s
--   ai_summary_cache    count estimated  272      571.0ms     155 s
--   entity_tags         count estimated  273      337.6ms      92 s
--   financial_relationships   estimated  263      337.1ms      89 s
--   entity_connections        estimated  273      188.6ms      51 s
--   ─────────────────────────────────────────────────────────────────
--                                                TOTAL      5,806 s
--
-- ~830 s of prod execution a day. `get_quality_counts()` alone is 63% of it and
-- is the single most expensive statement on the snapshot path.
--
-- ── THE DECISION (Craig, 2026-09-04) ───────────────────────────────────────
-- The headline counts need not be live-exact. That REVERSES PART OF FIX-1095
-- deliberately, and it is worth being precise about which part. FIX-1095's
-- finding was correct and stands: `count: estimated` reads pg_class.reltuples,
-- which is not a count, and after the vote-stub deletions it overstated votes
-- by 31% (reltuples 1,270,118 vs count 969,302). What FIX-1095 chose — pay for
-- an exact count on every tick — is what changes. Every metric in this cache is
-- an EXACT count, so the reltuples hazard cannot recur: the cache IS a count,
-- just one taken daily instead of 48 times a day. FIX-1095's "revisit any of
-- them if a large delete lands" tell is retired by construction, not ignored.
--
-- What stays LIVE on the request path, and why:
--   * the two planner-`planned` proposals counts (bills, regulations) — they do
--     not scan, and FIX-503 already accepted planner accuracy for them;
--   * `page_views_24h` — a rolling 24-hour filtered count, so a daily snapshot
--     would answer a different question, and it is cheap.
--
-- ── SHAPE ──────────────────────────────────────────────────────────────────
-- One row per metric. Scalars are stored directly; the one map-valued metric
-- (`vote_category_counts`, which the quality section renders per category) is
-- stored as one row per category under a `vote_category:` prefix, so the table
-- stays (metric, bigint) and the read path reassembles.
--
-- NOT to be confused with `daily_platform_counts` (FIX-090), which is a
-- 30-day-per-day HISTORICAL SERIES for the dashboard sparklines, written from
-- the already-computed status payload. This table is a CACHE of the current
-- values, keyed by metric, one row per metric, overwritten daily. FIX-090 reads
-- the payload; this feeds it.
--
-- ── CADENCE AND SLOT ───────────────────────────────────────────────────────
-- Daily at 03:53 UTC (`53 3 * * *`), chosen against the FIX-1141 placement
-- rules and the FIX-1073 startup-timeout histogram by UTC hour:
--   * hour 3 sits in the measured quiet band (18:00–05:59 UTC, 0.0–3.8%
--     startup-timeout rate); hours 06–17 run 16–47%;
--   * minute 53 is ODD, so it clears the two */2 watchdogs (jobids 40, 44);
--   * 53 is not a multiple of 15 or 30, so it clears ec-crawl (*/15) and
--     fe-crawl (*/30);
--   * no other active job holds `53 3 * * *`. The nearest neighbour is
--     `vote-stats-refresh` at 03:30, which has run 16–27 s every night since
--     2026-08-29, so it is long finished;
--   * outside the 09:00–17:40 active-hours rule, outside the 05:45–09:00
--     ec_crawl blackout, and outside the 05:50–08:00 nightly window that makes
--     prod reads unreliable.
--
-- The job writes a `data_sync_log` closure named `platform_counts_daily`, which
-- is `platform-counts-daily` with dashes swapped — the exact key
-- `list_scheduled_rollup_pipelines()` correlates on (`by_name`). So the cache
-- enters the FIX-1135 rollup registry as a first-class pipeline with
-- cadence_source='cron_schedule' and 24 h declared, and the canary watches its
-- freshness from the first firing. It is not an orphan: `has_active_job` is
-- true and the driver is pg_cron.
--
-- ── FIRST FILL: NOT IN THIS MIGRATION ──────────────────────────────────────
-- Measured on the clone, full pass, 14 metrics, 30.0 s total:
--
--   financial_relationships 21.632   entity_connections     1.735
--   tagged_pacs              4.555   financial_entities     0.745
--   entity_tags              0.640   vote_connection_total  0.455
--   votes                    0.068   vote_category_counts   0.039
--   total_pacs               0.033   officials              0.028
--   ai_summary_cache         0.020   proposals              0.018
--
-- Past the 20 s an in-migration fill was budgeted, and that clone number is a
-- FLOOR for prod, not an estimate of it (see the budget note below). So the
-- table ships EMPTY and the first `platform-counts-daily` firing fills it.
-- Until then the read path reports the counts as not yet counted rather than
-- inventing a zero — a 0 would assert the platform tracks nothing, which is the
-- same lie FIX-090's NULL-vs-0 rule exists to prevent.
--
-- Cross-ref FIX-1095, FIX-1126, FIX-1127, FIX-333, FIX-206, FIX-503, FIX-090,
-- FIX-1135, FIX-1141, FIX-1073, FIX-1063.
--
-- Fixes: FIX-1146
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. platform_counts ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.platform_counts (
  metric      TEXT PRIMARY KEY,
  value       BIGINT      NOT NULL,
  -- The instant the count was TAKEN, not the instant the row was written. The
  -- read path surfaces it so the page can render "as of HH:MM UTC" — a cached
  -- number whose age is invisible is worse than a slow one.
  counted_at  TIMESTAMPTZ NOT NULL,
  -- 'exact' for everything today. The column exists so a future metric that
  -- genuinely cannot be counted exactly has somewhere honest to say so, rather
  -- than being silently indistinguishable from one that can.
  method      TEXT        NOT NULL DEFAULT 'exact'
              CHECK (method IN ('exact', 'estimated', 'planned'))
);

COMMENT ON TABLE public.platform_counts IS
  'FIX-1146 — daily EXACT counts of the status-page headline metrics, so the '
  '30-minute snapshot tick reads a 20-row table instead of re-scanning eight '
  'large tables. Written by refresh_platform_counts() on the platform-counts-daily '
  'pg_cron job. Map-valued metrics are stored one row per key under a prefix '
  '(vote_category:<category>). Not daily_platform_counts (FIX-090), which is the '
  'historical per-day series.';

ALTER TABLE public.platform_counts ENABLE ROW LEVEL SECURITY;

-- Read server-side through createAdminClient (bypasses RLS), so a deny-all
-- default keeps the table off the public PostgREST surface. Same posture as
-- status_snapshot and daily_platform_counts.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'platform_counts'
      AND policyname = 'no public read platform_counts'
  ) THEN
    CREATE POLICY "no public read platform_counts"
      ON public.platform_counts FOR SELECT USING (false);
  END IF;
END$$;

-- ── 2. refresh_platform_counts() ─────────────────────────────────────────────
--
-- A PROCEDURE, matching rebuild_official_vote_stats: pg_cron CALLs it, and the
-- outside bound is the cron_job_budget row below rather than a proconfig
-- statement_timeout (the same choice every other rollup procedure on this
-- instance makes).
--
-- Each metric is counted by its OWN statement, via a driven loop rather than
-- one giant UNION ALL. Three reasons, all of them operational: a per-statement
-- timeout bounds one metric instead of the batch; a metric that regresses is
-- visible by name in the metadata timings rather than buried in a single
-- number; and if any count throws, the whole procedure rolls back and the
-- PREVIOUS day's values survive intact — a half-refreshed cache is worse than
-- a day-old one.

CREATE OR REPLACE PROCEDURE public.refresh_platform_counts()
LANGUAGE plpgsql
SET search_path = public, pg_temp
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
      -- NOT read from connection_type_counts: that rollup exists and carries
      -- per-type totals, but its rows were last refreshed 2026-06-24 and it is
      -- missing three of the five vote types outright. A stale rollup is not a
      -- cheaper count, it is a wrong one. Filed separately.
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

REVOKE ALL ON PROCEDURE public.refresh_platform_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.refresh_platform_counts() TO service_role;

COMMENT ON PROCEDURE public.refresh_platform_counts() IS
  'FIX-1146 — recompute every platform_counts metric exactly, once. Driven by '
  'the platform-counts-daily pg_cron job at 03:53 UTC. Per-metric statements so '
  'one slow count is visible by name in data_sync_log.metadata.timings_s and a '
  'throw leaves yesterday''s cache intact.';

-- ── 3. Schedule ──────────────────────────────────────────────────────────────
--
-- BY NAME (playbook D3). cron.schedule() with a name is upsert-by-name, so
-- re-running this migration re-points the same jobid rather than minting a new
-- one and orphaning the job's own run history.

DO $$
DECLARE
  c_jobname  CONSTANT text := 'platform-counts-daily';
  c_sched    CONSTANT text := '53 3 * * *';
  v_id       bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE WARNING '[fix1146] pg_cron not installed — job not scheduled';
    RETURN;
  END IF;

  SELECT cron.schedule(c_jobname, c_sched, 'CALL public.refresh_platform_counts();')
    INTO v_id;
  RAISE NOTICE '[fix1146] scheduled % (jobid %) at %', c_jobname, v_id, c_sched;
END $$;

-- Budget: the outside bound the FIX-1063 watchdog cancels on.
--
-- The clone total × 7 would be 210 s, and that number is NOT usable here. The
-- clone understates precisely the metrics that dominate this job: prod's own
-- pg_stat_statements records a single FILTERED count(*) over
-- financial_relationships at 270,058 ms — already past a 210 s bound before the
-- other eleven metrics are counted — against 21.6 s for the unfiltered count on
-- the clone. Cache residency is the difference (prod runs 256 MB
-- shared_buffers at ~54% hit), and it is a property of prod that no clone
-- measurement can carry. So the base is the prod-projected total, not the clone
-- total, and 1800 s matches the outside bound every other bounded job on this
-- instance carries. The first firings re-size it with real numbers.
INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES (
  'platform-counts-daily',
  1800,
  'FIX-1146. Daily exact recount of the status-page headline metrics. Clone '
  'full pass 30.0 s (financial_relationships 21.6 s of it); clone x7 = 210 s is '
  'NOT the bound because prod records a single filtered FR count at 270 s. '
  'Sized off the prod projection instead. A cancel here is SAFE: the procedure '
  'is one transaction, so a cancelled run rolls back whole and the page keeps '
  'yesterday''s counts.')
ON CONFLICT (jobname) DO UPDATE
  SET budget_seconds = EXCLUDED.budget_seconds,
      note           = EXCLUDED.note,
      updated_at     = NOW();

-- ── 4. Guard ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_sched text;
  v_min   int;
  v_hour  int;
  v_clash int;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE '[fix1146] pg_cron absent — placement guard skipped';
    RETURN;
  END IF;

  SELECT schedule INTO v_sched FROM cron.job WHERE jobname = 'platform-counts-daily';
  IF v_sched IS NULL THEN
    RAISE EXCEPTION '[fix1146] platform-counts-daily was not scheduled';
  END IF;

  v_min  := split_part(v_sched, ' ', 1)::int;
  v_hour := split_part(v_sched, ' ', 2)::int;

  IF NOT (v_hour >= 18 OR v_hour <= 5) THEN
    RAISE EXCEPTION '[fix1146] lands at hour % — outside the measured quiet band (18-05 UTC)', v_hour;
  END IF;
  IF v_min % 2 = 0 THEN
    RAISE EXCEPTION '[fix1146] lands on even minute % — collides with the */2 watchdogs', v_min;
  END IF;
  IF v_min % 15 = 0 THEN
    RAISE EXCEPTION '[fix1146] lands on minute % — collides with ec-crawl/fe-crawl', v_min;
  END IF;

  SELECT count(*) INTO v_clash FROM cron.job
   WHERE active AND jobname <> 'platform-counts-daily' AND schedule = v_sched;
  IF v_clash > 0 THEN
    RAISE EXCEPTION '[fix1146] % active job(s) already hold schedule %', v_clash, v_sched;
  END IF;

  RAISE NOTICE '[fix1146] placement guard passed — platform-counts-daily at % (hour %, minute %)',
    v_sched, v_hour, v_min;
END $$;
