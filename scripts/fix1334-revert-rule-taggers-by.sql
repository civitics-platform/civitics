-- =============================================================================
-- FIX-1334 (cc-239) ROLLBACK — un-RETURN rule-taggers-daily, put
-- rule-taggers-weekly back on its bridge, drop the two phase locks (data only).
--
-- The mirror of
-- supabase/migrations/20261020001000_fix1334_return_rule_taggers_daily_switch_weekly_by.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1334-revert-rule-taggers-by.sql
--
-- WORKING ORDER (cc-239 D-i):
--   1. UPDATE public.platform_dials SET pause = true;
--   2. wait until every disp-% one-shot's cron.job_run_details row is terminal
--      (succeeded / failed) — a paused tick exits at step 2, BEFORE the step-3
--      reap, so no `reaped` row appears while paused;
--   3. this payload (the rows) FIRST;
--   4. scripts/fix1329-revert-dispatcher-b1.sql (the body), if it is reverting
--      too — a `by 0 16 * * 2` row must not meet the M1 body;
--   5. UPDATE public.platform_dials SET pause = false;
--   6. the next tick reaps the one-shot.
-- pause is deliberately NOT in this file.
--
-- What it does:
--   rule-taggers-weekly  `by 0 16 * * 2` → `stale_after 7 days` (the bridge).
--     Once a dispatched rule-taggers-daily has run, the bridge's clock is the
--     daily's last completion + 7 days (the shared pipeline) — the reason the
--     two moved together. Re-read the weekly's due before un-pausing.
--   rule-taggers-daily   `by 30 6 * * *` → `at 30 6 * * *` (an `at` row is
--     never dispatched).
--   donor-rollup-refresh, fr-vacuum-analyze  phase_lock → false,
--     phase_due_at → NULL (fixed-delay again).
-- The run_rule_taggers hold row was never converted (FIX-1334 (5)), so there
-- is nothing to restore there. The crons stay parked — a RETURN's revert
-- restores the pre-state, which was parked.
--
-- Idempotent: a second run NOTICEs 0 rows and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'stale_after 7 days',
         note          = note || '; by 0 16 * * 2 UN-SWITCHED (scripts/fix1334-revert-rule-taggers-by.sql)',
         updated_at    = now()
   WHERE job = 'rule-taggers-weekly'
     AND deadline_rule = 'by 0 16 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1334-revert] job_registry rule-taggers-weekly → stale_after 7 days: % row(s)', v_n;

  UPDATE public.job_registry
     SET deadline_rule = 'at 30 6 * * *',
         note          = note || '; UN-RETURNED (scripts/fix1334-revert-rule-taggers-by.sql)',
         updated_at    = now()
   WHERE job = 'rule-taggers-daily'
     AND deadline_rule = 'by 30 6 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1334-revert] job_registry rule-taggers-daily → at 30 6 * * *: % row(s)', v_n;

  UPDATE public.job_registry
     SET phase_lock = false,
         phase_due_at = NULL
   WHERE job IN ('donor-rollup-refresh', 'fr-vacuum-analyze')
     AND (phase_lock OR phase_due_at IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1334-revert] job_registry donor-rollup-refresh + fr-vacuum-analyze → phase_lock false: % row(s)', v_n;
END $$;
