-- =============================================================================
-- FIX-1365 (cc-254) ROLLBACK — un-RETURN donor-party-rollup-refresh (data only).
--
-- The mirror of the row move in
-- supabase/migrations/20261030000000_fix1365_return_donor_party_rollup_refresh_crawl_first.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1365-revert-return-donor-party-rollup.sql
--
-- FIRST, BY HAND, if a disp-donor-party-rollup-refresh-% one-shot is armed or
-- running (cron.job LIKE 'disp-donor-party-rollup-refresh-%', or an `armed`
-- dispatch_log row for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (a paused tick exits at
-- step 2, BEFORE the step-3 reap). A crawl in flight COMMITs per slice and
-- stops at its own 1500 s budget; do NOT pg_cancel_backend it. Run this
-- payload, then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot. pause is deliberately NOT in this file.
--
-- What it does: job_registry donor-party-rollup-refresh back to `at 0 15 * *
-- 2` (an `at` row is never dispatched), matched on `by 0 15 * * 2`.
--
-- What it does NOT do: touch pipeline_state (the RETURN wrote no dial:
-- donor_party_crawl.full_rebuild_lag_days 30 is FIX-1249's, and the
-- watermark a crawl advanced is real progress); touch the FIX-1311 hold row
-- (still a hold; the RETURN only appended to its note); un-park cron jobid
-- 17. The cron stays parked: running the weekly from cron again is
-- scripts/fix1311-unpark-derived-layer-crons.sql, a separate decision.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 0 15 * * 2',
         note          = note || '; UN-RETURNED (scripts/fix1365-revert-return-donor-party-rollup.sql)',
         updated_at    = now()
   WHERE job = 'donor-party-rollup-refresh'
     AND deadline_rule = 'by 0 15 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1365-revert] job_registry donor-party-rollup-refresh → at 0 15 * * 2: % row(s)', v_n;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'donor-party-rollup-refresh' AND active) THEN
    RAISE EXCEPTION '[fix1365-revert] cron donor-party-rollup-refresh is active — this payload never un-parks it; resolve by hand';
  END IF;
END $$;
