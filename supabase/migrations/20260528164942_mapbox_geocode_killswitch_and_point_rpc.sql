-- =============================================================================
-- 20260528164942_mapbox_geocode_killswitch_and_point_rpc.sql
-- First consumer of the role/claim spine (FIX-419):
--   1. Seed pipeline_state.kill_switches.mapbox_geocode (defaults ON, idempotent
--      JSONB merge — preserves prior state if re-run).
--   2. Create jurisdictions_containing_point(lng, lat) SECURITY DEFINER RPC
--      for the verify-constituent route's spatial lookup.
-- =============================================================================

-- ── 1. Seed mapbox_geocode kill switch ────────────────────────────────────

INSERT INTO public.pipeline_state (key, value, updated_at)
VALUES (
  'kill_switches',
  jsonb_build_object(
    'mapbox_geocode',
    jsonb_build_object(
      'enabled', true,
      'auto_trip_threshold_pct', null,
      'metrics', '[]'::jsonb
    )
  ),
  NOW()
)
ON CONFLICT (key) DO UPDATE
  SET value = public.pipeline_state.value || jsonb_build_object(
        'mapbox_geocode',
        COALESCE(
          public.pipeline_state.value->'mapbox_geocode',
          jsonb_build_object(
            'enabled', true,
            'auto_trip_threshold_pct', null,
            'metrics', '[]'::jsonb
          )
        )
      ),
      updated_at = NOW();

-- ── 2. Spatial lookup RPC ─────────────────────────────────────────────────
-- Returns every active jurisdiction whose boundary_geometry contains the given
-- (lng, lat) point. SECURITY DEFINER so the route can call it with the admin
-- client without needing direct table grants, and so RLS on jurisdictions
-- doesn't gate the spatial scan.
--
-- statement_timeout of 3s protects against the rare cold-cache GIST query
-- under load — the request-path budget for /api/auth/verify-constituent
-- expects sub-second responses.

-- search_path = public, extensions matches the established pattern from
-- upsert_district_jurisdiction (FIX-160) — PostGIS lives in the extensions
-- schema on Supabase Pro, not public, so an empty/public-only search_path
-- breaks the ST_* resolution on prod.

CREATE OR REPLACE FUNCTION public.jurisdictions_containing_point(
  p_lng DOUBLE PRECISION,
  p_lat DOUBLE PRECISION
) RETURNS TABLE(id UUID, name TEXT, type TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT j.id, j.name, j.type::text
  FROM public.jurisdictions j
  WHERE j.is_active = true
    AND j.boundary_geometry IS NOT NULL
    AND ST_Contains(
      j.boundary_geometry,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)
    );
$$;

ALTER FUNCTION public.jurisdictions_containing_point(DOUBLE PRECISION, DOUBLE PRECISION)
  SET statement_timeout = '3s';

GRANT EXECUTE ON FUNCTION public.jurisdictions_containing_point(DOUBLE PRECISION, DOUBLE PRECISION)
  TO authenticated, service_role;
