-- =============================================================================
-- FIX-1374 (cc-258) ROLLBACK — un-RETURN the five monthly sweeps (data only).
--
-- The mirror of the row moves in
-- supabase/migrations/20261102000000_fix1374_return_five_monthly_sweeps.sql.
-- NOT a migration: a payload for the --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1374-revert-return-five-monthly-sweeps.sql
--
-- FIRST, BY HAND, if a disp-<job>-% one-shot of any of the five is armed or
-- running (cron.job LIKE 'disp-%-orphan-sweep-%' or
-- 'disp-financial-entity-totals-reconcile-%', or an `armed` dispatch_log row
-- for the job with no `reaped`/`missed` row):
--   UPDATE public.platform_dials SET pause = true;
-- wait until its cron.job_run_details row is terminal (a paused tick exits at
-- step 2, BEFORE the step-3 reap). Each sweep is ATOMIC: a cancel rolls its
-- statement back and closes the running row `partial`, so nothing needs a
-- pg_cancel_backend; let it end. Run this payload, then:
--   UPDATE public.platform_dials SET pause = false;
-- and the next tick reaps the one-shot. pause is deliberately NOT in this file.
--
-- What it does: the five job_registry rows back to `at <slot>` (an `at` row is
-- never dispatched), each matched on its `by <slot>` text.
--
-- What it does NOT do: touch pipeline_state (the RETURN wrote nothing there);
-- touch the FIX-1311 hold rows (still holds; the RETURN only appended to their
-- notes); un-park the crons. They stay parked: running the sweeps from cron
-- again is scripts/fix1311-unpark-derived-layer-crons.sql, a separate
-- decision.
--
-- Idempotent: a second run NOTICEs 0 rows ×5 and changes nothing.
-- =============================================================================

DO $$
DECLARE
  r   record;
  v_n int;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('donation-edge-orphan-sweep',           '30 11 1 * *'),
    ('financial-entity-totals-reconcile',    '0 12 1 * *'),
    ('donor-rollup-orphan-sweep',            '30 12 1 * *'),
    ('donor-party-rollup-orphan-sweep',      '0 13 1 * *'),
    ('entity-connection-stats-orphan-sweep', '30 13 1 * *')
  ) AS v(job, slot) LOOP
    UPDATE public.job_registry
       SET deadline_rule = 'at ' || r.slot,
           note          = note || '; UN-RETURNED (scripts/fix1374-revert-return-five-monthly-sweeps.sql)',
           updated_at    = now()
     WHERE job = r.job
       AND deadline_rule = 'by ' || r.slot;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[fix1374-revert] job_registry % → at %: % row(s)', r.job, r.slot, v_n;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = r.job AND active) THEN
      RAISE EXCEPTION '[fix1374-revert] cron % is active — this payload never un-parks it; resolve by hand', r.job;
    END IF;
  END LOOP;
END $$;
