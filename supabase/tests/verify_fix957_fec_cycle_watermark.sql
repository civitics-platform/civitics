-- FIX-957 — synthetic proof for fec_cycle_watermark() / fec_cycle_full_pass_at().
--
-- Runs in ONE transaction and ROLLBACKs, so it can be replayed against any DB
-- without leaving a row behind. It writes a synthetic
-- pipeline_state.fec_bulk_cycle_watermarks value, exercises both functions
-- through the four states that matter, and restores nothing because nothing
-- commits.
--
--   node scripts/db-query.mjs --local --file supabase/tests/verify_fix957_fec_cycle_watermark.sql
--
-- NOTE: --prod is read-only by construction (SET TRANSACTION READ ONLY), so
-- this file cannot be run there; that is intentional. The prod verification is
-- the migration paste plus a plain SELECT against whatever the pipeline has
-- actually stamped.

BEGIN;

\set ON_ERROR_STOP on

-- Preserve whatever is really there; the ROLLBACK undoes this either way, but
-- an explicit upsert keeps the test honest about being destructive-in-txn.
INSERT INTO public.pipeline_state (key, value, updated_at)
VALUES (
  'fec_bulk_cycle_watermarks',
  jsonb_build_object(
    -- 2024: a COMPLETE pass — all four indiv writer stages, IE too.
    '2024', jsonb_build_object(
      'donor-entities',           jsonb_build_object('completed_at', '2026-07-13T04:10:00Z', 'fec_last_modified', 'Sun, 12 Jul 2026 09:00:00 GMT'),
      'indiv-to-candidate',       jsonb_build_object('completed_at', '2026-07-13T05:20:00Z', 'fec_last_modified', 'Sun, 12 Jul 2026 09:00:00 GMT'),
      'recipient-entities',       jsonb_build_object('completed_at', '2026-07-13T05:25:00Z', 'fec_last_modified', 'Sun, 12 Jul 2026 09:00:00 GMT'),
      'indiv-to-committee',       jsonb_build_object('completed_at', '2026-07-13T06:40:00Z', 'fec_last_modified', 'Sun, 12 Jul 2026 09:00:00 GMT'),
      'independent-expenditures', jsonb_build_object('completed_at', '2026-07-13T06:55:00Z', 'fec_last_modified', 'Sun, 12 Jul 2026 09:00:00 GMT')
    ),
    -- 2026: a KILLED pass — the last writer stage never completed. This is the
    -- shape a SIGTERM at the GHA budget leaves behind, and the whole reason the
    -- stamp is success-only.
    '2026', jsonb_build_object(
      'donor-entities',     jsonb_build_object('completed_at', '2026-08-09T05:12:00Z', 'fec_last_modified', 'Sun, 09 Aug 2026 09:00:00 GMT'),
      'indiv-to-candidate', jsonb_build_object('completed_at', '2026-08-09T06:01:00Z', 'fec_last_modified', 'Sun, 09 Aug 2026 09:00:00 GMT'),
      'recipient-entities', jsonb_build_object('completed_at', '2026-08-09T06:03:00Z', 'fec_last_modified', 'Sun, 09 Aug 2026 09:00:00 GMT')
    )
  ),
  now()
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

\echo '=== 1. Per-stage rows for a COMPLETE cycle (expect 5, IE included) ==='
SELECT stage, completed_at, fec_last_modified
FROM public.fec_cycle_watermark(2024)
ORDER BY completed_at;

\echo '=== 2. full_pass_at(2024) = MIN over the FOUR writer stages = 04:10 ==='
\echo '    (MIN, not MAX: the cycle is only re-derived once the slowest finished.)'
DO $$
DECLARE v timestamptz;
BEGIN
  SELECT public.fec_cycle_full_pass_at(2024) INTO v;
  ASSERT v = '2026-07-13T04:10:00Z'::timestamptz,
    format('expected 2026-07-13T04:10:00Z, got %s', v);
  RAISE NOTICE 'OK  full_pass_at(2024) = %', v;
END $$;

\echo '=== 3. The IE stage must NOT drag the scalar later (it is 06:55) ==='
DO $$
BEGIN
  ASSERT public.fec_cycle_full_pass_at(2024) < '2026-07-13T06:55:00Z'::timestamptz,
    'IE completion leaked into the full-pass scalar';
  RAISE NOTICE 'OK  IE stage excluded from the scalar';
END $$;

\echo '=== 4. A KILLED cycle has stage rows but NO full pass ==='
SELECT stage, completed_at FROM public.fec_cycle_watermark(2026) ORDER BY completed_at;
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.fec_cycle_watermark(2026)) = 3,
    'expected 3 stamped stages for the killed cycle';
  ASSERT public.fec_cycle_full_pass_at(2026) IS NULL,
    'a cycle missing indiv-to-committee must NOT report a full pass';
  RAISE NOTICE 'OK  killed cycle 2026: 3 stages stamped, full_pass_at IS NULL';
END $$;

\echo '=== 5. A cycle that was never run at all returns nothing / NULL ==='
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM public.fec_cycle_watermark(2020)) = 0,
    'an unstamped cycle must return zero rows';
  ASSERT public.fec_cycle_full_pass_at(2020) IS NULL,
    'an unstamped cycle must report NULL, not a bogus timestamp';
  RAISE NOTICE 'OK  unstamped cycle 2020: 0 rows, full_pass_at IS NULL';
END $$;

\echo '=== 6. The audit predicate short-circuits to NO rows when unanswerable ==='
\echo '    (NULL must never read as "everything is stale".)'
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM public.financial_relationships fr
  WHERE fr.cycle_year = 2020
    AND fr.updated_at < public.fec_cycle_full_pass_at(2020);
  ASSERT n = 0, format('NULL watermark must select no rows, got %s', n);
  RAISE NOTICE 'OK  NULL watermark selects 0 rows, not the whole cycle';
END $$;

ROLLBACK;

\echo '=== ROLLED BACK — pipeline_state is unchanged ==='
