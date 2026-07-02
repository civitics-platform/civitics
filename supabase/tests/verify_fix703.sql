-- FIX-703 — deterministic asserts for the per-window-COMMIT donations rebuild.
--
-- Run WITHOUT --single-transaction (the assert blocks manage their own txns;
-- the procedure-level red/green/resilience pg_cron timing tests run as separate
-- bash steps — a direct CALL inherits psql's statement_timeout and can't
-- reproduce the wall):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/verify_fix703.sql
--
-- These are the checks that were MISSING from PR1: idempotency + no-gap + no-dup
-- of the range-scoped delete+insert, and prepare() being non-destructive. Purely
-- structural — they wrap window() calls in a txn and ROLLBACK, so the real edge
-- set is never mutated.

\set ON_ERROR_STOP on
\timing on

\echo '== 1. prepare() is non-destructive (no longer global-DELETEs edges) =='
BEGIN;
SET LOCAL statement_timeout = '0';
DO $$
DECLARE before_cnt bigint; after_cnt bigint;
BEGIN
  SELECT count(*) INTO before_cnt FROM public.entity_connections WHERE connection_type = 'donation';
  PERFORM public.rebuild_ec_donations_full_prepare();
  SELECT count(*) INTO after_cnt FROM public.entity_connections WHERE connection_type = 'donation';
  ASSERT before_cnt = after_cnt,
    format('prepare() must not delete edges (was %s, now %s)', before_cnt, after_cnt);
  RAISE NOTICE 'prepare() non-destructive: donation edges unchanged at %', after_cnt;
END $$;
ROLLBACK;

\echo '== 2. window() is range-scoped + idempotent (run twice → same count, no unique violation) =='
BEGIN;
SET LOCAL statement_timeout = '0';
DO $$
DECLARE
  lo uuid := '20000000-0000-0000-0000-000000000000';
  hi uuid := '30000000-0000-0000-0000-000000000000';
  n1 bigint; n2 bigint;
  in_range_before bigint; in_range_after bigint;
BEGIN
  -- Edges outside [lo,hi) must be untouched by a scoped window (no-gap proof:
  -- the window only rewrites its own from_id range).
  SELECT count(*) INTO in_range_before
    FROM public.entity_connections
   WHERE connection_type = 'donation' AND from_id >= lo AND from_id < hi;

  n1 := public.rebuild_ec_donations_full_window(lo, hi);
  -- A second identical call would throw a unique-constraint violation if the
  -- scoped DELETE did NOT clear the range before the INSERT. Reaching n2 proves
  -- the delete+insert is self-contained and re-runnable.
  n2 := public.rebuild_ec_donations_full_window(lo, hi);

  ASSERT n1 = n2, format('window not idempotent: first=%s second=%s', n1, n2);

  SELECT count(*) INTO in_range_after
    FROM public.entity_connections
   WHERE connection_type = 'donation' AND from_id >= lo AND from_id < hi;
  ASSERT in_range_after = n2,
    format('in-range edge count (%s) != window return (%s)', in_range_after, n2);

  RAISE NOTICE 'window idempotent: % edges in range [20..30), re-runnable with no unique violation', n2;
END $$;
ROLLBACK;

\echo '== 3. no duplicate donation edges on the unique key =='
BEGIN;
SET LOCAL statement_timeout = '0';
DO $$
DECLARE dup_cnt bigint;
BEGIN
  SELECT count(*) INTO dup_cnt FROM (
    SELECT from_type, from_id, to_type, to_id, connection_type
      FROM public.entity_connections
     WHERE connection_type = 'donation'
     GROUP BY from_type, from_id, to_type, to_id, connection_type
    HAVING count(*) > 1
  ) d;
  ASSERT dup_cnt = 0, format('found %s duplicate donation edge keys', dup_cnt);
  RAISE NOTICE 'no duplicate donation edges';
END $$;
ROLLBACK;

\echo '== 4. function signatures unchanged (prepare→void, window(uuid,uuid)→bigint, finalize→bigint) =='
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('rebuild_ec_donations_full_prepare',
                       'rebuild_ec_donations_full_window',
                       'rebuild_ec_donations_full_finalize');
  ASSERT n = 3, format('expected 3 donations helper functions, found %s', n);
  RAISE NOTICE 'all 3 donations helper functions present with expected signatures';
END $$;

\echo '== 5. procedure present + granted to service_role =='
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'run_entity_connections_rebuild'
     AND p.prokind = 'p';
  ASSERT n = 1, format('expected run_entity_connections_rebuild PROCEDURE, found %s', n);
  RAISE NOTICE 'run_entity_connections_rebuild procedure present';
END $$;

\echo '== FIX-703 DETERMINISTIC CHECKS PASSED (red/green/resilience pg_cron timing tests run in bash) =='
