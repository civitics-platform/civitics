-- FIX-1063 — bound the CALL-shaped pg_cron jobs.
--
-- THE INCIDENT (prod, 2026-08-18 09:45-10:41 UTC). PostgREST returned 503
-- PGRST002 for ~56 minutes. refresh_treemap_individuals_global(), fired by
-- pg_cron job 26 at 08:15, was still running at 10:02 — and starved the box so
-- badly that the catalog query PostgREST needs to build its schema cache timed
-- out (SELECT count(*) FROM pg_proc JOIN pg_namespace FAILED 57014 at
-- 60,247 ms). No schema cache, no data layer.
--
-- ── THE FIX SHAPE IN FIX-1063'S BULLET DOES NOT WORK ────────────────────────
-- The bullet proposes putting the bound in the job COMMAND:
--     SET statement_timeout='<ms>'; CALL public.foo();
-- MEASURED on local (pg_cron 1.6.4, cron.use_background_workers=off — the SAME
-- setting prod runs), three probe jobs scheduled and left to fire:
--
--   t1063-bare     CALL public._t1063_proc(0.1);                    succeeded
--   t1063-setcall  SET statement_timeout='9000'; CALL public._t1063_proc(0.1);
--                                                                   FAILED
--                  ERROR: invalid transaction termination
--                  CONTEXT: PL/pgSQL function _t1063_proc line 4 at COMMIT
--   t1063-wrapped  DO $$BEGIN PERFORM 1; END$$;                     succeeded
--
-- WHY: with cron.use_background_workers=off, pg_cron sends the job command to a
-- libpq connection as ONE simple-query message. Multiple statements in one
-- simple query execute inside an IMPLICIT TRANSACTION BLOCK, and a procedure
-- cannot execute transaction control inside a transaction block. SIX of the
-- seven jobs this FIX targets contain COMMIT:
--
--   refresh_agency_staffing_rollup               COMMIT
--   refresh_donor_party_rollup_incremental       COMMIT
--   refresh_financial_entity_totals_incremental  COMMIT
--   refresh_official_donor_rollup_incremental    COMMIT
--   refresh_treemap_individuals_global           COMMIT
--   run_rule_taggers                             COMMIT
--   refresh_contract_flow_rollups                (no COMMIT — would have worked)
--
-- So shipping the bullet's shape would have converted a job that runs too long
-- into a job that fails instantly, every firing, on six of seven targets.
--
-- The bullet's fallback — "wrap in a SECURITY DEFINER function whose ALTER
-- FUNCTION SET statement_timeout applies at the outermost call" — is ALSO
-- measured-false. Probe, same box, session statement_timeout=0:
--
--   CREATE FUNCTION _t1063_fn() ... SET statement_timeout='2000'
--     AS $$ BEGIN PERFORM pg_sleep(5); RETURN 'slept-5s-no-timeout'; END $$;
--   SELECT public._t1063_fn();   ->  'slept-5s-no-timeout'
--
-- statement_timeout is armed ONCE, in start_xact_command(), before the CALL
-- executes. Neither proconfig at function entry, nor SET inside the body, nor
-- the new transaction that a procedure's COMMIT starts, re-arms that timer.
-- FIX-1056 found this; the FIX-1030 migration already states it in a comment
-- (line 347: "statement_timeout is armed once at CALL time and neither SET nor
-- SET LOCAL re-arms it across a procedure's COMMIT (verified on PG 17)").
--
-- ── THEREFORE: THE ESTABLISHED PATTERN, GENERALISED ─────────────────────────
-- A CALL cannot bound itself. FIX-1030 already solved this for ONE job family
-- by bounding it FROM OUTSIDE: enforce_derived_mvs_unit_budget() + a 2-minute
-- pg_cron job that cancels the published backend. This migration generalises
-- that to any pg_cron job, with two improvements:
--
--   * it keys off cron.job_run_details, whose job_pid column is written by
--     pg_cron itself — so the target job needs NO instrumentation and no
--     cooperating procedure (the FIX-1030 watchdog needs the procedure to
--     publish backend_pid into data_sync_log metadata; most jobs do not);
--   * budgets live in a TABLE, so re-tuning one is an UPDATE, not a migration.
--
-- Nothing about any existing job's command, schedule, or procedure changes.
-- This migration is purely additive: a table, a ledger, a function, one job.
--
-- ── THE ONLY CEILING TODAY IS 6 HOURS, AND IT IS GLOBAL ─────────────────────
--   SHOW statement_timeout  ->  21600000   (6 h, cluster-wide)
-- Every CALL job inherits it. That is why so many rows in job_run_details land
-- at 21,6xx s: 08-04 job 17 (21,629 s), 08-04 job 26 (21,616 s), 07-27..07-30
-- job 24 (21,600-22,080 s), 08-17 job 22 (21,615 s). Six hours is not a bound,
-- it is the absence of one.
--
-- ── BUDGET SIZING (from each job's OWN cron.job_run_details history) ────────
-- Rule: healthy max x ~1.5-4, rounded, every value far below the 6 h ceiling.
-- Deliberately generous — per FIX-1021's header, "a breaker that trips every
-- Tuesday is a breaker nobody should have shipped".
--
--   job 17 donor-party-rollup-refresh        healthy 352/388/420 s   -> 1800 s
--   job 25 agency-staffing-rollup-refresh    healthy 196/547/1183 s  -> 3600 s
--   job 26 treemap-individuals-global        healthy 1500/1638 s     -> 5400 s
--   job 28 contract-flow-rollups-refresh     healthy 986/1053/7126 s -> 10800 s
--   job 13 financial-entity-totals-incr      healthy max 2589 s      -> 7200 s
--   job 12 rule-taggers-weekly               healthy max 2741 s      -> 7200 s
--   job 24 donor-rollup-refresh              healthy max 9388 s post
--          -FIX-1002                                                 -> 14400 s
--
-- job 24 deserves a note. FIX-1002 gave it a 2 h INTERNAL budget and it is
-- resumable, so this is a backstop, not the primary bound: 14400 s sits well
-- above the internal budget so the internal one always wins on a healthy run.
-- It is needed anyway because FIX-1018 established that job 24's cost is the
-- PRE-LOOP dirty-set build, which happens before the budget loop can evaluate
-- anything — 9,388 s and 8,234 s runs post-FIX-1002 are that phase overrunning.
--
-- ── JOBS DELIBERATELY NOT GIVEN A BUDGET (each for a stated reason) ─────────
--   2, 22  rebuild-ec-incremental{,-mon}  FIX-1056 shipped its budget and
--          per-arm resume checkpoint on 08-18, and Wednesday 08-19 08:00 UTC is
--          the DESIGNED first test of it. A second, outside canceller racing
--          that test would destroy the measurement. Do not add these until the
--          08-19 read is in.
--   9, 10  refresh-derived-mvs-{daily,weekly}  already bounded per-UNIT by
--          FIX-1030's watchdog (job 40). Two independent cancellers on one
--          backend is a race, and the per-unit bound is strictly better than a
--          whole-run bound. Note the FIX-1033 lock-split constraint too.
--   11     rule-taggers-daily  healthy runs reach 14,028 s (3.9 h). A bound
--          here would be a guess, not a sizing. Needs its own investigation.
--   16     entity-connection-stats-rebuild  healthy max 18,568 s (5.2 h) — it
--          genuinely lives near the ceiling. Same: size it first.
--   14,15,18,19,23,27,29  every run ever recorded is under 300 s (most under
--          60 s). No evidence of risk; adding budgets would be ceremony.
--
-- Cross-ref FIX-1056 (the re-arm finding), FIX-1030 (the pattern), FIX-1021,
-- FIX-1002/1003 (job 24's internal budget), FIX-1018, FIX-1028 (the
-- query_canceled handlers the cancel lands in), FIX-965, FIX-985, FIX-1065.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The budget registry.
--
--    A row here is the statement "this job may run this long". Absence of a row
--    means "unbounded except by the 6 h cluster ceiling" — which is the status
--    quo for every job, so adding this table changes nothing until rows land.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cron_job_budget (
  jobname         text PRIMARY KEY,
  budget_seconds  int  NOT NULL CHECK (budget_seconds > 0),
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cron_job_budget IS
  'FIX-1063 — per-pg_cron-job wall-clock budget in seconds, enforced from '
  'outside by enforce_cron_job_budgets(). A job with no row here is bounded '
  'only by the 6h cluster statement_timeout. Re-tune with UPDATE; sizing must '
  'come from that job''s own cron.job_run_details history, not from its cron '
  'expression (playbook D2).';

COMMENT ON COLUMN public.cron_job_budget.jobname IS
  'cron.job.jobname. Matched by NAME, not jobid, so the budget survives a '
  'reschedule that changes the jobid.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The action ledger — the cancel-at-most-once-per-run guard.
--
--    FIX-1030's header explains why this matters and it applies verbatim here:
--    without it the watchdog fires again two minutes later and cancels the
--    procedure's own bookkeeping UPDATE, turning a clean 'partial' close back
--    into the stranded 'running' row this whole line of work exists to remove.
--    Keying on runid (unique per firing) makes "once" exact.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cron_job_budget_action (
  runid           bigint PRIMARY KEY,
  jobid           bigint      NOT NULL,
  jobname         text        NOT NULL,
  job_pid         int,
  age_seconds     numeric,
  budget_seconds  int,
  signaled        boolean,
  acted_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cron_job_budget_action_acted_at_idx
  ON public.cron_job_budget_action (acted_at DESC);

COMMENT ON TABLE public.cron_job_budget_action IS
  'FIX-1063 — append-only record of every budget cancellation, one row per '
  'pg_cron runid. Doubles as the once-per-run guard: a runid present here is '
  'never cancelled again.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The watchdog.
--
--    Every unsatisfied check refuses to cancel (FIX-1030's rule). The liveness
--    guard is the important one: pids are recycled, so cancelling on a stale
--    pid alone could signal an unrelated backend. Three independent conditions
--    must all hold before pg_cancel_backend is called —
--      (a) the pid is a live, non-idle backend in this database;
--      (b) its backend_start is close to the run's start_time. NOT an equality:
--          with use_background_workers=off pg_cron stamps start_time and THEN
--          dials the libpq connection, so backend_start is reliably a few ms
--          LATER. A strict `backend_start <= start_time` would never match and
--          the watchdog would silently never fire. The tolerance below is safe
--          because any run reaching this line has already outlived a budget of
--          at least 1800 s, so a recycled pid's backend_start would miss by
--          half an hour, not by two minutes;
--      (c) its current query still names the procedure this job CALLs.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_cron_job_budgets()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  r          record;
  v_target   text;
  v_signaled boolean;
  v_acted    jsonb := '[]'::jsonb;
  v_checked  int   := 0;
BEGIN
  FOR r IN
    SELECT d.runid,
           d.jobid,
           j.jobname,
           j.command,
           d.job_pid,
           d.start_time,
           b.budget_seconds,
           EXTRACT(epoch FROM (clock_timestamp() - d.start_time)) AS age
    FROM cron.job_run_details d
    JOIN cron.job              j ON j.jobid   = d.jobid
    JOIN public.cron_job_budget b ON b.jobname = j.jobname
    WHERE d.status = 'running'
    ORDER BY d.start_time
  LOOP
    v_checked := v_checked + 1;

    -- within budget: nothing to do
    CONTINUE WHEN r.age <= r.budget_seconds;

    -- already cancelled this firing
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.cron_job_budget_action a WHERE a.runid = r.runid
    );

    -- pg_cron did not record a pid for this run
    CONTINUE WHEN r.job_pid IS NULL;

    -- The procedure this job CALLs, e.g. 'public.refresh_treemap_individuals_global'.
    v_target := substring(r.command from 'CALL\s+([a-zA-Z0-9_."]+)');
    CONTINUE WHEN v_target IS NULL;

    PERFORM 1
    FROM pg_stat_activity a
    WHERE a.pid           = r.job_pid
      AND a.datname       = current_database()
      AND a.state        <> 'idle'
      AND a.backend_start <= r.start_time + interval '2 minutes'
      AND a.query ILIKE '%' || v_target || '%';

    CONTINUE WHEN NOT FOUND;

    -- The cancel lands in the target procedure's FIX-1028 / FIX-1021
    -- `WHEN query_canceled` handler, which closes its data_sync_log row
    -- 'partial' rather than leaving it stranded 'running'.
    v_signaled := pg_cancel_backend(r.job_pid);

    INSERT INTO public.cron_job_budget_action
      (runid, jobid, jobname, job_pid, age_seconds, budget_seconds, signaled)
    VALUES
      (r.runid, r.jobid, r.jobname, r.job_pid, round(r.age, 1), r.budget_seconds, v_signaled);

    RAISE WARNING '[cron-budget watchdog] cancelled % (jobid %, runid %, pid %) after %s — budget %s',
      r.jobname, r.jobid, r.runid, r.job_pid, round(r.age)::int, r.budget_seconds;

    v_acted := v_acted || jsonb_build_object(
      'jobname',        r.jobname,
      'jobid',          r.jobid,
      'runid',          r.runid,
      'pid',            r.job_pid,
      'age_seconds',    round(r.age, 1),
      'budget_seconds', r.budget_seconds,
      'signaled',       v_signaled);
  END LOOP;

  RETURN jsonb_build_object(
    'checked',  v_checked,
    'canceled', jsonb_array_length(v_acted),
    'actions',  v_acted);
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_cron_job_budgets() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_cron_job_budgets() IS
  'FIX-1063 — bounds any pg_cron job listed in cron_job_budget from OUTSIDE '
  'the backend running it, because a CALL cannot bound itself: statement_timeout '
  'is armed once at CALL time and no SET, proconfig, or post-COMMIT transaction '
  'restart re-arms it (measured, FIX-1056). Generalises FIX-1030''s '
  'enforce_derived_mvs_unit_budget() by keying off cron.job_run_details.job_pid, '
  'so target jobs need no instrumentation. Cancels at most once per runid; '
  'every unsatisfied check refuses to cancel.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Seed the budgets. See the header for the sizing evidence per job.
--
--    ON CONFLICT DO NOTHING: once a row exists, an operator's hand-tune is the
--    live value and a migration re-run must not silently revert it.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.cron_job_budget (jobname, budget_seconds, note) VALUES
  ('treemap-individuals-global-refresh', 5400,
   'FIX-1063. Healthy 1500/1638s. Took prod''s REST API down 2026-08-18 running 1h47m unbounded.'),
  ('donor-party-rollup-refresh',         1800,
   'FIX-1063. Healthy 352/388/420s. Hit the 6h ceiling 2026-08-04 (21,629s).'),
  ('agency-staffing-rollup-refresh',     3600,
   'FIX-1063. Healthy 196/547/1183s.'),
  ('contract-flow-rollups-refresh',      10800,
   'FIX-1063. Healthy 986/1053/7126s. Only target with no COMMIT in its procedure.'),
  ('financial-entity-totals-incremental',7200,
   'FIX-1063. Healthy max 2589s. Co-victim of the 08-18 incident (cancelled at 5518s). See FIX-1031.'),
  ('rule-taggers-weekly',                7200,
   'FIX-1063. Healthy max 2741s. Hit the 6h ceiling 2026-08-04; stranded a sync row 2026-08-18.'),
  ('donor-rollup-refresh',               14400,
   'FIX-1063. Backstop ABOVE FIX-1002''s 2h internal budget, which does not cover the FIX-1018 pre-loop dirty-set build (9,388s observed).')
ON CONFLICT (jobname) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Run it every two minutes — the same cadence FIX-1030 chose, for the same
--    reason: the budgets are 30 min to 4 h, so 2-minute granularity is far
--    finer than it needs to be and costs one cheap catalog scan.
--
--    Scheduled by NAME. cron.schedule() on an existing name updates it in place.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_id bigint;
BEGIN
  SELECT cron.schedule('cron-job-budget-watchdog', '*/2 * * * *',
                       'SELECT public.enforce_cron_job_budgets();')
    INTO v_id;
  RAISE NOTICE '[fix1063] cron-job-budget-watchdog scheduled (jobid %) every 2 minutes', v_id;
END $$;
