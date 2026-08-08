-- FIX-980 — nothing watched the watchman. One level of meta-monitoring, no tower.
--
-- THE EXPOSURE. `canary_check` is a GitHub Actions workflow
-- (.github/workflows/sync-canary-check.yml, `cron: 0 5 * * *`), so
-- check_cron_job_health() structurally cannot see it — that function reads
-- cron.job_run_details and there is no pg_cron job for the canary. It is also
-- absent from the rollup registry, and no workflow asserts on another workflow.
-- Coverage check by mechanism: grep for "canary_check" across apps/, packages/
-- and supabase/ returns only the writer itself.
--
-- Measured on prod: canary_check rows are present on 19 consecutive UTC days,
-- 2026-07-18 -> 08-05, then ZERO rows on 2026-08-06. That gap is not random —
-- it is the single day with the most incidents in the retained window (the
-- FIX-968 migration and canary-check.ts:68-85 both document GHA run
-- 31081114924 on 08-06 07:30 dying on service_role's 8s statement timeout).
-- On the day the platform most needed a health signal it emitted none, and
-- nothing noticed.
--
-- BLAST RADIUS. Six of the seven scheduled detectors run ONLY inside that one
-- process — check_cron_job_health, check_rollup_freshness,
-- check_rebuild_autovacuum_status, check_sector_affinity_tag_staleness and the
-- rest. When the canary does not run they all go dark at once, and the silence
-- is indistinguishable from health.
--
-- SCOPE — WHY THIS IS THE SMALLEST FIX AND WHERE IT STOPS. The health function
-- gains one section that reads the canary's OWN last run and escalates on
-- silence past 30h. That catches a previous run's silence on the next run that
-- does complete. It deliberately does NOT attempt to catch "the canary never
-- runs again", which would require an observer outside the process; building a
-- watcher-watching-the-watcher tower is explicitly out of scope. The other half
-- of the exposure — the meta-row INSERT failing quietly — is closed in
-- canary-check.ts by exiting non-zero so GHA marks the run failed.
--
-- Rebuilt from the CURRENT prod body (md5 dbf8fb0e549b02d3103df5d8ab4cf680,
-- verified identical to the FIX-968 migration text before editing), with the
-- canary section and its two new keys added and nothing else changed.

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
  v_startup         jsonb;
  v_missing         jsonb;
  v_blowouts        jsonb;
  v_runs            jsonb;
  v_canary          jsonb;
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
      'canary_liveness',  jsonb_build_object(
      'silent',          (v_last_canary IS NULL OR v_last_canary < now() - interval '30 hours'),
      'hours_since',     ROUND(EXTRACT(epoch FROM (now() - v_last_canary)) / 3600.0, 1),
      'last_started_at', v_last_canary,
      'threshold_hours', 30
    )
    );
  END IF;

  -- ESCALATING — a firing pg_cron abandoned before the job body ever ran.
  -- On this instance cron.use_background_workers=off, so this is a libpq
  -- connect that could not complete inside pg_cron's ~10 s window.
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
    'available',        true,
    'lookback_hours',   p_lookback_hours,
    'startup_timeouts', v_startup,
    'missing_daily',    v_missing,
    'timeout_blowouts', v_blowouts,
    'runs',             v_runs,
    'canary_liveness',  v_canary
  );
END;
$$;

-- Script-gated only (canary → createAdminClient → service_role). No anon or
-- authenticated surface — FIX-834/835 hygiene.

-- Script-gated only (canary -> createAdminClient -> service_role). No anon or
-- authenticated surface — FIX-834/835 hygiene.
REVOKE ALL ON FUNCTION public.check_cron_job_health(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_cron_job_health(int) TO service_role;

COMMENT ON FUNCTION public.check_cron_job_health(int) IS
  'FIX-968 + FIX-980 — pg_cron firing health over the last p_lookback_hours, '
  'plus the canary''s own dead-man check. startup_timeouts, missing_daily and '
  'canary_liveness.silent ESCALATE; timeout_blowouts and runs are report-only, '
  'per the FIX-943 cause-vs-consequence split. SECURITY DEFINER because '
  'service_role lacks USAGE on schema cron. Consumed by canary-check.ts.';
