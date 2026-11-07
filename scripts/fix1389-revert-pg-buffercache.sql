-- =============================================================================
-- FIX-1389 (cc-264) ROLLBACK — pg_buffercache OFF.
--
-- The mirror of supabase/migrations/20261108003000_fix1389_install_pg_buffercache.sql.
-- NOT a migration: a payload for the --call path.
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1389-revert-pg-buffercache.sql
--
-- Nothing depends on it; M4-class reads go back to rule 429's rolled-back pattern.
-- Idempotent: IF EXISTS.
-- =============================================================================

DROP EXTENSION IF EXISTS pg_buffercache;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_buffercache') THEN
    RAISE EXCEPTION '[fix1389 revert] read-back: pg_buffercache is still installed';
  END IF;
  RAISE NOTICE '[fix1389 revert] done: pg_buffercache removed';
END $$;
