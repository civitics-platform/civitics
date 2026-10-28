-- FIX-1356 REVERT — restores pg_db_role_setting for postgres@postgres and
-- authenticator@postgres to the state cc-252 read 2 recorded on prod
-- (2026-10-28 00:47Z), before 20261028000000_fix1356_parallel_zero_hash_mem_one.sql:
--
--   postgres      @ postgres  {statement_timeout=3h,work_mem=64MB}
--   authenticator @ postgres  no row
--
-- Neither parameter had an entry on either role, so each comes back with
-- RESET (a present entry would have been SET back to its old value instead).
-- RESET of the last entry deletes authenticator's db row; postgres keeps its
-- row with M1's two settings. The global authenticator row (setdatabase 0)
-- was never touched and is not touched here. Sessions pick the old values up
-- at their next login.
--
-- Run (prod):  node scripts/db-query.mjs --prod --call --yes-i-mean-prod --file scripts/fix1356-revert-parallel-hash.sql
-- Rehearse:    inside BEGIN … ROLLBACK on the clone.
ALTER ROLE postgres IN DATABASE postgres RESET max_parallel_workers_per_gather;
ALTER ROLE postgres IN DATABASE postgres RESET hash_mem_multiplier;
ALTER ROLE authenticator IN DATABASE postgres RESET max_parallel_workers_per_gather;
ALTER ROLE authenticator IN DATABASE postgres RESET hash_mem_multiplier;

DO $$
DECLARE
  v_pg   text[];
  v_auth text[];
BEGIN
  SELECT s.setconfig INTO v_pg
    FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
   WHERE r.rolname = 'postgres' AND d.datname = 'postgres';
  SELECT s.setconfig INTO v_auth
    FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole JOIN pg_database d ON d.oid = s.setdatabase
   WHERE r.rolname = 'authenticator' AND d.datname = 'postgres';
  RAISE NOTICE '[fix1356 revert] postgres@postgres = % · authenticator@postgres = %', v_pg, v_auth;
  IF v_pg IS DISTINCT FROM ARRAY['statement_timeout=3h', 'work_mem=64MB'] THEN
    RAISE EXCEPTION '[fix1356 revert] postgres@postgres is %, want {statement_timeout=3h,work_mem=64MB}', v_pg;
  END IF;
  IF v_auth IS NOT NULL THEN
    RAISE EXCEPTION '[fix1356 revert] authenticator@postgres still has a row: %', v_auth;
  END IF;
END $$;
