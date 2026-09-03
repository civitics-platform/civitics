-- FIX-1141 — move `agency-staffing-rollup-refresh` out of Tuesday 13:00 UTC,
-- the single worst hour of the week for pg_cron worker-launch starvation.
--
-- Second half of FIX-1138's agency leg. FIX-987 made the run cheap; this makes
-- it START.
--
-- ── THE FAILURE, from cron.job_run_details on prod 2026-09-03 ────────────────
--   2026-09-01 13:00  failed     job startup timeout      10 s
--   2026-08-25 13:00  failed     job startup timeout      18 s
--   2026-08-18 07:30  failed     job startup timeout      10 s
--   2026-08-11 07:30  failed     job startup timeout      12 s
--   2026-08-04 07:30  succeeded                          196 s
--   2026-07-28 07:30  succeeded                        1,183 s
--   2026-07-21 07:30  succeeded                          547 s
--
-- Four consecutive failures, ALL FOUR at worker launch. `cron_job_budget_action`
-- holds exactly ONE row in its entire history and it belongs to
-- `rule-taggers-weekly`, so there has never been a budget cancel here; there
-- has never been a statement timeout either. Neither the 3,600 s budget nor the
-- runtime was ever the problem — and after FIX-987 the steady-state run is
-- milliseconds (21.7 ms measured on the clone, 6.5 ms on an empty dirty set).
-- Startup contention is the whole remaining cause.
--
-- ── THE MEASUREMENT FIX-1066 DID NOT HAVE ───────────────────────────────────
-- Share of ALL pg_cron firings that died with 'job startup timeout', by UTC
-- hour, TUESDAYS only, 56 days:
--
--   00-05h  0.0-0.5%      12h  35.3%
--   06h    21.5%          13h  47.3%   <-- where this job sits
--   07h    16.8%          14h  31.3%
--   08h    16.9%          15h  23.2%
--   09h    26.3%          16h  18.7%
--   10h    18.7%          17h  17.7%
--   11h    20.0%          18h   2.7%
--                         19-22h 0.0%    23h 3.8%
--
-- Nearly one firing in two. FIX-1066 moved this job 07:30 -> 13:00 on
-- 2026-08-19 to break up the Tuesday 06:00-10:00 weekly stack, and that
-- reasoning was correct for JOB-TO-JOB collision — Tuesday afternoon genuinely
-- is empty apart from the 11:05-11:20 and 17:05-17:20 vacuum waves. But it
-- optimised the wrong axis. The failure mode is box-level connection-accept
-- pressure (FIX-1052, FIX-1073), which is a property of the HOUR, not of which
-- sibling jobs share it. Both firings at the new slot died too. That is the
-- falsification, and this migration is the correction, not a revert.
--
-- ── THE NEW SLOT: `5 0 * * 2` — Tuesday 00:05 UTC ───────────────────────────
--   * HOUR 0 is 0.0% over 154 Tuesday firings AND 0.0% over 1,195 all-day
--     firings in the 21-day window — the only band clean on both.
--   * MINUTE 5 is ODD, so it clears the every-two-minute watchdogs (jobids 40
--     and 44 fire on even minutes only); it is not a multiple of 15 or 30, so
--     it clears ec-crawl (jobid 45, */15) and fe-crawl (jobid 46, */30); and no
--     other active job holds it.
--   * Hour 0 is outside the 09:00-17:40 UTC active-hours rule and outside the
--     05:45-09:00 ec_crawl blackout. That matters concretely: the FIRST firing
--     after FIX-987 takes the full path and re-baselines all 133 agencies
--     (196-1,183 s historically), so it belongs in the quietest window there is.
--
-- REJECTED: 10:15 UTC (18.7%), and worse than that number looks — jobid 24
-- `donor-rollup-refresh` regularly runs 4,400-6,700 s from its 09:00 daily
-- firing and is still inside its own run at 10:15.
--
-- ── alter_job BY NAME (playbook D3), never unschedule+schedule ───────────────
-- Every number above comes from this job's own `cron.job_run_details` history,
-- which is keyed on jobid. Rescheduling would mint a new jobid and orphan it.
-- The jobid is 25 on prod and 37 on local — which is exactly why the NAME is
-- the handle and the jobid is looked up, not hardcoded.
--
-- FIRST EXERCISE: Tuesday 2026-09-08 00:05 UTC. That firing is also the first
-- run of the FIX-987 body, so it takes the full path: expect
-- data_sync_log.metadata mode='full', agencies=133. The Tuesday after should
-- read mode='incremental' with a small dirty set.
--
-- Cross-ref FIX-1138 (stays OPEN — its treemap-individuals-global leg is
-- untouched and fails for an unrelated structural reason), FIX-987, FIX-1066,
-- FIX-1073, FIX-1052, FIX-1063, FIX-1137.
--
-- Fixes: FIX-1141
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_jobname  CONSTANT text := 'agency-staffing-rollup-refresh';
  c_new      CONSTANT text := '5 0 * * 2';
  v_id       bigint;
  v_old      text;
BEGIN
  SELECT jobid, schedule INTO v_id, v_old FROM cron.job WHERE jobname = c_jobname;

  IF v_id IS NULL THEN
    -- Not an error: a fresh local DB may not carry the cron catalogue yet.
    RAISE WARNING '[fix1141] job % not found — skipped', c_jobname;
    RETURN;
  END IF;

  PERFORM cron.alter_job(v_id, schedule := c_new);
  RAISE NOTICE '[fix1141] % (jobid %) -> % (was %)', c_jobname, v_id, c_new, v_old;
END $$;

-- Guard: fail the migration rather than leave a silent mis-edit on prod. Every
-- clause below is one of the placement constraints argued for in the header, so
-- a future edit that breaks one of them stops here instead of quietly landing
-- the job back in a starved minute.
DO $$
DECLARE
  c_jobname CONSTANT text := 'agency-staffing-rollup-refresh';
  v_sched   text;
  v_min     int;
  v_hour    int;
  v_clash   int;
BEGIN
  SELECT schedule INTO v_sched FROM cron.job WHERE jobname = c_jobname;
  IF v_sched IS NULL THEN
    RAISE NOTICE '[fix1141] job absent — guard skipped';
    RETURN;
  END IF;

  v_min  := split_part(v_sched, ' ', 1)::int;
  v_hour := split_part(v_sched, ' ', 2)::int;

  -- The quiet band: 18:00-05:59 UTC, measured at 0.0-3.8% startup timeouts.
  IF NOT (v_hour >= 18 OR v_hour <= 5) THEN
    RAISE EXCEPTION '[fix1141] % lands at hour % — outside the measured quiet band (18-05 UTC)',
      c_jobname, v_hour;
  END IF;

  -- Odd minute clears the */2 watchdogs (jobids 40, 44).
  IF v_min % 2 = 0 THEN
    RAISE EXCEPTION '[fix1141] % lands on even minute % — collides with the */2 watchdogs',
      c_jobname, v_min;
  END IF;

  -- Clear of ec-crawl (*/15) and fe-crawl (*/30).
  IF v_min % 15 = 0 THEN
    RAISE EXCEPTION '[fix1141] % lands on minute % — collides with ec-crawl/fe-crawl',
      c_jobname, v_min;
  END IF;

  -- No other ACTIVE job may hold the same schedule string.
  SELECT count(*) INTO v_clash FROM cron.job
   WHERE active AND jobname <> c_jobname AND schedule = v_sched;
  IF v_clash > 0 THEN
    RAISE EXCEPTION '[fix1141] % active job(s) already hold schedule %', v_clash, v_sched;
  END IF;

  RAISE NOTICE '[fix1141] post-move guard passed — % now at % (hour %, minute %)',
    c_jobname, v_sched, v_hour, v_min;
END $$;
