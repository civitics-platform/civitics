-- =============================================================================
-- FIX-1355 (cc-251) ROLLBACK — un-RETURN refresh-derived-mvs-daily (data only).
--
-- The mirror of the row move in
-- supabase/migrations/20261027001000_fix1355_return_refresh_derived_mvs_daily.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1355-revert-return-refresh-derived-mvs-daily.sql
--
-- FIRST, BY HAND, if a disp-refresh-derived-mvs-daily-% one-shot is armed or
-- running (cron.job LIKE 'disp-refresh-derived-mvs-daily-%', or an `armed`
-- dispatch_log row for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (a paused tick exits at
-- step 2, BEFORE the step-3 reap), run this payload, then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot. pause is deliberately NOT in this file.
--
-- What it does:
--   1. job_registry refresh-derived-mvs-daily back to `at 0 6 * * *` (an `at`
--      row is never dispatched).
--   2. the shared refresh_derived_mvs rollup_watch_overrides row back to the
--      cc-232 cutover hold, but ONLY if it still carries FIX-1355's note: a
--      later hand on that row is a human's to resolve.
--
-- What it does NOT do: un-park cron jobid 9. The cron stays parked; to run the
-- daily from cron again is scripts/fix1311-unpark-derived-layer-crons.sql, a
-- separate decision. FIX-1354's bodies are not touched.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 0 6 * * *',
         note          = note || '; UN-RETURNED (scripts/fix1355-revert-return-refresh-derived-mvs-daily.sql)',
         updated_at    = now()
   WHERE job = 'refresh-derived-mvs-daily'
     AND deadline_rule = 'by 0 6 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1355-revert] job_registry refresh-derived-mvs-daily → at 0 6 * * *: % row(s)', v_n;

  UPDATE public.rollup_watch_overrides
     SET held_since    = now(),
         hold_reason   = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry',
         cadence_hours = NULL,
         note          = 'FIX-1311 (cc-232) — pg_cron refresh-derived-mvs-daily + refresh-derived-mvs-weekly parked; '
                         'restored by scripts/fix1355-revert-return-refresh-derived-mvs-daily.sql',
         updated_at    = now()
   WHERE pipeline = 'refresh_derived_mvs'
     AND note LIKE 'FIX-1355 (cc-251)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1355-revert] rollup_watch_overrides refresh_derived_mvs → the cutover hold: % row(s)', v_n;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-derived-mvs-daily' AND active) THEN
    RAISE EXCEPTION '[fix1355-revert] cron refresh-derived-mvs-daily is active — this payload never un-parks it; resolve by hand';
  END IF;
END $$;
