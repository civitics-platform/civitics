-- =============================================================================
-- 20260627000600_fix663_jurisdiction_page_cache.sql
-- FIX-663 — materialize get_jurisdiction_page's payload for the content-bearing
-- jurisdictions into a cache table read by PK, with a live-compute fallback.
--
-- After FIX-661/662 the federal page is fast warm (~80ms) but COLD renders still
-- spike (US ~3.7s, Rhode Island ~9.5s) — IOWait on the cache-starved Pro Small
-- reading the non-spend sections (boundary PostGIS SVG, get_jurisdiction_activity,
-- officials/institutions). EXPLAIN established only 62 of 10,509 active
-- jurisdictions carry any content; the other ~10.4k are empty district/county
-- shells that render trivially and need no materialization.
--
-- Design (agreed with Craig; see FIX-663):
--   1. Cache TABLE (not an MV) — a table lets us UPSERT only the ~62
--      content-bearing rows, matching the donor_rollup/spending_totals precedent.
--      An MV's REFRESH rebuilds every row and can't selectively refresh.
--   2. Split the function: get_jurisdiction_page_live(uuid) does the work (the
--      verbatim FIX-661 body, UNCAPPED); the public get_jurisdiction_page(uuid)
--      wrapper reads the cache by PK and falls back to _live on a miss. The page
--      keeps calling get_jurisdiction_page with the identical signature + payload
--      shape -> zero app/page.tsx change.
--   3. The 3s cap lives ON THE WRAPPER (bounds the request-path cache-miss
--      fallback, preserving the FIX-662 invariant: cap <= the page's 3s client
--      withDbTimeout). _live carries NO cap because statement_timeout is inherited
--      from the caller — so the nightly refresh of the cold federal page (>3s) can
--      set its own generous bound while the request path stays at 3s.
--   4. refresh_jurisdiction_page_cache() (SECURITY DEFINER, generous timeout)
--      UPSERTs payload = get_jurisdiction_page_live(id) for jurisdictions that
--      have content OR are type IN ('country','state') (the crawled, boundary-heavy
--      set). The exact content predicate isn't load-bearing — anything not cached
--      falls back to _live, which is cheap for empty shells.
--   5. Refresh runs via direct-pg on the nightly tail (after entity_connections +
--      the MV refreshes), mirroring FIX-641. Activity is cached too (option 1) —
--      accepted as up to ~1 day stale.
--   6. RLS: anon + authenticated SELECT USING (true) (payload is already-public
--      data); no anon writes — the INVOKER wrapper reads the cache as anon.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Cache table + RLS (decisions 1, 6)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.jurisdiction_page_cache (
  jurisdiction_id uuid PRIMARY KEY
    REFERENCES public.jurisdictions(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.jurisdiction_page_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS jurisdiction_page_cache_read ON public.jurisdiction_page_cache;
CREATE POLICY jurisdiction_page_cache_read
  ON public.jurisdiction_page_cache
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- 2. get_jurisdiction_page_live(uuid) — the verbatim FIX-661 body, UNCAPPED.
--    Identical to 20260627000100 except: renamed, and the
--    `SET statement_timeout = '8s'` (later '3s' via FIX-662) is REMOVED so the
--    timeout is inherited from whichever caller invokes it (wrapper = 3s,
--    refresh = generous). SECURITY INVOKER + unquoted search_path unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_jurisdiction_page_live(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH j AS (
    SELECT * FROM public.jurisdictions WHERE id = p_id
  ),
  -- Agency-sourced institutions in this jurisdiction (institution.id == agency
  -- id for source_table='agency' rows). Matches the page's
  -- institutions.filter(source_table==='agency').map(id).slice(0,300).
  agency_ids AS (
    SELECT i.id
    FROM public.institutions i
    WHERE i.jurisdiction_id = p_id
      AND i.is_active
      AND i.source_table = 'agency'
    LIMIT 300
  ),
  -- Top-100 contract/grant relationships from those agencies, by amount.
  -- Mirrors the page's first spending query (order amount_cents desc, limit 100).
  -- FIX-661: take per-agency top-100 via the index-ordered LATERAL scan, then the
  -- global top-100 of that union. Identical result to a single global
  -- ORDER BY amount_cents DESC LIMIT 100 (a global-top-100 row is always within
  -- its own agency's top-100), but reads ~5.7k rows instead of 1.28M on federal.
  spend AS (
    SELECT t.to_id, t.to_type, t.relationship_type, t.amount_cents, t.occurred_at
    FROM agency_ids a
    CROSS JOIN LATERAL (
      SELECT fr.to_id, fr.to_type, fr.relationship_type, fr.amount_cents, fr.occurred_at
      FROM public.financial_relationships fr
      WHERE fr.from_id = a.id
        AND fr.from_type = 'agency'
        AND fr.relationship_type IN ('contract', 'grant')
      ORDER BY fr.amount_cents DESC NULLS LAST
      LIMIT 100
    ) t
    ORDER BY t.amount_cents DESC NULLS LAST
    LIMIT 100
  )
  SELECT jsonb_build_object(
    -- Base jurisdiction row. NULL when the id doesn't exist -> page calls
    -- notFound(). Columns match the page's pre-Promise.all base fetch.
    'jurisdiction', (
      SELECT jsonb_build_object(
        'id', j.id, 'name', j.name, 'short_name', j.short_name, 'type', j.type,
        'parent_id', j.parent_id, 'population', j.population, 'timezone', j.timezone,
        'fips_code', j.fips_code, 'is_synthetic', j.is_synthetic
      ) FROM j
    ),

    -- Parent jurisdiction (id, name) or null.
    'parent', (
      SELECT jsonb_build_object('id', pj.id, 'name', pj.name)
      FROM public.jurisdictions pj
      WHERE pj.id = (SELECT parent_id FROM j)
    ),

    -- Boundary SVG (0 or 1 row from the SECURITY DEFINER PostGIS RPC) -> object
    -- or null. Shape: { svg_path, viewbox, centroid_x, centroid_y }.
    'boundary', (
      SELECT to_jsonb(b) FROM public.jurisdiction_boundary_svg(p_id) b LIMIT 1
    ),

    -- Child jurisdictions: is_active, order type asc, name asc, limit 1000.
    'children', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', c.id, 'name', c.name, 'short_name', c.short_name, 'type', c.type)
        ORDER BY c.type ASC, c.name ASC
      )
      FROM (
        SELECT id, name, short_name, type
        FROM public.jurisdictions
        WHERE parent_id = p_id AND is_active
        ORDER BY type ASC, name ASC
        LIMIT 1000
      ) c
    ), '[]'::jsonb),

    -- Institutions: is_active, order type asc, name asc, limit 200.
    'institutions', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', i.id, 'name', i.name, 'short_name', i.short_name, 'type', i.type,
          'acronym', i.acronym, 'source_table', i.source_table, 'is_synthetic', i.is_synthetic
        )
        ORDER BY i.type ASC, i.name ASC
      )
      FROM (
        SELECT id, name, short_name, type, acronym, source_table, is_synthetic
        FROM public.institutions
        WHERE jurisdiction_id = p_id AND is_active
        ORDER BY type ASC, name ASC
        LIMIT 200
      ) i
    ), '[]'::jsonb),

    -- Officials: is_active, order role_title asc, last_name asc, limit 51
    -- (OFFICIALS_LIMIT + 1, so the page can detect "has more").
    'officials', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', o.id, 'full_name', o.full_name, 'role_title', o.role_title,
          'party', o.party, 'photo_url', o.photo_url, 'district_name', o.district_name,
          'is_synthetic', o.is_synthetic
        )
        ORDER BY o.role_title ASC, o.last_name ASC
      )
      FROM (
        SELECT id, full_name, role_title, party, photo_url, district_name, is_synthetic, last_name
        FROM public.officials
        WHERE jurisdiction_id = p_id AND is_active
        ORDER BY role_title ASC, last_name ASC
        LIMIT 51
      ) o
    ), '[]'::jsonb),

    -- Proposals (non-initiative): order introduced_at desc nulls last, limit 10.
    'proposals', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id, 'title', p.title, 'type', p.type, 'status', p.status,
          'summary_plain', p.summary_plain, 'summary_model', p.summary_model,
          'introduced_at', p.introduced_at, 'external_url', p.external_url,
          'metadata', p.metadata, 'is_synthetic', p.is_synthetic
        )
        ORDER BY p.introduced_at DESC NULLS LAST
      )
      FROM (
        SELECT id, title, type, status, summary_plain, summary_model,
               introduced_at, external_url, metadata, is_synthetic
        FROM public.proposals
        WHERE jurisdiction_id = p_id AND type <> 'initiative'
        ORDER BY introduced_at DESC NULLS LAST
        LIMIT 10
      ) p
    ), '[]'::jsonb),

    -- Meetings via governing_bodies in this jurisdiction, within the
    -- [now-30d, now+60d] window, order scheduled_at desc, limit 10. The nested
    -- governing_bodies object matches the page's PostGIS embed shape.
    'meetings', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', m.id, 'title', m.title, 'meeting_type', m.meeting_type,
          'scheduled_at', m.scheduled_at, 'agenda_url', m.agenda_url,
          'governing_bodies', jsonb_build_object(
            'name', m.gb_name, 'jurisdiction_id', m.gb_jurisdiction_id, 'is_synthetic', m.gb_is_synthetic
          )
        )
        ORDER BY m.scheduled_at DESC
      )
      FROM (
        SELECT mt.id, mt.title, mt.meeting_type, mt.scheduled_at, mt.agenda_url,
               gb.name AS gb_name, gb.jurisdiction_id AS gb_jurisdiction_id,
               gb.is_synthetic AS gb_is_synthetic
        FROM public.meetings mt
        JOIN public.governing_bodies gb ON gb.id = mt.governing_body_id
        WHERE gb.jurisdiction_id = p_id
          AND mt.scheduled_at >= now() - interval '30 days'
          AND mt.scheduled_at <= now() + interval '60 days'
        ORDER BY mt.scheduled_at DESC
        LIMIT 10
      ) m
    ), '[]'::jsonb),

    -- Initiatives: initiative_details JOIN proposals (type='initiative',
    -- jurisdiction match), stage <> 'draft', limit 20. The page then sorts by
    -- created_at desc and slices 10 in JS — so the raw 20 rows match the embed.
    'initiatives', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'proposal_id', idt.proposal_id, 'stage', idt.stage, 'scope', idt.scope,
          'authorship_type', idt.authorship_type, 'issue_area_tags', idt.issue_area_tags,
          'target_district', idt.target_district, 'mobilise_started_at', idt.mobilise_started_at,
          'proposals', jsonb_build_object(
            'id', idt.p_id, 'title', idt.p_title, 'summary_plain', idt.p_summary_plain,
            'created_at', idt.p_created_at, 'resolved_at', idt.p_resolved_at,
            'type', idt.p_type, 'jurisdiction_id', idt.p_jurisdiction_id
          )
        )
      )
      FROM (
        SELECT d.proposal_id, d.stage, d.scope, d.authorship_type, d.issue_area_tags,
               d.target_district, d.mobilise_started_at,
               p.id AS p_id, p.title AS p_title, p.summary_plain AS p_summary_plain,
               p.created_at AS p_created_at, p.resolved_at AS p_resolved_at,
               p.type AS p_type, p.jurisdiction_id AS p_jurisdiction_id
        FROM public.initiative_details d
        JOIN public.proposals p ON p.id = d.proposal_id
        WHERE p.type = 'initiative'
          AND p.jurisdiction_id = p_id
          AND d.stage <> 'draft'
        LIMIT 20
      ) idt
    ), '[]'::jsonb),

    -- Activity feed (already ordered by occurred_at desc inside the sub-RPC).
    'activity', COALESCE((
      SELECT jsonb_agg(to_jsonb(a))
      FROM public.get_jurisdiction_activity(p_id, 20) a
    ), '[]'::jsonb),

    -- Spending: the top-100 contract/grant rows with recipient name resolved,
    -- shaped to feed the page's existing aggregateSpending() (group by
    -- recipient|awardType|fiscalYear, top 10). Only financial_entity recipients
    -- get a name; everything else -> 'Unknown recipient' (matches the page).
    'spending', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'recipient', COALESCE(fe.display_name, fe.canonical_name, 'Unknown recipient'),
        'awardType', s.relationship_type,
        'amountCents', COALESCE(s.amount_cents, 0),
        'date', s.occurred_at
      ))
      FROM spend s
      LEFT JOIN public.financial_entities fe
        ON fe.id = s.to_id AND s.to_type = 'financial_entity'
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.get_jurisdiction_page_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_jurisdiction_page_live(uuid)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Public wrapper get_jurisdiction_page(uuid) — reads the cache by PK, falls
--    back to _live on a miss (decisions 2, 3). plpgsql so the explicit IF guard
--    guarantees _live is NEVER evaluated on a cache hit (a COALESCE of (subquery,
--    function) would risk computing both). Same signature + payload shape as
--    before -> page.tsx unchanged. 3s cap (= the page's client withDbTimeout)
--    bounds the request-path cache-miss fallback (FIX-662 invariant).
--    CREATE OR REPLACE changing LANGUAGE sql -> plpgsql is allowed (return type,
--    arg type, and arg name p_id are unchanged).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_jurisdiction_page(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  SELECT payload INTO v_payload
  FROM public.jurisdiction_page_cache
  WHERE jurisdiction_id = p_id;

  IF FOUND THEN
    RETURN v_payload;
  END IF;

  RETURN public.get_jurisdiction_page_live(p_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_jurisdiction_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_jurisdiction_page(uuid)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. refresh_jurisdiction_page_cache() — UPSERT the expensive set (decision 4).
--    SECURITY DEFINER with a generous own cap. Targets jurisdictions that carry
--    any content (officials / institutions / proposals / children / meetings /
--    initiatives) OR are type IN ('country','state') (the crawled, boundary-heavy
--    set). Misses fall back to _live, which is cheap for empty shells, so we
--    favor covering the expensive set over precision. Returns the row count.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_jurisdiction_page_cache()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '600s'
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH target AS (
    SELECT jr.id
    FROM public.jurisdictions jr
    WHERE jr.is_active
      AND (
        jr.type IN ('country', 'state')
        OR EXISTS (SELECT 1 FROM public.officials o     WHERE o.jurisdiction_id = jr.id AND o.is_active)
        OR EXISTS (SELECT 1 FROM public.institutions i  WHERE i.jurisdiction_id = jr.id AND i.is_active)
        OR EXISTS (SELECT 1 FROM public.proposals p     WHERE p.jurisdiction_id = jr.id)
        OR EXISTS (SELECT 1 FROM public.jurisdictions c WHERE c.parent_id = jr.id AND c.is_active)
        OR EXISTS (
          SELECT 1 FROM public.meetings mt
          JOIN public.governing_bodies gb ON gb.id = mt.governing_body_id
          WHERE gb.jurisdiction_id = jr.id
        )
      )
  ),
  upserted AS (
    INSERT INTO public.jurisdiction_page_cache (jurisdiction_id, payload, refreshed_at)
    SELECT t.id, public.get_jurisdiction_page_live(t.id), now()
    FROM target t
    ON CONFLICT (jurisdiction_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          refreshed_at = EXCLUDED.refreshed_at
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_jurisdiction_page_cache() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_jurisdiction_page_cache() TO service_role;
