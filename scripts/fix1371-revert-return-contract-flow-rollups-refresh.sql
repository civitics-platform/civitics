-- =============================================================================
-- FIX-1371 (cc-257) ROLLBACK — un-RETURN contract-flow-rollups-refresh (data
-- only).
--
-- The mirror of the row move in
-- supabase/migrations/20261101000000_fix1371_return_contract_flow_rollups_refresh.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1371-revert-return-contract-flow-rollups-refresh.sql
--
-- FIRST, BY HAND, if a disp-contract-flow-rollups-refresh-% one-shot is armed
-- or running (cron.job LIKE 'disp-contract-flow-rollups-refresh-%', or an
-- `armed` dispatch_log row for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (a paused tick exits at
-- step 2, BEFORE the step-3 reap). The run is ATOMIC: a cancel rolls both
-- rollup tables back intact and closes the running row `failed`, so nothing
-- needs a pg_cancel_backend; let it end or let the budget end it. Run this
-- payload, then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot. pause is deliberately NOT in this file.
--
-- What it does: job_registry contract-flow-rollups-refresh back to
-- `at 0 14 * * 4` (an `at` row is never dispatched), matched on
-- `by 0 14 * * 4`.
--
-- What it does NOT do: touch pipeline_state (the RETURN wrote nothing there);
-- touch the FIX-1311 hold row (still a hold; the RETURN only appended to its
-- note); un-park cron jobid 28. The cron stays parked: running the weekly from
-- cron again is scripts/fix1311-unpark-derived-layer-crons.sql, a separate
-- decision.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 0 14 * * 4',
         note          = note || '; UN-RETURNED (scripts/fix1371-revert-return-contract-flow-rollups-refresh.sql)',
         updated_at    = now()
   WHERE job = 'contract-flow-rollups-refresh'
     AND deadline_rule = 'by 0 14 * * 4';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1371-revert] job_registry contract-flow-rollups-refresh → at 0 14 * * 4: % row(s)', v_n;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'contract-flow-rollups-refresh' AND active) THEN
    RAISE EXCEPTION '[fix1371-revert] cron contract-flow-rollups-refresh is active — this payload never un-parks it; resolve by hand';
  END IF;
END $$;
