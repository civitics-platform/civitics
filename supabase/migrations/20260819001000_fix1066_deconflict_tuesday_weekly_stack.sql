-- FIX-1066 — serialize the six WEEKLY jobs that share Tuesday 06:00-10:00 UTC
-- with the three DAILY ones.
--
-- ── THE MEASURED SHAPE (prod, Tuesday 2026-08-18) ───────────────────────────
-- Nine jobs fire inside four hours. This particular Tuesday also carried the
-- cc-65 phase-4 FEC backfill (03:54 -> 09:44), which is why it is the worst
-- instance observed rather than a typical one — but the STACK is structural and
-- fires every Tuesday regardless of what else is running.
--
--   06:00  jobid  9  refresh-derived-mvs-daily            1,355 s  ok
--   06:30  jobid 11  rule-taggers-daily                      21 s  STARVED
--   07:00  jobid 10  refresh-derived-mvs-weekly              11 s  STARVED
--   07:30  jobid 25  agency-staffing-rollup-refresh          10 s  STARVED
--   08:15  jobid 26  treemap-individuals-global-refresh   6,477 s  unbounded;
--                    took the public REST API down for 56 min (FIX-1063)
--   08:45  jobid 17  donor-party-rollup-refresh              10 s  STARVED
--   09:00  jobid 24  donor-rollup-refresh                 3,587 s  ok
--   09:00  jobid 13  financial-entity-totals-incremental  5,539 s  cancelled
--                    ^^ BOTH stamped 09:00:01 — a same-second collision every
--                       Tuesday between a daily job and a weekly one
--   10:00  jobid 12  rule-taggers-weekly                          server restarted
--
-- Four of the nine failed with pg_cron 'job startup timeout'. Per FIX-1052 that
-- is worker-LAUNCH starvation, not query cancellation — over 08-10..08-17 prod
-- logged 191 startup timeouts against only three real statement timeouts.
--
-- ── WHY MOVES ARE THE RIGHT INSTRUMENT HERE ────────────────────────────────
-- Six of the nine are WEEKLY. Their combined healthy runtime is ~2.5 h:
--
--   jobid 13  financial-entity-totals-incremental   healthy max 2,589 s
--   jobid 25  agency-staffing-rollup-refresh        healthy max 1,183 s
--   jobid 26  treemap-individuals-global-refresh    healthy max 1,638 s
--   jobid 17  donor-party-rollup-refresh            healthy max   420 s
--   jobid 12  rule-taggers-weekly                   healthy max 2,741 s
--
-- and Tuesday afternoon is empty apart from two 13-minute vacuum waves. There
-- is no dependency ordering among them — each reads committed upstream data
-- (financial_relationships, officials, agency FTE) that the Sunday ingest and
-- the daily nightly have already landed — so spreading them costs nothing and
-- turns six overlapping jobs into five serialized ones with >= 1 h of margin
-- between each finish and the next start.
--
-- ── PLACEMENT CONSTRAINTS OBSERVED ─────────────────────────────────────────
--   * jobid 24 donor-rollup-refresh fires DAILY at 09:00 and 12:00 — avoided.
--   * jobids 32..37 vacuum wave runs 11:05-11:18 and 17:05-17:18 daily — avoided.
--   * jobid 28 contract-flow-rollups is Thursday 14:00 — different day, no clash.
--   * jobid 16 entity-connection-stats-rebuild is Mon+Wed 16:00 (FIX-1052) —
--     different day, no clash.
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH ────────────────────────
-- EVERY job altered here is a TUESDAY job. Nothing on Wednesday changes, and in
-- particular jobids 2 and 22 (the entity-connections rebuild) are not touched at
-- all. Wednesday 2026-08-19 08:00 UTC is the DESIGNED first test of FIX-1056's
-- budget + per-arm resume checkpoint, and it is also the first real EC rebuild
-- exercise since 2026-07-29 (08-05 startup-timed-out, 08-12 was hand-paused).
-- Perturbing it would destroy that measurement.
--
-- jobid 9 (daily MVs) and jobid 10 (weekly MVs) are also left alone: FIX-1030's
-- unit watchdog bounds them per-unit and FIX-1033's lock-split constraint means
-- their shared advisory lock must keep the watchdog's in-flight state
-- single-slot. jobid 11 (rule-taggers-daily) stays because a daily job at 06:30
-- is not the problem — the weeklies piling onto it are.
--
-- alter_job by NAME (playbook D3), not unschedule+schedule: these jobs' entire
-- diagnosis rests on their cron.job_run_details history, and rescheduling would
-- mint new jobids and orphan it.
--
-- FIRST EXERCISE: Tuesday 2026-08-25. Read it together with FIX-1031's
-- jobid-13 re-measure, which lands on the same day and is now scheduled into a
-- quiet slot rather than a same-second collision with jobid 24.
--
-- Cross-ref FIX-1052 (the Monday/Wednesday half of this work), FIX-1063 (the
-- budgets that bound these same jobs), FIX-1031, FIX-1033, FIX-985, FIX-965.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_id  bigint;
  r     record;
  -- jobname, new schedule, old schedule (for the log line)
  moves text[][] := ARRAY[
    ['financial-entity-totals-incremental', '0 10 * * 2', '0 9 * * 2'],
    ['agency-staffing-rollup-refresh',      '0 13 * * 2', '30 7 * * 2'],
    ['treemap-individuals-global-refresh',  '0 14 * * 2', '15 8 * * 2'],
    ['donor-party-rollup-refresh',          '0 15 * * 2', '45 8 * * 2'],
    ['rule-taggers-weekly',                 '0 16 * * 2', '0 10 * * 2']
  ];
BEGIN
  FOR r IN SELECT moves[i][1] AS jobname, moves[i][2] AS new_sched, moves[i][3] AS old_sched
             FROM generate_subscripts(moves, 1) AS i
  LOOP
    SELECT jobid INTO v_id FROM cron.job WHERE jobname = r.jobname;
    IF v_id IS NULL THEN
      RAISE WARNING '[fix1066] job % not found — skipped', r.jobname;
      CONTINUE;
    END IF;
    PERFORM cron.alter_job(v_id, schedule := r.new_sched);
    RAISE NOTICE '[fix1066] % (jobid %) -> % (was %)', r.jobname, v_id, r.new_sched, r.old_sched;
  END LOOP;
END $$;

-- Guard: after this migration no two of the moved jobs may share a start minute,
-- and none may land back inside the 06:00-10:00 Tuesday peak. Cheap, and it
-- fails the migration rather than leaving a silent mis-edit on prod.
DO $$
DECLARE
  v_dupes int;
  v_peak  int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT schedule FROM cron.job
     WHERE jobname IN ('financial-entity-totals-incremental','agency-staffing-rollup-refresh',
                       'treemap-individuals-global-refresh','donor-party-rollup-refresh',
                       'rule-taggers-weekly')
     GROUP BY schedule HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION '[fix1066] % duplicate schedule(s) among the moved jobs', v_dupes;
  END IF;

  SELECT count(*) INTO v_peak FROM cron.job
   WHERE jobname IN ('agency-staffing-rollup-refresh','treemap-individuals-global-refresh',
                     'donor-party-rollup-refresh','rule-taggers-weekly')
     AND split_part(schedule, ' ', 2)::int BETWEEN 6 AND 10;
  IF v_peak > 0 THEN
    RAISE EXCEPTION '[fix1066] % job(s) still inside the 06:00-10:00 peak', v_peak;
  END IF;

  RAISE NOTICE '[fix1066] post-move guard passed';
END $$;
