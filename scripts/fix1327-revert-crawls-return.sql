-- =============================================================================
-- FIX-1327 (cc-237) ROLLBACK — un-RETURN ec-crawl and fe-crawl (data only).
--
-- The mirror of supabase/migrations/20261018000000_fix1327_return_crawls.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1327-revert-crawls-return.sql
--
-- WORKING ORDER (cc-234 #5):
--   1. UPDATE public.platform_dials SET pause = true;
--   2. wait until every disp-% one-shot's cron.job_run_details row is terminal
--      (succeeded / failed) — a paused tick exits at step 2, BEFORE the step-3
--      reap, so no `reaped` row appears while paused;
--   3. run this payload;
--   4. UPDATE public.platform_dials SET pause = false;
--   5. the next tick reaps the one-shot.
-- pause is deliberately NOT in this file.
--
-- What it does:
--   1. both job_registry rows back to `at */15 * * * *` / `at */30 * * * *`
--      (an `at` row is never dispatched).
--   2. both rollup_watch_overrides rows back to the cutover hold, so
--      scripts/fix1311-unpark-derived-layer-crons.sql is whole again.
-- The crons stay parked — a RETURN's revert restores the pre-state, which was
-- parked (contrast a MOVE's revert, which re-activates its cron).
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at */15 * * * *',
         note          = note || '; UN-RETURNED (scripts/fix1327-revert-crawls-return.sql)',
         updated_at    = now()
   WHERE job = 'ec-crawl'
     AND deadline_rule = 'stale_after 10 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1327-revert] job_registry ec-crawl → at */15 * * * *: % row(s)', v_n;

  UPDATE public.job_registry
     SET deadline_rule = 'at */30 * * * *',
         note          = note || '; UN-RETURNED (scripts/fix1327-revert-crawls-return.sql)',
         updated_at    = now()
   WHERE job = 'fe-crawl'
     AND deadline_rule = 'stale_after 25 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1327-revert] job_registry fe-crawl → at */30 * * * *: % row(s)', v_n;

  UPDATE public.rollup_watch_overrides
     SET held_since    = now(),
         hold_reason   = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry',
         cadence_hours = NULL,
         note          = 'FIX-1311 (cc-232) — pg_cron ec-crawl parked; restored by scripts/fix1327-revert-crawls-return.sql',
         updated_at    = now()
   WHERE pipeline = 'entity_connections_rebuild'
     AND cadence_hours = 24
     AND note LIKE 'FIX-1327 (cc-237)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1327-revert] rollup_watch_overrides entity_connections_rebuild → the cutover hold: % row(s)', v_n;

  UPDATE public.rollup_watch_overrides
     SET held_since    = now(),
         hold_reason   = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry',
         cadence_hours = NULL,
         note          = 'FIX-1311 (cc-232) — pg_cron fe-crawl parked; restored by scripts/fix1327-revert-crawls-return.sql',
         updated_at    = now()
   WHERE pipeline = 'financial_entity_totals_refresh'
     AND cadence_hours = 24
     AND note LIKE 'FIX-1327 (cc-237)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1327-revert] rollup_watch_overrides financial_entity_totals_refresh → the cutover hold: % row(s)', v_n;
END $$;
