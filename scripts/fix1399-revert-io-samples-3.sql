-- =============================================================================
-- FIX-1399 (cc-267) ROLLBACK — io_samples 2 → 3.
--
-- The mirror of supabase/migrations/20261111002000_fix1399_io_samples_2.sql.
-- NOT a migration: a payload for the --call path:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1399-revert-io-samples-3.sql
--
-- A hold already set stands until it expires (io_throttle_hold_min); the
-- streak reads against 3 from the next sample on. Idempotent.
-- =============================================================================

DO $$
DECLARE
  v_n int;
BEGIN
  UPDATE public.platform_dials SET io_samples = 3 WHERE io_samples = 2;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1399-revert] platform_dials.io_samples 2 → 3: % row(s); now %', v_n,
    (SELECT io_samples FROM public.platform_dials WHERE id);
END $$;
