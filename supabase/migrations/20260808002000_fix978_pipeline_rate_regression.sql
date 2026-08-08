-- FIX-978 — the platform's first RATE detector.
--
-- THE GAP. Every one of the seven scheduled detectors on this box answers "is
-- it stale?" or "is it in a bad state?". None answers "is it getting SLOWER?".
-- Playbook D4 signature A: a throughput regression that converges inside the
-- freshness window is invisible by construction. The arc already paid for this
-- once — the canary fired correctly for a stale rollup and could not see the
-- same job's per-row cost regress ~9x in six days (FIX-973). A job that doubles
-- in cost but still lands inside its window stays invisible until it crosses
-- the 6h ceiling, at which point it is a FIX-969 blowout, and blowouts are
-- report-only by design. So the platform can see a regression arrive but never
-- see it coming.
--
-- WHAT THIS READS, AND WHY NOT WHAT THE AUDIT PROPOSED. The FIX-977/978 audit
-- prescribed reading FIX-972's per-run `recipients_done` + `chunk_size`
-- metadata. Measured on prod 2026-08-08 before building: those keys are present
-- on 2 of 1,372 data_sync_log rows in the last 90 days. A detector keyed on
-- them would watch essentially nothing — the same enumeration defect FIX-977
-- exists to remove. The audit's own fallback option (c) is the correct
-- foundation and is genuinely universal: `data_sync_log.rows_inserted +
-- rows_updated` and `completed_at - started_at` are populated for 13 of 13
-- pg_cron-driven pipelines. No new writes are required.
--
-- THE TWO FALSE-POSITIVE SHAPES THIS MUST NOT FIRE ON (decision 6):
--
--   1. LEGITIMATE-ZERO RUNS. A rate is only defined when work EXISTED. Source-
--      gated no-ops are common here, not hypothetical: measured on prod,
--      donation_edge_orphan_sweep did 0 rows on 2 of 2 runs and
--      donor_rollup_refresh on 8 of 17. Dividing a duration by zero work
--      manufactures an infinite rate out of a healthy no-op. Zero-work runs are
--      EXCLUDED from both baseline and recent windows.
--
--   2. ZERO-SPAN WRITERS. `recipient_count_reconcile` writes completed_at =
--      started_at, so its span is 0 and every rate derived from it is infinite.
--      Excluded on the same principle, from the same side of the division.
--
--   3. BIMODAL JOBS (the audit's class-4 lesson: one reading is not a trend).
--      entity-connection-stats-rebuild measured a 184x spread between its two
--      modes with no rising curve. Two defences: the baseline statistic is the
--      P90 of history, NOT the median — so the comparison line sits ABOVE the
--      slow mode rather than between the modes — and escalation requires EVERY
--      run in the recent window to exceed it. A job alternating fast/slow can
--      never satisfy that; a job that has genuinely shifted regime will.
--
-- ESCALATE VS REPORT (FIX-943 cause-vs-consequence split): a SUSTAINED
-- regression — every one of the last N usable runs above P90 x factor, with
-- enough baseline history to mean anything — escalates. Anything intermittent,
-- or any pipeline without enough history, is REPORT ONLY. Single-sample dips
-- never escalate.
--
-- Lives in the check_cron_job_health() family and reports through the same
-- canary surface. No new monitoring tower.

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
    SELECT
      l.pipeline,
      l.started_at,
      EXTRACT(epoch FROM (l.completed_at - l.started_at))::numeric      AS span_s,
      (COALESCE(l.rows_inserted, 0) + COALESCE(l.rows_updated, 0))::numeric AS work
    FROM public.data_sync_log l
    WHERE l.started_at >= v_since
      AND l.status = 'complete'
      AND l.metadata->>'source' = 'pg_cron'
      AND l.completed_at > l.started_at                                    -- shape 2
      AND (COALESCE(l.rows_inserted, 0) + COALESCE(l.rows_updated, 0)) > 0 -- shape 1
  ),
  rated AS (
    SELECT
      pipeline,
      started_at,
      span_s,
      work,
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
  'Consumed by canary-check.ts.';
