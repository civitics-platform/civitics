-- =============================================================================
-- FIX-1349 (cc-249) ROLLBACK — un-MOVE ec-vacuum-analyze and fe-vacuum-analyze
-- (data only).
--
-- The mirror of supabase/migrations/20261026000000_fix1349_move_ec_fe_vacuums.sql.
-- NOT a migration: a payload for the --call path, one statement at a time:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1349-revert-move-ec-fe-vacuums.sql
--
-- WORKING ORDER (cc-234 #5):
--   1. UPDATE public.platform_dials SET pause = true;
--   2. wait until no `disp-ec-vacuum-analyze-…` / `disp-fe-vacuum-analyze-…`
--      one-shot is armed, or until each one's cron.job_run_details row is
--      terminal (succeeded / failed). A paused tick exits BEFORE the reap, so
--      no `reaped` row appears while paused. A dispatched VACUUM in flight
--      shows in pg_stat_progress_vacuum; do NOT pg_cancel_backend it (<= ~140 s).
--   3. run this payload (the rows, then the crons);
--   4. UPDATE public.platform_dials SET pause = false;
--   5. the next tick reaps any one-shot (the reap reads dispatch_log's `armed`
--      row and the run row, not the registry rule).
-- pause is deliberately NOT in this file.
--
-- What it does:
--   1. job_registry ec-vacuum-analyze back to `at 30 4 * * *` and
--      fe-vacuum-analyze back to `at 50 4 * * *`, both with gates '{}' (an
--      `at` row is never dispatched), phase_lock false, phase_due_at NULL, the
--      note trimmed of the cc-249 MOVE clause and marked UN-MOVED.
--   2. both cron rows RE-ACTIVATED, by name (FIX-946).
--
-- Valid any time. A MOVE's revert re-activates the cron because the registry
-- row goes back to `at` and nothing else owns the job. Idempotent: a second
-- run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 30 4 * * *',
         gates         = '{}',
         phase_lock    = false,
         phase_due_at  = NULL,
         note          = replace(note, '; MOVED by cc-249 (FIX-1349) from at 30 4 * * *', '')
                         || '; UN-MOVED (scripts/fix1349-revert-move-ec-fe-vacuums.sql)',
         updated_at    = now()
   WHERE job = 'ec-vacuum-analyze'
     AND deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1349-revert] job_registry ec-vacuum-analyze → at 30 4 * * *, gates {}, phase_lock false: % row(s)', v_n;

  UPDATE public.job_registry
     SET deadline_rule = 'at 50 4 * * *',
         gates         = '{}',
         phase_lock    = false,
         phase_due_at  = NULL,
         note          = replace(note, '; MOVED by cc-249 (FIX-1349) from at 50 4 * * *', '')
                         || '; UN-MOVED (scripts/fix1349-revert-move-ec-fe-vacuums.sql)',
         updated_at    = now()
   WHERE job = 'fe-vacuum-analyze'
     AND deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1349-revert] job_registry fe-vacuum-analyze → at 50 4 * * *, gates {}, phase_lock false: % row(s)', v_n;
END $$;

DO $$
DECLARE
  v_job    text;
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  FOREACH v_job IN ARRAY ARRAY['ec-vacuum-analyze', 'fe-vacuum-analyze'] LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_job;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1349-revert] % cron.job rows named % — expected exactly 1', v_n, v_job;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_job;
    IF v_active THEN
      RAISE NOTICE '[fix1349-revert] cron % (jobid %) already active — no-op', v_job, v_jobid;
    ELSE
      PERFORM cron.alter_job(job_id := v_jobid, active := true);
      RAISE NOTICE '[fix1349-revert] cron % (jobid %) re-activated', v_job, v_jobid;
    END IF;
  END LOOP;
END $$;
