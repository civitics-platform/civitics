-- scripts/fix1448-revert-vote-rolls-row.sql
-- FIX-1448 ROLLBACK (cc-331) — takes the vote-rolls walker out of the
-- dispatcher: DELETEs the one job_registry row
-- 20261127001000_fix1448_vote_rolls_registry_row.sql INSERTed. With no row the
-- pick never arms it, and the vote-rolls-request route (every 5 min) reads no
-- request and fires nothing; remove its vercel.json cron by commit.
--
-- It touches nothing else. dispatch_log rows naming vote-rolls are history and
-- stay; a run in flight finishes or is cancelled by hand (gh run cancel — each
-- write is one statement or one transaction, and the mark-killed step closes
-- the row); vote_rolls rows stay (nothing reads them until cc-332). Refuses a
-- row that is not the one the file wrote.
--
-- Apply:  node scripts/db-query.mjs --local --file scripts/fix1448-revert-vote-rolls-row.sql
-- prod, under the gate, from the PRIMARY checkout (cc-331's STOP table):
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod --timeout 30s --file scripts/fix1448-revert-vote-rolls-row.sql

DO $$
DECLARE
  c_row CONSTANT text := 'stale_after 2 hours | github_actions | gha-dispatch:vote-rolls | congress_vote_rolls';
  v_row text;
  v_n   int;
BEGIN
  SELECT concat_ws(' | ', deadline_rule, runner, unit_call, pipeline) INTO v_row
    FROM public.job_registry WHERE job = 'vote-rolls';
  IF NOT FOUND THEN
    RAISE NOTICE '[fix1448 revert] no vote-rolls row — nothing to do';
    RETURN;
  END IF;
  IF v_row IS DISTINCT FROM c_row THEN
    RAISE EXCEPTION '[fix1448 revert] vote-rolls reads %, not the row 20261127001000 wrote (%) — read it before deleting', v_row, c_row;
  END IF;
  DELETE FROM public.job_registry WHERE job = 'vote-rolls';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1448 revert] job_registry vote-rolls deleted: % row(s)', v_n;
END $$;
