-- =============================================================================
-- FIX-1316 (cc-234) ROLLBACK — un-RETURN donor-rollup-refresh (data only).
--
-- The mirror of the row move in
-- supabase/migrations/20261016230000_fix1316_return_donor_rollup_refresh.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1316-revert-donor-rollup-return.sql
--
-- FIRST, BY HAND, if a disp-donor-rollup-refresh-% one-shot is armed or running
-- (cron.job LIKE 'disp-donor-rollup-refresh-%', or an `armed` dispatch_log row
-- for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (succeeded / failed —
-- a paused tick exits at step 2, BEFORE the step-3 reap, so no `reaped` row
-- appears while paused), run this payload, then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot (the reap reads dispatch_log's `armed`
-- row and the run row, not the registry rule). pause is deliberately NOT in
-- this file.
--
-- What it does:
--   1. job_registry donor-rollup-refresh back to `at 0 9,12 * * *` with the
--      bulk's own unit_call (an `at` row is never dispatched).
--   2. its rollup_watch_overrides row back to the cc-232 cutover hold, so
--      scripts/fix1311-unpark-derived-layer-crons.sql is whole again.
--
-- What it does NOT revert: dispatch_log.runid_floor, platform_dials.
-- rearm_cooldown_seconds, the two function bodies and
-- donor_rollup_rebuild_bulk_dispatched(). They are improvements and inert
-- without an eligible row; reverting them is a follow-up migration that
-- re-applies 20261015230000's bodies. There is no role GUC to RESET: the
-- ratified ALTER ROLE was not settable on Supabase, and the window was retired
-- by the wrapper instead (gone with step 1's unit_call).
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 0 9,12 * * *',
         unit_call     = 'CALL public.donor_rollup_rebuild_bulk();',
         note          = note || '; UN-RETURNED (scripts/fix1316-revert-donor-rollup-return.sql)',
         updated_at    = now()
   WHERE job = 'donor-rollup-refresh'
     AND deadline_rule = 'stale_after 12 hours';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1316-revert] job_registry donor-rollup-refresh → at 0 9,12 * * *: % row(s)', v_n;

  UPDATE public.rollup_watch_overrides
     SET held_since    = now(),
         hold_reason   = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry',
         cadence_hours = NULL,
         note          = 'FIX-1311 (cc-232) — pg_cron donor-rollup-refresh parked; restored by scripts/fix1316-revert-donor-rollup-return.sql',
         updated_at    = now()
   WHERE pipeline = 'donor_rollup_refresh'
     AND held_since IS NULL
     AND cadence_hours = 12
     AND note LIKE 'FIX-1316 (cc-234)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1316-revert] rollup_watch_overrides donor_rollup_refresh → the cutover hold: % row(s)', v_n;
END $$;
