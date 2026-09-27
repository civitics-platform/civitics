-- =============================================================================
-- FIX-1239 — `votes` gets a vacuum owner: `votes-vacuum-analyze`, weekly,
-- Saturday 02:37 UTC.
--
-- THE FINDING (prod, read-only, cc-167 read 5, 2026-09-27 06:43 UTC).
--
--   pg_stat_user_tables  vacuum_count 0, autovacuum_count 0, last_vacuum NULL,
--                        last_autovacuum NULL, last_autoanalyze 2026-09-20 18:51
--   n_dead_tup 29,927   vs trigger 49,009 (reloptions
--                        autovacuum_vacuum_scale_factor=0.05: 50 + 0.05 x
--                        979,183) = 61.1 % — autovacuum is doing what it is
--                        told; the table is below its trigger
--   growth              +433/day on every pre-ec probe 09-21 -> 09-27, all of
--                        it rolled-back writes (FIX-1238); ~44 d to trigger
--   pg_class            relpages 73,085, relallvisible 60,343 = 82.6 %
--   size                heap 571 MB, indexes 502 MB
--
-- The 82.6 % that the pre-ec probe printed on all seven mornings is ONE reading:
-- record_vm_probe() reads pg_class.relallvisible/relpages, which only VACUUM and
-- ANALYZE refresh, and the last of either on `votes` was that 09-20 autoanalyze.
-- The live map can only be at or below it — only VACUUM sets all-visible bits.
-- That is rule 146's second case: not "autovacuum never reaches it" in the
-- sense of a mis-set trigger, but a visibility map that decays below a trigger
-- nothing is scheduled to cross.
--
-- WHO PAYS. The rule-taggers (cc-136 §3.4: `Index Only Scan using
-- votes_official_voted_at` — the only IOS in that plan, at 96.7 % then),
-- get_official_page's recent_votes (FIX-1180), vote-stats-refresh (03:30 daily).
--
-- WHY WEEKLY, WHY SATURDAY 02:37 (rule 143 — checked before it was written).
--   * Committed write volume is small (0-200 rows/day); the decay is slow, so a
--     weekly pass keeps the map near 100 %. A daily one would be FIX-1169's
--     question over again.
--   * Saturday: the Friday 21:00 UTC nightly carries the congressional week's
--     last votes ingest, and Saturday is the only weekday no dow-specific job
--     uses (prod cron.job read by NAME, 2026-09-27 06:47 UTC).
--   * 02:37: hour 02 is inside the measured quiet band; 37 is odd (the two */2
--     watchdogs) and not a multiple of 15 (ec-crawl/fe-crawl).
--     Neighbours: fe-inbound-rollup-refresh 13 2 * * * (0.8 s, -24 min),
--     vm-probe-pre-fr 55 2 * * * (+18 min), fr-vacuum-analyze 0 3 * * *
--     (+23 min; 14-d max wall 212 s). No other vacuum job fires on Saturday
--     before 03:00. Done before vote-stats-refresh (03:30) and before the
--     04:25 pre-ec probe, which therefore reads the post-vacuum state on
--     Saturday morning — that probe line is this job's receipt.
--
-- SHAPE. The fix975 shape: by NAME, cron.schedule when absent, alter_job IN
-- PLACE when present (a new jobid would discard the run history — FIX-968).
-- One statement per job — VACUUM cannot run in a transaction block, and a
-- multi-statement pg_cron command is one. VACUUM, never VACUUM FULL.
-- NO cron_job_budget row (rule 120): a bare VACUUM is not a unit the FIX-1063
-- watchdog should cancel, and none of the twelve sibling vacuum jobs has one.
-- prod_op_gate() finds it by `jobname ILIKE '%vacuum%'`; its look-ahead parses
-- daily schedules only, so this job reads as `unparsed` there, exactly like
-- officials-vacuum-analyze and dpr-vacuum-analyze.
--
-- The dead-tuple SOURCE is FIX-1238 (a roll that fails its FK every night).
-- Fixing that stops the growth; it does not re-set a map that has already
-- decayed, which is why the owner is needed either way.
-- =============================================================================

DO $$
DECLARE
  c_jobname CONSTANT text := 'votes-vacuum-analyze';
  c_sched   CONSTANT text := '37 2 * * 6';
  c_cmd     CONSTANT text := 'VACUUM (ANALYZE) public.votes;';
  v_jobid   bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE '[fix1239] pg_cron absent — votes-vacuum-analyze not scheduled';
    RETURN;
  END IF;

  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = c_jobname;
  IF v_jobid IS NULL THEN
    SELECT cron.schedule(c_jobname, c_sched, c_cmd) INTO v_jobid;
    RAISE NOTICE '[fix1239] scheduled % (jobid %) at %', c_jobname, v_jobid, c_sched;
  ELSE
    PERFORM cron.alter_job(job_id := v_jobid, schedule := c_sched, command := c_cmd);
    RAISE NOTICE '[fix1239] retuned % (jobid %) to %', c_jobname, v_jobid, c_sched;
  END IF;
END $$;

-- Guard: fail the migration rather than land the job in a slot the placement
-- rules refuse. The fix1221 checks restated (20260920160000), with two changes:
-- its cron_job_budget clause is inverted (rule 120 — a bare VACUUM carries
-- none), and a spacing clause is added — at least 10 minutes from every other
-- active *vacuum* job that fires on a day this one does (rule 155).
DO $$
DECLARE
  c_jobname CONSTANT text := 'votes-vacuum-analyze';
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
    RAISE NOTICE '[fix1239] pg_cron absent — placement guard skipped';
    RETURN;
  END IF;

  SELECT schedule, command INTO v_sched, v_cmd FROM cron.job WHERE jobname = c_jobname;
  IF v_sched IS NULL THEN
    RAISE EXCEPTION '[fix1239] % was not scheduled', c_jobname;
  END IF;
  IF v_sched !~ '^\d+ \d+ \* \* \d$' THEN
    RAISE EXCEPTION '[fix1239] % must be one fixed weekly slot, got %', c_jobname, v_sched;
  END IF;

  v_min  := split_part(v_sched, ' ', 1)::int;
  v_hour := split_part(v_sched, ' ', 2)::int;
  v_dow  := split_part(v_sched, ' ', 5);

  IF NOT (v_hour >= 18 OR v_hour <= 5) THEN
    RAISE EXCEPTION '[fix1239] % lands at hour % — outside the measured quiet band (18-05 UTC)', c_jobname, v_hour;
  END IF;
  IF v_min % 2 = 0 THEN
    RAISE EXCEPTION '[fix1239] % lands on even minute % — collides with the */2 watchdogs', c_jobname, v_min;
  END IF;
  IF v_min % 15 = 0 THEN
    RAISE EXCEPTION '[fix1239] % lands on minute % — collides with ec-crawl/fe-crawl', c_jobname, v_min;
  END IF;
  SELECT count(*) INTO v_clash FROM cron.job
   WHERE active AND jobname <> c_jobname AND schedule = v_sched;
  IF v_clash > 0 THEN
    RAISE EXCEPTION '[fix1239] % active job(s) already hold schedule %', v_clash, v_sched;
  END IF;
  IF position(';' IN rtrim(v_cmd, '; ')) > 0 THEN
    RAISE EXCEPTION '[fix1239] % command is not one statement: %', c_jobname, v_cmd;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cron_job_budget WHERE jobname = c_jobname) THEN
    RAISE EXCEPTION '[fix1239] % has a cron_job_budget row — a bare VACUUM carries none (rule 120)', c_jobname;
  END IF;

  -- Spacing: every other active vacuum job sharing a day with this one.
  -- Their schedules are all `<m> <h[,h]> * * <* | d[,d]>`; anything else fails
  -- closed, because a slot that cannot be checked has not been checked.
  FOR r IN
    SELECT jobname, schedule FROM cron.job
     WHERE active AND jobname <> c_jobname AND jobname ILIKE '%vacuum%'
  LOOP
    IF r.schedule !~ '^\d+ \d+(,\d+)* \* \* (\*|\d(,\d)*)$' THEN
      RAISE EXCEPTION '[fix1239] cannot check spacing against % (schedule %)', r.jobname, r.schedule;
    END IF;
    CONTINUE WHEN split_part(r.schedule, ' ', 5) <> '*'
              AND NOT (v_dow = ANY (string_to_array(split_part(r.schedule, ' ', 5), ',')));
    FOREACH v_h IN ARRAY string_to_array(split_part(r.schedule, ' ', 2), ',') LOOP
      v_gap := abs((v_h::int * 60 + split_part(r.schedule, ' ', 1)::int) - (v_hour * 60 + v_min));
      IF v_gap < 10 THEN
        RAISE EXCEPTION '[fix1239] % at % is % min from % (%) — rule 155 wants >= 10',
          c_jobname, v_sched, v_gap, r.jobname, r.schedule;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE '[fix1239] placement guard passed — % at % (hour %, minute %, dow %)',
    c_jobname, v_sched, v_hour, v_min, v_dow;
END $$;
