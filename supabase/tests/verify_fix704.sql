-- FIX-704 — deterministic asserts for the incremental donor-rollup table +
-- recipient_count decouple.
--
-- Run AFTER the bootstrap (CALL public.refresh_official_donor_rollup_incremental()
-- with a NULL watermark) so the invariant checks see a populated table. Run
-- WITHOUT --single-transaction (assert blocks manage their own txns):
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/verify_fix704.sql
--
-- The memory-boundedness proof (flat RSS during bootstrap), the old-MV parity
-- diff, and the incremental dirty-only check are run as separate steps — they
-- need a pre-migration MV snapshot and OS-level observation. This file holds
-- everything re-runnable.

\set ON_ERROR_STOP on
\timing on

\echo '== 1. official_donor_rollup_mv is a TABLE (relkind r), not an MV =='
DO $$
DECLARE k char;
BEGIN
  SELECT c.relkind INTO k
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public' AND c.relname = 'official_donor_rollup_mv';
  ASSERT k = 'r', format('official_donor_rollup_mv relkind = %s, expected r (table)', k);
  RAISE NOTICE 'official_donor_rollup_mv is a regular table';
END $$;

\echo '== 2. PK (official_id, relationship_type, rank) + RLS read policy present =='
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
  WHERE conrelid = 'public.official_donor_rollup_mv'::regclass AND contype = 'p';
  ASSERT n = 1, 'missing PK on official_donor_rollup_mv';
  SELECT count(*) INTO n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'official_donor_rollup_mv' AND cmd = 'SELECT';
  ASSERT n = 1, 'missing SELECT policy on official_donor_rollup_mv';
  RAISE NOTICE 'PK + RLS read policy present';
END $$;

\echo '== 3. shape invariants: no rank in (202..1001], tail rows are rank 201 with NULL donor_id, ranked rows have donor_id =='
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.official_donor_rollup_mv WHERE rank > 201;
  ASSERT n = 0, format('%s rows beyond rank 201 (old top-1000 shape leaked)', n);
  SELECT count(*) INTO n FROM public.official_donor_rollup_mv
   WHERE rank = 201 AND (donor_id IS NOT NULL OR tail_donor_count IS NULL OR tail_donor_count < 1);
  ASSERT n = 0, format('%s malformed tail rows', n);
  SELECT count(*) INTO n FROM public.official_donor_rollup_mv
   WHERE rank <= 200 AND (donor_id IS NULL OR tail_donor_count IS NOT NULL);
  ASSERT n = 0, format('%s malformed ranked rows', n);
  RAISE NOTICE 'top-200 + tail shape holds';
END $$;

\echo '== 4. SUM invariant: rollup total = live FR total for the top-5 recipients by rollup total =='
BEGIN;
SET LOCAL statement_timeout = '0';
DO $$
DECLARE r record; live bigint; bad int := 0;
BEGIN
  FOR r IN
    SELECT official_id, relationship_type, SUM(total_cents) AS rollup_cents
    FROM public.official_donor_rollup_mv
    GROUP BY official_id, relationship_type
    ORDER BY SUM(total_cents) DESC
    LIMIT 5
  LOOP
    SELECT COALESCE(SUM(fr.amount_cents), 0) INTO live
    FROM public.financial_relationships fr
    WHERE fr.to_id = r.official_id
      AND fr.relationship_type::text = r.relationship_type
      AND fr.from_type = 'financial_entity';
    IF live <> r.rollup_cents THEN
      bad := bad + 1;
      RAISE WARNING 'SUM mismatch for % / %: rollup=% live=%',
        r.official_id, r.relationship_type, r.rollup_cents, live;
    END IF;
  END LOOP;
  ASSERT bad = 0, format('%s of 5 sampled recipients fail the SUM invariant', bad);
  RAISE NOTICE 'SUM invariant holds for the top-5 recipients';
END $$;
ROLLBACK;

\echo '== 5. recipients now include financial_entity to_ids (the widened super-PAC set) =='
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(DISTINCT r.official_id) INTO n
  FROM public.official_donor_rollup_mv r
  JOIN public.financial_entities fe ON fe.id = r.official_id;
  ASSERT n > 0, 'no financial_entity recipients in the rollup — FIX-704 widening missing';
  RAISE NOTICE '% financial_entity recipients present (super-PAC money in the rollup)', n;
END $$;

\echo '== 6. rebuild procedure is edges-only (no MV refresh, no finalize) =='
DO $$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'run_entity_connections_rebuild' AND p.prokind = 'p';
  ASSERT src IS NOT NULL, 'run_entity_connections_rebuild procedure missing';
  ASSERT src NOT ILIKE '%REFRESH MATERIALIZED VIEW%', 'procedure still refreshes the donor-rollup MV';
  ASSERT src NOT ILIKE '%rebuild_ec_donations_full_finalize%', 'procedure still calls the finalize';
  RAISE NOTICE 'rebuild procedure is edges-only';
END $$;

\echo '== 7. finalize dropped; new helper/procedures present =='
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public' AND p.proname = 'rebuild_ec_donations_full_finalize';
  ASSERT n = 0, 'rebuild_ec_donations_full_finalize still exists';
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND ((p.proname = 'donor_rollup_rebuild_recipients' AND p.prokind = 'f')
      OR (p.proname = 'refresh_official_donor_rollup_incremental' AND p.prokind = 'p')
      OR (p.proname = 'reconcile_recipient_count' AND p.prokind = 'p')
      OR (p.proname = 'refresh_official_donor_rollup_mv' AND p.prokind = 'f'));
  ASSERT n = 4, format('expected 4 FIX-704 routines, found %s', n);
  RAISE NOTICE 'finalize dropped; helper + 2 procedures + compat shim present';
END $$;

\echo '== 8. pg_cron jobs registered and PAUSED =='
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM cron.job
  WHERE jobname IN ('donor-rollup-refresh', 'ec-vacuum-analyze', 'ec-recipient-count-reconcile')
    AND active = false;
  ASSERT n = 3, format('expected 3 paused FIX-704 cron jobs, found %s', n);
  RAISE NOTICE 'donor-rollup-refresh + ec-vacuum-analyze + ec-recipient-count-reconcile registered, paused';
END $$;

\echo '== 9. reconcile_recipient_count() matches the legacy finalize aggregation (window sample, txn-rollback) =='
BEGIN;
SET LOCAL statement_timeout = '0';
DO $$
DECLARE n_mismatch bigint;
BEGIN
  -- Ground truth for one from_id window vs the stored column AFTER a reconcile
  -- run would have applied it. Here we only assert the stored counts are not
  -- wildly divergent NOW for donors that have edges in the window — the full
  -- reconcile correctness is exercised by the CALL step outside this file.
  SELECT count(*) INTO n_mismatch
  FROM (
    SELECT ec.from_id, COUNT(DISTINCT ec.to_id)::smallint AS cnt
    FROM public.entity_connections ec
    WHERE ec.connection_type = 'donation'
      AND ec.from_type = 'financial_entity'
      AND ec.from_id >= '00000000-0000-0000-0000-000000000000'
      AND ec.from_id <  '10000000-0000-0000-0000-000000000000'
    GROUP BY ec.from_id
  ) sub
  JOIN public.financial_entities fe ON fe.id = sub.from_id AND fe.entity_type = 'individual'
  WHERE fe.recipient_count IS DISTINCT FROM sub.cnt;
  ASSERT n_mismatch = 0,
    format('%s individual donors in window 1 have recipient_count out of sync (run CALL reconcile_recipient_count())', n_mismatch);
  RAISE NOTICE 'recipient_count in sync for window 1 individuals';
END $$;
ROLLBACK;

\echo '== FIX-704 DETERMINISTIC CHECKS PASSED (bootstrap memory profile + old-MV parity + incremental dirty-only run as separate steps) =='
