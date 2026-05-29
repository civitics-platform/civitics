-- =============================================================================
-- 20260528180100_jurisdiction_retype_and_centroid_backfill.sql
-- FIX-E (2/3): Re-type DC + the 5 territories off the 'district' catch-all, and
-- backfill centroids for the pre-existing district rows that never got one.
--
-- Depends on 20260528180000 having committed the new enum values first.
--
-- search_path = public, extensions:
--   PostGIS lives in `extensions` on Pro and in `public` on local Docker. A
--   path containing BOTH lets the unqualified ST_* calls below resolve in
--   either environment. (Do NOT schema-qualify as extensions.ST_* — that
--   breaks locally, where PostGIS is in public. Precedent: FIX-420/FIX-421.)
-- =============================================================================

SET search_path = public, extensions;

-- ── Re-type the District of Columbia ─────────────────────────────────────────
-- DC is the federal district per Article I §8. The census_geoid IS NULL guard
-- ensures we only ever touch the state-equivalent row (real legislative /
-- congressional districts all carry a census_geoid), never a CD/SLD row.
UPDATE public.jurisdictions
   SET type = 'federal_district', updated_at = now()
 WHERE type = 'district'
   AND short_name = 'DC'
   AND census_geoid IS NULL;

-- ── Re-type the 5 unincorporated territories ─────────────────────────────────
-- PR, VI, GU, AS, MP — all stored as type='district' with NULL census_geoid and
-- a bare 2-letter short_name. Same census_geoid guard.
UPDATE public.jurisdictions
   SET type = 'unincorporated_territory', updated_at = now()
 WHERE type = 'district'
   AND short_name IN ('PR', 'VI', 'GU', 'AS', 'MP')
   AND census_geoid IS NULL;

-- ── Centroid backfill for pre-existing district rows ─────────────────────────
-- The districts-tiger pipeline (FIX-160 / FIX-217) populated boundary_geometry
-- but never computed a centroid. FIX-421's RPC only sets a centroid on rows it
-- backfills, so the ~6,775 district rows seeded earlier are left with a
-- boundary and a NULL centroid. Fill them here.
--
-- ST_PointOnSurface (not ST_Centroid): guarantees a label point that lies ON an
-- irregular / multipart polygon, where a centroid can land outside the shape.
-- The WHERE centroid IS NULL filter makes this idempotent and prevents
-- overwriting any centroid already present.
UPDATE public.jurisdictions
   SET centroid   = ST_PointOnSurface(boundary_geometry)::geometry(Point, 4326),
       updated_at = now()
 WHERE boundary_geometry IS NOT NULL
   AND centroid IS NULL;
