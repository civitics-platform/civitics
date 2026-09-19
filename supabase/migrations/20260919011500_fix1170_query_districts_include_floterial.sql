-- FIX-1170 — query_districts() gains p_include_floterial, and reports which
-- rows are overlay rows.
--
-- FIX-914 (20260910130000) made the fill path exclude the 39 derived New
-- Hampshire floterial districts, so a choropleth of a state stays a partition
-- of that state (its D7). That is still right as the DEFAULT, and it stays the
-- default here. What it left with no route at all is the caller that wants the
-- partition AND the overlay, tagged, in one round trip — which is the floterial
-- overlay layer FIX-914's own header asked someone to build.
--
-- TWO changes, both additive at the call site:
--
--   p_include_floterial boolean DEFAULT false — appended LAST, so every
--     existing call, positional or named, is unchanged in meaning. The three
--     callers in the tree (/api/districts, /api/graph/voting-divergence,
--     /districts/[id]) all call by NAME; the FIX-914 reader tests call
--     positionally with 11 arguments. Both keep working and both keep getting
--     the base layer.
--
--   a `floterial boolean` output column — so the client can style the overlay
--     without a second lookup keyed back to jurisdictions. Computed from the
--     same metadata flag the predicate reads, so the two cannot disagree.
--
-- DROP before CREATE, not CREATE OR REPLACE: adding a parameter changes the
-- identity argument list, and PostgreSQL would create a SECOND function rather
-- than replace the first. Two overloads is the failure mode that matters here —
-- PostgREST resolves an RPC by the argument NAMES in the request body, and a
-- call naming ten of the eleven shared parameters would match both candidates
-- and fail with PGRST203 rather than pick one. After this migration there is
-- exactly one query_districts.
--
-- Adding the output column is itself a reason DROP is required: a RETURNS TABLE
-- change is rejected by CREATE OR REPLACE ("cannot change return type of
-- existing function") regardless of the parameter list.
--
-- The body is the prod definition read back with pg_get_functiondef on
-- 2026-09-19 (identical to 20260910130000 on disk), plus the two changes.
-- STABLE, SECURITY DEFINER and the search_path SET are restated because DROP
-- discards them along with the ACL — the grants below are therefore load-bearing
-- rather than defensive. Prod ACL read the same day:
-- {postgres,anon,authenticated,service_role}, each =X/postgres. No
-- statement_timeout proconfig on this function before or after (FIX-1128).

DROP FUNCTION IF EXISTS public.query_districts(
  text, text, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  integer, uuid
);

CREATE FUNCTION public.query_districts(
  p_chamber  text DEFAULT NULL,        -- 'upper' | 'lower' | NULL (both)
  p_state    text DEFAULT NULL,        -- state abbr, e.g. 'CA'
  p_bbox_w   double precision DEFAULT NULL,
  p_bbox_s   double precision DEFAULT NULL,
  p_bbox_e   double precision DEFAULT NULL,
  p_bbox_n   double precision DEFAULT NULL,
  p_point_lng double precision DEFAULT NULL,
  p_point_lat double precision DEFAULT NULL,
  p_simplify_tolerance double precision DEFAULT 0.001,
  p_limit    integer DEFAULT 500,
  p_id       uuid    DEFAULT NULL,     -- exact id lookup (overrides other filters)
  -- FIX-1170. Opt-in, appended last. false keeps FIX-914's D7 exactly.
  p_include_floterial boolean DEFAULT false
) RETURNS TABLE (
  id            uuid,
  name          text,
  short_name    text,
  state_abbr    text,
  chamber       text,
  district_id   text,
  geom_geojson  text,
  -- FIX-1170. True for a derived overlay polygon. Always emitted, including on
  -- the id and point paths, which have returned overlay rows since FIX-914 with
  -- no way for the caller to tell which was which.
  floterial     boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH bbox AS (
    SELECT
      CASE
        WHEN p_bbox_w IS NOT NULL AND p_bbox_s IS NOT NULL
         AND p_bbox_e IS NOT NULL AND p_bbox_n IS NOT NULL
        THEN ST_MakeEnvelope(p_bbox_w, p_bbox_s, p_bbox_e, p_bbox_n, 4326)
        ELSE NULL
      END AS env,
      CASE
        WHEN p_point_lng IS NOT NULL AND p_point_lat IS NOT NULL
        THEN ST_SetSRID(ST_MakePoint(p_point_lng, p_point_lat), 4326)
        ELSE NULL
      END AS pt
  )
  SELECT
    d.id,
    d.name,
    d.short_name,
    (d.metadata->>'state_abbr')::text  AS state_abbr,
    (d.metadata->>'chamber')::text     AS chamber,
    (d.metadata->>'district_id')::text AS district_id,
    ST_AsGeoJSON(ST_SimplifyPreserveTopology(d.boundary_geometry, p_simplify_tolerance))::text AS geom_geojson,
    COALESCE((d.metadata->>'floterial')::boolean, false) AS floterial
  FROM public.jurisdictions d, bbox
  WHERE d.type = 'district'
    AND d.metadata->>'source' IN ('tiger', 'derived')
    AND d.boundary_geometry IS NOT NULL
    -- FIX-914: overlay districts answer "what contains this point" and "give me
    -- this district", but never "paint the state" -- unless the caller asks, as
    -- of FIX-1170, in which case it is asking for a separate layer and has said
    -- so. See the header.
    AND (
      p_id IS NOT NULL
      OR bbox.pt IS NOT NULL
      OR p_include_floterial
      OR NOT COALESCE((d.metadata->>'floterial')::boolean, false)
    )
    AND (p_id      IS NULL OR d.id = p_id)
    AND (p_chamber IS NULL OR d.metadata->>'chamber' = p_chamber)
    AND (p_state   IS NULL OR d.metadata->>'state_abbr' = p_state)
    AND (bbox.env IS NULL OR d.boundary_geometry && bbox.env)
    AND (bbox.pt  IS NULL OR ST_Contains(d.boundary_geometry, bbox.pt))
  ORDER BY d.metadata->>'state_abbr', d.metadata->>'chamber', d.metadata->>'district_id'
  LIMIT GREATEST(p_limit, 1);
$$;

-- Restated because DROP took the old ACL with it. query_districts is reached
-- from the browser through route handlers on a cookie-scoped client, so anon
-- and authenticated both need EXECUTE (unchanged from FIX-914).
REVOKE ALL ON FUNCTION public.query_districts(text, text, double precision, double precision, double precision, double precision, double precision, double precision, double precision, integer, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.query_districts(text, text, double precision, double precision, double precision, double precision, double precision, double precision, double precision, integer, uuid, boolean) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.query_districts(text, text, double precision, double precision, double precision, double precision, double precision, double precision, double precision, integer, uuid, boolean) IS
  'District geometry for the maps UI, simplified server-side. Returns TIGER base '
  'districts plus (FIX-914) the derived floterial overlay -- the overlay only on '
  'an exact p_id lookup, a point-containment query, or (FIX-1170) an explicit '
  'p_include_floterial := true, so a choropleth of a state stays a partition of '
  'it unless the caller asks for the overlay as its own layer. The floterial '
  'column says which rows those are.';
