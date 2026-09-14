-- FIX-1128 Half 2 — what survives the refutation.
--
-- Half 2's plan was to put the bound in each pg_cron job's command string:
--     SET statement_timeout = '<N>'; CALL public.<proc>(...)
-- It does not work, and this migration does not do it. Measured on the clone's
-- live scheduler, recorded in
-- docs/audits/2026-09-14-fix1128-half2-census.md section 4:
--
--   SET statement_timeout = '10s'; CALL public._fix1128_probe_units(5, 4);
--     -> failed at 0.008-0.018 s, "invalid transaction termination", 0 units run
--   SELECT 1;                      CALL public._fix1128_probe_units(3, 1);
--     -> failed at 0.013 s, identical error
--   CALL public._fix1128_probe_units(3, 1);
--     -> succeeded, 3.027 s, all units run
--
-- It is not the SET. A pg_cron command with more than one statement runs in an
-- IMPLICIT TRANSACTION BLOCK, and a procedure cannot COMMIT inside one. All six
-- census procedures COMMIT internally -- that is why they are procedures. So the
-- command-string form would not bound them, it would stop them.
--
-- The FIX-1063 watchdog therefore remains the ONLY per-job bound. Which makes
-- the one job in the census with no budget row the only thing here worth
-- landing.
--
-- Nothing in this file redefines a procedure. H2's record-and-STOP handler shape
-- is already built in all three C1 procedures (FIX-1021 / 1028 / 1056 / 1111 /
-- 1112) and the three C2 procedures have no EXCEPTION block at all, so a cancel
-- rolls their single transaction back whole.


-- ── 1/2 · cron_job_budget for rule-taggers-daily (FIX-1125's outside backstop)
--
-- Nine of the ten census jobs carry a budget row. `rule-taggers-daily` is the
-- one that does not, so today it has NO bound below the postgres role's 6 h.
-- (FIX-1125 recorded the gap as `refresh-derived-mvs-daily`; that job has had a
-- row since 2026-08-31 -- FIX-1123 added it. The gap is this one.)
--
-- 7200 s, matching its sibling `rule-taggers-weekly`, which has carried exactly
-- that since 2026-08-19: same procedure, same code path either side of one
-- cadence branch. `run_rule_taggers` has no internal predictive budget of its
-- own to derive from.
--
-- Headroom against the measured series (cron.job_run_details, whole retained
-- window, 72 runs):
--   30-day healthy range   674.5 - 899.5 s   -> 7200 is 8.0x the worst
--   all-time healthy max   1277.1 s (08-04)  -> 7200 is 5.6x
--   the one outlier        14028.2 s (08-05) -> 7200 WOULD have cancelled it
--
-- That outlier is contention, not work, and it is the reason for the row rather
-- than an argument against it. The data_sync_log rows for the three mornings
-- either side wrote the same tags:
--   2026-08-04   708,194 tags in  1,277.1 s
--   2026-08-05   691,277 tags in 14,028.2 s   <- same work, 27x the time
--   2026-08-09   689,966 tags in    523.9 s
-- 2026-08-05 is the same platform-wide bad morning that took
-- refresh-derived-mvs-daily to 12,546.6 s.
--
-- A cancel here is SAFE. `run_rule_taggers('daily')` is one ungated rebuild of
-- pre_vote_timing tags inside a subtransaction with a by-name query_canceled
-- handler: the cancel rolls the rebuild back, the handler records it
-- ('partial', metadata.canceled), and the next morning's firing redoes the same
-- work from scratch. Nothing is banked, so nothing is lost.
--
-- To revert: DELETE FROM public.cron_job_budget WHERE jobname = 'rule-taggers-daily';

INSERT INTO public.cron_job_budget (jobname, budget_seconds, note)
VALUES (
  'rule-taggers-daily',
  7200,
  'FIX-1128 Half 2. The last census job with no outside bound, and the command-string '
  || 'bound that was meant to cover it is unbuildable (a multi-statement pg_cron command '
  || 'runs in an implicit transaction block and this procedure COMMITs). Sized at its '
  || 'sibling rule-taggers-weekly''s 7200 s -- same procedure, one cadence branch apart; '
  || 'run_rule_taggers carries no internal budget to derive from. 30-day healthy range '
  || '674.5-899.5 s, all-time healthy max 1277.1 s (2026-08-04). The 14,028.2 s run of '
  || '2026-08-05 is contention, not work: it wrote 691,277 tags where 08-04 wrote 708,194 '
  || 'in 1,277.1 s. A cancel is SAFE -- the rebuild is ungated and rolls back whole, and '
  || 'the next morning redoes it.'
)
ON CONFLICT (jobname) DO NOTHING;


-- ── 2/2 · drop the probe (H5) ───────────────────────────────────────────────
--
-- cc-124 added _fix1128_probe_sleep(int) to measure whether a statement_timeout
-- could be armed from inside a routine. It answered that (no, both directions)
-- and it answered the command-string question above (B1: cancelled at 3.006 s
-- under `SET statement_timeout = '3s'; SELECT public._fix1128_probe_sleep(20);`
-- on the clone's live scheduler). Both answers are recorded in
-- docs/audits/2026-09-13-fix1128-experiments.md and the Half 2 census.
--
-- It is service_role-EXECUTE only and not reachable from the front door, but a
-- sleep function is a trivial resource-exhaustion primitive if a service_role
-- key ever leaks, and there is no reason to keep one standing. Re-creating it is
-- one line if a later half needs it again.

DROP FUNCTION IF EXISTS public._fix1128_probe_sleep(int);


-- ── post-conditions ─────────────────────────────────────────────────────────
-- Fail the migration rather than leave a half-applied state on prod.

DO $$
DECLARE
  v_budget int;
  v_probe  int;
BEGIN
  SELECT budget_seconds INTO v_budget
  FROM public.cron_job_budget WHERE jobname = 'rule-taggers-daily';

  IF v_budget IS DISTINCT FROM 7200 THEN
    RAISE EXCEPTION '[fix1128] rule-taggers-daily budget is %, expected 7200',
      COALESCE(v_budget::text, '(no row)');
  END IF;

  SELECT count(*) INTO v_probe
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = '_fix1128_probe_sleep';

  IF v_probe <> 0 THEN
    RAISE EXCEPTION '[fix1128] _fix1128_probe_sleep still present (% overload(s))', v_probe;
  END IF;

  RAISE NOTICE '[fix1128] rule-taggers-daily budget 7200s; _fix1128_probe_sleep dropped.';
END $$;
