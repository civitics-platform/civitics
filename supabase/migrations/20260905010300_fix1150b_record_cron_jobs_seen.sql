-- FIX-1150 (follow-up to 20260905010200) - the ledger write moves OUT of
-- check_cron_job_health(), which goes back to STABLE.
--
-- WHAT THE FIRST MIGRATION GOT WRONG. It made check_cron_job_health() VOLATILE
-- so the function could maintain its own first-seen ledger. That is one caller
-- too shallow a view: public.check_cron_job_escalations() is STABLE, wraps
-- check_cron_job_health(26), and is the RPC apps/civitics/.../status renders
-- from on every tick. A transitive INSERT under it fails outright in a
-- read-only transaction - measured on the clone immediately after the push:
--
--   ERROR:  cannot execute INSERT in a read-only transaction
--   CONTEXT: SQL statement "INSERT INTO public.cron_job_first_seen ..."
--     PL/pgSQL function check_cron_job_health(integer) line 52
--     PL/pgSQL function check_cron_job_escalations(integer,integer) line 29
--
-- PostgREST runs GET /rpc/ read-only and only allows GET on non-VOLATILE
-- functions, so a STABLE wrapper around a writing callee is a trap that springs
-- the moment anything reaches it by a read-only path. Detector code has to be
-- the most boring thing in the system, not the most clever.
--
-- THE SPLIT. record_cron_jobs_seen() is VOLATILE and does the write; the health
-- check is STABLE again and only READS the ledger. The canary calls the
-- recorder immediately before the health RPC, so by the time missing_daily is
-- evaluated every active job has a row - which is what makes the '-infinity'
-- default (absent row => NOT exempt) safe rather than a silent suppressor.
--
-- The status page reaches check_cron_job_health() without recording first. A
-- job created between two canary runs therefore has no ledger row yet and can
-- appear in the status page's missing_daily for that gap. That is the SAFE
-- direction (report a newborn, never hide a genuinely dead job) and the status
-- page is a render, not the escalating consumer.
--
-- Rule 34: both functions below restate SECURITY DEFINER and their search_path
-- SET clause verbatim, and the GRANT posture is re-asserted after each.

CREATE OR REPLACE FUNCTION public.record_cron_jobs_seen()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron', 'pg_catalog'
AS $function$
DECLARE
  v_new integer;
BEGIN
  -- Degrade cleanly where pg_cron is absent, same contract as the health check.
  IF to_regclass('cron.job') IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.cron_job_first_seen (jobname)
  SELECT j.jobname FROM cron.job j
   WHERE j.jobname IS NOT NULL AND j.active
  ON CONFLICT (jobname) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  RETURN v_new;
END;
$function$;

COMMENT ON FUNCTION public.record_cron_jobs_seen() IS
  'FIX-1150 - records every active pg_cron job in public.cron_job_first_seen the first time it is seen. VOLATILE by necessity; kept separate from check_cron_job_health() so that function can stay STABLE for the read-only status-page path. Called by canary-check immediately before the health RPC.';

REVOKE ALL ON FUNCTION public.record_cron_jobs_seen() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_cron_jobs_seen() FROM anon;
REVOKE ALL ON FUNCTION public.record_cron_jobs_seen() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_cron_jobs_seen() TO service_role;

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
