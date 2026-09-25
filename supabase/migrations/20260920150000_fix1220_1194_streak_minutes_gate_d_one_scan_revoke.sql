-- FIX-1220 + FIX-1194 (cc-153) — the cc-149 follow-ups that are DDL:
--   1. check_cron_job_health(): a startup-timeout STREAK escalates only when it
--      is also 12 minutes long at the job's own cadence (FIX-1220, rule 178).
--   2. prod_op_gate(): the (d) reads take the probe's one-MATERIALIZED-scan
--      form (FIX-1194, cc-149 §5.3).
--   3. record_box_health(timestamptz) loses service_role's EXECUTE (FIX-1194,
--      cc-149 §5.4).
--
-- Design of record: the cc-153 prompt, D1/D3/D4. Its D2 (a 30-day retention
-- job for cron.job_run_details) is NOT here: read 4 found a live reader that
-- scans the table over 90 days (list_scheduled_rollup_pipelines(), called by
-- the canary with its default p_lookback_days = 90) and takes its FIX-1135 era
-- boundary from min(start_time) over ALL history. A 30-day purge would move
-- every job's era boundary. Filed as FIX-1221; nothing here deletes a row.
--
-- ── 1. THE STREAK KEYS ON MINUTES AS WELL AS RUNS (FIX-1220) ─────────────────
--
-- Rule 178: a new */1 job is a calibration change to every alert that counts
-- failures per RUN. per_job escalated at 6 consecutive startup timeouts, sized
-- when every sub-hourly job fired */2 or slower: 6 runs = 12 min of a starved
-- forker. box-health-probe (* * * * *, prod jobid 53, live since 2026-09-24
-- 02:02 UTC) reaches 6 in 6 min.
--
-- THE RULE: escalate when runs >= 6 AND runs x the job's interval >= 12 min.
-- Measured on prod 2026-09-24 23:48-23:59 UTC over every retained streak (from
-- 07-26): this reproduces the old decision on 87 of 87 (2 of 2 in the last 7
-- days, 85 of 85 older, 0 demoted) and holds the probe to 12 runs = 12 min.
-- The minutes condition ALONE (runs ignored, as the prompt worded it) would
-- have ADDED 84 escalations, 11 of them in the last 7 days, every one a short
-- run on a slow job: one lost firing of a weekly or twice-daily job spans
-- days. That contradicts this function's own REPORT-ONLY reading of a lone
-- startup timeout ("ordinary weather on this box"), so the runs floor stays.
--
-- THE INTERVAL is the median gap between the job's consecutive firings over
-- the streak history `hist` (2 x p_lookback_hours), rounded to 0.1 min. On
-- prod: both watchdogs 2.0, ec-crawl 15.0, fe-crawl 30.0. It is NOT
-- last.start - first.start: under stress pg_cron fires late and bunched (09-22,
-- both watchdogs, 16:01:04, 16:02:07, 16:03:25, 16:04:06), and a span measured
-- from start times can undercount a */2 streak. On an on-grid streak runs x
-- interval equals (last - first) + interval, which is the prompt's formula.
-- A job with no measurable gap is judged as */2 (COALESCE 2), the calibration
-- the thresholds were sized on, so a missing interval can only preserve the
-- old decision. `span_minutes` keeps its meaning; per_job gains
-- `interval_minutes` and `streak_minutes`, and the tiers gain
-- `streak_minutes_threshold`. Every change to this function is an ADDED line
-- (rule 34: +N/-0 against pg_get_functiondef on prod, read 2026-09-24 23:4x
-- UTC, 289 lines, byte-identical to local). STABLE, SECURITY DEFINER and the
-- search_path SET are restated unchanged; the grants are re-asserted below.
--
-- THE BURST IS UNCHANGED. The prompt's rule (count DISTINCT minutes per hourly
-- bucket) replayed on the same history gives 50 escalating buckets on 11 days
-- against today's 64 on 13. It silences two paging days outright (08-26, 09-14),
-- because the threshold of 10 was sized while both */2 watchdogs failed on the
-- same even minutes and counted twice. Stopped, measured, filed as FIX-1222.
-- The probe has had 0 startup timeouts in its first 22 h, so this costs
-- nothing measurable today.
--
-- ── 2. prod_op_gate() (d): ONE SCAN (FIX-1194) ──────────────────────────────
--
-- (d) read cron.job_run_details three times: the */2 watchdogs' 60-minute
-- walls, the 60-minute startup-timeout count, and running jobs past their
-- budget over 1 day. EXPLAIN ANALYZE on prod, 2026-09-24 23:52 UTC, 64,862
-- rows, 1,288 heap pages, three runs each:
--   watchdog walls        22.6 / 23.2 / 24.8 ms   (2 loops x 1,288 buffers)
--   startup timeouts      78.8 / 79.3 / 100.6 ms  (the ILIKE is evaluated
--                                                  FIRST, on every row)
--   budget overruns        9.7 /  9.8 /  9.8 ms
--   total                 112 - 133 ms
-- The probe's form, one MATERIALIZED CTE filtered by start_time alone over the
-- longest (d) window (1 day, 2,923 rows), the predicate in its select list and
-- every (d) read over the CTE: 23.3 / 23.6 / 26.2 ms, one scan, 1,288 buffers.
-- The whole gate measured 373-387 ms (36-38k buffers). The rest is (b)'s
-- 14-day co-tenancy LATERAL, whose per-job last_wall_s subquery has no
-- start_time bound. It is left alone: it cannot share a 1-day CTE without
-- changing its 14-day window.
--
-- Same windows, same predicate (byte-identical, rule 93 — box-health-probe and
-- prod-op-gate tests grep for it), same JSON keys (rule 103: wait-for-gate and
-- the FIX-1215 tests parse them; there is NO format change). The watchdog rows
-- round-trip through jsonb so the loop body below is byte-identical. Signature,
-- VOLATILE, SECURITY INVOKER and the one search_path SET are restated from
-- 20260920140000, which pg_get_functiondef on prod matches (418 lines, 0
-- diff). The COMMENT and grants are left as they are (CREATE OR REPLACE keeps
-- both). Outside (d) the body is unchanged.
--
-- ── 3. record_box_health() loses service_role ───────────────────────────────
--
-- 20260920130000 revoked PUBLIC, anon and authenticated only, and Supabase's
-- default grant left service_role=X on prod (read 2026-09-24 23:54 UTC). It is
-- inert (SECURITY INVOKER, and service_role has no USAGE on schema cron), but
-- the probe is meant to run as postgres under pg_cron only. P1-A's migration was
-- to carry this; it lands here instead. record_box_health_mem(jsonb) KEEPS
-- service_role (the Vercel route calls it), and box_is_saturated() is untouched.
--
-- rule 109 / FIX-1128: no statement_timeout anywhere; search_path is the only
-- SET clause on either function (check:proconfig). Neither function COMMITs.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. check_cron_job_health() — FIX-1220. Prod's body; every change an ADDED line.
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
  'FIX-968 + FIX-980 + FIX-1073 + FIX-1220 — pg_cron firing health over the last p_lookback_hours, plus the canary''s own dead-man check. '
  'ESCALATING: missing_daily, canary_liveness.silent, and startup_timeout_tiers (>=6 consecutive startup timeouts for one job that also span '
  '>=12 minutes at that job''s own cadence — runs x its median firing interval, FIX-1220 — or >=10 in a 60-minute bucket across all jobs). '
  'REPORT-ONLY: startup_timeouts (a lone abandoned firing is ordinary weather on this box — 1,849 in 30 days), timeout_blowouts, runs. '
  'SECURITY DEFINER because service_role lacks USAGE on schema cron. Consumed by canary-check.ts.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. prod_op_gate() — FIX-1194. 20260920140000's body; (d) reads one MATERIALIZED scan.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.prod_op_gate(
  p_expected_seconds int         DEFAULT 5400,
  p_now              timestamptz DEFAULT clock_timestamp()
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- (a) cron `0 21 * * *` + the GitHub offset (rule 79, cc-141). A constant
  -- because GitHub does not publish when it will actually start the run.
  c_nightly_start   CONSTANT time     := '21:00';  -- FIX-1218: the dispatch time (was 22:35, slot + GitHub offset)
  c_nightly_age     CONSTANT interval := interval '6 hours';
  -- (c) FIX-1124 / rule 2: the fallback when pipeline_state.ec_crawl has none.
  c_blackout_from   CONSTANT time     := '05:45';
  c_blackout_to     CONSTANT time     := '09:00';
  -- (b) rule 155.
  c_vac_long_s      CONSTANT numeric  := 60;
  c_vac_long_gap    CONSTANT interval := interval '90 minutes';
  c_vac_any_gap     CONSTANT interval := interval '10 minutes';
  -- (d)
  c_wd_min_runs     CONSTANT int      := 28;
  c_wd_max_wall_s   CONSTANT numeric  := 1.0;

  v_exp       interval;
  v_span_end  timestamptz;
  v_day       date;
  v_blocked   jsonb := '[]'::jsonb;
  v_readings  jsonb := '{}'::jsonb;
  r           record;
  v_n         bigint;
  v_t         timestamptz;
  v_json      jsonb;
  -- (a)
  v_today_slot  timestamptz;
  v_next_start  timestamptz;
  v_last_phase  jsonb;
  v_started_since boolean;
  -- (b)
  v_vac_jobs  jsonb := '[]'::jsonb;
  v_unparsed  jsonb := '[]'::jsonb;
  v_slot      timestamptz;
  v_h         int;
  v_m         int;
  -- (c)
  v_cfg       jsonb;
  v_windows   jsonb;
  v_source    text;
  v_from      time;
  v_to        time;
  v_occ_start timestamptz;
  v_occ_end   timestamptz;
  v_hit_end   timestamptz;
  v_hit_desc  text;
  -- (d)
  v_wd        jsonb := '[]'::jsonb;
  v_wd_n      int := 0;
  v_wd_rows   jsonb;  -- FIX-1194 cc-153: the watchdog rows from the one (d) scan
  -- (e)
  v_pss       jsonb;
  -- (f)
  v_guarded   text[];
BEGIN
  v_exp      := make_interval(secs => GREATEST(COALESCE(p_expected_seconds, 5400), 1));
  v_span_end := p_now + 2 * v_exp;
  v_day      := (p_now AT TIME ZONE 'UTC')::date;

  -- ══ (a) nightly ═══════════════════════════════════════════════════════════
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'phase', COALESCE(d.metadata->>'phase', 'all'),
           'started_at', d.started_at,
           'age_seconds', round(EXTRACT(epoch FROM (p_now - d.started_at)))::int)
           ORDER BY d.started_at), '[]'::jsonb)
    INTO v_json
    FROM public.data_sync_log d
   WHERE d.pipeline = 'nightly_cron'
     AND d.status   = 'running'
     AND d.started_at >  p_now - c_nightly_age
     AND d.started_at <= p_now;
  IF jsonb_array_length(v_json) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'a', 'name', 'nightly_running',
      'detail', format('nightly phase %s running since %s',
                       v_json->-1->>'phase', v_json->-1->>'started_at'),
      'retry_after', NULL);
  END IF;

  SELECT jsonb_build_object('phase', COALESCE(d.metadata->>'phase', 'all'), 'status', d.status,
                            'started_at', d.started_at, 'completed_at', d.completed_at)
    INTO v_last_phase
    FROM public.data_sync_log d
   WHERE d.pipeline = 'nightly_cron' AND d.started_at <= p_now
   ORDER BY d.started_at DESC LIMIT 1;

  IF v_last_phase IS NOT NULL
     AND v_last_phase->>'status' <> 'running'
     AND (v_last_phase->>'completed_at')::timestamptz > p_now - interval '10 minutes'
     AND (v_last_phase->>'completed_at')::timestamptz <= p_now THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'a', 'name', 'nightly_between_phases',
      'detail', format('nightly phase %s closed %s at %s — the next phase may not have opened yet',
                       v_last_phase->>'phase', v_last_phase->>'status', v_last_phase->>'completed_at'),
      'retry_after', (v_last_phase->>'completed_at')::timestamptz + interval '10 minutes');
  END IF;

  v_today_slot := (v_day + c_nightly_start) AT TIME ZONE 'UTC';
  IF p_now < v_today_slot THEN
    v_next_start := v_today_slot;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.data_sync_log d
                    WHERE d.pipeline = 'nightly_cron'
                      AND d.started_at >= v_today_slot - interval '60 minutes'
                      AND d.started_at <= p_now)
      INTO v_started_since;
    IF NOT v_started_since AND p_now < v_today_slot + interval '3 hours' THEN
      v_next_start := v_today_slot;   -- due, not started: it is "now"
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'a', 'name', 'nightly_due',
        'detail', format('nightly due since %s UTC and no nightly_cron row yet — waiting for it to start and finish',
                         c_nightly_start),
        'retry_after', NULL);
    ELSE
      v_next_start := v_today_slot + interval '1 day';
    END IF;
  END IF;
  IF v_next_start > p_now AND v_next_start - p_now < 2 * v_exp + interval '15 minutes' THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'a', 'name', 'nightly_next_start',
      'detail', format('next nightly start %s is %s min away; need >= %s (2 x expected + 15 min)',
                       to_char(v_next_start AT TIME ZONE 'UTC', 'MM-DD HH24:MI'),
                       round(EXTRACT(epoch FROM (v_next_start - p_now)) / 60),
                       round(EXTRACT(epoch FROM (2 * v_exp + interval '15 minutes')) / 60)),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('nightly', jsonb_build_object(
    'running', v_json,
    'last_phase', v_last_phase,
    'next_start', v_next_start,
    'minutes_to_next_start', round(EXTRACT(epoch FROM (v_next_start - p_now)) / 60),
    'required_minutes', round(EXTRACT(epoch FROM (2 * v_exp + interval '15 minutes')) / 60)));

  -- ══ (b) vacuum spacing (rule 155) ═════════════════════════════════════════
  FOR r IN
    SELECT j.jobid, j.jobname, j.schedule, j.active,
           s.runs_14d, s.mean_s, s.last_end, s.last_wall_s, s.running_since
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE d.end_time IS NOT NULL)                          AS runs_14d,
               round(avg(EXTRACT(epoch FROM (d.end_time - d.start_time)))
                       FILTER (WHERE d.end_time IS NOT NULL)::numeric, 1)              AS mean_s,
               max(d.end_time) FILTER (WHERE d.end_time <= p_now)                      AS last_end,
               min(d.start_time) FILTER (WHERE d.end_time IS NULL
                                           AND d.status IN ('starting', 'running', 'sending', 'connecting')
                                           AND d.start_time > p_now - interval '6 hours') AS running_since,
               (SELECT round(EXTRACT(epoch FROM (d2.end_time - d2.start_time))::numeric, 1)
                  FROM cron.job_run_details d2
                 WHERE d2.jobid = j.jobid AND d2.end_time <= p_now
                 ORDER BY d2.end_time DESC LIMIT 1)                                   AS last_wall_s
          FROM cron.job_run_details d
         WHERE d.jobid = j.jobid
           AND d.start_time >  p_now - interval '14 days'
           AND d.start_time <= p_now
      ) s ON true
     WHERE j.jobname ILIKE '%vacuum%'
     ORDER BY j.jobname
  LOOP
    v_slot := NULL;
    IF r.schedule ~ '^\d+ \d+ \* \* \*$' THEN
      v_m := split_part(r.schedule, ' ', 1)::int;
      v_h := split_part(r.schedule, ' ', 2)::int;
      v_slot := (v_day + make_time(v_h, v_m, 0)) AT TIME ZONE 'UTC';
      IF v_slot < p_now THEN v_slot := v_slot + interval '1 day'; END IF;
    ELSE
      v_unparsed := v_unparsed || jsonb_build_object(
        'jobname', r.jobname, 'schedule', r.schedule, 'active', r.active, 'mean_14d_s', r.mean_s);
    END IF;

    v_vac_jobs := v_vac_jobs || jsonb_build_object(
      'jobname', r.jobname, 'schedule', r.schedule, 'active', r.active,
      'runs_14d', r.runs_14d, 'mean_14d_s', r.mean_s,
      'last_end', r.last_end, 'last_wall_s', r.last_wall_s,
      'running_since', r.running_since, 'next_slot', v_slot);

    IF r.running_since IS NOT NULL THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s running since %s', r.jobname,
                         to_char(r.running_since AT TIME ZONE 'UTC', 'HH24:MI:SS')),
        'retry_after', NULL);
    END IF;

    -- The newest run of each job decides; an older long run inside 90 min is
    -- only possible for a job firing more than once in 90 min, and none does.
    IF r.last_end IS NOT NULL AND r.last_wall_s > c_vac_long_s
       AND r.last_end > p_now - c_vac_long_gap THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s ran %s s, ended %s; +90 min = %s', r.jobname, r.last_wall_s,
                         to_char(r.last_end AT TIME ZONE 'UTC', 'HH24:MI'),
                         to_char((r.last_end + c_vac_long_gap) AT TIME ZONE 'UTC', 'HH24:MI')),
        'retry_after', r.last_end + c_vac_long_gap);
    ELSIF r.last_end IS NOT NULL AND r.last_end > p_now - c_vac_any_gap THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s ended %s (%s s); +10 min = %s', r.jobname,
                         to_char(r.last_end AT TIME ZONE 'UTC', 'HH24:MI:SS'), r.last_wall_s,
                         to_char((r.last_end + c_vac_any_gap) AT TIME ZONE 'UTC', 'HH24:MI')),
        'retry_after', r.last_end + c_vac_any_gap);
    END IF;

    IF v_slot IS NOT NULL AND r.active AND COALESCE(r.mean_s, 0) > c_vac_long_s
       AND v_slot <= v_span_end THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'b', 'name', r.jobname,
        'detail', format('%s (mean %s s over %s runs) is scheduled %s UTC, inside the span to %s',
                         r.jobname, r.mean_s, r.runs_14d,
                         to_char(v_slot AT TIME ZONE 'UTC', 'HH24:MI'),
                         to_char(v_span_end AT TIME ZONE 'UTC', 'HH24:MI')),
        'retry_after', v_slot + make_interval(secs => r.mean_s) + c_vac_long_gap);
    END IF;
  END LOOP;
  v_readings := v_readings || jsonb_build_object('vacuum', jsonb_build_object(
    'jobs', v_vac_jobs, 'unparsed', v_unparsed));

  -- ══ (c) blackout ══════════════════════════════════════════════════════════
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'ec_crawl';
  v_windows := v_cfg->'blackout';
  IF v_windows IS NULL OR jsonb_typeof(v_windows) <> 'array' OR jsonb_array_length(v_windows) = 0 THEN
    v_windows := jsonb_build_array(jsonb_build_object('from', c_blackout_from::text, 'to', c_blackout_to::text));
    v_source  := 'constant 05:45-09:00 (FIX-1124 fallback: pipeline_state.ec_crawl has no blackout)';
  ELSE
    v_source  := 'pipeline_state.ec_crawl';
  END IF;

  v_hit_end := NULL;
  FOR r IN SELECT e.value AS w FROM jsonb_array_elements(v_windows) e
  LOOP
    BEGIN
      v_from := (r.w->>'from')::time;
      v_to   := (r.w->>'to')::time;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[prod_op_gate] unparseable blackout entry % — ignored', r.w;
      CONTINUE;
    END;
    IF v_from IS NULL OR v_to IS NULL OR v_from = v_to THEN CONTINUE; END IF;
    -- Occurrences starting from yesterday (a wrap window that began then may
    -- still be open) through the span's last day.
    FOR v_n IN -1 .. (((v_span_end AT TIME ZONE 'UTC')::date - v_day) + 1)
    LOOP
      v_occ_start := ((v_day + v_n::int) + v_from) AT TIME ZONE 'UTC';
      v_occ_end   := ((v_day + v_n::int + CASE WHEN v_to > v_from THEN 0 ELSE 1 END) + v_to) AT TIME ZONE 'UTC';
      IF v_occ_start < v_span_end AND v_occ_end > p_now THEN
        IF v_hit_end IS NULL OR v_occ_start < v_hit_end THEN
          v_hit_end  := v_occ_end;
          v_hit_desc := format('%s–%s UTC %s', v_from, v_to,
                               CASE WHEN v_occ_start <= p_now THEN 'is open now'
                                    ELSE format('opens %s, inside the span to %s',
                                                to_char(v_occ_start AT TIME ZONE 'UTC', 'HH24:MI'),
                                                to_char(v_span_end AT TIME ZONE 'UTC', 'HH24:MI')) END);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  IF v_hit_end IS NOT NULL THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'c', 'name', 'blackout',
      'detail', format('blackout %s; clear at %s', v_hit_desc,
                       to_char(v_hit_end AT TIME ZONE 'UTC', 'HH24:MI')),
      'retry_after', v_hit_end);
  END IF;
  v_readings := v_readings || jsonb_build_object('blackout', jsonb_build_object(
    'source', v_source, 'windows', v_windows,
    'now_utc', to_char(p_now AT TIME ZONE 'UTC', 'HH24:MI:SS')));

  -- ══ (d) watchdogs ═════════════════════════════════════════════════════════
  -- FIX-1194 (cc-153) — ONE scan of cron.job_run_details for every (d) reading,
  -- the probe's form (record_box_health, 20260920130000). As three statements
  -- these reads cost 112-133 ms on prod (the startup-timeout read alone 79-101
  -- ms: the planner evaluated the ILIKE before the start_time filter, on every
  -- row). One MATERIALIZED CTE on start_time over the longest (d) window, 1 day,
  -- with the predicate in its select list: 23-26 ms. Same windows, same keys.
  -- The watchdog rows round-trip through jsonb so the loop body is unchanged.
  WITH d AS MATERIALIZED (
    SELECT d.jobid, d.status, d.start_time, d.end_time,
           (d.status = 'failed' AND d.return_message ILIKE '%startup timeout%') AS startup_timeout
      FROM cron.job_run_details d
     WHERE d.start_time >  p_now - interval '1 day'
       AND d.start_time <= p_now
  ),
  wd AS (
    SELECT j.jobname,
           count(d.*) FILTER (WHERE d.start_time > p_now - interval '60 minutes')        AS runs_60m,
           round(max(EXTRACT(epoch FROM (COALESCE(d.end_time, p_now) - d.start_time)))
                   FILTER (WHERE d.start_time > p_now - interval '10 minutes')::numeric, 3) AS max_wall_10m_s,
           round(percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(epoch FROM (COALESCE(d.end_time, p_now) - d.start_time)))::numeric, 3)
                                                                                         AS median_wall_60m_s
      FROM cron.job j
      LEFT JOIN d
        ON d.jobid = j.jobid
       AND d.start_time >  p_now - interval '60 minutes'
     WHERE j.schedule = '*/2 * * * *' AND j.active
     GROUP BY j.jobname
  ),
  bo AS (
    SELECT j.jobname, b.budget_seconds,
           round(EXTRACT(epoch FROM (p_now - d.start_time)))::int AS age_s
      FROM d
      JOIN cron.job j              ON j.jobid   = d.jobid
      JOIN public.cron_job_budget b ON b.jobname = j.jobname
     WHERE d.status = 'running'
       AND EXTRACT(epoch FROM (p_now - d.start_time)) > b.budget_seconds
  )
  SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(wd) ORDER BY wd.jobname), '[]'::jsonb) FROM wd),
         (SELECT count(*) FROM d WHERE d.startup_timeout AND d.start_time > p_now - interval '60 minutes'),
         (SELECT max(d.start_time) FROM d WHERE d.startup_timeout AND d.start_time > p_now - interval '60 minutes'),
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'jobname', bo.jobname, 'age_seconds', bo.age_s, 'budget_seconds', bo.budget_seconds)), '[]'::jsonb)
            FROM bo)
    INTO v_wd_rows, v_n, v_t, v_json;

  FOR r IN
    SELECT x.jobname, x.runs_60m, x.max_wall_10m_s, x.median_wall_60m_s
      FROM jsonb_to_recordset(v_wd_rows)
           AS x(jobname text, runs_60m bigint, max_wall_10m_s numeric, median_wall_60m_s numeric)
     ORDER BY x.jobname
  LOOP
    v_wd_n := v_wd_n + 1;
    v_wd := v_wd || jsonb_build_object('jobname', r.jobname, 'runs_60m', r.runs_60m,
                                       'max_wall_10m_s', r.max_wall_10m_s,
                                       'median_wall_60m_s', r.median_wall_60m_s);
    IF r.runs_60m < c_wd_min_runs THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'd', 'name', r.jobname,
        'detail', format('%s ran %s times in the last 60 min; need >= %s', r.jobname, r.runs_60m, c_wd_min_runs),
        'retry_after', NULL);
    END IF;
    IF r.max_wall_10m_s > c_wd_max_wall_s THEN
      v_blocked := v_blocked || jsonb_build_object(
        'check', 'd', 'name', r.jobname,
        'detail', format('%s max wall %s s over the last 10 min; need <= %s s', r.jobname,
                         r.max_wall_10m_s, c_wd_max_wall_s),
        'retry_after', p_now + interval '10 minutes');
    END IF;
  END LOOP;
  IF v_wd_n = 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'no_watchdog',
      'detail', 'no active */2 watchdog job — nothing is enforcing cron budgets', 'retry_after', NULL);
  END IF;

  IF v_n > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'startup_timeout',
      'detail', format('%s job startup timeout failure(s) in the last 60 min, latest %s', v_n,
                       to_char(v_t AT TIME ZONE 'UTC', 'HH24:MI:SS')),
      'retry_after', v_t + interval '60 minutes');
  END IF;

  IF jsonb_array_length(v_json) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'd', 'name', 'budget_overrun',
      'detail', format('%s budgeted job(s) running past budget: %s', jsonb_array_length(v_json), v_json),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('watchdogs', jsonb_build_object(
    'jobs', v_wd, 'startup_timeouts_60m', v_n, 'budget_overruns', v_json));

  -- ══ (e) interlock ═════════════════════════════════════════════════════════
  v_pss := public.prod_session_state();
  IF (v_pss->>'held')::boolean THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'e', 'name', 'session_held',
      'detail', v_pss->>'reason_text', 'retry_after', NULL);
  END IF;
  IF jsonb_array_length(COALESCE(v_pss->'live_writers', '[]'::jsonb)) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'e', 'name', 'live_writers',
      'detail', format('live heavy writer(s): %s', v_pss->'live_writers'),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('interlock', jsonb_build_object(
    'held', v_pss->'held', 'live_writers', v_pss->'live_writers',
    'live_writer_detail', v_pss->'live_writer_detail', 'reason_text', v_pss->'reason_text'));

  -- ══ (f) stuck units — the guarded set, derived as Q_CRON_JOB_PIPELINES does ═
  -- The three patterns are byte-identical to RE_PROC_FROM_COMMAND,
  -- RE_COMMENT_ONLY_LINE, RE_PIPELINE_FROM_INSERT and RE_PIPELINE_FROM_LOCAL in
  -- packages/data/src/lib/cron-job-pipelines.ts (asserted by prod-op-gate.test.ts).
  WITH job AS (
    SELECT (regexp_match(j.command, '(?:CALL|SELECT)\s+(?:public\.)?([a-z_0-9]+)\s*\(', 'i'))[1] AS proc
      FROM cron.job j
  ), src AS (
    SELECT regexp_replace(pr.prosrc, '(?n)^[ \t]*--[^\n]*$', '', 'g') AS body,
           pr.prosrc AS raw
      FROM job
      JOIN pg_proc pr
        ON pr.proname = job.proc
       AND pr.pronamespace = 'public'::regnamespace
  )
  SELECT COALESCE(array_agg(DISTINCT p ORDER BY p), ARRAY[]::text[]) INTO v_guarded
    FROM (
      SELECT COALESCE(
               (regexp_match(body, 'data_sync_log\s*\([^)]*\)\s*VALUES\s*\(\s*''([a-z_0-9]+)''', 'i'))[1],
               (regexp_match(body, 'c_pipeline\s+text\s*:=\s*''([a-z_0-9]+)''', 'i'))[1]) AS p
        FROM src
       WHERE raw ILIKE '%prod_session_state%'
    ) g
   WHERE p IS NOT NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', d.pipeline, 'started_at', d.started_at,
           'age_minutes', round(EXTRACT(epoch FROM (p_now - d.started_at)) / 60)) ORDER BY d.started_at), '[]'::jsonb)
    INTO v_json
    FROM public.data_sync_log d
   WHERE d.status = 'running'
     AND d.pipeline = ANY (v_guarded)
     AND d.started_at < p_now - interval '60 minutes';
  IF jsonb_array_length(v_json) > 0 THEN
    v_blocked := v_blocked || jsonb_build_object(
      'check', 'f', 'name', 'stuck_units',
      'detail', format('%s guarded unit(s) running > 60 min: %s', jsonb_array_length(v_json), v_json),
      'retry_after', NULL);
  END IF;
  v_readings := v_readings || jsonb_build_object('stuck_units', jsonb_build_object(
    'guarded_pipelines', to_jsonb(v_guarded), 'stuck', v_json));

  RETURN jsonb_build_object(
    'ok',               jsonb_array_length(v_blocked) = 0,
    'checked_at',       p_now,
    'expected_seconds', p_expected_seconds,
    'span_end',         v_span_end,
    'blocked_by',       v_blocked,
    'readings',         v_readings);
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. record_box_health() — FIX-1194. postgres under pg_cron only.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.record_box_health(timestamptz) FROM service_role;
