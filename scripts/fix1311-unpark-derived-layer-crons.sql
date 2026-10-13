-- =============================================================================
-- FIX-1311 (cc-232) ROLLBACK — un-park the 18 derived-layer pg_cron jobs.
--
-- The mirror of supabase/migrations/20261013230000_fix1311_park_derived_layer_crons.sql.
-- NOT a migration: it is a payload for the --call path, run only on a decision
-- to abandon the cutover:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1311-unpark-derived-layer-crons.sql
--
-- (under a FIX-950 claim, like any other prod write).
--
-- It is the WHOLE-CUTOVER rollback and is valid only before the first return.
-- Once a job has come back through job_registry, un-parking all 18 by cron
-- would make that job dual-owned — return the remainder one at a time instead.
--
-- It mirrors PROD: all 18 read active there before the park (2026-10-13 23:14Z).
-- The local clone's cron.job is local history (FIX-946) and several of these
-- were already inactive there before the park, so on the clone this would
-- switch on jobs the clone had off.
--
-- By NAME (FIX-946): a missing or duplicated name RAISEs. A name already
-- active is a no-op. The hold rows are deleted by their hold_reason, so a human
-- declaration on the same pipeline is never touched.
-- =============================================================================

DO $$
DECLARE
  c_reason_like CONSTANT text := 'parked for the dispatcher cutover (cc-232%';
  c_jobs CONSTANT text[] := ARRAY[
    'ec-crawl',
    'fe-crawl',
    'donor-rollup-refresh',
    'donor-party-rollup-refresh',
    'treemap-individuals-global-refresh',
    'contract-flow-rollups-refresh',
    'agency-staffing-rollup-refresh',
    'group-donor-rollup-refresh',
    'fe-inbound-rollup-refresh',
    'rule-taggers-daily',
    'rule-taggers-weekly',
    'refresh-derived-mvs-daily',
    'refresh-derived-mvs-weekly',
    'financial-entity-totals-reconcile',
    'donation-edge-orphan-sweep',
    'donor-party-rollup-orphan-sweep',
    'donor-rollup-orphan-sweep',
    'entity-connection-stats-orphan-sweep'
  ];
  v_name    text;
  v_n       int;
  v_jobid   bigint;
  v_active  boolean;
  v_rows    int;
BEGIN
  FOREACH v_name IN ARRAY c_jobs LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1311-unpark] % cron.job rows named % — expected exactly 1', v_n, v_name;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_name;
    IF NOT v_active THEN
      PERFORM cron.alter_job(job_id := v_jobid, active := true);
      RAISE NOTICE '[fix1311-unpark] re-activated % (jobid %)', v_name, v_jobid;
    END IF;
  END LOOP;

  DELETE FROM public.rollup_watch_overrides WHERE hold_reason LIKE c_reason_like;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE '[fix1311-unpark] % hold row(s) removed', v_rows;
END $$;
