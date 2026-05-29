-- =============================================================================
-- 20260528180200_upsert_county_jurisdiction_rpc.sql
-- FIX-E (3/3): RPC to create-or-backfill county jurisdiction rows from TIGER.
--
-- Why a NEW RPC (not backfill_jurisdiction_boundary)?
--   FIX-421's backfill_jurisdiction_boundary(p_id, p_geojson) is UPDATE-only by
--   design — it never inserts. County rows don't exist yet (0 today), so the
--   county pass needs an INSERT-or-update path. This RPC inserts a row when no
--   county with the GEOID exists, and otherwise fills boundary/centroid only if
--   they are currently NULL — same "never overwrite an existing boundary"
--   guarantee FIX-421 enforces for the UPDATE-only case.
--
-- Why an RPC at all?
--   PostgREST cannot set a GEOMETRY column from a GeoJSON string directly. The
--   pipeline passes GeoJSON text and this SECURITY DEFINER RPC casts it via
--   ST_GeomFromGeoJSON inside the DB — same shape as FIX-421 / FIX-160.
--
-- search_path = public, extensions:
--   PostGIS lives in `extensions` on Pro, `public` on local Docker. A path with
--   both lets the unqualified ST_* calls resolve in either environment. An
--   empty / public-only path breaks ST_* resolution on Pro (bit FIX-420).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.upsert_county_jurisdiction(
  p_parent_id        uuid,
  p_census_geoid     text,   -- 5-digit STATEFP || COUNTYFP
  p_fips_code        text,   -- same 5-digit value (Civitics fips_code convention)
  p_name             text,   -- NAMELSAD, e.g. "King County", "Adjuntas Municipio"
  p_short_name       text,   -- NAME (bare), e.g. "King", "Adjuntas"
  p_boundary_geojson text    -- Polygon|MultiPolygon GeoJSON, stringified
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id   uuid;
  v_geom geometry(MultiPolygon, 4326);
BEGIN
  -- Normalize Polygon|MultiPolygon GeoJSON to MULTIPOLYGON (counties vary).
  v_geom := ST_Multi(ST_GeomFromGeoJSON(p_boundary_geojson))::geometry(MultiPolygon, 4326);

  -- Existing county row for this GEOID?
  SELECT id INTO v_id
    FROM public.jurisdictions
   WHERE type = 'county'
     AND census_geoid = p_census_geoid;

  IF v_id IS NULL THEN
    -- Insert path. centroid via ST_PointOnSurface (always lands inside the
    -- polygon, unlike ST_Centroid).
    INSERT INTO public.jurisdictions
      (parent_id, type, name, short_name, census_geoid, fips_code,
       boundary_geometry, centroid, is_active)
    VALUES
      (p_parent_id, 'county', p_name, p_short_name, p_census_geoid, p_fips_code,
       v_geom, ST_PointOnSurface(v_geom)::geometry(Point, 4326), true)
    RETURNING id INTO v_id;
  ELSE
    -- Update path — fill boundary/centroid only if currently NULL. COALESCE
    -- makes overwrite impossible, matching FIX-421's safety semantics.
    UPDATE public.jurisdictions
       SET boundary_geometry = COALESCE(boundary_geometry, v_geom),
           centroid          = COALESCE(centroid, ST_PointOnSurface(v_geom)::geometry(Point, 4326)),
           updated_at        = now()
     WHERE id = v_id;
  END IF;

  RETURN v_id;
END;
$$;

-- A single-row insert/update keyed on GEOID is fast, but a high-resolution
-- county MultiPolygon plus ST_PointOnSurface can take a beat. 5s is generous.
ALTER FUNCTION public.upsert_county_jurisdiction(uuid, text, text, text, text, text)
  SET statement_timeout = '5s';

REVOKE ALL ON FUNCTION public.upsert_county_jurisdiction(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_county_jurisdiction(uuid, text, text, text, text, text) TO service_role;
