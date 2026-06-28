-- FIX-687 — enable pg_cron (PR1 of the cron-resilience program).
--
-- The rebuild_entity_connections derivation has been timing out ~3 of 4 weeks on
-- the GitHub Actions runner (`rebuild-entity-connections.yml`, timeout-minutes:
-- 240). The donations chunk does ~90 min of million-row writes against the
-- IOWait-bound Pro Micro (256MB shared_buffers vs ~12.5GB working set, FIX-589)
-- and on Sundays contends with the still-running nightly-sync ingest. We can't
-- make the DB faster pre-revenue, so the fix is to make the rebuild
-- un-killable by an external runner: move it INTO the database via pg_cron,
-- where it is governed by the chunk functions' own statement_timeout instead of
-- a GHA wall-clock budget. This migration only enables the extension; the
-- procedure (FIX-687) and the schedule (FIX-688) land in the following two
-- migrations.
--
-- pg_cron installs into and runs its jobs against the database where public.*
-- lives — here that is `postgres` (Supabase's default cron.database_name), so
-- the scheduled CALL public.run_entity_connections_rebuild(...) resolves the
-- public functions without a cross-database hop. Confirmed locally:
--   SELECT * FROM pg_available_extensions WHERE name = 'pg_cron';
--     → pg_cron 1.6.4, and pg_cron is in shared_preload_libraries.

-- Belt-and-braces: surface a clear error at apply time if the binary isn't
-- available on this server, rather than the opaque CREATE EXTENSION failure.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    RAISE EXCEPTION
      'pg_cron is not available on this server (not in shared_preload_libraries). '
      'On Supabase enable it from the dashboard first; FIX-687 cannot proceed.';
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron;
