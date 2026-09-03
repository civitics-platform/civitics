-- FIX-1073 (option B) — tier the startup-timeout signal instead of paging on
-- every single abandoned firing.
--
-- THE BULLET'S PREMISE IS INVERTED, AND THAT MATTERS FOR THE FIX. FIX-1073 is
-- filed as "skipped firings are silent". They are not: FIX-968 put
-- `startup_timeouts` in the ESCALATING set and canary-check.ts fails the
-- workflow on a SINGLE startup-timeout row anywhere in the 26h window. The
-- defect is over-alerting, and the cost is the same one FIX-977b names — an
-- alarm that fires most days is an alarm nobody reads.
--
-- WHAT THE HISTORY ACTUALLY LOOKS LIKE (cron.job_run_details, prod, 30 days to
-- 2026-09-02). The bullet's "191 rows / 8 days" is an undercount by an order of
-- magnitude; the real window holds 1,849 startup timeouts across 16 days:
--
--   day        max consecutive streak   max per-60min bucket
--   08-04                  2                      2
--   08-05                  1                      1
--   08-06                  3                      2
--   08-07                  -                      1
--   08-08                  1                      1
--   08-10                  3                      6
--   08-11                  4                      6
--   ------------------------------- quiet ceiling: streak 4, bucket 6
--   08-17                 29                     35
--   08-18                 13                     48
--   08-19                 49                     91
--   08-24                 22                     49
--   08-25                 28                     59
--   08-26                  4                     11
--   08-29                 20                     39
--   08-31                 29                     44
--   09-01                  9                     38
--
-- Distribution over all 458 streaks: p50 2, p90 9, p95 15, max 49.
-- Distribution over the 84 non-empty hourly buckets: p50 14.5, p90 48.7,
-- p95 59, max 91.
--
-- The volume is dominated by the `*/2` watchdogs (jobid 40 derived-mvs-unit-
-- watchdog, 44 cron-job-budget-watchdog, and 43 — a since-deleted job still
-- present in job_run_details). Those fire 720x/day, so under connection-accept
-- pressure they generate enormous streaks that cost almost nothing: jobid 40's
-- 49-run streak on 08-19 spans 96 minutes. The signal worth paging on is not
-- "a firing was dropped" but "firings are being dropped in a way that outlasts
-- one bad minute". Hence two tiers, and `span_minutes` recorded alongside the
-- count so a reader can tell 96 minutes of watchdog from three days of a
-- twice-daily rollup.
--
-- THRESHOLDS, derived from the table above rather than picked:
--
--   N = 6 consecutive startup timeouts in a job's OWN run history.
--       The quiet-day ceiling is 4, so 6 leaves two notches of margin. Every
--       incident day except 08-26 trips it (max streaks 29/13/49/22/28/20/29/9)
--       and 08-26 trips the burst tier instead, so detection over the last 30
--       days is identical at N=5 and N=6 — take the margin.
--
--   M = 10 startup timeouts in one 60-minute bucket across ALL jobs.
--       The quiet-day ceiling is 6 and the lowest incident-day peak is 11, so
--       10 sits cleanly in the gap. This is the tier that catches a short,
--       broad connection-accept collapse that no single job stretches out.
--
-- Effect: over the last 30 days the OLD rule (any startup timeout) escalates on
-- 16 of 30 days; the new rule escalates on 9 — every one of them a day the box
-- genuinely could not accept pg_cron's connections. `startup_timeouts` itself is
-- unchanged and stays in the payload; it simply moves to report-only in
-- canary-check.ts, and `startup_timeout_tiers` is what escalates.
--
-- OPTION A (re-fire an idempotent job once after a startup timeout) is
-- deliberately NOT built here — it changes what runs on prod rather than what
-- is reported, and needs the per-job exclusion list the bullet describes.
-- Filed separately.
--
-- Rebuilt from the CURRENT prod body (md5 05be7a0653ec7fb6f7a722c2b6bb7515,
-- diffed against the FIX-980 migration text and identical modulo
-- pg_get_functiondef normalisation), with the tier section and its one new key
-- added and nothing else changed.

CREATE OR REPLACE FUNCTION public.check_cron_job_health(
  p_lookback_hours int DEFAULT 26
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, cron, pg_catalog
AS $$
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
  -- burst: any 60-minute bucket inside the window with M-or-more startup
  -- timeouts across ALL jobs. This is the short, broad connection-accept
  -- collapse that no single job stretches into a streak.
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
             -- The count alone cannot separate 96 minutes of a */2 watchdog
             -- from three days of a twice-daily rollup. This can.
             'span_minutes', ROUND(EXTRACT(epoch FROM (s.last_at - s.first_at)) / 60.0, 1)
           ) AS t
    FROM streaks s
    LEFT JOIN cron.job j ON j.jobid = s.jobid
    WHERE s.streak >= v_streak_n
      AND s.last_at >= v_since
  ),
  buckets AS (
    SELECT date_trunc('hour', d.start_time) AS bucket,
           count(*) AS n, count(DISTINCT d.jobid) AS n_jobs,
           string_agg(DISTINCT COALESCE(j.jobname, 'jobid ' || d.jobid), ', '
                      ORDER BY COALESCE(j.jobname, 'jobid ' || d.jobid)) AS jobs
    FROM cron.job_run_details d
    LEFT JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= v_since
      AND d.status = 'failed'
      AND d.return_message ILIKE '%startup timeout%'
    GROUP BY 1
  ),
  burst AS (
    SELECT jsonb_build_object(
             'bucket', bucket, 'count', n, 'jobs_affected', n_jobs, 'jobs', jobs
           ) AS t
    FROM buckets WHERE n >= v_burst_m
  )
  SELECT jsonb_build_object(
           'streak_threshold', v_streak_n,
           'burst_threshold',  v_burst_m,
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
  -- Known transient: a genuinely NEW daily job has no run rows until its first
  -- firing, so it reports here for up to a day. That is why the reschedule above
  -- uses cron.alter_job rather than unschedule+schedule — see its comment.
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
$$;

-- Script-gated only (canary -> createAdminClient -> service_role). No anon or
-- authenticated surface — FIX-834/835 hygiene.
REVOKE ALL ON FUNCTION public.check_cron_job_health(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_cron_job_health(int) TO service_role;

COMMENT ON FUNCTION public.check_cron_job_health(int) IS
  'FIX-968 + FIX-980 + FIX-1073 — pg_cron firing health over the last '
  'p_lookback_hours, plus the canary''s own dead-man check. ESCALATING: '
  'missing_daily, canary_liveness.silent, and startup_timeout_tiers (>=6 '
  'consecutive startup timeouts for one job, or >=10 in a 60-minute bucket '
  'across all jobs). REPORT-ONLY: startup_timeouts (a lone abandoned firing is '
  'ordinary weather on this box — 1,849 in 30 days), timeout_blowouts, runs. '
  'SECURITY DEFINER because service_role lacks USAGE on schema cron. Consumed '
  'by canary-check.ts.';
