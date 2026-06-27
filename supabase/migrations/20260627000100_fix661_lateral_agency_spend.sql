-- =============================================================================
-- 20260627000100_fix661_lateral_agency_spend.sql
-- FIX-661 — make get_jurisdiction_page's `spend` CTE tractable on the federal
-- page (the generateStaticParams warm set + most-crawled id).
--
-- 2026-06-27 incident: get_jurisdiction_page(US-federal) hit its own 8s
-- statement_timeout (57014). Prod EXPLAIN (ANALYZE, BUFFERS) isolated the cause
-- to the `spend` CTE: 118 federal agencies fan into 1,287,741 contract/grant
-- financial_relationships rows, and the query asks for the global top-100 by
-- amount_cents. Finding a GLOBAL top-100 forces the planner to materialize ALL
-- 1.28M matched rows and sort them — measured 213,060 ms.
--
-- An index alone does NOT fix this (both shapes measured on prod):
--   * (from_id) INCLUDE(amount_cents)                      -> 26,367 ms
--   * (from_id, amount_cents DESC) INCLUDE(all cols), as a
--     true Index-Only Scan of the original query           -> 27,374 ms
-- Both still scan + sort the full 1.28M-row matched set; the index only removes
-- the per-row heap fetch, not the 1.28M-row scan. So the FIX-443-style covering
-- index added in 20260627000000 (INCLUDE amount_cents only) is INSUFFICIENT and
-- is dropped here — it is superseded by the index below and was never enough to
-- clear the 8s cap.
--
-- The fix is to change the query SHAPE: take the top-100 PER AGENCY first (each
-- bounded by an index-ordered LIMIT 100), then the global top-100 of that small
-- union. Any row in the global top-100 is necessarily within its own agency's
-- top-100, so the result is identical to the original global ORDER BY ... LIMIT.
-- With an index keyed (from_id, amount_cents DESC NULLS LAST), each per-agency
-- scan stops after 100 rows: the LATERAL plan reads ~5.7k rows instead of 1.28M.
-- Prod EXPLAIN: 94 ms (2000x vs the original 213 s).
--
-- The ordered covering index also INCLUDEs the other columns the CTE selects
-- (to_id, to_type, relationship_type, occurred_at) so the per-agency scans are
-- index-only. Predicate matches the CTE's WHERE exactly.
--
-- Only the `spend` CTE changes; every other section is byte-for-byte the body of
-- 20260621020000 (FIX-634). The function keeps SECURITY INVOKER, the unquoted
-- `search_path = public, extensions` (FIX-420), and its 8s statement_timeout
-- (FIX-662 lowers that to align with the page's 3s client withDbTimeout, in a
-- separate migration — kept distinct so the cap change is greppable on its own).
-- =============================================================================

-- Drop the superseded INCLUDE(amount_cents)-only index from 20260627000000.
DROP INDEX IF EXISTS public.financial_relationships_agency_spend_rollup;

-- Ordered covering index for the per-agency LIMIT 100 scans. (from_id,
-- amount_cents DESC NULLS LAST) provides the per-agency ordering so the inner
-- LIMIT terminates early; INCLUDE carries the remaining selected columns so the
-- scan is index-only. Plain CREATE INDEX (push wraps each migration in a txn;
-- only pipelines write this table and none runs during a push). Raise the
-- build timeout for the ~1.3M-row partial index build.
SET LOCAL statement_timeout = '600s';

CREATE INDEX IF NOT EXISTS financial_relationships_agency_spend_lateral
  ON public.financial_relationships (from_id, amount_cents DESC NULLS LAST)
  INCLUDE (to_id, to_type, relationship_type, occurred_at)
  WHERE from_type = 'agency' AND relationship_type IN ('contract', 'grant');

CREATE OR REPLACE FUNCTION public.get_jurisdiction_page(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
SET statement_timeout = '8s'
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

REVOKE ALL ON FUNCTION public.get_jurisdiction_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_jurisdiction_page(uuid)
  TO anon, authenticated, service_role;
