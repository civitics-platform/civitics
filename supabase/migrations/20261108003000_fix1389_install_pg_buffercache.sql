-- =============================================================================
-- FIX-1389 — install pg_buffercache in the extensions schema. cc-264, 2026-11-07.
--
-- Prompt: cc-prompt-264-…, D5. M4-class pool reads have been riding a rolled-back
-- CREATE EXTENSION (rule 429: BEGIN / CREATE / read / ROLLBACK), twice each in cc-255
-- and cc-263. This retires that pattern: the read is a plain SELECT from here on.
--
-- WHAT: CREATE EXTENSION IF NOT EXISTS pg_buffercache WITH SCHEMA extensions, guarded
-- by pg_available_extensions like fix1258 and on the repo's convention
-- (20260420040000). Prod offers 1.5 (cc-264 read 2), and so does the local image, so
-- the NOTICE path is for a build that lacks it. The clone's ACL after install gives
-- the view and its functions to postgres and pg_monitor. The REVOKE names anon,
-- authenticated and service_role anyway: this repo has been caught by Supabase's
-- default grants before, and the read-back RAISEs if any of the three can read it.
--
-- THE COST: none at rest. Each read walks the buffer headers, 32,768 at the current
-- 256 MB; it is a diagnostic, never a request-path read.
--
-- CLASS: P. A catalog write and a read-back.
--
-- ROLLBACK: scripts/fix1389-revert-pg-buffercache.sql (DROP EXTENSION IF EXISTS).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_buffercache') THEN
    CREATE EXTENSION IF NOT EXISTS pg_buffercache WITH SCHEMA extensions;
  ELSE
    RAISE NOTICE '[fix1389] pg_buffercache is not available on this build — nothing installed';
  END IF;
END $$;

-- ── privileges, then the read-back — RAISE on any miss ──────────────────────
DO $$
DECLARE
  v_version text;
  v_schema  text;
  v_buffers bigint;
  v_public  boolean;
BEGIN
  SELECT e.extversion::text, n.nspname::text INTO v_version, v_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_buffercache';
  IF v_version IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_buffercache') THEN
      RAISE EXCEPTION '[fix1389] read-back failed: available but not installed';
    END IF;
    RETURN;
  END IF;
  IF v_schema IS DISTINCT FROM 'extensions' THEN
    RAISE EXCEPTION '[fix1389] read-back failed: installed in schema %, expected extensions', v_schema;
  END IF;

  EXECUTE 'REVOKE ALL ON extensions.pg_buffercache FROM anon, authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION extensions.pg_buffercache_pages() FROM anon, authenticated, service_role';

  EXECUTE 'SELECT count(*) FROM extensions.pg_buffercache' INTO v_buffers;
  v_public := has_table_privilege('anon', 'extensions.pg_buffercache', 'SELECT')
           OR has_table_privilege('authenticated', 'extensions.pg_buffercache', 'SELECT')
           OR has_table_privilege('service_role', 'extensions.pg_buffercache', 'SELECT')
           OR has_function_privilege('anon', 'extensions.pg_buffercache_pages()', 'EXECUTE')
           OR has_function_privilege('authenticated', 'extensions.pg_buffercache_pages()', 'EXECUTE')
           OR has_function_privilege('service_role', 'extensions.pg_buffercache_pages()', 'EXECUTE');
  IF v_public THEN
    RAISE EXCEPTION '[fix1389] read-back failed: an API role can still read pg_buffercache';
  END IF;
  RAISE NOTICE '[fix1389] read-back ok: pg_buffercache % in schema %; % buffers readable by postgres; no API role can read it',
    v_version, v_schema, v_buffers::text;
END $$;
