-- =============================================================================
-- FIX-1368 (cc-256) ROLLBACK — un-RETURN treemap-individuals-global-refresh
-- (data only).
--
-- The mirror of the row move in
-- supabase/migrations/20261031000000_fix1368_return_treemap_individuals_global_refresh.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1368-revert-return-treemap-individuals-global-refresh.sql
--
-- FIRST, BY HAND, if a disp-treemap-individuals-global-refresh-% one-shot is
-- armed or running (cron.job LIKE 'disp-treemap-individuals-global-refresh-%',
-- or an `armed` dispatch_log row for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (a paused tick exits at
-- step 2, BEFORE the step-3 reap). A sweep in flight COMMITs per chunk and
-- stops at its own predictive budget guard; do NOT pg_cancel_backend it (a
-- cancel is caught by name and ends `partial`, but nothing needs it). Run
-- this payload, then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot. pause is deliberately NOT in this file.
--
-- What it does: job_registry treemap-individuals-global-refresh back to
-- `at 0 14 * * 2` (an `at` row is never dispatched), matched on
-- `by 0 14 * * 2`.
--
-- What it does NOT do: touch pipeline_state (the RETURN wrote nothing there;
-- a cursor a sweep left is real progress and the body resumes or discards it
-- by c_max_sweep); touch the FIX-1311 hold row (still a hold; the RETURN only
-- appended to its note); un-park cron jobid 26. The cron stays parked:
-- running the weekly from cron again is
-- scripts/fix1311-unpark-derived-layer-crons.sql, a separate decision.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 0 14 * * 2',
         note          = note || '; UN-RETURNED (scripts/fix1368-revert-return-treemap-individuals-global-refresh.sql)',
         updated_at    = now()
   WHERE job = 'treemap-individuals-global-refresh'
     AND deadline_rule = 'by 0 14 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1368-revert] job_registry treemap-individuals-global-refresh → at 0 14 * * 2: % row(s)', v_n;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'treemap-individuals-global-refresh' AND active) THEN
    RAISE EXCEPTION '[fix1368-revert] cron treemap-individuals-global-refresh is active — this payload never un-parks it; resolve by hand';
  END IF;
END $$;
