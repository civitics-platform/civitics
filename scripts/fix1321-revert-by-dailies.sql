-- =============================================================================
-- FIX-1321 (cc-235) ROLLBACK — un-RETURN fe-inbound-rollup-refresh and
-- vote-stats-refresh (data only).
--
-- The mirror of supabase/migrations/20261017021000_fix1321_return_by_dailies.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1321-revert-by-dailies.sql
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
--   1. both job_registry rows back to `at 13 2 * * *` / `at 30 3 * * *` (an
--      `at` row is never dispatched).
--   2. both rollup_watch_overrides rows back to their cutover holds, so
--      scripts/fix1311-unpark-derived-layer-crons.sql and
--      scripts/fix1312-unpark-vote-stats-refresh.sql are whole again.
-- The crons stay parked — a RETURN's revert restores the pre-state, which was
-- parked (contrast fix1320-revert-…, a MOVE's, which re-activates its cron).
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 13 2 * * *',
         note          = note || '; UN-RETURNED (scripts/fix1321-revert-by-dailies.sql)',
         updated_at    = now()
   WHERE job = 'fe-inbound-rollup-refresh'
     AND deadline_rule = 'by 13 2 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1321-revert] job_registry fe-inbound-rollup-refresh → at 13 2 * * *: % row(s)', v_n;

  UPDATE public.job_registry
     SET deadline_rule = 'at 30 3 * * *',
         note          = note || '; UN-RETURNED (scripts/fix1321-revert-by-dailies.sql)',
         updated_at    = now()
   WHERE job = 'vote-stats-refresh'
     AND deadline_rule = 'by 30 3 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1321-revert] job_registry vote-stats-refresh → at 30 3 * * *: % row(s)', v_n;

  UPDATE public.rollup_watch_overrides
     SET held_since    = now(),
         hold_reason   = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry',
         cadence_hours = NULL,
         note          = 'FIX-1311 (cc-232) — pg_cron fe-inbound-rollup-refresh parked; restored by scripts/fix1321-revert-by-dailies.sql',
         updated_at    = now()
   WHERE pipeline = 'financial_entity_inbound_rollup'
     AND cadence_hours = 24
     AND note LIKE 'FIX-1321 (cc-235)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1321-revert] rollup_watch_overrides financial_entity_inbound_rollup → the cutover hold: % row(s)', v_n;

  UPDATE public.rollup_watch_overrides
     SET held_since    = now(),
         hold_reason   = 'parked for the dispatcher cutover (cc-226, FIX-1312); returns via job_registry',
         cadence_hours = NULL,
         note          = 'FIX-1312 (cc-226) — pg_cron vote-stats-refresh parked; restored by scripts/fix1321-revert-by-dailies.sql',
         updated_at    = now()
   WHERE pipeline = 'official_vote_stats_rebuild'
     AND cadence_hours = 24
     AND note LIKE 'FIX-1321 (cc-235)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1321-revert] rollup_watch_overrides official_vote_stats_rebuild → the cutover hold: % row(s)', v_n;
END $$;
