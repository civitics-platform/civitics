-- =============================================================================
-- FIX-1381 (cc-264) ROLLBACK — entity-tags-vacuum-analyze OFF the registry.
--
-- The mirror of supabase/migrations/20261108004000_fix1381_entity_tags_vacuum_analyze_registry_row.sql.
-- NOT a migration: a payload for the --call path.
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1381-revert-entity-tags-vacuum-row.sql
--
-- A LIVE ONE-SHOT is not cancelled by this: wait for its reap, or set
-- platform_dials.pause by hand first. A dispatch_log row naming the job is history
-- and stays. No cron row exists to park. Autovacuum carries entity_tags again.
--
-- Idempotent: the DELETE matches zero rows on a second run.
-- =============================================================================

DELETE FROM public.job_registry WHERE job = 'entity-tags-vacuum-analyze';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.job_registry WHERE job = 'entity-tags-vacuum-analyze') THEN
    RAISE EXCEPTION '[fix1381 revert] read-back: the row survived';
  END IF;
  RAISE NOTICE '[fix1381 revert] done: no entity-tags-vacuum-analyze row; autovacuum carries entity_tags';
END $$;
