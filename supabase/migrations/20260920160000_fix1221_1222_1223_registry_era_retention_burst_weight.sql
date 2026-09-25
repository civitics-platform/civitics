-- FIX-1221 + FIX-1223 + FIX-1222 (cc-156) — cron.job_run_details gets a
-- retention job, in the order cc-153 stated: first the one reader that looked
-- past it stops needing the purged rows, then the purge.
--   1. list_scheduled_rollup_pipelines(): the FIX-1135 era boundary comes from
--      public.cron_job_first_seen, correlation reads both of its sides over the
--      retention window, and the correlation join stops being a nested loop
--      (FIX-1221, FIX-1223).
--   2. check_cron_job_health(): the startup-timeout burst weighs each failure
--      at the */2 cadence it was sized on (FIX-1222).
--   3. cron-job-run-details-retention: daily 01:51 UTC, 42 days, and its
--      cron_job_budget row (FIX-1221).
--
-- Design of record: the cc-156 prompt, reading cc-153 reads 2/3/4/8.
--
-- ── 1a. THE ERA BOUNDARY (FIX-1221) ─────────────────────────────────────────
--
-- driver_start took min(start_time) over ALL of cron.job_run_details for each
-- pipeline's correlated active job. A purge would move every job older than the
-- retention to the retention edge. It now takes the EARLIER of the job's
-- cron_job_first_seen row (FIX-1150; one row per jobname, never deleted) and its
-- oldest RETAINED firing. Read on prod 2026-09-25 03:1x UTC: every one of the
-- 42 cron.job rows has a ledger row; 36 equal min(start_time), 2 are earlier
-- (created before their first firing: group-donor-rollup-refresh 09-07 23:55
-- vs 09-09 03:10, platform-counts-daily 09-05 01:30 vs 03:53) and 4 are later
-- (recorded by the canary after the first firing; none is a registry driver).
-- Of the 15 pipelines with an era boundary, 13 keep it to the microsecond and
-- the 2 above move EARLIER, onto their ledger row; both are cron_schedule
-- cadences and no closure falls in the moved interval, so the output does not
-- change (below). LEAST, not the ledger alone: the canary records a new job at
-- its next run, which can be hours after the first firing, and the oldest
-- retained firing is the better sighting until it ages out. A jobname the
-- ledger lacks keeps its oldest retained firing. A job unscheduled and
-- re-created under the same name keeps its first ledger row, so its boundary
-- is the older job's; none exists today.
--
-- ── 1b. CORRELATION OVER THE RETENTION, AND NOT AS A NESTED LOOP (FIX-1221,
--        FIX-1223) ──────────────────────────────────────────────────────────
--
-- job_counts and by_time read job_run_details over the whole 90-day lookback,
-- and pipeline_counts counted runs over the same 90 days. Both sides of the
-- FIX-977b two-sided support test now read v_corr_since = the later of the
-- lookback and 42 days, so the ratios compare like with like before and after
-- a purge. The census, closures and cadence still read data_sync_log over the
-- whole lookback: the retention does not touch them.
--
-- FIX-1223 — while reading this function, cc-156 found the canary has not been
-- able to call it since 2026-09-08 09:11 UTC. Every run logged "rollup registry
-- query failed (non-fatal, falling back to the 1-entry literal): canceling
-- statement due to statement timeout" (PostgREST's authenticator carries
-- statement_timeout 8s). EXPLAIN ANALYZE on prod 2026-09-25 03:11 UTC: 35,709 ms,
-- 3.27M shared-buffer hits, nearly all in by_time. Its only join condition was
-- a range (a run's started_at inside a firing's [start - 90 s, end + 90 s]),
-- which can only nested-loop: 2,353 pg_cron runs x 64k firings = 151M
-- comparisons. The window alone does not fix it: the crawl arms' runs are all
-- recent, and the prompt's form (a 42-day window, same join) measured 89.6 s.
--
-- THE JOIN. Each firing lists the minutes its window touches (firing_minutes,
-- MATERIALIZED: 268k rows from 64k firings on prod); a run meets it only
-- through its own minute, so each (run, firing) pair meets at most once, and
-- the same BETWEEN still decides. The planner estimates `runs` at 1 row (a
-- jsonb LIKE through a CTE, no statistics), and with the expansion materialized
-- it chose the hash join by a close cost margin (447-475 ms). A flip back would
-- be silent and would cost a minute, so the function carries
-- SET enable_nestloop TO 'off'. That is a planner setting, read when each query
-- is planned, so a routine-level SET is honoured (unlike a statement_timeout,
-- FIX-1128). The one nested loop left is generate_series's own LATERAL, which
-- has no alternative. Measured on prod as an inline read of this exact body,
-- 2026-09-25 03:28 UTC: 422 / 427 / 431 ms.
--
-- EQUIVALENCE, on prod, the same minute (03:28-03:30 UTC): the old body and
-- this one returned byte-identical JSON (52 pipelines, the same drivers, the
-- same orphans), and this one with cron.job_run_details cut to 42 days
-- returned the same JSON again. Restoring the registry changes what the
-- canary reads from a 1-entry literal to 52 watches: on the 03:1x state that
-- escalates 0 pipelines and reports 6.
--
-- Rule 34: the signature, STABLE, SECURITY DEFINER and the search_path SET are
-- restated from prod's pg_get_functiondef (224 lines, identical to 20260903000000
-- and to local); enable_nestloop is the one SET added. The grants and the
-- COMMENT are re-asserted below.
--
-- ── 2. THE BURST AT THE */2 CADENCE (FIX-1222) ──────────────────────────────
--
-- The burst counted startup-timeout RUNS per hourly bucket (>= 10), sized when
-- both */2 watchdogs failed on the same even minutes. The */1 box-health-probe
-- samples twice as often. Each failure now weighs least(1, interval / 2), the
-- interval being the job's median firing gap FIX-1220's `cadence` CTE already
-- computes (COALESCE 2). v_burst_m stays 10.
--
-- REPLAYED on prod 2026-09-25 03:17 UTC over all retained history (from
-- 06-29), each bucket judged with the interval the canary would have computed
-- an hour after it (the median gap over the trailing 52 h): 64 buckets reach 10
-- on 13 days under both rules, and the weighted count equals the run count in
-- every one (no failing job had a median interval under 2 minutes; the probe
-- has had no startup timeout). 64 of 64 identical. A full stall now reaches 10
-- in about 6.7 minutes instead of 10.
--
-- +15 / -0 against prod's pg_get_functiondef (read 03:1x UTC, identical to
-- 20260920150000's body). The threshold line stays and the weighted one is
-- ADDED beside it: weighted_n <= n, so `n >= 10 AND weighted_n >= 10` is
-- exactly `weighted_n >= 10`. Each burst element gains `weighted_count`; the
-- tiers' own keys are unchanged. STABLE, SECURITY DEFINER and the one
-- search_path SET are restated; the grants are re-asserted and the COMMENT
-- updated.
--
-- ── 3. THE RETENTION JOB (FIX-1221) ─────────────────────────────────────────
--
-- 42 DAYS, both bounds read on prod 2026-09-25 03:1x UTC:
--   Lower. The registry's weekly pipelines on an OBSERVED cadence need
--   v_min_support = 4 gaps (5 closures) to escalate. Closures per trailing
--   window (data_sync_log, complete, gaps >= 0.5 h): 30 d -> 4-5, 35 d -> 5,
--   42 d -> 6 for the 14 observed ~168 h weeklies (13 GHA and
--   contract_flow_rollups_rebuild); irs990 (190 h) has 4 at 35 d and 5 at 42 d.
--   42 is the smallest N where every one of them has 4 gaps, irs990 included,
--   and where a weekly one keeps 4 after one lost firing. The four pg_cron
--   weeklies hold 1-3 closures in any window up to 45 d, but they are on a
--   cron_schedule cadence, where support is not tested. (After 1a/1b the
--   closures come from data_sync_log over the whole lookback, so the table's
--   retention no longer feeds them at all; the bound now governs the
--   correlation evidence and stays as the stated floor.)
--   Upper. The probe's one scan of the table (record_box_health) measured
--   20.2 ms over 65,290 rows (3 runs, 1,288 buffers). At ~3,050 rows/day the
--   table settles near 128k rows at 42 d: ~40 ms for the probe, and ~46 ms for
--   prod_op_gate (d)'s one scan (23.3-26.2 ms at 64.9k, cc-153). Under ~50 ms.
--   Every other live reader of the table reads <= 14 days (cc-153 read 4:
--   check_cron_job_escalations 336 h, prod_op_gate (b) 14 d, receipts 14 d,
--   check_cron_job_health 52 h, get_ec_crawl_health 7 d, record_box_health
--   1 d), and check_cron_job_health's missing_daily "no run row ever" arm
--   exempts only a job first seen < 26 h ago, which a 42-day purge cannot reach.
--
-- THE FIRST PURGE: 986 rows older than 42 days on 09-25 03:15 UTC, far under
-- the 200k batching line, so one statement. Autovacuum owns the dead tuples
-- (rule 61): at ~3k a day against a trigger of 50 + 0.2 x reltuples it
-- vacuums the table about weekly, and pg_cron's inserts reuse the space.
--
-- 01:51 UTC. cc-153 read 8 named 01:50; this is the odd minute beside it.
-- FIX-1141, FIX-1129 and FIX-1146 each refuse an even minute in their guard,
-- because both */2 watchdogs (cron-job-budget-watchdog, derived-mvs-unit-
-- watchdog) fire on every even minute; 51 also clears ec-crawl (*/15) and
-- fe-crawl (*/30). Neighbours on prod's cron.job 03:1x UTC: officials-vacuum-
-- analyze Mon 01:30 (3 s), dpr-vacuum-analyze Sun/Wed 02:00 (4 s),
-- refresh-derived-mvs-weekly Tue 00:47 (done by ~01:10). Outside the
-- 05:45-09:00 blackout and after the longest nightly (21:00 dispatch, ends by
-- ~22:46). Inside the 18-05 UTC quiet band.
--
-- The job is UNGUARDED (its command does not reach prod_session_state()), like
-- abuse-events-retention, the precedent: a ~1 s delete of rows nothing reads.
-- Its cron_job_budget row is 300 s (rule 120), far under the 9,836 s a budget
-- may reach below the postgres role's 3 h ceiling (FIX-1185). No index: the
-- table's owner is supabase_admin, and postgres holds DELETE but cannot index.
--
-- rule 109 / FIX-1128: no statement_timeout anywhere; the job's command is ONE
-- statement; neither function COMMITs.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. list_scheduled_rollup_pipelines() — FIX-1221 + FIX-1223. Prod's body with the era
-- boundary, the correlation window and the join changed; enable_nestloop is the one SET added.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.list_scheduled_rollup_pipelines(p_lookback_days integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'cron', 'pg_catalog'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE
  v_since   timestamptz := now() - make_interval(days => p_lookback_days);
  -- FIX-1221 — cron.job_run_details keeps 42 days (cron-job-run-details-retention,
  -- scheduled below). Correlation reads BOTH of its sides over the same window,
  -- so the two-sided support test compares like with like before and after a
  -- purge; the census, the closures and the cadence still read data_sync_log
  -- over the whole lookback.
  v_corr_since timestamptz := GREATEST(v_since, now() - make_interval(days => 42));
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
    runs AS (SELECT pipeline, started_at FROM all_runs WHERE metadata->>'source' LIKE 'pg_cron%'
               AND started_at >= v_corr_since),
    pipeline_counts AS (SELECT pipeline, count(*) AS n_pipeline FROM runs GROUP BY 1),
    job_counts AS (
      SELECT jobid, count(*) AS n_job FROM cron.job_run_details
      WHERE start_time >= v_corr_since GROUP BY 1
    ),
    by_name AS (
      SELECT c.pipeline, j.jobid
      FROM census c JOIN cron.job j ON replace(j.jobname, '-', '_') = c.pipeline
    ),
    -- FIX-1221 — the same match as before (a run inside a firing's
    -- [start - 90 s, end + 90 s]), found through the minute each could share.
    -- A range predicate alone can only nested-loop, and it did: every pg_cron
    -- run against every firing, 3.27M buffer hits and 35.7 s on prod
    -- (2026-09-25), past the canary's 8 s role timeout on every run since
    -- 09-08. A firing lists each minute its window touches; a run matches
    -- only through its own minute, so each (run, firing) pair meets at most
    -- once and the exact BETWEEN still decides.
    firings AS MATERIALIZED (
      SELECT d.jobid,
             d.start_time - interval '90 seconds'                       AS lo,
             COALESCE(d.end_time, d.start_time) + interval '90 seconds' AS hi
      FROM cron.job_run_details d
      WHERE d.start_time >= v_corr_since
    ),
    firing_minutes AS MATERIALIZED (
      SELECT f.jobid, f.lo, f.hi, m.minute
      FROM firings f
      CROSS JOIN LATERAL generate_series(date_trunc('minute', f.lo), date_trunc('minute', f.hi),
                                         interval '1 minute') AS m(minute)
    ),
    by_time AS (
      SELECT r.pipeline, d.jobid, count(*) AS n
      FROM runs r
      JOIN firing_minutes d
        ON d.minute = date_trunc('minute', r.started_at)
       AND r.started_at BETWEEN d.lo AND d.hi
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
    -- FIX-1221 — the first sighting outlives the run rows: the earlier of the
    -- job's cron_job_first_seen row (FIX-1150, kept forever) and its oldest
    -- RETAINED firing. On 2026-09-25 every active registry driver had both, and
    -- the ledger was equal to or earlier than the first firing for every one,
    -- so the boundary is what it was; after a purge it no longer moves to the
    -- retention edge. A job with no ledger row (created since the canary last
    -- ran record_cron_jobs_seen) keeps its oldest retained firing.
    driver_start AS (
      SELECT d.pipeline,
             LEAST(min(fs.first_seen_at), min(rd.start_time)) AS first_firing
      FROM drivers d
      JOIN cron.job j ON j.jobid = d.jobid AND j.active
      LEFT JOIN public.cron_job_first_seen fs ON fs.jobname = j.jobname
      LEFT JOIN cron.job_run_details rd ON rd.jobid = d.jobid
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
$function$;

REVOKE ALL ON FUNCTION public.list_scheduled_rollup_pipelines(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_scheduled_rollup_pipelines(int) TO service_role;

COMMENT ON FUNCTION public.list_scheduled_rollup_pipelines(int) IS
  'FIX-977/977b + FIX-1135/1059/1011 + FIX-1221/1223 — the DERIVED rollup watch registry. '
  'Census is every pipeline in data_sync_log over the lookback regardless of '
  'source; cadence is measured over cycle CLOSURES (status=complete) anchored '
  'to the correlated active job''s first sighting (the earlier of its cron_job_first_seen '
  'row and its oldest retained firing, so the 42-day cron.job_run_details retention '
  'does not move it), with a 0.5h same-run floor and '
  'a 4-gap support floor before an observed median may escalate. Correlation reads '
  'both sides over the 42-day retention and joins through a shared minute (enable_nestloop off). '
  'Retired/held (rollup_watch_overrides) and orphaned (pg_cron rows, no active job) '
  'pipelines stay LISTED with NULL thresholds. Consumed by canary-check.ts.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. check_cron_job_health() — FIX-1222. Prod's body; every change an ADDED line.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_cron_job_health(p_lookback_hours integer DEFAULT 26)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'cron', 'pg_catalog'
AS $function$
DECLARE
  v_since           timestamptz := now() - make_interval(hours => p_lookback_hours);
  -- FIX-980: the canary's OWN last run. Resolved in DECLARE because it is
  -- knowable even on an instance without pg_cron, where the guard below
  -- returns early.
  v_last_canary     timestamptz := (SELECT max(started_at) FROM public.data_sync_log
                                     WHERE pipeline = 'canary_check');
  -- FIX-1073 — see the header for how both are derived.
  v_streak_n        int := 6;
  v_burst_m         int := 10;
  -- FIX-1220 — a streak must ALSO span this many minutes at the job's own
  -- cadence (runs x interval): the */2 calibration of v_streak_n, kept for a
  -- job that fires more often than every 2 minutes.
  v_streak_min      int := 12;
  v_startup         jsonb;
  v_missing         jsonb;
  v_blowouts        jsonb;
  v_runs            jsonb;
  v_canary          jsonb;
  v_tiers           jsonb;
BEGIN
  -- Degrade cleanly where pg_cron is absent rather than raising: the canary
  -- treats a detector error as non-fatal, but a shaped empty answer keeps the
  -- meta-row trail honest instead of silently dropping the section.
  IF to_regclass('cron.job_run_details') IS NULL OR to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object(
      'available',        false,
      'lookback_hours',   p_lookback_hours,
      'startup_timeouts', '[]'::jsonb,
      'missing_daily',    '[]'::jsonb,
      'timeout_blowouts', '[]'::jsonb,
      'runs',             '[]'::jsonb,
      'startup_timeout_tiers', jsonb_build_object(
        'streak_threshold', v_streak_n,
        'burst_threshold',  v_burst_m,
        'streak_minutes_threshold', v_streak_min,
        'per_job',          '[]'::jsonb,
        'burst',            '[]'::jsonb
      ),
      'canary_liveness',  jsonb_build_object(
      'silent',          (v_last_canary IS NULL OR v_last_canary < now() - interval '30 hours'),
      'hours_since',     ROUND(EXTRACT(epoch FROM (now() - v_last_canary)) / 3600.0, 1),
      'last_started_at', v_last_canary,
      'threshold_hours', 30
    )
    );
  END IF;

  -- FIX-1150 - the ledger this function READS is written by
  -- public.record_cron_jobs_seen(), which the canary calls immediately before
  -- this RPC. It is deliberately NOT written here: this function must stay
  -- STABLE, because public.check_cron_job_escalations() (STABLE, and the RPC
  -- the status page calls every tick) wraps it, and a transitive INSERT makes
  -- that whole path fail with "cannot execute INSERT in a read-only
  -- transaction" - measured, not theorised.

  -- REPORT-ONLY as of FIX-1073 — a firing pg_cron abandoned before the job body
  -- ever ran. On this instance cron.use_background_workers=off, so this is a
  -- libpq connect that could not complete inside pg_cron's ~10 s window. A LONE
  -- one of these is now ordinary weather on this box (1,849 in 30 days); what
  -- escalates is startup_timeout_tiers below.
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'start_time' DESC), '[]'::jsonb)
    INTO v_startup
  FROM (
    SELECT jsonb_build_object(
             'jobid',      d.jobid,
             'jobname',    j.jobname,
             'schedule',   j.schedule,
             'start_time', d.start_time,
             'seconds',    ROUND(EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric, 1),
             'message',    d.return_message
           ) AS t
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= v_since
      AND d.status = 'failed'
      AND d.return_message ILIKE '%startup timeout%'
  ) s;

  -- FIX-1073 — THE ESCALATING TIERS.
  --
  -- per_job: N-or-more CONSECUTIVE startup timeouts in that job's own ordered
  -- run history. Gaps-and-islands over cron.job_run_details, NOT a count within
  -- the window — a job that failed six times interleaved with six successes is
  -- flaky weather, while six in a row is a job that has stopped running. The
  -- streak is computed over a wider history than the report window (twice the
  -- lookback) so a streak straddling the window boundary is not cut in half,
  -- then kept only if it reaches into the window.
  --
  -- FIX-1220 — AND at least v_streak_min minutes long at the job's own cadence
  -- (runs x interval). Six runs of a */2 job are 12 minutes; six of the */1
  -- box-health-probe are six, so it needs twelve. Exact on every job at */2 or
  -- slower (87 of 87 retained streaks on prod, 2026-09-24).
  --
  -- burst: any 60-minute bucket inside the window with M-or-more startup
  -- timeouts across ALL jobs. This is the short, broad connection-accept
  -- collapse that no single job stretches into a streak.
  --
  -- FIX-1222 — each failure in a bucket is weighed at the */2 cadence the
  -- threshold was sized on: least(1, interval / 2), with the job's interval
  -- from `cadence` below (COALESCE 2, as the streak). A job at */2 or slower
  -- weighs 1, so every pre-probe bucket keeps its count exactly (64 of 64
  -- paging buckets on prod's retained history, 2026-09-25); the */1
  -- box-health-probe weighs 0.5, one more */2-rate sensor rather than a
  -- doubled sample.
  WITH hist AS (
    SELECT d.jobid, d.start_time,
           (d.status = 'failed' AND d.return_message ILIKE '%startup timeout%') AS is_to
    FROM cron.job_run_details d
    WHERE d.start_time >= now() - make_interval(hours => p_lookback_hours * 2)
  ),
  islands AS (
    SELECT jobid, start_time, is_to,
           row_number() OVER (PARTITION BY jobid ORDER BY start_time)
             - row_number() OVER (PARTITION BY jobid, is_to ORDER BY start_time) AS grp
    FROM hist
  ),
  -- FIX-1220 — each job's interval: the median gap between its consecutive
  -- firings in hist, in minutes. Not a span of start times: under stress
  -- pg_cron fires late and bunched, and a span can undercount a */2 streak.
  cadence AS (
    SELECT jobid,
           ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_min))::numeric, 1) AS interval_minutes
    FROM (
      SELECT jobid,
             EXTRACT(epoch FROM (start_time - lag(start_time) OVER (PARTITION BY jobid ORDER BY start_time))) / 60.0 AS gap_min
      FROM hist
    ) g
    WHERE gap_min > 0
    GROUP BY jobid
  ),
  streaks AS (
    SELECT jobid, count(*) AS streak,
           min(start_time) AS first_at, max(start_time) AS last_at
    FROM islands WHERE is_to GROUP BY jobid, grp
  ),
  per_job AS (
    SELECT jsonb_build_object(
             'jobid',        s.jobid,
             'jobname',      j.jobname,
             'schedule',     j.schedule,
             'streak',       s.streak,
             'first_at',     s.first_at,
             'last_at',      s.last_at,
             -- FIX-1220 — the streak in minutes at the job's cadence, the
             -- quantity v_streak_min is compared against.
             'interval_minutes', COALESCE(c.interval_minutes, 2),
             'streak_minutes',   s.streak * COALESCE(c.interval_minutes, 2),
             -- The count alone cannot separate 96 minutes of a */2 watchdog
             -- from three days of a twice-daily rollup. This can.
             'span_minutes', ROUND(EXTRACT(epoch FROM (s.last_at - s.first_at)) / 60.0, 1)
           ) AS t
    FROM streaks s
    LEFT JOIN cron.job j ON j.jobid = s.jobid
    LEFT JOIN cadence c ON c.jobid = s.jobid
    WHERE s.streak >= v_streak_n
      AND s.streak * COALESCE(c.interval_minutes, 2) >= v_streak_min
      AND s.last_at >= v_since
  ),
  buckets AS (
    SELECT date_trunc('hour', d.start_time) AS bucket,
           count(*) AS n, count(DISTINCT d.jobid) AS n_jobs,
           -- FIX-1222 — the bucket at the */2 rate; see the tiers header.
           sum(LEAST(1, COALESCE(c.interval_minutes, 2) / 2.0)) AS weighted_n,
           string_agg(DISTINCT COALESCE(j.jobname, 'jobid ' || d.jobid), ', '
                      ORDER BY COALESCE(j.jobname, 'jobid ' || d.jobid)) AS jobs
    FROM cron.job_run_details d
    LEFT JOIN cadence c ON c.jobid = d.jobid
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= v_since
      AND d.status = 'failed'
      AND d.return_message ILIKE '%startup timeout%'
    GROUP BY 1
  ),
  burst AS (
    SELECT jsonb_build_object(
             'weighted_count', ROUND(weighted_n, 1),
             'bucket', bucket, 'count', n, 'jobs_affected', n_jobs, 'jobs', jobs
           ) AS t
    FROM buckets WHERE n >= v_burst_m
      -- FIX-1222 — the decision. weighted_n <= n (every weight <= 1), so the
      -- line above is implied by this one and kept only as the old floor.
      AND weighted_n >= v_burst_m
  )
  SELECT jsonb_build_object(
           'streak_threshold', v_streak_n,
           'burst_threshold',  v_burst_m,
           'streak_minutes_threshold', v_streak_min,
           'per_job', COALESCE((SELECT jsonb_agg(t ORDER BY t->>'last_at' DESC) FROM per_job), '[]'::jsonb),
           'burst',   COALESCE((SELECT jsonb_agg(t ORDER BY t->>'bucket' DESC) FROM burst),   '[]'::jsonb)
         )
    INTO v_tiers;

  -- ESCALATING — a job scheduled to fire at least daily with NO run row in the
  -- window. pg_cron writes a row for every firing including failures, so an
  -- absent row means the firing never happened at all.
  --
  -- "at least daily" = day-of-month, month and day-of-week fields are all '*'.
  -- That is exact for every schedule in use here (daily jobs are `M H * * *`;
  -- weekly carry a dow, monthly carry a dom). Non-standard syntax (@daily,
  -- step values) is deliberately not matched — a false negative is silent,
  -- which is the safe direction for a detector that escalates.
  --
  -- 26h, not 24h: consecutive firings of an at-least-daily job are at most 24h
  -- apart, so a 26h window always contains one regardless of what time the
  -- canary runs, with 2h of slack for a late start.
  --
  -- FIX-1150 - a NEWBORN job is not a missing one.
  --
  -- This arm ESCALATES: it fails the canary. But a daily job scheduled less
  -- than a day ago has no run rows yet for the ordinary reason that it has not
  -- fired, and it reported here for up to 26h every time one was added. jobid
  -- 48 (platform-counts-daily, scheduled 2026-09-05, first firing 03:53 UTC)
  -- is the surfacing case and was red at the moment this was written.
  --
  -- The exclusion is keyed on public.cron_job_first_seen, an explicit ledger
  -- this function maintains above, NOT on the jobid ordering heuristic: jobids
  -- are only monotonic until someone unschedules and re-creates a job, at which
  -- point high-jobid stops meaning new and the guard silently protects the
  -- wrong row. A job is exempt only while it has NO run rows at all AND its
  -- first_seen_at is inside the same 26h the window already allows. The moment
  -- it produces one run row, or that window passes, it is judged like
  -- everything else - so a job that is genuinely broken from birth is caught
  -- one cycle later, not never.
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'jobid'), '[]'::jsonb)
    INTO v_missing
  FROM (
    SELECT jsonb_build_object(
             'jobid',    j.jobid,
             'jobname',  j.jobname,
             'schedule', j.schedule
           ) AS t
    FROM cron.job j
    WHERE j.active
      AND split_part(j.schedule, ' ', 3) = '*'
      AND split_part(j.schedule, ' ', 4) = '*'
      AND split_part(j.schedule, ' ', 5) = '*'
      AND NOT EXISTS (
        SELECT 1 FROM cron.job_run_details d
        WHERE d.jobid = j.jobid AND d.start_time >= v_since
      )
      -- FIX-1150: a job born less than one window ago has not missed
      -- anything. Only exempt while it has produced NO run row ever - one
      -- run means it is alive and any later gap is real.
      AND NOT (
        NOT EXISTS (SELECT 1 FROM cron.job_run_details d2 WHERE d2.jobid = j.jobid)
        AND COALESCE(
              (SELECT f.first_seen_at FROM public.cron_job_first_seen f
                WHERE f.jobname = j.jobname),
              '-infinity'::timestamptz
            ) > now() - interval '26 hours'
      )
  ) m;

  -- REPORT ONLY — a run cancelled by the 6 h statement_timeout on the postgres
  -- role. Real failures, but seven jobs have done it and jobid 12 does it
  -- near-weekly; escalating here would fail the canary most Tuesdays until the
  -- rollup arms are chunked. Kept greppable so the trend is visible.
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'start_time' DESC), '[]'::jsonb)
    INTO v_blowouts
  FROM (
    SELECT jsonb_build_object(
             'jobid',      d.jobid,
             'jobname',    j.jobname,
             'schedule',   j.schedule,
             'start_time', d.start_time,
             'seconds',    ROUND(EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric, 1)
           ) AS t
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= v_since
      AND d.status = 'failed'
      AND d.return_message ILIKE '%statement timeout%'
  ) b;

  -- REPORT ONLY — the full window trail.
  SELECT COALESCE(jsonb_agg(t ORDER BY t->>'start_time'), '[]'::jsonb)
    INTO v_runs
  FROM (
    SELECT jsonb_build_object(
             'jobid',      d.jobid,
             'jobname',    j.jobname,
             'start_time', d.start_time,
             'seconds',    ROUND(EXTRACT(epoch FROM (d.end_time - d.start_time))::numeric, 1),
             'status',     d.status
           ) AS t
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= v_since
  ) r;

  -- FIX-980 — ESCALATING: the watchman's own dead-man switch.
  --
  -- canary_check is a GitHub Actions workflow, not a pg_cron job, so nothing in
  -- cron.job_run_details can ever see it and no other workflow asserts on it.
  -- On 2026-08-06 it produced ZERO rows in data_sync_log after 19 consecutive
  -- daily rows — and that was the single day with the most incidents in the
  -- retained window. Six of the seven scheduled detectors run only inside that
  -- one process, so when it dies they all go dark simultaneously and the
  -- silence is indistinguishable from health.
  --
  -- Deliberately ONE level of meta-monitoring and no more. This catches a
  -- PREVIOUS run's silence on the next run that does complete, which is the
  -- cheap majority of the exposure. It cannot catch "the canary never runs
  -- again" — that needs an observer outside the process, and a
  -- watcher-watching-the-watcher tower is explicitly out of scope.
  --
  -- 30h, not 24h: the workflow is daily at 05:00 UTC, so consecutive runs are
  -- 24h apart and 30h leaves 6h of slack for a late start before calling it.
  v_canary := jsonb_build_object(
      'silent',          (v_last_canary IS NULL OR v_last_canary < now() - interval '30 hours'),
      'hours_since',     ROUND(EXTRACT(epoch FROM (now() - v_last_canary)) / 3600.0, 1),
      'last_started_at', v_last_canary,
      'threshold_hours', 30
    );

  RETURN jsonb_build_object(
    'available',             true,
    'lookback_hours',        p_lookback_hours,
    'startup_timeouts',      v_startup,
    'startup_timeout_tiers', v_tiers,
    'missing_daily',         v_missing,
    'timeout_blowouts',      v_blowouts,
    'runs',                  v_runs,
    'canary_liveness',       v_canary
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.check_cron_job_health(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_cron_job_health(integer) FROM anon;
REVOKE ALL ON FUNCTION public.check_cron_job_health(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_cron_job_health(integer) TO service_role;

COMMENT ON FUNCTION public.check_cron_job_health(integer) IS
  'FIX-968 + FIX-980 + FIX-1073 + FIX-1220 + FIX-1222 — pg_cron firing health over the last p_lookback_hours, plus the canary''s own dead-man check. '
  'ESCALATING: missing_daily, canary_liveness.silent, and startup_timeout_tiers (>=6 consecutive startup timeouts for one job that also span '
  '>=12 minutes at that job''s own cadence — runs x its median firing interval, FIX-1220 — or >=10 in a 60-minute bucket across all jobs, '
  'each failure weighed at the */2 cadence: least(1, interval / 2), FIX-1222). '
  'REPORT-ONLY: startup_timeouts (a lone abandoned firing is ordinary weather on this box — 1,849 in 30 days), timeout_blowouts, runs. '
  'SECURITY DEFINER because service_role lacks USAGE on schema cron. Consumed by canary-check.ts.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. cron-job-run-details-retention — FIX-1221.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BY NAME (playbook D3): cron.schedule() with a name is upsert-by-name, so a
-- re-run re-points the same jobid instead of minting a second job. The command
-- is ONE statement (a multi-statement pg_cron command runs in an implicit
-- transaction block; FIX-1128), and 42 is the same number as v_corr_since's in
-- list_scheduled_rollup_pipelines() above. A test pins the two together.

DO $$
DECLARE
  c_jobname  CONSTANT text := 'cron-job-run-details-retention';
  c_sched    CONSTANT text := '51 1 * * *';
  v_id       bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE WARNING '[fix1221] pg_cron not installed — job not scheduled';
    RETURN;
  END IF;

  SELECT cron.schedule(c_jobname, c_sched,
           $job$DELETE FROM cron.job_run_details WHERE start_time < now() - make_interval(days => 42)$job$)
    INTO v_id;
  RAISE NOTICE '[fix1221] scheduled % (jobid %) at %', c_jobname, v_id, c_sched;
END $$;

-- Budget (rule 120): the outside bound the FIX-1063 watchdog cancels on. The
-- first purge is 986 rows and a steady-state day ~3,050, each a single scan of
-- a table the probe reads in 20-40 ms; 300 s is two orders of magnitude of
-- headroom over that. A cancel is SAFE: the DELETE is one transaction, and the next day retries it.
INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES (
  'cron-job-run-details-retention',
  300,
  'FIX-1221. Daily 01:51 UTC DELETE of cron.job_run_details rows older than 42 days '
  '(list_scheduled_rollup_pipelines correlates over the same 42). First purge 986 rows '
  '(2026-09-25), steady state ~3,050/day. A cancel is SAFE: one statement, one '
  'transaction, retried the next day.')
ON CONFLICT (jobname) DO UPDATE
  SET budget_seconds = EXCLUDED.budget_seconds,
      note           = EXCLUDED.note,
      updated_at     = NOW();

-- Guard: fail the migration rather than land the job in a slot the placement
-- rules refuse (the FIX-1141 / FIX-1129 / FIX-1146 checks, restated).
DO $$
DECLARE
  c_jobname CONSTANT text := 'cron-job-run-details-retention';
  v_sched   text;
  v_cmd     text;
  v_min     int;
  v_hour    int;
  v_clash   int;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE '[fix1221] pg_cron absent — placement guard skipped';
    RETURN;
  END IF;

  SELECT schedule, command INTO v_sched, v_cmd FROM cron.job WHERE jobname = c_jobname;
  IF v_sched IS NULL THEN
    RAISE EXCEPTION '[fix1221] % was not scheduled', c_jobname;
  END IF;

  v_min  := split_part(v_sched, ' ', 1)::int;
  v_hour := split_part(v_sched, ' ', 2)::int;

  IF NOT (v_hour >= 18 OR v_hour <= 5) THEN
    RAISE EXCEPTION '[fix1221] % lands at hour % — outside the measured quiet band (18-05 UTC)', c_jobname, v_hour;
  END IF;
  IF v_min % 2 = 0 THEN
    RAISE EXCEPTION '[fix1221] % lands on even minute % — collides with the */2 watchdogs', c_jobname, v_min;
  END IF;
  IF v_min % 15 = 0 THEN
    RAISE EXCEPTION '[fix1221] % lands on minute % — collides with ec-crawl/fe-crawl', c_jobname, v_min;
  END IF;
  SELECT count(*) INTO v_clash FROM cron.job
   WHERE active AND jobname <> c_jobname AND schedule = v_sched;
  IF v_clash > 0 THEN
    RAISE EXCEPTION '[fix1221] % active job(s) already hold schedule %', v_clash, v_sched;
  END IF;
  IF position(';' IN v_cmd) > 0 THEN
    RAISE EXCEPTION '[fix1221] % command is not one statement: %', c_jobname, v_cmd;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cron_job_budget WHERE jobname = c_jobname) THEN
    RAISE EXCEPTION '[fix1221] % has no cron_job_budget row', c_jobname;
  END IF;

  RAISE NOTICE '[fix1221] placement guard passed — % at % (hour %, minute %)', c_jobname, v_sched, v_hour, v_min;
END $$;
