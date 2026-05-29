-- =============================================================================
-- 20260528180400_jurisdiction_page_rpcs.sql
-- FIX-F (2/2): two read-only RPCs powering the /jurisdictions/[id] hub.
--
--   jurisdiction_boundary_svg  → server-rendered static map (no Mapbox JS).
--   get_jurisdiction_activity  → UNION activity feed across proposals /
--                                meetings / civic_initiatives.
--
-- search_path = public, extensions:
--   PostGIS lives in `extensions` on Pro, `public` on local Docker. A path with
--   both lets unqualified ST_* calls resolve in either environment. An empty /
--   public-only path breaks ST_* resolution on Pro (bit FIX-420). Unquoted form
--   (two schemas) — NOT 'public, extensions' (that names one schema literally).
-- =============================================================================

-- ── Boundary SVG generator ───────────────────────────────────────────────────
-- Returns ST_AsSVG path data (rel=0 → absolute coords, 6 decimal places) plus a
-- viewBox computed from the envelope. SVG's Y axis points down, so Y is negated
-- in both the viewBox and the centroid marker. Returns NO ROW when the
-- jurisdiction has no boundary_geometry — the page omits the map section.
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
  v_geom geometry;
  v_pt   geometry;
  v_env  geometry;
BEGIN
  SELECT boundary_geometry, centroid
    INTO v_geom, v_pt
    FROM public.jurisdictions
   WHERE id = p_id;

  IF v_geom IS NULL THEN
    RETURN;  -- no boundary → empty result set
  END IF;

  v_env := ST_Envelope(v_geom);
  -- centroid column may be NULL on rows that got a boundary but no centroid;
  -- ST_PointOnSurface always lands inside the polygon, unlike ST_Centroid.
  v_pt  := COALESCE(v_pt, ST_PointOnSurface(v_geom));

  RETURN QUERY SELECT
    ST_AsSVG(v_geom, 0, 6) AS svg_path,
    format('%s %s %s %s',
      ST_XMin(v_env),
      -ST_YMax(v_env),                       -- SVG Y is inverted
      ST_XMax(v_env) - ST_XMin(v_env),
      ST_YMax(v_env) - ST_YMin(v_env)
    ) AS viewbox,
    ST_X(v_pt)::numeric    AS centroid_x,
    (-ST_Y(v_pt))::numeric AS centroid_y;     -- negated to match SVG space
END;
$$;

ALTER FUNCTION public.jurisdiction_boundary_svg(uuid, int, int)
  SET statement_timeout = '2s';

REVOKE ALL ON FUNCTION public.jurisdiction_boundary_svg(uuid, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jurisdiction_boundary_svg(uuid, int, int)
  TO anon, authenticated, service_role;

-- ── Activity feed ──────────────────────────────────────────────────────────--
-- UNION of recent legislative proposals + meetings + citizen initiatives,
-- bounded by jurisdiction. Jurisdiction links confirmed against the LIVE schema
-- (Stage 1 rebuild — civic_initiatives/spending_records were folded away):
--   proposals (legislative) → proposals.jurisdiction_id, type <> 'initiative'
--   initiatives             → proposals.jurisdiction_id, type =  'initiative'
--                             (the old civic_initiatives table is now a proposal
--                              row + initiative_details; routes live at /initiatives)
--   meetings                → meetings.governing_body_id → governing_bodies.jurisdiction_id
CREATE OR REPLACE FUNCTION public.get_jurisdiction_activity(
  p_id    uuid,
  p_limit int DEFAULT 20
) RETURNS TABLE(occurred_at timestamptz, event_type text, entity_id uuid, summary text, url text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH proposal_events AS (
    SELECT p.introduced_at::timestamptz AS occurred_at,
           'proposal_introduced'::text  AS event_type,
           p.id                         AS entity_id,
           COALESCE(p.title, 'Proposal')::text AS summary,
           ('/proposals/' || p.id::text)       AS url
    FROM public.proposals p
    WHERE p.jurisdiction_id = p_id
      AND p.type <> 'initiative'
      AND p.introduced_at IS NOT NULL
    ORDER BY p.introduced_at DESC
    LIMIT p_limit
  ),
  meeting_events AS (
    SELECT m.scheduled_at          AS occurred_at,
           'meeting'::text         AS event_type,
           m.id                    AS entity_id,
           COALESCE(m.title, 'Meeting')::text AS summary,
           ('/meetings/' || m.id::text)       AS url
    FROM public.meetings m
    JOIN public.governing_bodies gb ON gb.id = m.governing_body_id
    WHERE gb.jurisdiction_id = p_id
      AND m.scheduled_at IS NOT NULL
    ORDER BY m.scheduled_at DESC
    LIMIT p_limit
  ),
  initiative_events AS (
    SELECT p.created_at            AS occurred_at,
           'initiative_created'::text AS event_type,
           p.id                    AS entity_id,
           COALESCE(p.title, 'Initiative')::text AS summary,
           ('/initiatives/' || p.id::text)       AS url
    FROM public.proposals p
    WHERE p.jurisdiction_id = p_id
      AND p.type = 'initiative'
    ORDER BY p.created_at DESC
    LIMIT p_limit
  )
  SELECT * FROM proposal_events
  UNION ALL SELECT * FROM meeting_events
  UNION ALL SELECT * FROM initiative_events
  ORDER BY occurred_at DESC NULLS LAST
  LIMIT p_limit;
$$;

ALTER FUNCTION public.get_jurisdiction_activity(uuid, int)
  SET statement_timeout = '3s';

REVOKE ALL ON FUNCTION public.get_jurisdiction_activity(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_jurisdiction_activity(uuid, int)
  TO anon, authenticated, service_role;
