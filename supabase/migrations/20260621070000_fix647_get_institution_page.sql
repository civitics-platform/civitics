-- FIX-647: collapse the institutions/[id] render N+1 into consolidating RPCs.
--
-- institutions/[id] is already ISR (FIX-645) on the publishable client and its
-- render reads are already withDbTimeout-wrapped (FIX-638). This is the further
-- N+1 collapse on top: the page's two branches each fan out ~16–22 PostgREST
-- calls on a cache-miss render. Two RPCs — one per branch — return everything as
-- one jsonb payload so each render is ~1 base fetch + 1 RPC.
--
-- Two RPCs (not one branched function) because the agency and governing-body
-- payloads barely overlap; each gets a single, testable shape:
--   * get_agency_page(uuid)  — agency profile (mirrors /agencies/[slug])
--   * get_gb_page(uuid)      — governing-body profile (roster, votes, meetings)
--
-- Modeled on get_jurisdiction_page (FIX-634) and get_official_page (FIX-646):
-- SECURITY INVOKER (every table read here is anon-readable, exactly as the page
-- reads them via the publishable client), EXECUTE to anon. The heavy JS
-- post-processing on the page (aggregateSpending, the SOURCE_PRIORITY connection
-- dedup, party-balance bucketing, roster/meeting reshape, mapProposal) is left
-- UNCHANGED in JS and fed from these payloads — each section's rows mirror the
-- exact shape its old per-section query returned, so the downstream .map()/sort
-- logic is byte-identical. Only the heaviest aggregation that can be proven
-- identical (spending recipient-name resolution) moves into SQL.
--
-- search_path = public, extensions (UNQUOTED — two schemas). The quoted form
-- names ONE schema literally and breaks on Pro (bit FIX-420). Keep it unquoted.
-- Sub-RPCs (get_institution_recent_votes, get_plum_book_last_change) are
-- delegated to BY NAME, not inlined, so they keep their own SECURITY DEFINER
-- rights, search_path, and statement_timeouts.

-- ════════════════════════════════════════════════════════════════════════════
-- get_agency_page — AgencyView branch
-- ════════════════════════════════════════════════════════════════════════════
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
  -- PostgREST .order(amount_cents, desc) => DESC (Postgres default NULLS FIRST).
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
    ORDER BY fr.amount_cents DESC
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

ALTER FUNCTION public.get_agency_page(uuid) SET statement_timeout = '8s';
REVOKE ALL ON FUNCTION public.get_agency_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agency_page(uuid)
  TO anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- get_gb_page — GoverningBodyView branch
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_gb_page(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH gb AS (
    SELECT id, jurisdiction_id, seat_count, term_length_years
    FROM public.governing_bodies WHERE id = p_id
  )
  SELECT jsonb_build_object(
    'gb_extra', (
      SELECT jsonb_build_object('seat_count', gb.seat_count, 'term_length_years', gb.term_length_years)
      FROM gb
    ),

    -- Jurisdiction (id, name, is_synthetic) or null.
    'jurisdiction', (
      SELECT jsonb_build_object('id', j.id, 'name', j.name, 'is_synthetic', j.is_synthetic)
      FROM public.jurisdictions j
      WHERE j.id = (SELECT jurisdiction_id FROM gb)
    ),

    -- Parent institution (id, name) via institution_extensions.parent_id ->
    -- institutions view, matching the page's parent fetch. Null when no ext row.
    'parent', (
      SELECT jsonb_build_object('id', pi.id, 'name', pi.name)
      FROM public.institutions pi
      WHERE pi.id = (
        SELECT ie.parent_id FROM public.institution_extensions ie
        WHERE ie.governing_body_id = p_id
      )
    ),

    -- Roster: current members (is_active AND tier='elected', FIX-470), order
    -- role_title ASC, last_name ASC, limit 500.
    'roster', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', o.id, 'full_name', o.full_name, 'role_title', o.role_title,
        'party', o.party, 'photo_url', o.photo_url, 'district_name', o.district_name,
        'is_synthetic', o.is_synthetic
      ) ORDER BY o.role_title ASC NULLS LAST, o.last_name ASC NULLS LAST)
      FROM (
        SELECT id, full_name, role_title, party, photo_url, district_name, is_synthetic, last_name
        FROM public.officials
        WHERE governing_body_id = p_id AND is_active AND tier = 'elected'
        ORDER BY role_title ASC NULLS LAST, last_name ASC NULLS LAST
        LIMIT 500
      ) o
    ), '[]'::jsonb),

    -- Party balance over ALL current members (limit 1000 — PostgREST max_rows
    -- ceiling, FIX-476). Just the party value; bucketed in JS.
    'party_balance', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('party', o.party))
      FROM (
        SELECT party
        FROM public.officials
        WHERE governing_body_id = p_id AND is_active AND tier = 'elected'
        LIMIT 1000
      ) o
    ), '[]'::jsonb),

    -- Active proposals: status in (introduced, in_committee, passed_committee,
    -- floor_vote), order introduced_at DESC, limit 15. NULLS FIRST is the
    -- PostgREST/PG default for a DESC order — and it MATTERS: this body has 1388
    -- null-introduced_at active proposals, so NULLS FIRST surfaces 15 undated
    -- rows (what the page renders) while NULLS LAST would wrongly surface the few
    -- dated ones. [[FIX-647]] verification turned on this.
    'active_proposals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'status', p.status, 'type', p.type,
        'introduced_at', p.introduced_at, 'summary_plain', p.summary_plain,
        'metadata', p.metadata,
        'bill_details', (
          SELECT jsonb_build_object('bill_number', bd.bill_number)
          FROM public.bill_details bd WHERE bd.proposal_id = p.id LIMIT 1
        )
      ) ORDER BY p.introduced_at DESC NULLS FIRST)
      FROM (
        SELECT id, title, status, type, introduced_at, summary_plain, metadata
        FROM public.proposals
        WHERE governing_body_id = p_id
          AND status IN ('introduced', 'in_committee', 'passed_committee', 'floor_vote')
        ORDER BY introduced_at DESC NULLS FIRST
        LIMIT 15
      ) p
    ), '[]'::jsonb),

    -- Recent proposals: status in (enacted, signed, failed, withdrawn), order
    -- updated_at DESC, limit 5. NULLS FIRST = PostgREST/PG default for DESC.
    'recent_proposals', COALESCE((
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
        WHERE governing_body_id = p_id
          AND status IN ('enacted', 'signed', 'failed', 'withdrawn')
        ORDER BY updated_at DESC NULLS FIRST
        LIMIT 5
      ) p
    ), '[]'::jsonb),

    'total_proposals', (
      SELECT count(*) FROM public.proposals WHERE governing_body_id = p_id
    ),

    -- Sub-bodies / committees: institution_extensions.parent_id -> child
    -- governing_bodies, is_active, order name ASC, limit 100. (Folds the page's
    -- two-step ext-then-gb fetch.) Empty today — institution_extensions is empty.
    'sub_bodies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'type', c.type)
        ORDER BY c.name ASC)
      FROM (
        SELECT c.id, c.name, c.type::text AS type
        FROM public.governing_bodies c
        JOIN public.institution_extensions ie ON ie.governing_body_id = c.id
        WHERE ie.parent_id = p_id AND c.is_active
        ORDER BY c.name ASC
        LIMIT 100
      ) c
    ), '[]'::jsonb),

    -- Meetings within [now-30d, now+60d], order scheduled_at DESC, limit 10. The
    -- nested governing_bodies object matches the page's !inner embed shape.
    'meetings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'title', m.title, 'meeting_type', m.meeting_type,
        'scheduled_at', m.scheduled_at, 'agenda_url', m.agenda_url,
        'governing_bodies', jsonb_build_object('is_synthetic', m.gb_is_synthetic)
      ) ORDER BY m.scheduled_at DESC)
      FROM (
        SELECT mt.id, mt.title, mt.meeting_type, mt.scheduled_at, mt.agenda_url,
               g.is_synthetic AS gb_is_synthetic
        FROM public.meetings mt
        JOIN public.governing_bodies g ON g.id = mt.governing_body_id
        WHERE mt.governing_body_id = p_id
          AND mt.scheduled_at >= now() - interval '30 days'
          AND mt.scheduled_at <= now() + interval '60 days'
        ORDER BY mt.scheduled_at DESC
        LIMIT 10
      ) m
    ), '[]'::jsonb),

    -- Recent votes (delegated to the SECURITY DEFINER RPC, which orders by
    -- voted_at DESC and bounds itself to 3s). Column shape == the page's
    -- RecentVote type.
    'recent_votes', COALESCE((
      SELECT jsonb_agg(to_jsonb(rv) ORDER BY rv.voted_at DESC NULLS LAST)
      FROM public.get_institution_recent_votes(p_id, 10) rv
    ), '[]'::jsonb)
  );
$$;

ALTER FUNCTION public.get_gb_page(uuid) SET statement_timeout = '8s';
REVOKE ALL ON FUNCTION public.get_gb_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_gb_page(uuid)
  TO anon, authenticated, service_role;
