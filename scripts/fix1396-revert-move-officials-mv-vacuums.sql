-- =============================================================================
-- FIX-1396 (cc-267) ROLLBACK — un-MOVE the last eight cron vacuums (data only).
--
-- The mirror of supabase/migrations/20261111000000_fix1396_move_officials_and_mv_vacuum_series_eight_rows.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1396-revert-move-officials-mv-vacuums.sql
--
-- WORKING ORDER (cc-234 #5, fix1366's):
--   1. UPDATE public.platform_dials SET pause = true;
--   2. wait until no `disp-<job>-…` one-shot of the eight is armed, or until
--      its cron.job_run_details row is terminal (succeeded / failed). A paused
--      tick exits BEFORE the reap. A dispatched VACUUM in flight shows in
--      pg_stat_progress_vacuum; do NOT pg_cancel_backend it (<= ~40 s).
--   3. run this payload (the rows, then the crons);
--   4. UPDATE public.platform_dials SET pause = false;
--   5. the next tick reaps any one-shot (the reap reads dispatch_log's `armed`
--      row and the run row, not the registry rule).
-- pause is deliberately NOT in this file.
--
-- What it does, per row:
--   1. job_registry back to its `at …` text with gates '{}' (an `at` row is
--      never dispatched), phase_lock false, phase_due_at NULL, the note
--      trimmed of the cc-267 MOVE clause and marked UN-MOVED. Matched on the
--      MOVED rule, so a row already back on `at` is left alone.
--   2. its cron row RE-ACTIVATED, by name (FIX-946): a MOVE parked it, and once
--      the row is back on `at` nothing else owns the job.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_x      record;
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  FOR v_x IN
    SELECT * FROM (VALUES
      ('officials-vacuum-analyze',           'at 30 1 * * 1',     'dead_tuples > 60% of trigger + floor 7 days'),
      ('odr-mv-vacuum-analyze',              'at 5 11,17 * * *',  'dead_tuples > 60% of trigger + floor 24 hours'),
      ('treemap-individuals-vacuum-analyze', 'at 10 11,17 * * *', 'dead_tuples > 60% of trigger + floor 24 hours'),
      ('odt-vacuum-analyze',                 'at 12 11,17 * * *', 'dead_tuples > 60% of trigger + floor 24 hours'),
      ('osdr-vacuum-analyze',                'at 14 11,17 * * *', 'dead_tuples > 60% of trigger + floor 24 hours'),
      ('osar-vacuum-analyze',                'at 16 11,17 * * *', 'dead_tuples > 60% of trigger + floor 24 hours'),
      ('odbt-vacuum-analyze',                'at 18 11,17 * * *', 'dead_tuples > 60% of trigger + floor 24 hours'),
      ('ecs-vacuum-analyze',                 'at 20 11,17 * * *', 'dead_tuples > 60% of trigger + floor 24 hours')
    ) AS m(job, at_rule, moved_rule)
  LOOP
    UPDATE public.job_registry
       SET deadline_rule = v_x.at_rule,
           gates         = '{}',
           phase_lock    = false,
           phase_due_at  = NULL,
           note          = replace(note, '; MOVED 2026-11-11 (FIX-1396, cc-267) from ' || v_x.at_rule || '; first dispatched firing owed', '')
                           || '; UN-MOVED (scripts/fix1396-revert-move-officials-mv-vacuums.sql)',
           updated_at    = now()
     WHERE job = v_x.job
       AND deadline_rule = v_x.moved_rule;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[fix1396-revert] job_registry % → %, gates {}, phase_lock false: % row(s)', v_x.job, v_x.at_rule, v_n;

    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_x.job;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1396-revert] % cron.job rows named % — expected exactly 1', v_n, v_x.job;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_x.job;
    IF v_active THEN
      RAISE NOTICE '[fix1396-revert] cron % (jobid %) already active — no-op', v_x.job, v_jobid;
    ELSE
      PERFORM cron.alter_job(job_id := v_jobid, active := true);
      RAISE NOTICE '[fix1396-revert] cron % (jobid %) re-activated', v_x.job, v_jobid;
    END IF;
  END LOOP;
END $$;
