-- FIX-338 — append PERFORM public.refresh_connection_type_counts() to the
-- umbrella rebuild_entity_connections() function, so any caller that goes
-- through the umbrella RPC (local dev `pnpm data:rebuild-connections` when
-- SUPABASE_DB_URL is unset, or ad-hoc PostgREST callers) refreshes the
-- connection_type_counts table at the end.
--
-- The GHA prod path does NOT call this umbrella — it iterates chunk
-- functions directly via pg.Client. That path gets its own refresh from
-- packages/data/src/scripts/rebuild-entity-connections.ts.
--
-- Body is identical to 20260513000000_chunked_rebuild_entity_connections.sql
-- (the FIX-263 chunked-rebuild definition), with one new line:
--   PERFORM public.refresh_connection_type_counts();
-- emitted after the chunk-loop, before the final RETURN.

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections()
RETURNS TABLE(connection_type TEXT, edges_upserted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  chunk_fn TEXT;
  chunk_names TEXT[] := ARRAY[
    'rebuild_entity_connections_donations',
    'rebuild_entity_connections_votes',
    'rebuild_entity_connections_cosponsors',
    'rebuild_entity_connections_appointments',
    'rebuild_entity_connections_oversight',
    'rebuild_entity_connections_holds',
    'rebuild_entity_connections_gifts',
    'rebuild_entity_connections_contracts',
    'rebuild_entity_connections_lobbying',
    'rebuild_entity_connections_external'
  ];
BEGIN
  FOREACH chunk_fn IN ARRAY chunk_names LOOP
    BEGIN
      FOR r IN EXECUTE format('SELECT * FROM public.%I()', chunk_fn) LOOP
        connection_type := r.connection_type;
        edges_upserted  := r.edges_upserted;
        RETURN NEXT;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'rebuild chunk % failed: %', chunk_fn, SQLERRM;
      connection_type := chunk_fn || ':failed';
      edges_upserted  := -1;
      RETURN NEXT;
    END;
  END LOOP;

  -- FIX-338 — materialize the connection_type GROUP BY once per rebuild.
  -- Wrapped in BEGIN/EXCEPTION so a refresh failure (e.g. lock contention)
  -- doesn't abort the umbrella; the next rebuild or a manual refresh will
  -- catch up. Logged as a warning so the failure stays greppable.
  BEGIN
    PERFORM public.refresh_connection_type_counts();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'refresh_connection_type_counts failed: %', SQLERRM;
  END;

  RETURN;
END;
$$;

ALTER FUNCTION public.rebuild_entity_connections() SET statement_timeout = '60min';
