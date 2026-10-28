-- FIX-1358 REVERT — fe-vacuum-analyze back to phase_lock true (its value
-- since FIX-1349, 20261026000000), matched on false. phase_due_at is not
-- touched: with the lock back on, the row's next floor arm writes a fresh one.
--
-- Run (prod):  node scripts/db-query.mjs --prod --call --yes-i-mean-prod --file scripts/fix1358-revert-fe-phase-lock.sql
-- Rehearse:    inside BEGIN … ROLLBACK on the clone.
DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.job_registry
     SET phase_lock = true, updated_at = now()
   WHERE job = 'fe-vacuum-analyze' AND phase_lock = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1358 revert] % rows — fe-vacuum-analyze is not phase_lock false', v_n;
  END IF;
  RAISE NOTICE '[fix1358 revert] fe-vacuum-analyze phase_lock false → true (1 row)';
END $$;
