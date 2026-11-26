-- scripts/fix1453-revert-bill-details-row.sql
-- FIX-1453 ROLLBACK (cc-328) — takes the bill-details walker out of the
-- dispatcher: DELETEs the one job_registry row
-- 20261126008000_fix1453_bill_details_registry_row.sql INSERTed. With no row the
-- pick never arms it, and the bill-details-request route (every 5 min) reads no
-- request and fires nothing; remove its vercel.json cron by commit.
--
-- It touches nothing else. dispatch_log rows naming bill-details are history and
-- stay; a run in flight finishes or is cancelled by hand (gh run cancel — the open
-- measure rolls back and the mark-killed step closes the row); its walker rows
-- stay. Refuses a row that is not the one the file wrote.
--
-- Apply:  node scripts/db-query.mjs --local --file scripts/fix1453-revert-bill-details-row.sql
-- prod, under the gate, from the PRIMARY checkout (cc-328's STOP table):
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod --timeout 30s --file scripts/fix1453-revert-bill-details-row.sql

DO $$
DECLARE
  c_row CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:bill-details | congress_bill_details';
  v_row text;
  v_n   int;
BEGIN
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline) INTO v_row
    FROM public.job_registry WHERE job = 'bill-details';
  IF NOT FOUND THEN
    RAISE NOTICE '[fix1453 revert] no bill-details row — nothing to do';
    RETURN;
  END IF;
  IF v_row IS DISTINCT FROM c_row THEN
    RAISE EXCEPTION '[fix1453 revert] bill-details reads %, not the row 20261126008000 wrote (%) — read it before deleting', v_row, c_row;
  END IF;
  DELETE FROM public.job_registry WHERE job = 'bill-details';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1453 revert] job_registry bill-details deleted: % row(s)', v_n;
END $$;
