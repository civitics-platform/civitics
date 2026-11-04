-- =============================================================================
-- FIX-1338 — check_pipeline_rate_regression() rates WORK DONE, not rows
-- written, and sees registry-owned rows that stamp no source. cc-259,
-- 2026-11-04. The first file of cc-263's push (files 2–5 read the verdict
-- this body returns).
--
-- THE DEFECT. fix978 (20260808002000) rates every `complete` pg_cron row as
-- span_s × 1000 / (rows_inserted + rows_updated). run_rule_taggers went
-- merge-mode (FIX-1178a): a run writes only the DELTA, so rows_inserted =
-- tags_written reads 0–1 on a quiet day. A 0-tag run is filtered (shape 1), a
-- 1-tag run of 62 s rates 62,000 s/1k, and the DELETE-all era's rows (inserted
-- ≈ the whole desired set) are the baseline it is judged against. The bullet's
-- reading: "weekly 23.5 s/1k, a 397-tag daily 532 s/1k". The run's cost is the
-- SCAN over the desired set, and the body already stamps it:
-- metadata.desired_rows (873,305 on prod's Tue 11-03 daily, 4,466,294 on the
-- weekly; cc-259 read 3), on every `rebuilt` row of both cadences.
--
-- D1 — THE DENOMINATOR IS WORK DONE, GENERICALLY.
--   work := COALESCE(desired, rows_inserted + rows_updated)
-- where `desired` is metadata->>'desired_rows' ONLY when the text is all
-- digits, and NULL when it is 0 (NULLIF). The digit test guards the cast, so a
-- stray non-numeric stamp rates on rows written instead of erroring the whole
-- check. Any body that stamps desired_rows is denominated on it with no
-- further change. The `> 0` filter (shape 1) applies to the COALESCEd work.
--
-- THE ERAS ARGUMENT (why the 90-day baseline needs no reset). In the
-- DELETE-all era a run inserted the whole desired set, so rows written ≈
-- desired and an old row rates the same under either denominator. The
-- merge-era rows that stamp desired_rows now rate like them: one rule, two
-- eras, one baseline.
--
-- D3 — THE MEMBERSHIP TEST WIDENS. `source = 'pg_cron'` OR (no source AND the
-- pipeline has a job_registry row). Bodies that stamp no source (treemap's
-- driver reads `unknown`) were invisible to the check. Registry ownership is
-- the membership test, FIX-1317's direction. A script-run backfill with no
-- source and no registry row stays out, and so does any other stamp
-- (`pg_cron/backfill`, `vercel_cron`). cc-259 read 5 (prod, 90 d): the
-- newcomers are contract_flow_rollups_rebuild, nightly_cron,
-- official_vote_stats_rebuild and treemap_individuals_global_refresh;
-- irs990's no-source rows all did zero work and stay filtered.
--
-- EACH ELEMENT GAINS `denominator`: 'desired_rows' | 'rows_written' | 'mixed',
-- the mode of the RECENT window (the runs the verdict is about). Additive: the
-- canary picks fields by name (canary-check.ts RateFinding), and
-- packages/db/src/types/database.ts types the return as Json. No regen.
--
-- Everything else is fix978's body, unchanged: the signature, STABLE,
-- SECURITY DEFINER, the search_path, the P90 × factor line, the all-not-any
-- sustained test, the escalation rule, the return shape.
--
-- READ-BACK (RAISE on a miss): prosecdef, proconfig, the three grants, one
-- call of the new body with the run_rule_taggers element printed, and RAISE
-- if that element's denominator is not desired_rows (the premise of the whole
-- fix). md5(prosrc) is a NOTICE: this function is not a dispatcher pin.
--
-- ROLLBACK: re-apply fix978's CREATE OR REPLACE (20260808002000) verbatim.
-- IDEMPOTENT (CREATE OR REPLACE).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.check_pipeline_rate_regression(
  p_lookback_days     int     DEFAULT 90,
  p_recent_runs       int     DEFAULT 3,
  p_min_baseline_runs int     DEFAULT 5,
  p_factor            numeric DEFAULT 2.0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_since  timestamptz := now() - make_interval(days => p_lookback_days);
  v_rows   jsonb;
BEGIN
  WITH usable AS (
    -- The rate substrate, with both undefined-rate shapes filtered out at the
    -- source so nothing downstream can divide by zero.
    -- FIX-1338 D1: work is the desired set when the body stamps one (a
    -- merge-mode body writes only its delta), else rows written.
    SELECT
      l.pipeline,
      l.started_at,
      EXTRACT(epoch FROM (l.completed_at - l.started_at))::numeric      AS span_s,
      d.desired,
      COALESCE(d.desired, (COALESCE(l.rows_inserted, 0) + COALESCE(l.rows_updated, 0))::numeric) AS work
    FROM public.data_sync_log l
    CROSS JOIN LATERAL (
      -- The digit test guards the cast: a non-numeric stamp rates on rows written.
      SELECT CASE WHEN l.metadata->>'desired_rows' ~ '^[0-9]+$'
                  THEN NULLIF((l.metadata->>'desired_rows')::numeric, 0)
             END AS desired
    ) d
    WHERE l.started_at >= v_since
      AND l.status = 'complete'
      -- FIX-1338 D3: pg_cron, or no source on a registry-owned pipeline.
      AND (l.metadata->>'source' = 'pg_cron'
           OR (l.metadata->>'source' IS NULL
               AND EXISTS (SELECT 1 FROM public.job_registry j WHERE j.pipeline = l.pipeline)))
      AND l.completed_at > l.started_at                                    -- shape 2
      AND COALESCE(d.desired, COALESCE(l.rows_inserted, 0) + COALESCE(l.rows_updated, 0)) > 0 -- shape 1
  ),
  rated AS (
    SELECT
      pipeline,
      started_at,
      span_s,
      work,
      desired,
      -- Seconds per thousand rows. Cost per unit of work, so a run that is
      -- slower only because it had more to do does not read as a regression.
      (span_s * 1000.0) / work AS s_per_1k,
      row_number() OVER (PARTITION BY pipeline ORDER BY started_at DESC) AS rn
    FROM usable
  ),
  baseline AS (
    SELECT
      pipeline,
      count(*) AS baseline_runs,
      -- percentile_cont only has a double-precision variant, so a numeric input
      -- comes back as double. Cast straight back: round(double, int) does not
      -- exist, and neither does double * numeric.
      percentile_cont(0.9) WITHIN GROUP (ORDER BY s_per_1k)::numeric AS p90_s_per_1k,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY s_per_1k)::numeric AS median_s_per_1k
    FROM rated
    WHERE rn > p_recent_runs
    GROUP BY pipeline
  ),
  recent AS (
    SELECT
      pipeline,
      count(*)      AS recent_runs,
      min(s_per_1k) AS min_recent,
      max(s_per_1k) AS max_recent,
      -- FIX-1338: the recent window's denominator; a window that mixes says so.
      CASE WHEN bool_and(desired IS NOT NULL) THEN 'desired_rows'
           WHEN bool_or(desired IS NOT NULL)  THEN 'mixed'
           ELSE                                    'rows_written'
      END AS denominator,
      max(started_at) AS last_run_at
    FROM rated
    WHERE rn <= p_recent_runs
    GROUP BY pipeline
  ),
  judged AS (
    SELECT
      b.pipeline,
      b.baseline_runs,
      r.recent_runs,
      ROUND(b.median_s_per_1k, 4) AS baseline_median_s_per_1k,
      ROUND(b.p90_s_per_1k,    4) AS baseline_p90_s_per_1k,
      ROUND(r.min_recent,      4) AS recent_min_s_per_1k,
      ROUND(r.max_recent,      4) AS recent_max_s_per_1k,
      ROUND(b.p90_s_per_1k * p_factor, 4) AS threshold_s_per_1k,
      r.last_run_at,
      r.denominator,
      ROUND(r.min_recent / NULLIF(b.p90_s_per_1k, 0), 2) AS worst_case_ratio,
      -- SUSTAINED: the BEST of the recent window is still above the line, i.e.
      -- every recent run regressed. This is the bimodal guard — one slow run
      -- among fast ones leaves min_recent below the threshold.
      (r.min_recent > b.p90_s_per_1k * p_factor) AS sustained,
      -- INTERMITTENT: at least one recent run above the line, but not all.
      (r.max_recent > b.p90_s_per_1k * p_factor
        AND r.min_recent <= b.p90_s_per_1k * p_factor)   AS intermittent,
      -- Not enough history for either verdict to mean anything.
      (b.baseline_runs < p_min_baseline_runs OR r.recent_runs < 2) AS insufficient
    FROM baseline b
    JOIN recent   r ON r.pipeline = b.pipeline
    WHERE b.p90_s_per_1k > 0
  )
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'pipeline'), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT jsonb_build_object(
             'pipeline',                 pipeline,
             'baseline_runs',            baseline_runs,
             'recent_runs',              recent_runs,
             'baseline_median_s_per_1k', baseline_median_s_per_1k,
             'baseline_p90_s_per_1k',    baseline_p90_s_per_1k,
             'threshold_s_per_1k',       threshold_s_per_1k,
             'recent_min_s_per_1k',      recent_min_s_per_1k,
             'recent_max_s_per_1k',      recent_max_s_per_1k,
             'worst_case_ratio',         worst_case_ratio,
             'last_run_at',              last_run_at,
             'denominator',              denominator,
             'verdict', CASE
                          WHEN insufficient          THEN 'insufficient_data'
                          WHEN sustained             THEN 'sustained_regression'
                          WHEN intermittent          THEN 'intermittent'
                          ELSE                            'ok'
                        END,
             -- Only a sustained regression backed by real history escalates.
             'escalates', (sustained AND NOT insufficient)
           ) AS t
    FROM judged
  ) s;

  RETURN jsonb_build_object(
    'available',       true,
    'lookback_days',   p_lookback_days,
    'recent_runs',     p_recent_runs,
    'factor',          p_factor,
    'pipelines',       v_rows,
    'regressions',     COALESCE((
                         SELECT jsonb_agg(e)
                         FROM jsonb_array_elements(v_rows) e
                         WHERE (e->>'escalates')::boolean
                       ), '[]'::jsonb)
  );
END;
$$;

-- Script-gated only (canary -> createAdminClient -> service_role). FIX-834/835:
-- Supabase default-grants EXECUTE to anon/authenticated on new functions.
REVOKE ALL ON FUNCTION public.check_pipeline_rate_regression(int, int, int, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_pipeline_rate_regression(int, int, int, numeric)
  TO service_role;

COMMENT ON FUNCTION public.check_pipeline_rate_regression(int, int, int, numeric) IS
  'FIX-978 — the first RATE detector on this instance. Cost per unit of work '
  '(seconds per 1k rows) from data_sync_log span + rows_inserted/rows_updated, '
  'which are populated for 13 of 13 pg_cron pipelines (FIX-972''s '
  'recipients_done/chunk_size were present on 2 of 1,372 rows and are NOT used). '
  'Zero-work and zero-span runs are excluded — a rate is only defined when work '
  'existed. Escalates ONLY on a sustained regression: every one of the last N '
  'runs above baseline P90 x factor, with >= p_min_baseline_runs of history. '
  'P90 not median, and all-not-any, are the bimodal guards (FIX-969 class-4). '
  'FIX-1338: work is metadata.desired_rows when a body stamps it (all digits, > 0), '
  'else rows written; each element names its recent window''s denominator; rows '
  'with no source count when the pipeline has a job_registry row. '
  'Consumed by canary-check.ts.';

-- ── read-back — RAISE on any miss ───────────────────────────────────────────
DO $$
DECLARE
  v_oid     oid := 'public.check_pipeline_rate_regression(int, int, int, numeric)'::regprocedure;
  v_md5     text;
  v_definer boolean;
  v_config  text[];
  v_missing text[] := '{}';
  v_result  jsonb;
  v_el      jsonb;
  v_n       int;
BEGIN
  SELECT md5(prosrc), prosecdef, proconfig INTO v_md5, v_definer, v_config FROM pg_proc WHERE oid = v_oid;
  IF v_definer IS DISTINCT FROM true THEN
    v_missing := v_missing || 'prosecdef is not true'::text;
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_catalog'] THEN
    v_missing := v_missing || format('proconfig %s (expected {search_path=public, pg_catalog})', v_config);
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    v_missing := v_missing || format('grants anon %s / authenticated %s / service_role %s (expected f / f / t)',
                                     has_function_privilege('anon', v_oid, 'EXECUTE'),
                                     has_function_privilege('authenticated', v_oid, 'EXECUTE'),
                                     has_function_privilege('service_role', v_oid, 'EXECUTE'));
  END IF;

  BEGIN
    v_result := public.check_pipeline_rate_regression();
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '[fix1338] check_pipeline_rate_regression() errored on its first call: % (%)', SQLERRM, SQLSTATE;
  END;
  SELECT e INTO v_el FROM jsonb_array_elements(v_result->'pipelines') e WHERE e->>'pipeline' = 'run_rule_taggers';
  IF v_el->>'denominator' IS DISTINCT FROM 'desired_rows' THEN
    v_missing := v_missing || format('run_rule_taggers denominator %s (expected desired_rows — the premise of FIX-1338)',
                                     COALESCE(v_el->>'denominator', CASE WHEN v_el IS NULL THEN '(no element)' ELSE 'null' END));
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1338] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  v_n := jsonb_array_length(v_result->'pipelines');
  RAISE NOTICE '[fix1338] read-back ok: md5 % (not a dispatcher pin); prosecdef t; proconfig %; grants f / f / t; % pipelines rated, % regressions',
    v_md5, v_config, v_n, jsonb_array_length(v_result->'regressions');
  RAISE NOTICE '[fix1338] run_rule_taggers: verdict % · denominator % · recent_min % · threshold % s/1k (baseline_p90 %, % baseline / % recent runs)',
    v_el->>'verdict', v_el->>'denominator', v_el->>'recent_min_s_per_1k', v_el->>'threshold_s_per_1k',
    v_el->>'baseline_p90_s_per_1k', v_el->>'baseline_runs', v_el->>'recent_runs';
END $$;
