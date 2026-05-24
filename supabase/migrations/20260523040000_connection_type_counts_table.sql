-- FIX-338 — materialize connection_type GROUP BY into a 16-row table.
--
-- Background: get_connection_type_counts() RPC runs ~400ms standalone
-- warm on prod's 5.1M-row entity_connections but balloons to ~5.8s
-- under the parallel /status cron load. The contention is the
-- connection pool / shared buffers under ~28 concurrent queries from
-- computeStatusPayload's per-section parallel block (FIX-336 diagnosis
-- 2026-05-24). Materializing into a 16-row table makes the read
-- trivial (sub-ms) and eliminates the contention burst entirely.
--
-- Refresh strategy: TRUNCATE + INSERT inside the refresh function's
-- implicit transaction. Atomic. Called from:
--   1. End of umbrella public.rebuild_entity_connections() (PostgREST
--      RPC umbrella path + local dev single-call shape — handled in
--      a sibling migration that re-defines the umbrella).
--   2. The chunked-rebuild script (packages/data/src/scripts/
--      rebuild-entity-connections.ts), which is the path GHA actually
--      uses on prod via direct pg.Client per-chunk calls.

CREATE TABLE IF NOT EXISTS public.connection_type_counts (
  connection_type TEXT        PRIMARY KEY,
  total           BIGINT      NOT NULL,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.connection_type_counts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'connection_type_counts'
      AND policyname = 'no public read connection_type_counts'
  ) THEN
    CREATE POLICY "no public read connection_type_counts"
      ON public.connection_type_counts FOR SELECT USING (false);
  END IF;
END$$;

-- Refresh function — full rebuild of the 16-row table.
CREATE OR REPLACE FUNCTION public.refresh_connection_type_counts()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- TRUNCATE + INSERT inside the function's implicit transaction is
  -- atomic. Readers see either the pre-refresh state or the post-refresh
  -- state, never an empty mid-refresh state.
  TRUNCATE TABLE public.connection_type_counts;
  INSERT INTO public.connection_type_counts (connection_type, total, refreshed_at)
    SELECT connection_type, COUNT(*)::BIGINT, NOW()
    FROM public.entity_connections
    GROUP BY connection_type;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_connection_type_counts()
  TO authenticated, service_role;

-- Swap the RPC body to read from the materialized table.
CREATE OR REPLACE FUNCTION public.get_connection_type_counts()
RETURNS TABLE(connection_type TEXT, total BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT connection_type, total
  FROM public.connection_type_counts
  ORDER BY total DESC;
$$;

-- Seed the table immediately so the first post-deploy /status read
-- doesn't return empty.
SELECT public.refresh_connection_type_counts();
