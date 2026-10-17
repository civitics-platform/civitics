-- =============================================================================
-- FIX-1320 (cc-235) ROLLBACK — un-MOVE fr-vacuum-analyze (data only).
--
-- The mirror of
-- supabase/migrations/20261017020000_fix1320_move_fr_vacuum_analyze.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1320-revert-fr-vacuum-move.sql
--
-- WORKING ORDER (cc-234 #5):
--   1. UPDATE public.platform_dials SET pause = true;
--   2. wait until every disp-% one-shot's cron.job_run_details row is terminal
--      (succeeded / failed) — a paused tick exits at step 2, BEFORE the step-3
--      reap, so no `reaped` row appears while paused. A dispatched VACUUM in
--      flight shows in pg_stat_progress_vacuum; do NOT pg_cancel_backend it.
--   3. run this payload;
--   4. UPDATE public.platform_dials SET pause = false;
--   5. the next tick reaps the one-shot (the reap reads dispatch_log's `armed`
--      row and the run row, not the registry rule).
-- pause is deliberately NOT in this file.
--
-- What it does:
--   1. job_registry fr-vacuum-analyze back to `at 0 3 * * *` with gates '{}'
--      (an `at` row is never dispatched).
--   2. the cron row fr-vacuum-analyze RE-ACTIVATED, by name (FIX-946).
--
-- Valid any time. A MOVE's revert re-activates the cron because the registry
-- row goes back to `at` and nothing else owns the job — unlike a RETURN's
-- revert (fix1316-revert-…, fix1321-revert-…), where the cron stays parked
-- because it was already parked before the RETURN.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 0 3 * * *',
         gates         = '{}',
         note          = note || '; UN-MOVED (scripts/fix1320-revert-fr-vacuum-move.sql)',
         updated_at    = now()
   WHERE job = 'fr-vacuum-analyze'
     AND deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1320-revert] job_registry fr-vacuum-analyze → at 0 3 * * *, gates {}: % row(s)', v_n;

  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'fr-vacuum-analyze';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1320-revert] % cron.job rows named fr-vacuum-analyze — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'fr-vacuum-analyze';
  IF v_active THEN
    RAISE NOTICE '[fix1320-revert] cron fr-vacuum-analyze (jobid %) already active — no-op', v_jobid;
  ELSE
    PERFORM cron.alter_job(job_id := v_jobid, active := true);
    RAISE NOTICE '[fix1320-revert] cron fr-vacuum-analyze (jobid %) re-activated (0 3 * * *)', v_jobid;
  END IF;
END $$;
