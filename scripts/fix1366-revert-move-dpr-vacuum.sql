-- =============================================================================
-- FIX-1366 (cc-254) ROLLBACK — un-MOVE dpr-vacuum-analyze (data only).
--
-- The mirror of supabase/migrations/20261030001000_fix1366_move_dpr_vacuum_analyze.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1366-revert-move-dpr-vacuum.sql
--
-- WORKING ORDER (cc-234 #5):
--   1. UPDATE public.platform_dials SET pause = true;
--   2. wait until no `disp-dpr-vacuum-analyze-…` one-shot is armed, or until
--      its cron.job_run_details row is terminal (succeeded / failed). A paused
--      tick exits BEFORE the reap, so no `reaped` row appears while paused. A
--      dispatched VACUUM in flight shows in pg_stat_progress_vacuum; do NOT
--      pg_cancel_backend it (<= ~8 s).
--   3. run this payload (the row, then the cron);
--   4. UPDATE public.platform_dials SET pause = false;
--   5. the next tick reaps any one-shot (the reap reads dispatch_log's `armed`
--      row and the run row, not the registry rule).
-- pause is deliberately NOT in this file.
--
-- What it does:
--   1. job_registry dpr-vacuum-analyze back to `at 0 2 * * 0,3` with gates
--      '{}' (an `at` row is never dispatched), phase_lock false, phase_due_at
--      NULL, the note trimmed of the cc-254 MOVE clause and marked UN-MOVED.
--   2. its cron row RE-ACTIVATED, by name (FIX-946). The ONE case a revert
--      re-activates a cron: a MOVE parked it, and once the row is back on
--      `at` nothing else owns the job.
--
-- Valid any time; independent of FIX-1365's revert. Idempotent: a second run
-- NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 0 2 * * 0,3',
         gates         = '{}',
         phase_lock    = false,
         phase_due_at  = NULL,
         note          = replace(note, '; MOVED 2026-10-30 (FIX-1366, cc-254) from at 0 2 * * 0,3', '')
                         || '; UN-MOVED (scripts/fix1366-revert-move-dpr-vacuum.sql)',
         updated_at    = now()
   WHERE job = 'dpr-vacuum-analyze'
     AND deadline_rule = 'dead_tuples > 60% of trigger + floor 7 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1366-revert] job_registry dpr-vacuum-analyze → at 0 2 * * 0,3, gates {}, phase_lock false: % row(s)', v_n;
END $$;

DO $$
DECLARE
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'dpr-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1366-revert] % cron.job rows named dpr-vacuum-analyze — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'dpr-vacuum-analyze';
  IF v_active THEN
    RAISE NOTICE '[fix1366-revert] cron dpr-vacuum-analyze (jobid %) already active — no-op', v_jobid;
  ELSE
    PERFORM cron.alter_job(job_id := v_jobid, active := true);
    RAISE NOTICE '[fix1366-revert] cron dpr-vacuum-analyze (jobid %) re-activated', v_jobid;
  END IF;
END $$;
