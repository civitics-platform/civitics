-- FIX-1135 + FIX-1059 + FIX-1011 — make the freshness registry's verdicts
-- derivable instead of merely computed.
--
-- Three defects, one mechanism. All three were found by reading prod rather
-- than the bullets, and two of the bullets turned out to name the wrong cause.
--
-- ============================================================================
-- DEFECT 1 (FIX-1135) — THE CADENCE WAS MEASURED OVER THE WRONG ROWS.
-- ============================================================================
-- The bullet says the 0.25h cadence on `entity_connections_rebuild` is
-- "derived from the firing schedule". It is not: cron_cadence_hours() already
-- returns NULL for `*/15`, so declared_h is NULL and the value came from the
-- OBSERVED-MEDIAN fallback. ec-crawl writes one data_sync_log row per crawl
-- UNIT every 15 minutes, and the old `observed` CTE took the median gap over
-- every pg_cron-sourced row of ANY status. Measured on prod 2026-09-02:
--
--   entity_connections_rebuild      240 'partial' unit rows,  17 'complete'
--   financial_entity_totals_refresh  42 'partial' unit rows,   6 'complete'
--
-- So the median gap was the UNIT interval (0.25h / 0.50h), escalate_after
-- landed at 0.6h / 1.3h, and check_rollup_freshness judges the last row that
-- reached 'complete' — a CYCLE CLOSURE, which arrives every ~14h. Every single
-- run escalated. Playbook E5: a guard that cries wolf gets muted.
--
-- The fix is not schedule parsing. The cadence must be measured over the same
-- rows the freshness verdict is judged on: status = 'complete' only. Measured
-- on prod over the last 90 days, complete-row gaps for ec-crawl since its job's
-- first firing: n=10, median 14.12h, min 8.0, max 31.0.
--
-- Two further hazards the same change has to survive, both measured:
--
--   (a) SAME-RUN ROWS. `nightly_cron` writes ~4 'complete' rows per night,
--       seconds to minutes apart (p25 0.01h, p50 0.08h, p75 22.94h). A median
--       over raw closure gaps reproduces exactly the defect above at 0.08h. A
--       gap under 30 minutes is two rows from the SAME run, not two runs, so
--       gaps below 0.5h are excluded before the median. nightly_cron then
--       measures 23.63h over 101 usable gaps.
--
--   (b) A DRIVER THAT CHANGED. `financial_entity_totals_refresh` has 6 closures
--       in the window, but all of them predate fe-crawl (jobid 46, first firing
--       2026-09-01 23:00) — they belong to the retired weekly jobid 13. Their
--       median is 168h, which is not fe-crawl's cadence; it is the cadence of a
--       driver that no longer exists. Closures are therefore anchored to the
--       first observed firing of the pipeline's correlated ACTIVE job. fe-crawl
--       has closed no cycle yet, so it gets NO derived cadence and cannot
--       escalate — it still reports. Admitting we do not have a cadence beats
--       inventing one (the FIX-977b rule, applied to a second shape).
--
--   (c) LOW SUPPORT. A one-shot backfill with two rows an hour apart would
--       otherwise get a 1h cadence and page forever. An observed median needs
--       >= 4 usable gaps before it may escalate; below that it is still
--       reported, never paged.
--
-- ============================================================================
-- DEFECT 2 (FIX-1059) — AN UNSCHEDULED JOB'S PIPELINE STAYED IN THE CENSUS.
-- ============================================================================
-- There was no retired set, no ignore list and no anti-join against cron.job.
-- `recipient_count_reconcile`'s job (`ec-recipient-count-reconcile`) was
-- unscheduled by FIX-736 on 2026-07-05; its single data_sync_log row keeps it
-- in the census for 90 days at cadence_source='default'. It only failed to page
-- because FIX-977b had already NULLed the 'default' threshold — the retirement
-- itself was never recorded anywhere.
--
-- Two additions. `public.rollup_watch_overrides` is a DECLARATION table: a row
-- says what a human decided about a pipeline (retired, held, or a cadence we
-- assert), never what was measured. And every element now carries
-- `has_active_job`, with a top-level `orphans` array listing pg_cron-driven
-- pipelines that have rows, no ACTIVE correlated job and no override row.
-- Orphans REPORT; they never escalate. Measured on prod the orphan set is
-- exactly {entity_connection_stats_rebuild} (jobid 16, paused when ECS moved
-- to the bounded crawl arm) once recipient_count_reconcile is declared.
--
-- Retired and held pipelines STAY in pipelines[] with both thresholds NULL.
-- Removing them would narrow the watch list, which is the FIX-977 defect
-- wearing a different hat, and detector-coverage.test.ts pins registry >= census.
--
-- CONVENTION (see packages/db/CLAUDE.md): any cron.unschedule or alter_job
-- deactivation of a job whose procedure writes data_sync_log lands a
-- rollup_watch_overrides row in the SAME migration.
--
-- ============================================================================
-- DEFECT 3 (FIX-1011) — THE CENSUS FILTER EXCLUDED EVERY NON-pg_cron PIPELINE.
-- ============================================================================
-- The census was `metadata->>'source' = 'pg_cron'`, so 36 of the 49 pipelines
-- writing data_sync_log had no freshness watch at all. The census is now every
-- DISTINCT pipeline in the lookback regardless of source; only the pg_cron
-- CORRELATION still filters on source, because that is the only thing a
-- cron.job row can explain.
--
-- The source vocabulary, read from prod rather than assumed (the bullet
-- expected a 'github_actions' literal; there is none):
--
--   metadata->>'source'   rows    pipelines
--   'pg_cron'             628     13
--   'pg_cron/backfill'      4      1        <- exact-match dropped this one
--   NULL                 1348     35
--
-- GHA-driven rows carry no `source` at all, but they DO carry `github_workflow`
-- / `github_run_id`, so `driver` is derived from that instead: 'pg_cron' |
-- 'github_actions' | 'unknown'. Widening the census from 13 to 49 immediately
-- surfaced three weekly rollups that had not succeeded in over four weeks
-- (donor_party_rollup_refresh, agency_staffing_rollup_refresh,
-- treemap_individuals_global_refresh) — filed separately.

-- ---------------------------------------------------------------------------
-- The declaration table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rollup_watch_overrides (
  pipeline      text PRIMARY KEY,
  -- An ASSERTED cadence. Wins over the cron schedule and the observed median.
  cadence_hours numeric,
  -- Set => the pipeline is retired. Listed, never reported, never escalated.
  retired_at    timestamptz,
  -- Set => deliberately paused. Same treatment as retired, different reason.
  held_since    timestamptz,
  hold_reason   text,
  note          text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Retired and held are different declarations about different futures.
  CONSTRAINT rollup_watch_overrides_not_both
    CHECK (retired_at IS NULL OR held_since IS NULL),
  CONSTRAINT rollup_watch_overrides_hold_has_reason
    CHECK (held_since IS NULL OR hold_reason IS NOT NULL),
  CONSTRAINT rollup_watch_overrides_cadence_positive
    CHECK (cadence_hours IS NULL OR cadence_hours > 0)
);

COMMENT ON TABLE public.rollup_watch_overrides IS
  'FIX-1059 — human DECLARATIONS about watched pipelines (retired / held / an '
  'asserted cadence). Rows are decisions, never measurements. Read only by '
  'list_scheduled_rollup_pipelines(). Convention: unscheduling or pausing a '
  'pg_cron job whose procedure writes data_sync_log lands a row here in the '
  'same migration.';

ALTER TABLE public.rollup_watch_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rollup_watch_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rollup_watch_overrides TO service_role;

-- ---------------------------------------------------------------------------
-- Seeds. Verified against prod 2026-09-02 before writing.
--
-- recipient_count_reconcile — RETIRED. FIX-736 made recipient_count FR-derived
-- and folded the sweep into reconcile_financial_entity_totals() Sweep C; the
-- `ec-recipient-count-reconcile` job was unscheduled on 2026-07-05 and is
-- absent from cron.job today (confirmed: the pipeline correlates to jobid NULL).
--
-- fec_bulk — NO HOLD SEEDED. The bullet assumed FIX-998's hold was still in
-- force; it is not. Prod shows fec_bulk completing under the nightly-sync GHA
-- workflow on 2026-08-19, 08-23, 08-25, 08-30 and 09-01 (github_run_id
-- 33454338809 most recently). A hold row would have declared a fiction.
-- ---------------------------------------------------------------------------
INSERT INTO public.rollup_watch_overrides (pipeline, retired_at, note)
VALUES (
  'recipient_count_reconcile',
  timestamptz '2026-07-05 00:00:00+00',
  'FIX-736 retired the EC-based recipient_count sweep: recipient_count is now '
  'FR-derived inside refresh_financial_entity_totals_incremental, and the '
  'orphan pass lives in reconcile_financial_entity_totals() Sweep C. The '
  'ec-recipient-count-reconcile pg_cron job was unscheduled the same day. '
  'Declared here by FIX-1059 so the registry stops carrying it as live.'
)
ON CONFLICT (pipeline) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The registry.
-- ---------------------------------------------------------------------------
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
  v_since   timestamptz := now() - make_interval(days => p_lookback_days);
  -- A gap shorter than this is two rows from the SAME run, not two runs.
  -- Nothing on this instance is scheduled tighter than every 15 minutes, and
  -- the crawls' 15-minute rows are 'partial' and never counted as closures.
  v_same_run_floor_h numeric := 0.5;
  -- Minimum usable gaps before an OBSERVED median may be paged on.
  v_min_support      int     := 4;
  v_out     jsonb;
  v_orphans jsonb;
BEGIN
  IF to_regclass('cron.job_run_details') IS NULL OR to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object('available', false, 'pipelines', '[]'::jsonb, 'orphans', '[]'::jsonb);
  END IF;

  RETURN (
    WITH all_runs AS (
      SELECT l.pipeline, l.started_at, l.status, l.metadata
      FROM public.data_sync_log l
      WHERE l.started_at >= v_since
    ),
    -- FIX-1011 — the census no longer filters on source.
    census AS (SELECT DISTINCT pipeline FROM all_runs),
    last_row AS (SELECT pipeline, max(started_at) AS last_row_at FROM all_runs GROUP BY 1),
    -- FIX-1011 — driver from what the rows actually carry. GHA rows have no
    -- `source`; they carry github_workflow/github_run_id.
    drv AS (
      SELECT pipeline,
             CASE
               WHEN bool_or(metadata->>'source' LIKE 'pg_cron%') THEN 'pg_cron'
               WHEN bool_or(metadata ? 'github_workflow' OR metadata ? 'github_run_id') THEN 'github_actions'
               ELSE 'unknown'
             END AS driver
      FROM all_runs GROUP BY 1
    ),
    -- Correlation still sees ONLY pg_cron-sourced rows: a cron.job row cannot
    -- explain a firing it did not make. LIKE, not =, so 'pg_cron/backfill'
    -- (agency_staffing_rollup_refresh) is no longer silently dropped.
    runs AS (SELECT pipeline, started_at FROM all_runs WHERE metadata->>'source' LIKE 'pg_cron%'),
    pipeline_counts AS (SELECT pipeline, count(*) AS n_pipeline FROM runs GROUP BY 1),
    job_counts AS (
      SELECT jobid, count(*) AS n_job FROM cron.job_run_details
      WHERE start_time >= v_since GROUP BY 1
    ),
    by_name AS (
      SELECT c.pipeline, j.jobid
      FROM census c JOIN cron.job j ON replace(j.jobname, '-', '_') = c.pipeline
    ),
    by_time AS (
      SELECT r.pipeline, d.jobid, count(*) AS n
      FROM runs r
      JOIN cron.job_run_details d
        ON r.started_at BETWEEN d.start_time - interval '90 seconds'
                            AND COALESCE(d.end_time, d.start_time) + interval '90 seconds'
      WHERE d.start_time >= v_since
      GROUP BY 1, 2
    ),
    -- FIX-977b's two-sided support test, unchanged.
    by_time_kept AS (
      SELECT t.pipeline, t.jobid
      FROM by_time t
      JOIN pipeline_counts pc ON pc.pipeline = t.pipeline
      JOIN job_counts      jc ON jc.jobid    = t.jobid
      WHERE t.n::numeric / GREATEST(pc.n_pipeline, 1) >= 0.15
        AND t.n::numeric / GREATEST(jc.n_job,      1) >= 0.25
    ),
    drivers AS (
      SELECT pipeline, jobid FROM by_name
      UNION
      SELECT t.pipeline, t.jobid FROM by_time_kept t
      WHERE NOT EXISTS (SELECT 1 FROM by_name n WHERE n.pipeline = t.pipeline)
    ),
    combined AS (
      SELECT d.pipeline,
             min(d.jobid)                                               AS jobid,
             string_agg(DISTINCT j.jobname,  ', ' ORDER BY j.jobname)   AS jobname,
             string_agg(DISTINCT j.schedule, ', ' ORDER BY j.schedule)  AS schedule,
             bool_or(j.active)                                          AS has_active_job,
             CASE
               WHEN count(*) FILTER (WHERE public.cron_cadence_hours(j.schedule) IS NULL) > 0
                 THEN NULL
               ELSE ROUND((1.0 / NULLIF(sum(1.0 / public.cron_cadence_hours(j.schedule)), 0))::numeric, 2)
             END                                                        AS declared_h
      FROM drivers d JOIN cron.job j ON j.jobid = d.jobid
      GROUP BY d.pipeline
    ),
    -- FIX-1135(b) — the era boundary. Closures before the correlated ACTIVE
    -- job's first observed firing belong to a driver that no longer runs.
    driver_start AS (
      SELECT d.pipeline, min(rd.start_time) AS first_firing
      FROM drivers d
      JOIN cron.job j ON j.jobid = d.jobid AND j.active
      JOIN cron.job_run_details rd ON rd.jobid = d.jobid
      GROUP BY 1
    ),
    -- FIX-1135 — the cadence is measured over CYCLE CLOSURES, the same rows
    -- check_rollup_freshness judges. Unanchored count first, for report scope.
    closures_any AS (
      SELECT pipeline, count(*) AS n_closures
      FROM all_runs WHERE status = 'complete' GROUP BY 1
    ),
    closures AS (
      SELECT a.pipeline, a.started_at
      FROM all_runs a
      LEFT JOIN driver_start ds ON ds.pipeline = a.pipeline
      WHERE a.status = 'complete'
        AND (ds.first_firing IS NULL OR a.started_at >= ds.first_firing)
    ),
    gaps AS (
      SELECT pipeline,
             EXTRACT(epoch FROM (started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at))) / 3600.0 AS gap_h
      FROM closures
    ),
    observed AS (
      SELECT pipeline, count(*) AS n_gaps,
             ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_h)::numeric, 2) AS median_gap_h
      FROM gaps
      -- FIX-1135(a) — same-run rows are not a cadence.
      WHERE gap_h >= v_same_run_floor_h
      GROUP BY 1
    ),
    resolved AS (
      SELECT c.pipeline,
             dv.driver,
             k.jobid, k.jobname, k.schedule, k.has_active_job, k.declared_h,
             o.median_gap_h,
             COALESCE(o.n_gaps, 0)          AS cadence_support,
             COALESCE(ca.n_closures, 0) > 0 AS has_closures,
             lr.last_row_at,
             ov.cadence_hours               AS override_cadence_h,
             (ov.retired_at IS NOT NULL)    AS retired,
             (ov.held_since IS NOT NULL)    AS held,
             ov.hold_reason,
             (ov.pipeline IS NOT NULL)      AS has_override
      FROM census c
      JOIN      drv          dv ON dv.pipeline = c.pipeline
      LEFT JOIN combined     k  ON k.pipeline  = c.pipeline
      LEFT JOIN observed     o  ON o.pipeline  = c.pipeline
      LEFT JOIN closures_any ca ON ca.pipeline = c.pipeline
      LEFT JOIN last_row     lr ON lr.pipeline = c.pipeline
      LEFT JOIN public.rollup_watch_overrides ov ON ov.pipeline = c.pipeline
    ),
    final AS (
      SELECT r.*,
             COALESCE(r.override_cadence_h, r.declared_h, r.median_gap_h, 168.0) AS cadence_hours,
             CASE
               WHEN r.override_cadence_h IS NOT NULL THEN 'override'
               WHEN r.declared_h         IS NOT NULL THEN 'cron_schedule'
               WHEN r.median_gap_h       IS NOT NULL THEN 'observed_median'
               ELSE 'default'
             END AS cadence_source,
             -- FIX-1059 — the class that paged for six weeks: pg_cron rows, no
             -- ACTIVE job, nobody declared it. Reported, never escalated.
             -- Scoped to pg_cron because "no cron job" is not a defect for a
             -- GHA-driven pipeline.
             (r.driver = 'pg_cron'
              AND r.has_active_job IS NOT TRUE
              AND NOT r.has_override) AS orphan
      FROM resolved r
    ),
    elems AS (
      SELECT jsonb_build_object(
               'pipeline',        pipeline,
               'driver',          driver,
               'jobid',           jobid,
               'jobname',         jobname,
               'schedule',        schedule,
               -- Kept for back-compat with readers of the FIX-977 shape.
               'active',          COALESCE(has_active_job, true),
               'has_active_job',  has_active_job,
               'orphan',          orphan,
               'retired',         retired IS TRUE,
               'held',            held IS TRUE,
               'hold_reason',     hold_reason,
               'has_closures',    has_closures,
               'cadence_hours',   cadence_hours,
               'cadence_source',  cadence_source,
               'cadence_support', cadence_support,
               -- No closure in the window => "hours since last complete" is
               -- undefined, so neither threshold means anything. The pipeline
               -- stays LISTED with has_closures=false rather than being dropped.
               'report_after_hours',
                 CASE WHEN retired IS TRUE OR held IS TRUE OR NOT has_closures THEN NULL
                      ELSE ROUND(cadence_hours * 1.5, 1) END,
               'escalate_after_hours',
                 CASE
                   WHEN retired IS TRUE OR held IS TRUE      THEN NULL
                   WHEN NOT has_closures                     THEN NULL
                   WHEN cadence_source = 'default'           THEN NULL
                   WHEN cadence_source = 'observed_median'
                        AND cadence_support < v_min_support  THEN NULL
                   WHEN orphan                               THEN NULL
                   ELSE ROUND(cadence_hours * 2.5, 1)
                 END
             ) AS t,
             pipeline, orphan, jobid, jobname, schedule, last_row_at
      FROM final
    )
    SELECT jsonb_build_object(
      'available',      true,
      'lookback_days',  p_lookback_days,
      'pipeline_count', (SELECT count(*) FROM elems),
      'pipelines',      COALESCE((SELECT jsonb_agg(t ORDER BY pipeline) FROM elems), '[]'::jsonb),
      'orphans',        COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'pipeline',    pipeline,
                 'jobid',       jobid,
                 'jobname',     jobname,
                 'schedule',    schedule,
                 'last_row_at', last_row_at
               ) ORDER BY pipeline)
        FROM elems WHERE orphan), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.list_scheduled_rollup_pipelines(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_scheduled_rollup_pipelines(int) TO service_role;

COMMENT ON FUNCTION public.list_scheduled_rollup_pipelines(int) IS
  'FIX-977/977b + FIX-1135/1059/1011 — the DERIVED rollup watch registry. '
  'Census is every pipeline in data_sync_log over the lookback regardless of '
  'source; cadence is measured over cycle CLOSURES (status=complete) anchored '
  'to the correlated active job''s first firing, with a 0.5h same-run floor and '
  'a 4-gap support floor before an observed median may escalate. Retired/held '
  '(rollup_watch_overrides) and orphaned (pg_cron rows, no active job) '
  'pipelines stay LISTED with NULL thresholds. Consumed by canary-check.ts.';
