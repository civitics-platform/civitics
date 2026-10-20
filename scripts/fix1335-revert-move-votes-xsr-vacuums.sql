-- =============================================================================
-- FIX-1335 (cc-240) ROLLBACK — un-MOVE votes-vacuum-analyze and
-- xsr-vacuum-analyze (data only).
--
-- The mirror of
-- supabase/migrations/20261021000000_fix1335_move_votes_xsr_vacuums.sql.
-- NOT a migration: a payload for the --call path, one statement at a time:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1335-revert-move-votes-xsr-vacuums.sql
--
-- WORKING ORDER (cc-234 #5):
--   1. UPDATE public.platform_dials SET pause = true;
--   2. wait until no `disp-votes-vacuum-analyze-…` / `disp-xsr-vacuum-analyze-…`
--      one-shot is armed, or until each one's cron.job_run_details row is
--      terminal (succeeded / failed). A paused tick exits at step 2, BEFORE
--      the step-3 reap, so no `reaped` row appears while paused. A dispatched
--      VACUUM in flight shows in pg_stat_progress_vacuum; do NOT
--      pg_cancel_backend it (a 3–25 s VACUUM).
--   3. run this payload (the rows, then the crons);
--   4. UPDATE public.platform_dials SET pause = false;
--   5. the next tick reaps any one-shot (the reap reads dispatch_log's `armed`
--      row and the run row, not the registry rule).
-- pause is deliberately NOT in this file.
--
-- What it does:
--   1. job_registry votes-vacuum-analyze back to `at 37 2 * * 6` and
--      xsr-vacuum-analyze back to `at 41 1 * * 2`, both with gates '{}' (an
--      `at` row is never dispatched), the note trimmed of the cc-240 MOVE
--      clause.
--   2. both cron rows RE-ACTIVATED, by name (FIX-946).
--
-- Valid any time. A MOVE's revert re-activates the cron because the registry
-- row goes back to `at` and nothing else owns the job. A RETURN's revert is
-- different: its cron stays parked, because it was parked before the RETURN.
-- officials-vacuum-analyze and dpr-vacuum-analyze were never moved, so this
-- payload does not name them.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 37 2 * * 6',
         gates         = '{}',
         note          = replace(note, '; MOVED by cc-240 (FIX-1335) from at 37 2 * * 6', '')
                         || '; UN-MOVED (scripts/fix1335-revert-move-votes-xsr-vacuums.sql)',
         updated_at    = now()
   WHERE job = 'votes-vacuum-analyze'
     AND deadline_rule = 'dead_tuples > 60% of trigger + floor 7 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1335-revert] job_registry votes-vacuum-analyze → at 37 2 * * 6, gates {}: % row(s)', v_n;

  UPDATE public.job_registry
     SET deadline_rule = 'at 41 1 * * 2',
         gates         = '{}',
         note          = replace(note, '; MOVED by cc-240 (FIX-1335) from at 41 1 * * 2', '')
                         || '; UN-MOVED (scripts/fix1335-revert-move-votes-xsr-vacuums.sql)',
         updated_at    = now()
   WHERE job = 'xsr-vacuum-analyze'
     AND deadline_rule = 'dead_tuples > 60% of trigger + floor 7 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1335-revert] job_registry xsr-vacuum-analyze → at 41 1 * * 2, gates {}: % row(s)', v_n;
END $$;

DO $$
DECLARE
  v_job    text;
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  FOREACH v_job IN ARRAY ARRAY['votes-vacuum-analyze', 'xsr-vacuum-analyze'] LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_job;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1335-revert] % cron.job rows named % — expected exactly 1', v_n, v_job;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_job;
    IF v_active THEN
      RAISE NOTICE '[fix1335-revert] cron % (jobid %) already active — no-op', v_job, v_jobid;
    ELSE
      PERFORM cron.alter_job(job_id := v_jobid, active := true);
      RAISE NOTICE '[fix1335-revert] cron % (jobid %) re-activated', v_job, v_jobid;
    END IF;
  END LOOP;
END $$;
