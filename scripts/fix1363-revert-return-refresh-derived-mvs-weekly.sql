-- =============================================================================
-- FIX-1363 (cc-253) ROLLBACK — un-RETURN refresh-derived-mvs-weekly (data only).
--
-- The mirror of the row move in
-- supabase/migrations/20261029001000_fix1363_return_refresh_derived_mvs_weekly.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1363-revert-return-refresh-derived-mvs-weekly.sql
--
-- FIRST, BY HAND, if a disp-refresh-derived-mvs-weekly-% one-shot is armed or
-- running (cron.job LIKE 'disp-refresh-derived-mvs-weekly-%', or an `armed`
-- dispatch_log row for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (a paused tick exits at
-- step 2, BEFORE the step-3 reap), run this payload, then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot. pause is deliberately NOT in this file.
--
-- What it does: job_registry refresh-derived-mvs-weekly back to `at 47 0 * *
-- 2` (an `at` row is never dispatched), matched on `by 47 0 * * 2`.
--
-- What it does NOT do: touch the shared refresh_derived_mvs hold row (it is
-- the daily's cadence row, FIX-1355; the RETURN only appended to its note);
-- clear anchor_cadence (FIX-1361's, inert on an `at` row); un-park cron jobid
-- 10. The cron stays parked: running the weekly from cron again is
-- scripts/fix1311-unpark-derived-layer-crons.sql, a separate decision.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 47 0 * * 2',
         note          = note || '; UN-RETURNED (scripts/fix1363-revert-return-refresh-derived-mvs-weekly.sql)',
         updated_at    = now()
   WHERE job = 'refresh-derived-mvs-weekly'
     AND deadline_rule = 'by 47 0 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1363-revert] job_registry refresh-derived-mvs-weekly → at 47 0 * * 2: % row(s)', v_n;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-derived-mvs-weekly' AND active) THEN
    RAISE EXCEPTION '[fix1363-revert] cron refresh-derived-mvs-weekly is active — this payload never un-parks it; resolve by hand';
  END IF;
END $$;
