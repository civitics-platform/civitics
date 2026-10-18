-- =============================================================================
-- FIX-1328 (cc-237) ROLLBACK — un-RETURN rule-taggers-weekly's bridge (data
-- only).
--
-- The mirror of
-- supabase/migrations/20261018001000_fix1328_return_rule_taggers_weekly_bridge.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1328-revert-weekly-bridge.sql
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
-- What it does: the job_registry row back to `at 0 16 * * 2` (an `at` row is
-- never dispatched). The run_rule_taggers hold row was never converted
-- (FIX-1328 D-e), so there is nothing to restore there. The cron stays parked
-- — a RETURN's revert restores the pre-state, which was parked.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'at 0 16 * * 2',
         note          = note || '; UN-RETURNED (scripts/fix1328-revert-weekly-bridge.sql)',
         updated_at    = now()
   WHERE job = 'rule-taggers-weekly'
     AND deadline_rule = 'stale_after 7 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1328-revert] job_registry rule-taggers-weekly → at 0 16 * * 2: % row(s)', v_n;
END $$;
