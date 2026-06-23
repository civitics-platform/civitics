-- FIX-650 — read-only detector for stranded autovacuum on rebuild-toggled tables.
--
-- The full entity_connections rebuild (scripts/rebuild-entity-connections.ts)
-- pauses autovacuum (FIX-590: ALTER ... SET autovacuum_enabled=false) for the
-- duration to keep its VACUUM I/O from competing with the window INSERTs on the
-- cache-starved Pro Small, then re-enables it in a finally + startup reconcile
-- (FIX-591). But a GHA SIGKILL at the 4h cap skips the finally, and the manual
-- "2b" recovery path (run-rebuild-chunks-prod.ts) historically never managed the
-- flag — so on 2026-06-21 entity_connections was left at autovacuum_enabled=false
-- and bloated to ~70% dead tuples before anyone noticed (FIX-650).
--
-- This function lets the daily sync canary (canary-check.ts, 05:00 UTC — never
-- inside the Sun/Wed 08:00 rebuild window) detect that stranded state the morning
-- after, the belt-and-braces that would have caught FIX-650. PostgREST can't read
-- pg_class.reloptions or pg_stat_activity directly (system catalogs aren't in the
-- exposed schema), so the read is wrapped in this RPC.
--
-- Returns ONE jsonb aggregate (not SETOF) per the PostgREST row-cap convention:
--   { "tables":         [{ "relname": "entity_connections", "autovacuum_enabled": true }],
--     "rebuild_active":  false,
--     "stranded":        [] }   -- relnames sitting at autovacuum_enabled=false
--
-- SECURITY DEFINER so the function owner (postgres, a pg_monitor member on Pro)
-- can see every backend's application_name in pg_stat_activity — needed to tell a
-- legitimately-paused table during an in-flight rebuild from a genuinely stranded
-- one. reloptions/pg_class are world-readable regardless.

CREATE OR REPLACE FUNCTION public.check_rebuild_autovacuum_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH toggled(relname) AS (
    -- The set of tables the entity_connections rebuild toggles autovacuum on.
    -- Add a row here if a future rebuild path pauses autovacuum on another table.
    VALUES ('entity_connections')
  ),
  state AS (
    SELECT
      t.relname,
      -- reloptions only carries 'autovacuum_enabled=false' when EXPLICITLY set;
      -- absent => the default (true). Parse it out, defaulting to true.
      COALESCE(
        (SELECT (split_part(opt, '=', 2))::boolean
           FROM unnest(c.reloptions) AS opt
          WHERE opt LIKE 'autovacuum_enabled=%'),
        true
      ) AS autovacuum_enabled
    FROM toggled t
    JOIN pg_class c     ON c.relname = t.relname
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  )
  SELECT jsonb_build_object(
    'tables', COALESCE(
      jsonb_agg(jsonb_build_object(
        'relname',            s.relname,
        'autovacuum_enabled', s.autovacuum_enabled
      ) ORDER BY s.relname),
      '[]'::jsonb
    ),
    -- A full rebuild legitimately holds autovacuum off while running; don't flag
    -- that as stranded. The rebuild tags its backend application_name (FIX-591).
    'rebuild_active', EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE application_name LIKE 'entity_connections_rebuild%'
        AND state <> 'idle'
    ),
    'stranded', COALESCE(
      jsonb_agg(s.relname ORDER BY s.relname) FILTER (WHERE NOT s.autovacuum_enabled),
      '[]'::jsonb
    )
  )
  FROM state s;
$$;

COMMENT ON FUNCTION public.check_rebuild_autovacuum_status() IS
  'FIX-650 — read-only: returns rebuild-toggled tables stranded at autovacuum_enabled=false (excludes an in-flight rebuild). Consumed by the daily sync canary.';

REVOKE ALL ON FUNCTION public.check_rebuild_autovacuum_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rebuild_autovacuum_status() TO service_role;
