-- FIX-977b — harden the pipeline -> cron job correlation, and stop guessing a
-- cadence we do not have.
--
-- Both defects were found by validating the FIX-977 registry against live prod
-- rather than trusting it, and both push thresholds in the dangerous direction
-- (too tight => false escalation => the alert gets muted => the detector stops
-- covering what it enumerates, which is the very failure FIX-977 exists to fix).
--
-- DEFECT 1 — ONE-SIDED SUPPORT LETS A CO-FIRING JOB HIJACK A PIPELINE.
-- Containment matching asked only "what share of the PIPELINE's runs does this
-- job explain?". `financial_entity_totals_refresh` fires Tuesdays at 09:00 and
-- so does jobid 24 (donor-rollup-refresh, `0 9,12 * * *`), so jobid 24 contained
-- 3 of its 7 runs and was kept — collapsing the combined cadence from 168 h to
-- 11.2 h. Measured support on prod, 90-day window:
--
--   pipeline                          jobid  jobname                              %of_pipeline  %of_job
--   financial_entity_totals_refresh   13     financial-entity-totals-incremental      57%        80%
--   financial_entity_totals_refresh   24     donor-rollup-refresh                     43%        11%
--   entity_connections_rebuild        2      rebuild-ec-incremental                   36%        80%
--   entity_connections_rebuild        22     rebuild-ec-incremental-mon               18%        67%
--   refresh_derived_mvs               9      refresh-derived-mvs-daily                83%        97%
--   refresh_derived_mvs               10     refresh-derived-mvs-weekly               12%       100%
--
-- The second column separates a real driver from a coincidental co-firing
-- completely: a job that actually drives a pipeline writes that pipeline on
-- MOST of its own firings (67-100%), while a co-firing neighbour writes it on
-- almost none (11%). So the fix is a TWO-SIDED test — a candidate must explain
-- a meaningful share of the pipeline's runs AND a meaningful share of its own
-- firings. The 25% floor on the job side sits well above jobid 24's 11% and
-- well below jobid 22's 67%.
--
-- Note the genuine multi-driver cases survive, which is the point: EC rebuild
-- keeps jobid 2 + 22 (Mon and Wed => 84 h, the cadence the audit judged it
-- against) and refresh_derived_mvs keeps its daily + weekly pair.
--
-- DEFECT 2 — AN UNCORRELATED PIPELINE WAS GIVEN A FABRICATED THRESHOLD.
-- `recipient_count_reconcile` has one pg_cron row in the window and correlates
-- to no job, so it fell to the 168 h `default` and read ESCALATE at 812 h — but
-- it is written by the MONTHLY reconcile (730 h cadence), where 812 h is 1.1
-- cycles, i.e. fine. Guessing a cadence to alert against is worse than
-- admitting we do not have one. `cadence_source = 'default'` now yields a NULL
-- escalate threshold: the pipeline is still listed and still REPORTS, but can
-- never page. Playbook E5 — a guard that cries wolf gets muted.
--
-- Also rounds cadence_hours: the harmonic sum produced values like
-- 729.99999999999999839400 that would print verbatim into an alert email.

CREATE OR REPLACE FUNCTION public.list_scheduled_rollup_pipelines(
  p_lookback_days int DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, cron, pg_catalog
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(days => p_lookback_days);
  v_out   jsonb;
BEGIN
  IF to_regclass('cron.job_run_details') IS NULL OR to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object('available', false, 'pipelines', '[]'::jsonb);
  END IF;

  WITH runs AS (
    SELECT l.pipeline, l.started_at
    FROM public.data_sync_log l
    WHERE l.metadata->>'source' = 'pg_cron'
      AND l.started_at >= v_since
  ),
  census AS (SELECT DISTINCT pipeline FROM runs),
  pipeline_counts AS (SELECT pipeline, count(*) AS n_pipeline FROM runs GROUP BY 1),
  -- Every firing of every job in the window, for the job side of the support test.
  job_counts AS (
    SELECT jobid, count(*) AS n_job
    FROM cron.job_run_details
    WHERE start_time >= v_since
    GROUP BY 1
  ),
  -- Exact correlation by normalised name (kebab jobname <-> snake pipeline).
  by_name AS (
    SELECT c.pipeline, j.jobid
    FROM census c
    JOIN cron.job j ON replace(j.jobname, '-', '_') = c.pipeline
  ),
  -- Fallback: run-interval containment. A pipeline row written between a
  -- firing's start and end belongs to that firing.
  by_time AS (
    SELECT r.pipeline, d.jobid, count(*) AS n
    FROM runs r
    JOIN cron.job_run_details d
      ON r.started_at BETWEEN d.start_time - interval '90 seconds'
                          AND COALESCE(d.end_time, d.start_time) + interval '90 seconds'
    WHERE d.start_time >= v_since
    GROUP BY 1, 2
  ),
  by_time_kept AS (
    SELECT t.pipeline, t.jobid
    FROM by_time t
    JOIN pipeline_counts pc ON pc.pipeline = t.pipeline
    JOIN job_counts      jc ON jc.jobid    = t.jobid
    -- TWO-SIDED SUPPORT. Pipeline side keeps both halves of a Mon/Wed pair;
    -- job side rejects a neighbour that merely fires at the same hour.
    WHERE t.n::numeric / GREATEST(pc.n_pipeline, 1) >= 0.15
      AND t.n::numeric / GREATEST(jc.n_job,      1) >= 0.25
  ),
  drivers AS (
    SELECT pipeline, jobid FROM by_name
    UNION
    SELECT t.pipeline, t.jobid FROM by_time_kept t
    WHERE NOT EXISTS (SELECT 1 FROM by_name n WHERE n.pipeline = t.pipeline)
  ),
  -- Firing RATES add, so the combined interval is the harmonic sum.
  combined AS (
    SELECT d.pipeline,
           min(d.jobid)                                               AS jobid,
           string_agg(DISTINCT j.jobname,  ', ' ORDER BY j.jobname)   AS jobname,
           string_agg(DISTINCT j.schedule, ', ' ORDER BY j.schedule)  AS schedule,
           bool_or(j.active)                                          AS active,
           CASE
             WHEN count(*) FILTER (WHERE public.cron_cadence_hours(j.schedule) IS NULL) > 0
               THEN NULL
             ELSE ROUND((1.0 / NULLIF(sum(1.0 / public.cron_cadence_hours(j.schedule)), 0))::numeric, 2)
           END                                                        AS declared_h
    FROM drivers d
    JOIN cron.job j ON j.jobid = d.jobid
    GROUP BY d.pipeline
  ),
  gaps AS (
    SELECT pipeline,
           EXTRACT(epoch FROM (started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at))) / 3600.0 AS gap_h
    FROM runs
  ),
  observed AS (
    SELECT pipeline, percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_h)::numeric AS median_gap_h
    FROM gaps WHERE gap_h IS NOT NULL AND gap_h > 0 GROUP BY 1
  ),
  resolved AS (
    SELECT c.pipeline, k.jobid, k.jobname, k.schedule, k.active, k.declared_h, o.median_gap_h
    FROM census c
    LEFT JOIN combined k ON k.pipeline = c.pipeline
    LEFT JOIN observed o ON o.pipeline = c.pipeline
  ),
  final AS (
    SELECT
      pipeline, jobid, jobname, schedule, active,
      COALESCE(declared_h, ROUND(median_gap_h, 2), 168.0) AS cadence_hours,
      CASE
        WHEN declared_h   IS NOT NULL THEN 'cron_schedule'
        WHEN median_gap_h IS NOT NULL THEN 'observed_median'
        ELSE 'default'
      END AS cadence_source
    FROM resolved
  )
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'pipeline'), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
             'pipeline',             pipeline,
             'jobid',                jobid,
             'jobname',              jobname,
             'schedule',             schedule,
             'active',               COALESCE(active, true),
             'cadence_hours',        cadence_hours,
             'cadence_source',       cadence_source,
             'report_after_hours',   ROUND(cadence_hours * 1.5, 1),
             -- A cadence we GUESSED is not one we may page on. 'default' means
             -- the pipeline correlated to no job and has too little history to
             -- observe a gap — it stays listed and reported, never escalated.
             'escalate_after_hours',
               CASE WHEN cadence_source = 'default' THEN NULL
                    ELSE ROUND(cadence_hours * 2.5, 1) END
           ) AS t
    FROM final
  ) s;

  RETURN jsonb_build_object(
    'available',      true,
    'lookback_days',  p_lookback_days,
    'pipeline_count', jsonb_array_length(v_out),
    'pipelines',      v_out
  );
END;
$$;

REVOKE ALL ON FUNCTION public.list_scheduled_rollup_pipelines(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_scheduled_rollup_pipelines(int) TO service_role;
