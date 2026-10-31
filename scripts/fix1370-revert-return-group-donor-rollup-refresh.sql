-- =============================================================================
-- FIX-1370 (cc-256) ROLLBACK — un-RETURN group-donor-rollup-refresh (data only).
--
-- The mirror of the row move in
-- supabase/migrations/20261031002000_fix1370_return_group_donor_rollup_refresh.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1370-revert-return-group-donor-rollup-refresh.sql
--
-- FIRST, BY HAND, if a disp-group-donor-rollup-refresh-% one-shot is armed or
-- running (cron.job LIKE 'disp-group-donor-rollup-refresh-%', or an `armed`
-- dispatch_log row for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (a paused tick exits at
-- step 2, BEFORE the step-3 reap). The refresh is ONE transaction (DELETE,
-- not TRUNCATE): a cancel is safe and rolls it back whole, but waiting the
-- ~2 min it takes is simpler. Run this payload, then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot. pause is deliberately NOT in this file.
--
-- What it does: job_registry group-donor-rollup-refresh back to
-- `at 10 3 * * 3` (an `at` row is never dispatched), matched on
-- `by 10 3 * * 3`.
--
-- What it does NOT do: touch pipeline_state (the RETURN wrote nothing
-- there); touch the FIX-1311 hold row (still a hold; the RETURN only appended
-- to its note); un-park cron jobid 49. The cron stays parked: running the
-- weekly from cron again is scripts/fix1311-unpark-derived-layer-crons.sql, a
-- separate decision.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 10 3 * * 3',
         note          = note || '; UN-RETURNED (scripts/fix1370-revert-return-group-donor-rollup-refresh.sql)',
         updated_at    = now()
   WHERE job = 'group-donor-rollup-refresh'
     AND deadline_rule = 'by 10 3 * * 3';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1370-revert] job_registry group-donor-rollup-refresh → at 10 3 * * 3: % row(s)', v_n;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'group-donor-rollup-refresh' AND active) THEN
    RAISE EXCEPTION '[fix1370-revert] cron group-donor-rollup-refresh is active — this payload never un-parks it; resolve by hand';
  END IF;
END $$;
