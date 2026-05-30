-- =============================================================================
-- 20260529120000_jurisdiction_boundary_svg_simplify.sql
-- FIX-G (1/2): shrink the boundary SVG payload.
--
-- The FIX-424 RPC emitted ST_AsSVG(geom, 0, 6) on the RAW geometry. For large
-- states that is enormous — FL ~441KB, TX ~1.4MB of path string per request.
-- This replaces the body with type-adaptive ST_SimplifyPreserveTopology +
-- precision-4 output, dropping FL to ~7KB and TX to ~27KB with no visible
-- degradation at the 300-600px render sizes the page uses.
--
-- search_path = public, extensions (UNQUOTED — two schemas):
--   PostGIS lives in `extensions` on Pro, `public` on local Docker. The quoted
--   form 'public, extensions' names ONE schema literally and breaks ST_*
--   resolution on Pro (bit FIX-420). Keep this unquoted.
--
-- ST_SimplifyPreserveTopology over ST_Simplify: keeps the polygon valid and
-- prevents collapse for thin geometries (some state-house districts are long
-- and narrow; naive ST_Simplify can erode them to a point).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.jurisdiction_boundary_svg(
  p_id     uuid,
  p_width  int DEFAULT 480,
  p_height int DEFAULT 320
) RETURNS TABLE(svg_path text, viewbox text, centroid_x numeric, centroid_y numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_geom       geometry;
  v_simplified geometry;
  v_env        geometry;
  v_area       double precision;
  v_tolerance  double precision;
BEGIN
  SELECT boundary_geometry INTO v_geom
    FROM public.jurisdictions
   WHERE id = p_id;

  IF v_geom IS NULL THEN
    RETURN;  -- no boundary → empty result set (page omits the map section)
  END IF;

  -- Adaptive tolerance: larger geometries simplify more aggressively without
  -- visible degradation at typical render sizes. SRID 4326 → area in square
  -- degrees, calibrated against US-latitude data (see FIX-G calibration audit).
  v_area := ST_Area(v_geom);
  v_tolerance := CASE
    WHEN v_area > 1.0   THEN 0.005    -- large states (TX, CA, FL, WA)
    WHEN v_area > 0.1   THEN 0.001    -- counties + small states (RI, NYC)
    WHEN v_area > 0.01  THEN 0.0005   -- cities, large districts
    ELSE 0.0001                       -- small districts
  END;

  v_simplified := ST_SimplifyPreserveTopology(v_geom, v_tolerance);
  v_env := ST_Envelope(v_simplified);

  RETURN QUERY SELECT
    ST_AsSVG(v_simplified, 0, 4) AS svg_path,        -- rel=0 (absolute), 4 dp
    format('%s %s %s %s',
      ST_XMin(v_env),
      -ST_YMax(v_env),                               -- SVG Y is inverted
      ST_XMax(v_env) - ST_XMin(v_env),
      ST_YMax(v_env) - ST_YMin(v_env)
    ) AS viewbox,
    -- ST_PointOnSurface always lands inside the polygon (unlike ST_Centroid).
    ST_X(ST_PointOnSurface(v_simplified))::numeric    AS centroid_x,
    (-ST_Y(ST_PointOnSurface(v_simplified)))::numeric AS centroid_y;  -- negated for SVG space
END;
$$;

ALTER FUNCTION public.jurisdiction_boundary_svg(uuid, int, int)
  SET statement_timeout = '2s';

REVOKE ALL ON FUNCTION public.jurisdiction_boundary_svg(uuid, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jurisdiction_boundary_svg(uuid, int, int)
  TO anon, authenticated, service_role;
