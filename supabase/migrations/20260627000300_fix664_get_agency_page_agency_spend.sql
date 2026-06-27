-- =============================================================================
-- 20260627000200_fix664_get_agency_page_agency_spend.sql
-- FIX-664 — align get_agency_page's `spend` CTE to the FIX-661 ordered index so
-- the single-agency top-100-by-amount uses index-ordered early termination
-- instead of a full per-agency scan + on-disk sort.
--
-- FIX-661 sweep, sibling RPC. Prod EXPLAIN (ANALYZE, BUFFERS) on the heaviest
-- agency (37164e8b… , 743,723 contract/grant rows) showed the `spend` CTE's
-- `ORDER BY fr.amount_cents DESC` (Postgres default NULLS FIRST) does NOT match
-- the FIX-661 covering index keyed (from_id, amount_cents DESC NULLS LAST), so
-- the planner could not stop after the first 100 index rows: it scanned the
-- agency's entire matched set (371,862 rows × 2 parallel workers) and sorted it
-- on disk (24 MB external merge). Measured 556 ms / 574k buffer hits per render.
--
-- Unlike get_jurisdiction_page (FIX-661) this section filters a SINGLE from_id
-- (fr.from_id = p_id), so it needs NO LATERAL rewrite and NO new index — only a
-- NULLS LAST alignment so the existing financial_relationships_agency_spend_lateral
-- index serves the order. With that one-word change the same query becomes an
-- Index Only Scan that reads 100 rows (5 heap fetches): measured 0.48 ms — a
-- ~1100x reduction. (NULLS LAST also matches FIX-661's jurisdiction-spend
-- semantics and is strictly more correct: "top 100 by amount" should surface the
-- 100 largest awards, never up to 100 NULL-amount rows that NULLS FIRST would
-- float to the top.)
--
-- Only the `spend` CTE's ORDER BY changes; every other section is byte-for-byte
-- the body of 20260621070000 (FIX-647). SECURITY INVOKER, the unquoted
-- search_path = public, extensions (FIX-420), REVOKE/GRANT preserved. The
-- function's statement_timeout is lowered 8s -> 3s to match the page client's
-- withDbTimeout(..., 3000) ("institutions:agency-page"), the FIX-662 invariant
-- (a function's cap must be <= the page's client timeout so the DB stops doing
-- work once the client has already given up and degraded the render).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_agency_page(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH a AS (
    SELECT id, name, acronym, agency_type, description, founded_year,
           personnel_fte, governing_body_id, parent_agency_id
    FROM public.agencies WHERE id = p_id
  ),
  -- agencyKey = acronym ?? name (the page's metadata->>'agency_id' match value).
  key AS (
    SELECT COALESCE((SELECT acronym FROM a), (SELECT name FROM a)) AS agency_key
  ),
  -- Top-100 contract/grant relationships from this agency, by amount, with the
  -- recipient name pre-resolved (financial_entity recipients only; everything
  -- else -> 'Unknown recipient', matching the page). Shaped as the page's
  -- SpendingRow so the existing JS aggregateSpending() is unchanged.
  -- FIX-664: ORDER BY amount_cents DESC NULLS LAST (was bare DESC). NULLS LAST
  -- matches the FIX-661 financial_relationships_agency_spend_lateral index
  -- (from_id, amount_cents DESC NULLS LAST), so this single-agency scan stops
  -- after 100 index rows instead of scanning + disk-sorting the full agency set.
  spend AS (
    SELECT
      COALESCE(fe.display_name, fe.canonical_name, 'Unknown recipient') AS recipient_name,
      fr.relationship_type AS award_type,
      COALESCE(fr.amount_cents, 0) AS amount_cents,
      fr.occurred_at AS award_date
    FROM public.financial_relationships fr
    LEFT JOIN public.financial_entities fe
      ON fe.id = fr.to_id AND fr.to_type = 'financial_entity'
    WHERE fr.relationship_type IN ('contract', 'grant')
      AND fr.from_type = 'agency'
      AND fr.from_id = p_id
    ORDER BY fr.amount_cents DESC NULLS LAST
    LIMIT 100
  ),
  -- Appointment connections between officials and this agency (page's OR
  -- predicate). Raw shape mirrors the page's select so the SOURCE_PRIORITY dedup
  -- stays unchanged in JS. No order (the page query has none) — limit 100.
  conns AS (
    SELECT ec.from_id, ec.from_type, ec.to_id, ec.to_type, ec.connection_type,
           ec.strength, ec.metadata, ec.evidence_source
    FROM public.entity_connections ec
    WHERE ec.connection_type = 'appointment'
      AND ((ec.from_type = 'official' AND ec.to_id   = p_id)
        OR (ec.to_type   = 'official' AND ec.from_id = p_id))
    LIMIT 100
  )
  SELECT jsonb_build_object(
    'agency_extra', (
      SELECT jsonb_build_object(
        'description', a.description, 'founded_year', a.founded_year,
        'personnel_fte', a.personnel_fte, 'governing_body_id', a.governing_body_id,
        'agency_type', a.agency_type
      ) FROM a
    ),

    -- Active rulemaking: status in (introduced, in_committee), agency match,
    -- order metadata->>comment_period_end ASC (text), limit 20.
    'active_rules', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'status', p.status, 'type', p.type,
        'introduced_at', p.introduced_at, 'summary_plain', p.summary_plain,
        'metadata', p.metadata,
        'bill_details', (
          SELECT jsonb_build_object('bill_number', bd.bill_number)
          FROM public.bill_details bd WHERE bd.proposal_id = p.id LIMIT 1
        )
      ) ORDER BY (p.metadata->>'comment_period_end') ASC NULLS LAST)
      FROM (
        SELECT id, title, status, type, introduced_at, summary_plain, metadata
        FROM public.proposals
        WHERE status IN ('introduced', 'in_committee')
          AND metadata->>'agency_id' = (SELECT agency_key FROM key)
        ORDER BY (metadata->>'comment_period_end') ASC NULLS LAST
        LIMIT 20
      ) p
    ), '[]'::jsonb),

    -- Recent rules: status in (enacted, failed, withdrawn, tabled), agency
    -- match, order updated_at DESC, limit 5. NULLS FIRST = the PostgREST/PG
    -- default for a DESC order (the page's .order(updated_at,{ascending:false})).
    'recent_rules', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'status', p.status, 'type', p.type,
        'introduced_at', p.introduced_at, 'summary_plain', p.summary_plain,
        'metadata', p.metadata,
        'bill_details', (
          SELECT jsonb_build_object('bill_number', bd.bill_number)
          FROM public.bill_details bd WHERE bd.proposal_id = p.id LIMIT 1
        )
      ) ORDER BY p.updated_at DESC NULLS FIRST)
      FROM (
        SELECT id, title, status, type, introduced_at, summary_plain, metadata, updated_at
        FROM public.proposals
        WHERE status IN ('enacted', 'failed', 'withdrawn', 'tabled')
          AND metadata->>'agency_id' = (SELECT agency_key FROM key)
        ORDER BY updated_at DESC NULLS FIRST
        LIMIT 5
      ) p
    ), '[]'::jsonb),

    -- Spending rows (recipient pre-resolved), feeding JS aggregateSpending.
    'spending', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'recipient_name', s.recipient_name, 'award_type', s.award_type,
        'amount_cents', s.amount_cents, 'award_date', s.award_date
      ))
      FROM spend s
    ), '[]'::jsonb),

    'total_rules', (
      SELECT count(*) FROM public.proposals
      WHERE metadata->>'agency_id' = (SELECT agency_key FROM key)
    ),

    -- Open comment periods: status='introduced' AND comment_period_end > now.
    -- The page filters via PostgREST .gt("metadata->>comment_period_end", now)
    -- where now = new Date().toISOString() — a TEXT comparison of two ISO-8601
    -- 'YYYY-MM-DDTHH:MM:SS.mmmZ' strings (chronological because the format is
    -- fixed). Reproduce that exact text comparison via to_char (NOT a timestamptz
    -- cast — a malformed value would error the whole RPC; and now()::text uses a
    -- space not 'T', which would break the lexicographic order).
    'open_rules', (
      SELECT count(*) FROM public.proposals
      WHERE metadata->>'agency_id' = (SELECT agency_key FROM key)
        AND status = 'introduced'
        AND (metadata->>'comment_period_end')
            > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),

    -- Raw appointment connections (page select shape) for the JS dedup.
    'connections', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'from_id', c.from_id, 'from_type', c.from_type,
        'to_id', c.to_id, 'to_type', c.to_type,
        'connection_type', c.connection_type, 'strength', c.strength,
        'metadata', c.metadata, 'evidence_source', c.evidence_source
      ))
      FROM conns c
    ), '[]'::jsonb),

    -- Distinct officials referenced by those connections (page's second fetch).
    'officials', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'full_name', o.full_name, 'role_title', o.role_title
      ))
      FROM public.officials o
      WHERE o.id IN (
        SELECT DISTINCT CASE WHEN c.from_type = 'official' THEN c.from_id ELSE c.to_id END
        FROM conns c
      )
    ), '[]'::jsonb),

    -- Plum-book freshness date (delegated to the SECURITY DEFINER RPC).
    'plum_last_change', public.get_plum_book_last_change(),

    -- Parent agency (id, name, acronym) or null.
    'parent_agency', (
      SELECT jsonb_build_object('id', pa.id, 'name', pa.name, 'acronym', pa.acronym)
      FROM public.agencies pa
      WHERE pa.id = (SELECT parent_agency_id FROM a)
    ),

    -- Child agencies: is_active, order name ASC, limit 30.
    'child_agencies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'acronym', c.acronym)
        ORDER BY c.name ASC)
      FROM (
        SELECT id, name, acronym
        FROM public.agencies
        WHERE parent_agency_id = p_id AND is_active
        ORDER BY name ASC
        LIMIT 30
      ) c
    ), '[]'::jsonb)
  );
$$;

-- FIX-664: align the function cap to the page client's withDbTimeout(..., 3000).
-- Was 8s (FIX-647). CREATE OR REPLACE above does not carry a statement_timeout
-- SET, so this ALTER is the sole, unambiguous source of the cap.
ALTER FUNCTION public.get_agency_page(uuid) SET statement_timeout = '3s';
REVOKE ALL ON FUNCTION public.get_agency_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agency_page(uuid)
  TO anon, authenticated, service_role;
