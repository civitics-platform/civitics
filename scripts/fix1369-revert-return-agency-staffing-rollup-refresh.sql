-- =============================================================================
-- FIX-1369 (cc-256) ROLLBACK — un-RETURN agency-staffing-rollup-refresh
-- (data only).
--
-- The mirror of the row move in
-- supabase/migrations/20261031001000_fix1369_return_agency_staffing_rollup_refresh.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1369-revert-return-agency-staffing-rollup-refresh.sql
--
-- FIRST, BY HAND, if a disp-agency-staffing-rollup-refresh-% one-shot is armed
-- or running (cron.job LIKE 'disp-agency-staffing-rollup-refresh-%', or an
-- `armed` dispatch_log row for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (a paused tick exits at
-- step 2, BEFORE the step-3 reap). A run in flight COMMITs per 50-agency
-- chunk and is a minute or so; do NOT pg_cancel_backend it. Run this payload,
-- then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot. pause is deliberately NOT in this file.
--
-- What it does: job_registry agency-staffing-rollup-refresh back to
-- `at 5 0 * * 2` (an `at` row is never dispatched), matched on `by 5 0 * * 2`.
--
-- What it does NOT do: touch pipeline_state (the RETURN wrote nothing there;
-- a watermark a complete run advanced is real progress); touch the FIX-1311
-- hold row (still a hold; the RETURN only appended to its note); un-park
-- cron jobid 25. The cron stays parked: running the weekly from cron again
-- is scripts/fix1311-unpark-derived-layer-crons.sql, a separate decision.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 5 0 * * 2',
         note          = note || '; UN-RETURNED (scripts/fix1369-revert-return-agency-staffing-rollup-refresh.sql)',
         updated_at    = now()
   WHERE job = 'agency-staffing-rollup-refresh'
     AND deadline_rule = 'by 5 0 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1369-revert] job_registry agency-staffing-rollup-refresh → at 5 0 * * 2: % row(s)', v_n;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agency-staffing-rollup-refresh' AND active) THEN
    RAISE EXCEPTION '[fix1369-revert] cron agency-staffing-rollup-refresh is active — this payload never un-parks it; resolve by hand';
  END IF;
END $$;
