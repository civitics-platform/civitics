-- FIX-687/688 — local verification for the pg_cron entity_connections rebuild.
--
-- Run WITHOUT --single-transaction (the procedure issues COMMIT, which cannot
-- run inside a wrapping transaction block):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/verify_pgcron_rebuild.sql
--
-- Covers checks 1,2,3,5 from the FIX-687 plan. Check 4 (advisory-lock skip,
-- which needs a second session holding the lock) is run by the harness bash
-- command right after this file, with a background psql holding the lock.
-- No DELETE / destructive SQL — purely additive (rebuilds derived rows + reads).

\set ON_ERROR_STOP on
\timing on

\echo '== 1. pg_cron extension present =='
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron extension is not installed';
  END IF;
END;
$$;
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_cron';

\echo '== 2. both rebuild cron jobs registered with expected schedules =='
SELECT jobname, schedule, active, command
  FROM cron.job
 WHERE jobname IN ('rebuild-ec-full', 'rebuild-ec-incremental')
 ORDER BY jobname;
DO $$
DECLARE
  v_full text;
  v_incr text;
  v_n    int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('rebuild-ec-full', 'rebuild-ec-incremental');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected 2 rebuild cron jobs, found %', v_n;
  END IF;
  SELECT schedule INTO v_full FROM cron.job WHERE jobname = 'rebuild-ec-full';
  SELECT schedule INTO v_incr FROM cron.job WHERE jobname = 'rebuild-ec-incremental';
  IF v_full <> '0 8 * * 1' THEN
    RAISE EXCEPTION 'rebuild-ec-full schedule = % (expected 0 8 * * 1)', v_full;
  END IF;
  IF v_incr <> '0 8 * * 3' THEN
    RAISE EXCEPTION 'rebuild-ec-incremental schedule = % (expected 0 8 * * 3)', v_incr;
  END IF;
END;
$$;

\echo '== 3. baseline entity_connections count =='
SELECT count(*) AS entity_connections_before FROM public.entity_connections;

\echo '== 3a. CALL run_entity_connections_rebuild(incremental) =='
CALL public.run_entity_connections_rebuild('incremental');
DO $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM public.data_sync_log
   WHERE pipeline = 'entity_connections_rebuild'
   ORDER BY started_at DESC LIMIT 1;
  IF s <> 'complete' THEN
    RAISE EXCEPTION 'incremental rebuild terminal status = % (expected complete)', s;
  END IF;
  RAISE NOTICE 'incremental rebuild → complete';
END;
$$;

\echo '== 5 (extra). CALL run_entity_connections_rebuild(full) — exercises windowed donations + autovacuum bracket + MV refresh =='
CALL public.run_entity_connections_rebuild('full');
DO $$
DECLARE
  s   text;
  cnt bigint;
BEGIN
  SELECT status INTO s FROM public.data_sync_log
   WHERE pipeline = 'entity_connections_rebuild'
   ORDER BY started_at DESC LIMIT 1;
  IF s <> 'complete' THEN
    RAISE EXCEPTION 'full rebuild terminal status = % (expected complete)', s;
  END IF;
  SELECT count(*) INTO cnt FROM public.entity_connections;
  IF cnt < 1 THEN
    RAISE EXCEPTION 'entity_connections empty after full rebuild (count=%)', cnt;
  END IF;
  -- autovacuum must be back ON after a full rebuild (FIX-590 bracket).
  IF EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.entity_connections'::regclass
       AND reloptions @> ARRAY['autovacuum_enabled=false']
  ) THEN
    RAISE EXCEPTION 'autovacuum left disabled on entity_connections after full rebuild';
  END IF;
  RAISE NOTICE 'full rebuild → complete, entity_connections=%', cnt;
END;
$$;

\echo '== recent entity_connections_rebuild rows =='
SELECT status, rows_inserted, rows_failed, metadata->>'mode' AS mode,
       (completed_at - started_at) AS dur
  FROM public.data_sync_log
 WHERE pipeline = 'entity_connections_rebuild'
 ORDER BY started_at DESC LIMIT 4;

\echo '== ALL FILE CHECKS PASSED (advisory-lock skip proof runs next, in bash) =='
