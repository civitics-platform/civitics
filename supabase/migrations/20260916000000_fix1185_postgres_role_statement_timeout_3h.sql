-- FIX-1185 — the postgres role's in-backend ceiling: 6h -> 3h, sized on the
-- TRAILING-30-DAY window, with the two active budgets it would otherwise
-- demote cut in the same change and the one unbudgeted job given a row.
--
-- WHAT THIS IS FOR. A pg_cron command with more than one statement runs in an
-- implicit transaction block, and a procedure cannot COMMIT inside one, so a
-- COMMITting pg_cron procedure CANNOT carry a per-job bound in its command
-- string (cc-125, docs/audits/2026-09-14-fix1128-half2-census.md section 4). A
-- role-level GUC is the only in-backend timer that arms across intra-procedure
-- COMMITs (cc-127 proved it on the clone's live scheduler,
-- docs/audits/2026-09-14-fix1185-ceiling.md section 4). The FIX-1063
-- cron_job_budget watchdog stays PRIMARY; this is the backstop for the two
-- cases it cannot cover: the box cannot fork (2026-08-29, 06:12->07:03, no
-- watchdog firing succeeded and the run went 21,638 s), and the watchdog late
-- by more than the budget's slack.
--
-- THE WINDOW, STATED. This number is sized on the TRAILING 30 DAYS
-- (2026-08-17 .. 2026-09-16), measured on prod 2026-09-16 from each
-- procedure's OWN terminal row in public.data_sync_log -- never from
-- cron.job_run_details.status, which records "succeeded" for a run the
-- procedure itself logged "partial" (refresh-derived-mvs-daily, 2026-08-31,
-- 21,919.4 s wall, canceled=true, units_ok 8/13).
--
--   30-day longest complete, per budgeted job:
--     run_rule_taggers (weekly)            4,837.7 s
--     donor_rollup_refresh                 4,405.8 s   (wall max 7,201.7 s, terminal "partial",
--                                                       stop_reason budget_exhausted -- FIX-973's
--                                                       2 h internal budget, a clean stop)
--     entity_connections_rebuild           2,654.1 s
--     contract_flow_rollups_rebuild        1,949.2 s
--     refresh_derived_mvs (weekly/daily)   1,620.9 / 1,394.4 s
--     everything else                      <= 1,084.0 s
--   Nothing in the window completes above 4,837.7 s. Single-statement exposure
--   (pg_stat_statements, postgres role, window from stats_reset
--   2026-09-15 15:09:48Z): exactly one statement past 1 h,
--   CALL public.run_rule_taggers($1) at 4,837.7 s.
--
-- THE SIX complete RUNS ABOVE 2.5 h, listed so the choice of window is visible
-- rather than implied (the first five are the pre-FIX-973 / pre-FIX-1002
-- regime and sit OUTSIDE this window -- they are the retained window's
-- evidence, not this one's):
--     entity_connection_stats_rebuild  2026-07-27   18,568.0 s
--     entity_connection_stats_rebuild  2026-08-03   14,931.3 s
--     run_rule_taggers                 2026-08-05   14,028.2 s
--     refresh_derived_mvs              2026-08-05   12,543.8 s
--     donor_rollup_refresh             2026-07-31   11,280.7 s
--     fec_bulk                         2026-08-19   10,390.9 s  <- INSIDE the window, but it is a
--                                                                  GHA PIPELINE wall over many
--                                                                  statements, not one statement;
--                                                                  a statement_timeout bounds a
--                                                                  statement. Its largest single
--                                                                  statement is nowhere near 3 h
--                                                                  (see the pgss read above).
--
-- THE ORDERING, AS NUMBERS (this is why the two budgets come down here and not
-- in a later change). A ceiling at or below an active job's budget silently
-- DEMOTES the watchdog for that job -- it would never cancel it again, and the
-- run would end on a global timer that records nothing job-specific. cc-127
-- section 3.1 found exactly that for two active jobs. So:
--
--   watchdog max lateness, trailing 30 days, re-derived as
--     acted_at - (job_run_details.start_time + budget_seconds)
--     over public.cron_job_budget_action  ................  963.8 s
--     (2026-08-24, rebuild-ec-incremental-mon; cc-125's 973.9 s is the
--      age_seconds form, which is measured at watchdog scan time)
--   ceiling 10,800 - 963.8  ..............................  9,836.2 s
--   largest ACTIVE budget after this migration  ..........  9,000 s
--   9,000 <= 9,836.2  -> the watchdog still fires first on every active job.
--
-- KNOWN AND ACCEPTED: the two INACTIVE rebuild-ec-incremental rows keep an
-- 18,000 s budget, which is now ABOVE the ceiling. They are inactive, so
-- nothing is demoted today; re-enabling either one is a decision that must
-- revisit its number first. Stated here so it is not discovered later.
--
-- PREVIOUS VALUE: 6h.  ROLLBACK IS
--     ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '6h';
-- and NEVER "RESET statement_timeout" -- a RESET removes the ceiling entirely
-- rather than restoring it.
--
-- NOT TOUCHED: work_mem=256MB on the same pg_db_role_setting row (the DO block
-- below reads the row back and proves it survived); every inactive budget row;
-- cron.job; any procedure. The ceiling is a DEFAULT, not a cap: a supervised
-- landing that legitimately needs more sets statement_timeout as its own
-- statement. A pg_cron job cannot, because its command must stay
-- single-statement. That asymmetry is the whole point.

ALTER ROLE postgres IN DATABASE postgres SET statement_timeout = '3h';

DO $$
DECLARE
  cfg text[];
BEGIN
  SELECT s.setconfig INTO cfg
    FROM pg_db_role_setting s
    JOIN pg_roles r    ON r.oid = s.setrole
    JOIN pg_database d ON d.oid = s.setdatabase
   WHERE r.rolname = 'postgres' AND d.datname = 'postgres';
  RAISE NOTICE 'FIX-1185 pg_db_role_setting(postgres@postgres) = %', cfg;
  IF NOT ('statement_timeout=3h' = ANY(cfg)) THEN
    RAISE EXCEPTION 'FIX-1185: statement_timeout=3h not present after ALTER ROLE (got %)', cfg;
  END IF;
  IF NOT ('work_mem=256MB' = ANY(cfg)) THEN
    RAISE EXCEPTION 'FIX-1185: work_mem=256MB did not survive the ALTER ROLE (got %)', cfg;
  END IF;
END $$;

-- The two active budgets the ceiling would otherwise demote. Both come DOWN to
-- 9,000 s so the ceiling stays the backstop and the watchdog stays primary.

UPDATE public.cron_job_budget
   SET budget_seconds = 9000,
       note = COALESCE(note, '')
              || ' FIX-1185: cut from 14400 so the 3 h role ceiling stays the backstop --'
              || ' 30-day max complete 4,405.8 s, 30-day max wall 7,201.7 s (terminal partial,'
              || ' = FIX-973 2 h internal budget). The 9,388 s pre-loop dirty-set observation'
              || ' recorded earlier in this note predates the window and is NOT covered by'
              || ' 9,000 s; the job is resumable, so a cancel resumes rather than loses work.',
       updated_at = now()
 WHERE jobname = 'donor-rollup-refresh';

UPDATE public.cron_job_budget
   SET budget_seconds = 9000,
       note = COALESCE(note, '')
              || ' FIX-1185: cut from 10800 -- it was EQUAL to the new ceiling, so the ceiling'
              || ' (which never waits for a */2 scan) would have won every time. 30-day max'
              || ' complete 1,920.1 s (last run 2026-09-10); all-time healthy 7,125.6 s.',
       updated_at = now()
 WHERE jobname = 'contract-flow-rollups-refresh';

-- The longest clean completion on prod had no budget row at all: the only thing
-- that has ever bounded it is the role default (cc-127 section 3.3). It is
-- INACTIVE today; the row exists so that re-enabling it is a decision about a
-- number rather than a silent return to the ceiling.

INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES ('entity-connection-stats-rebuild', 9000,
        'FIX-1185: no row existed; 18,568.0 s (2026-07-27) / 14,931.3 s (2026-08-03) clean runs. '
        || 'Inactive. Re-enabling requires a windowed shape that completes under 9,000 s or its '
        || 'own supervised bound -- not a larger budget.')
ON CONFLICT (jobname) DO NOTHING;
