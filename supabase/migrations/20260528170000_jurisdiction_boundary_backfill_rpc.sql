-- =============================================================================
-- 20260528170000_jurisdiction_boundary_backfill_rpc.sql
-- FIX-D: Backfill jurisdictions.boundary_geometry for state / county / place
-- rows from Census TIGER 2024 shapefiles.
--
-- Why a new RPC (not upsert_district_jurisdiction)?
--   upsert_district_jurisdiction() (FIX-160, 20260428061525_district_boundaries)
--   is district-specific: it hardcodes type='district' and INSERTs a new row on
--   no-match. Reusing it for state/county/place rows would create forbidden new
--   district rows. This backfill ONLY ever UPDATEs existing rows, so it needs
--   its own write path.
--
-- Why an RPC at all?
--   PostgREST cannot set a GEOMETRY column from a GeoJSON string directly. The
--   pipeline passes GeoJSON text and this SECURITY DEFINER RPC casts it via
--   ST_GeomFromGeoJSON inside the DB — the same shape as
--   upsert_district_jurisdiction.
--
-- search_path = public, extensions:
--   PostGIS lives in the `extensions` schema on Supabase Pro, not `public`. An
--   empty / public-only search_path breaks ST_* resolution on prod (bit FIX-420;
--   precedent upsert_district_jurisdiction).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.backfill_jurisdiction_boundary(
  p_id      uuid,
  p_geojson text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_geom    geometry(MultiPolygon, 4326);
  v_updated integer;
BEGIN
  -- Normalize Polygon|MultiPolygon GeoJSON to MULTIPOLYGON to match the column
  -- type (TIGER places are frequently single Polygons; states/counties vary).
  v_geom := ST_Multi(ST_GeomFromGeoJSON(p_geojson))::geometry(MultiPolygon, 4326);

  -- Idempotency + safety guard: only ever populate a NULL boundary, never
  -- overwrite an existing one. Re-running the backfill is a no-op for rows that
  -- already carry geometry (e.g. the ~6,775 district rows). Overwrite is
  -- deliberately impossible here — a future --force path would need its own
  -- audited RPC.
  --
  -- ST_PointOnSurface (not ST_Centroid) for the label point: it guarantees a
  -- point that lies ON an irregular / multipart polygon, where a centroid can
  -- land in water or outside the shape entirely.
  UPDATE public.jurisdictions
     SET boundary_geometry = v_geom,
         centroid          = ST_PointOnSurface(v_geom)::geometry(Point, 4326),
         updated_at        = now()
   WHERE id = p_id
     AND boundary_geometry IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- A single-row UPDATE keyed on the PK is fast, but a high-resolution
-- whole-state MultiPolygon (Alaska, coastal states) plus ST_PointOnSurface can
-- take a beat. 30s is generous headroom over the service_role default.
ALTER FUNCTION public.backfill_jurisdiction_boundary(uuid, text)
  SET statement_timeout = '30s';

REVOKE ALL ON FUNCTION public.backfill_jurisdiction_boundary(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backfill_jurisdiction_boundary(uuid, text) TO service_role;
