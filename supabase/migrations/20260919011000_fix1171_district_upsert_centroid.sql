-- FIX-1171 — upsert_district_jurisdiction() writes centroid on BOTH paths.
--
-- THE FINDING. The RPC has written boundary_geometry since FIX-160
-- (20260428061525_district_boundaries.sql) and has never written `centroid` at
-- all. Every one of the 7,211 TIGER district rows carries a non-NULL centroid
-- only because 20260528170000's backfill RPC filled them once, out of band,
-- and that RPC refuses by construction to touch a row whose boundary_geometry
-- is already set. So:
--
--   INSERT path — a genuinely new district (a new TIGER vintage, a new
--                 chamber) lands with centroid NULL and nothing ever fills it,
--                 because the backfill only populates rows with a NULL
--                 boundary, and this INSERT sets the boundary.
--   UPDATE path — a redistricted polygon replaces the geometry and leaves the
--                 centroid at the OLD district's position. Silently: no
--                 constraint is violated, no count changes, and the label point
--                 is simply wrong.
--
-- This is a loaded gun rather than a live fire. `districts-tiger` runs on the
-- annual TIGER vintage, so no re-run has happened since the backfill and no
-- centroid is wrong TODAY (prod 2026-09-19: 7,250 district rows, 7,250 with a
-- centroid, 0 NULL). The next refresh is what pulls the trigger, and it is the
-- receipt for this fix. Nothing is re-run here.
--
-- ST_PointOnSurface, NOT ST_Centroid. The project's convention for jurisdiction
-- centroids — 20260528170000 ("a point that lies ON an irregular / multipart
-- polygon, where a centroid can land in water or outside the shape entirely"),
-- 20260528180100, and the FIX-914 floterial derivation in 20260910120000, whose
-- ON CONFLICT DO UPDATE sets `centroid = EXCLUDED.centroid` from exactly this
-- expression. The 7,211 base rows were filled the same way, so writing anything
-- else here would make the two populations disagree.
--
-- The body below is the prod definition read back with pg_get_functiondef on
-- 2026-09-19, plus the centroid lines. SECURITY DEFINER, the search_path SET
-- and the FIX-834 grants are restated because CREATE OR REPLACE keeps whatever
-- it is not told, and a migration that has to be replayed out of order must not
-- depend on that. Prod ACL read the same day: {postgres=X/postgres,
-- service_role=X/postgres} — service_role only, no anon, no authenticated.
-- Neither this function nor query_districts carries a statement_timeout
-- proconfig, and none is added (FIX-1128: a routine-level SET bounds nothing
-- and makes the routine atomic).

CREATE OR REPLACE FUNCTION public.upsert_district_jurisdiction(
  p_parent_id    uuid,
  p_name         text,
  p_short_name   text,
  p_fips_code    text,
  p_census_geoid text,
  p_chamber      text,
  p_metadata     jsonb,
  p_geojson      text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id  uuid;
  v_geom geometry(MultiPolygon, 4326);
BEGIN
  v_geom := ST_Multi(ST_GeomFromGeoJSON(p_geojson))::geometry(MultiPolygon, 4326);

  SELECT id INTO v_id
  FROM public.jurisdictions
  WHERE parent_id = p_parent_id
    AND type = 'district'
    AND census_geoid = p_census_geoid
    AND metadata->>'chamber' = p_chamber;

  IF v_id IS NULL THEN
    INSERT INTO public.jurisdictions (
      parent_id, type, name, short_name, fips_code, census_geoid,
      boundary_geometry, centroid, metadata, is_active
    ) VALUES (
      p_parent_id, 'district', p_name, p_short_name, p_fips_code, p_census_geoid,
      v_geom, ST_PointOnSurface(v_geom)::geometry(Point, 4326), p_metadata, true
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.jurisdictions
       SET name              = p_name,
           short_name        = p_short_name,
           fips_code         = p_fips_code,
           boundary_geometry = v_geom,
           -- FIX-1171. Derived from the geometry being written in this same
           -- statement, so the two can never disagree.
           centroid          = ST_PointOnSurface(v_geom)::geometry(Point, 4326),
           metadata          = p_metadata,
           updated_at        = now()
     WHERE id = v_id;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_district_jurisdiction(uuid, text, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_district_jurisdiction(uuid, text, text, text, text, text, jsonb, text) TO service_role;

COMMENT ON FUNCTION public.upsert_district_jurisdiction(uuid, text, text, text, text, text, jsonb, text) IS
  'Insert-or-update one district jurisdiction from GeoJSON, keyed on '
  '(parent_id, type=district, census_geoid, metadata->>chamber). Writes '
  'boundary_geometry and (FIX-1171) the ST_PointOnSurface centroid on both the '
  'insert and the update path, so a TIGER refresh cannot leave a label point at '
  'the previous vintage''s position.';
