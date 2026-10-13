-- =============================================================================
-- FIX-1299 — `external_source_refs` gets a vacuum owner: `xsr-vacuum-analyze`,
-- weekly, Tuesday 01:41 UTC.
--
-- THE FINDING (FIX-1299's bullet, prod read-only, cc-214, 2026-10-10 ~20:45Z).
--
--   pg_stat_user_tables  599,207 live / 5,601 dead, last_vacuum NULL,
--                        last_autovacuum 2026-09-29 21:04:58Z,
--                        last_autoanalyze 2026-10-08 17:56:27Z (during the
--                        USASpending run)
--
-- Prod carries thirteen VACUUM (ANALYZE) pg_cron jobs and none covers xsr,
-- although every USASpending flush and the FEC / LittleSis writers insert into
-- it, and the recipient-resolution lookup (source + external_id = ANY) reads it
-- on every 1,000-row flush.
--
-- Re-read by cc-219 (2026-10-13 00:4xZ): pg_stat_user_tables now says 1 live /
-- 339 dead with every last_* NULL. That is not the table; it is the 04:11:32Z
-- 10-12 postmaster restart (cc-229), which reset the cumulative stats. pg_class
-- still reads reltuples 609,548, 14,308 pages (112 MB heap, 232 MB total). A
-- stats reset makes autovacuum's trigger arithmetic start again from zero, so
-- until enough new churn accrues nothing autovacuums this table at all — one
-- more reason it needs a scheduled owner.
--
-- SIZE. The clone's xsr (reltuples 580,417, 13,552 pages, 213 MB total), timed
-- by cc-219 with `db-query.mjs --local --call "VACUUM (ANALYZE) …"`: 0.73 s
-- client wall (last_vacuum 00:48:28.498Z, last_analyze 00:48:29.076Z). The
-- clone was all-visible with 0 dead, so that is the floor; prod's first firing
-- will clean the drop night's churn and should still be seconds. The
-- provisional bands.json entry is taken from that first prod firing (the
-- votes-vacuum precedent: hi_s = first wall + 15 %), by cc-220, not here.
--
-- WHY WEEKLY, WHY TUESDAY 01:41 (rule D3: prod cron.job read by NAME,
-- 2026-10-13 00:4xZ, 41 active jobs).
--   * Tuesday: after the Monday 21:00 UTC drop nightly, which carries the
--     week's FEC writes and so the week's xsr inserts.
--   * 01:41: hour 01 is inside the measured quiet band; 41 is odd (the two */2
--     watchdogs) and not a multiple of 15 (ec-crawl / fe-crawl).
--   * The vacuum family on a Tuesday: fr-vacuum-analyze 03:00 (+79 min),
--     ec 04:30, fe 04:50, and the 11:xx / 17:xx rollup series — all >= 10 min
--     away (rule 155). officials-vacuum-analyze is Mon 01:30, dpr-vacuum-analyze
--     Sun/Wed 02:00, votes-vacuum-analyze Sat 02:37: different days.
--   * Other neighbours (not vacuums): refresh-derived-mvs-weekly Tue 00:47
--     (1,341.4 / 1,593.2 / 1,407.5 s on 09-22 / 09-29 / 10-06, so done by
--     ~01:14Z, >= 27 min clear); cron-job-run-details-retention 01:51 daily
--     (0.1–0.7 s); fe-inbound-rollup-refresh 02:13 daily.
--
-- SHAPE. fix1239's (20260927010100), verbatim: by NAME, cron.schedule when
-- absent, alter_job IN PLACE when present (a new jobid would discard the run
-- history — FIX-968). One statement — VACUUM cannot run in a transaction block,
-- and a multi-statement pg_cron command is one. VACUUM, never VACUUM FULL.
--
-- NO cron_job_budget row (rule 120). FIX-1299's bullet asks for one; that is
-- wrong. A bare VACUUM is not a unit the FIX-1063 watchdog should cancel,
-- enforce_cron_job_budgets() only cancels CALLs (so the row would be inert),
-- none of the thirteen sibling vacuum jobs has one, and the placement guard
-- below RAISES if one exists.
--
-- NO rollup_watch_overrides row either. A bare VACUUM writes no data_sync_log
-- row (packages/data/src/lib/cron-job-pipelines.ts:18-19 — `proc IS NULL`), so
-- list_scheduled_rollup_pipelines() does not list it and there is nothing for
-- the freshness watch to override.
--
-- FIX-1274's usaspending tail keeps its `VACUUM (ANALYZE) external_source_refs`:
-- it is cheap and idempotent, and it covers the landing's own completion. It is
-- not an owner (it does not run on the kill path); this job is.
--
-- ROLLBACK: SELECT cron.unschedule('xsr-vacuum-analyze');
-- =============================================================================

DO $$
DECLARE
  c_jobname CONSTANT text := 'xsr-vacuum-analyze';
  c_sched   CONSTANT text := '41 1 * * 2';
  c_cmd     CONSTANT text := 'VACUUM (ANALYZE) public.external_source_refs;';
  v_jobid   bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE '[fix1299] pg_cron absent — xsr-vacuum-analyze not scheduled';
    RETURN;
  END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = c_jobname;
  IF v_jobid IS NULL THEN
    SELECT cron.schedule(c_jobname, c_sched, c_cmd) INTO v_jobid;
    RAISE NOTICE '[fix1299] scheduled % (jobid %) at %', c_jobname, v_jobid, c_sched;
  ELSE
    PERFORM cron.alter_job(job_id := v_jobid, schedule := c_sched, command := c_cmd);
    RAISE NOTICE '[fix1299] retuned % (jobid %) to %', c_jobname, v_jobid, c_sched;
  END IF;
END $$;

-- Guard: fail the migration rather than land the job in a slot the placement
-- rules refuse. fix1239's guard (20260927010100:88-162), restated: one fixed
-- weekly slot, hour in 18-05 UTC, an odd minute not a multiple of 15, no other
-- active job on the identical schedule, a single-statement command, NO
-- cron_job_budget row (rule 120), and >= 10 min from every other active
-- *vacuum* job that fires on a day this one does (rule 155).
DO $$
DECLARE
  c_jobname CONSTANT text := 'xsr-vacuum-analyze';
  v_sched   text;
  v_cmd     text;
  v_min     int;
  v_hour    int;
  v_dow     text;
  v_clash   int;
  r         record;
  v_h       text;
  v_gap     int;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE '[fix1299] pg_cron absent — placement guard skipped';
    RETURN;
  END IF;

  SELECT schedule, command INTO v_sched, v_cmd FROM cron.job WHERE jobname = c_jobname;
  IF v_sched IS NULL THEN
    RAISE EXCEPTION '[fix1299] % was not scheduled', c_jobname;
  END IF;
  IF v_sched !~ '^\d+ \d+ \* \* \d$' THEN
    RAISE EXCEPTION '[fix1299] % must be one fixed weekly slot, got %', c_jobname, v_sched;
  END IF;

  v_min  := split_part(v_sched, ' ', 1)::int;
  v_hour := split_part(v_sched, ' ', 2)::int;
  v_dow  := split_part(v_sched, ' ', 5);

  IF NOT (v_hour >= 18 OR v_hour <= 5) THEN
    RAISE EXCEPTION '[fix1299] % lands at hour % — outside the measured quiet band (18-05 UTC)', c_jobname, v_hour;
  END IF;
  IF v_min % 2 = 0 THEN
    RAISE EXCEPTION '[fix1299] % lands on even minute % — collides with the */2 watchdogs', c_jobname, v_min;
  END IF;
  IF v_min % 15 = 0 THEN
    RAISE EXCEPTION '[fix1299] % lands on minute % — collides with ec-crawl/fe-crawl', c_jobname, v_min;
  END IF;
  SELECT count(*) INTO v_clash FROM cron.job
   WHERE active AND jobname <> c_jobname AND schedule = v_sched;
  IF v_clash > 0 THEN
    RAISE EXCEPTION '[fix1299] % active job(s) already hold schedule %', v_clash, v_sched;
  END IF;
  IF position(';' IN rtrim(v_cmd, '; ')) > 0 THEN
    RAISE EXCEPTION '[fix1299] % command is not one statement: %', c_jobname, v_cmd;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cron_job_budget WHERE jobname = c_jobname) THEN
    RAISE EXCEPTION '[fix1299] % has a cron_job_budget row — a bare VACUUM carries none (rule 120)', c_jobname;
  END IF;

  -- Spacing: every other active vacuum job sharing a day with this one.
  -- Their schedules are all `<m> <h[,h]> * * <* | d[,d]>`; anything else fails
  -- closed, because a slot that cannot be checked has not been checked.
  FOR r IN
    SELECT jobname, schedule FROM cron.job
     WHERE active AND jobname <> c_jobname AND jobname ILIKE '%vacuum%'
  LOOP
    IF r.schedule !~ '^\d+ \d+(,\d+)* \* \* (\*|\d(,\d)*)$' THEN
      RAISE EXCEPTION '[fix1299] cannot check spacing against % (schedule %)', r.jobname, r.schedule;
    END IF;
    CONTINUE WHEN split_part(r.schedule, ' ', 5) <> '*'
              AND NOT (v_dow = ANY (string_to_array(split_part(r.schedule, ' ', 5), ',')));
    FOREACH v_h IN ARRAY string_to_array(split_part(r.schedule, ' ', 2), ',') LOOP
      v_gap := abs((v_h::int * 60 + split_part(r.schedule, ' ', 1)::int) - (v_hour * 60 + v_min));
      IF v_gap < 10 THEN
        RAISE EXCEPTION '[fix1299] % at % is % min from % (%) — rule 155 wants >= 10',
          c_jobname, v_sched, v_gap, r.jobname, r.schedule;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '[fix1299] placement guard passed — % at % (hour %, minute %, dow %)',
    c_jobname, v_sched, v_hour, v_min, v_dow;
END $$;
