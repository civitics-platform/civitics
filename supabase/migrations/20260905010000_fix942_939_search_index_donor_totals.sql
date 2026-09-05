-- FIX-942 + FIX-939 - the search index reads the authoritative donation total,
-- and merge stubs stop surfacing.
--
-- FIX-942. officials.total_received_cents has had no writer since the nightly
-- moved to the FIX-836 / FIX-973 bulk regime; rebuild_official_donation_totals()
-- and _full() were the writers and are deprecated below. The column and
-- official_donor_totals.total_cents sum the IDENTICAL quantity - FR rows with
-- to_type='official' AND relationship_type='donation', grouped by to_id - so
-- this is a freshness swap, not a semantics change. Measured on prod
-- 2026-09-05: 4,131 of 37,294 officials disagree, $2,745,805,506 of |gap|,
-- worst case Joseph Biden at $0.88M stored against $340.3M real.
--
-- FIX-939. The 86 merge stubs are excluded here, which covers /api/browse/
-- typeahead, get_browse_page and get_browse_facets - all three read
-- entity_search_index. Expect the official row count to fall by 86 on the next
-- rebuild (a unit of refresh_derived_mvs('daily'), jobid 9, 06:00 UTC).
--
-- Rule 34: this is a REDEFINITION of a function that carries proconfig. Both
-- SET clauses (search_path, statement_timeout) and SECURITY DEFINER are
-- restated verbatim below, and the GRANT posture is re-asserted after.

CREATE OR REPLACE FUNCTION public.rebuild_entity_search_index()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '1200s'
AS $function$
DECLARE
  v_count integer;
  -- FIX-985(b). The spend-precedence vocabulary, declared ONCE so the
  -- predicate below and the domain assertion cannot drift apart. Was
  -- ('corporation','organization') at both sites; 'organization' has never
  -- been in the financial_entities.entity_type CHECK domain, so every
  -- non-corporation spender fell through to total_donated_cents and
  -- rendered amount_cents = 0. Prod 2026-09-02: 35 'other' + 2 'nonprofit'
  -- entities, 1,317,782,700 cents ($13,177,827.00) of contract+grant, all
  -- showing $0.
  c_spend_types text[] := ARRAY['corporation', 'other', 'nonprofit'];
  v_domain text[];
  v_lit    text;
  -- FIX-687's canonical 16. uuid v4 keys distribute evenly across them.
  c_bounds uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  i    int;
  v_lo uuid;
  v_hi uuid;
BEGIN
  -- FIX-985(b) guard: every literal in c_spend_types must be a real member of
  -- the financial_entities.entity_type CHECK domain. The next vocabulary
  -- drift fails loudly here instead of silently zeroing an amount column.
  SELECT array_agg(m[1]) INTO v_domain
  FROM pg_constraint con
  CROSS JOIN LATERAL regexp_matches(
         pg_get_constraintdef(con.oid), '''([a-z0-9_]+)''::text', 'g') AS m
  WHERE con.conrelid = 'public.financial_entities'::regclass
    AND con.contype  = 'c'
    AND con.conname  = 'financial_entities_entity_type_check';

  IF v_domain IS NULL THEN
    -- Constraint renamed or dropped: cannot assert. Say so, do not block the
    -- nightly rebuild on a missing guard.
    RAISE WARNING 'FIX-985: financial_entities_entity_type_check not readable - '
                  'entity_type vocabulary left unasserted.';
  ELSE
    FOREACH v_lit IN ARRAY c_spend_types LOOP
      IF NOT (v_lit = ANY (v_domain)) THEN
        RAISE EXCEPTION
          'FIX-985: entity_type ''%'' in the search-index spend vocabulary is not in '
          'the financial_entities.entity_type CHECK domain (%). Fix the vocabulary '
          'or the constraint before rebuilding the search index.',
          v_lit, array_to_string(v_domain, ', ');
      END IF;
    END LOOP;
  END IF;

  -- Per-statement memory for the GIN builds on the INSERTs below. The _conn
  -- stage no longer runs under this: entity_search_conn_window() carries its own
  -- 64MB proconfig, which is what actually bounds the aggregate (FIX-1123).
  SET LOCAL work_mem = '256MB';

  -- ── Shared derivations (built once) ──
  --
  -- FIX-1123 — sixteen bounded windows instead of one whole-table
  -- HashAggregate over a UNION ALL of both id columns. Each window is its own
  -- statement, so the memory ceiling is per-window and a future cardinality
  -- spills one window's worth rather than the box. entity_connections is
  -- 10,503,011 rows / 7,473 MB on prod as of 2026-08-31 — the ~2.4M in FIX-748's
  -- header was true when it shipped 2026-07-06 and has been 4.4x wrong since.
  CREATE TEMP TABLE _conn (entity_id uuid, c int) ON COMMIT DROP;
  FOR i IN 1 .. 16 LOOP
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    INSERT INTO _conn (entity_id, c)
    SELECT w.entity_id, w.c
      FROM public.entity_search_conn_window(v_lo, v_hi) w;
  END LOOP;
  CREATE UNIQUE INDEX ON _conn (entity_id);
  -- The old build was a CTAS, which leaves no statistics behind either; the
  -- INSERT path is the same. ANALYZE so the eight INSERTs below join against a
  -- real row count rather than a default guess.
  ANALYZE _conn;

  CREATE TEMP TABLE _off_committees ON COMMIT DROP AS
    SELECT official_id, array_agg(DISTINCT committee_id) AS committee_ids
    FROM public.official_committee_memberships
    WHERE ended_at IS NULL
    GROUP BY official_id;
  CREATE UNIQUE INDEX ON _off_committees (official_id);

  -- one primary industry slug per financial entity (deterministic pick)
  CREATE TEMP TABLE _fe_industry ON COMMIT DROP AS
    SELECT DISTINCT ON (entity_id) entity_id, tag
    FROM public.entity_tags
    WHERE entity_type = 'financial_entity' AND tag_category = 'industry'
    ORDER BY entity_id, tag;
  CREATE UNIQUE INDEX ON _fe_industry (entity_id);

  TRUNCATE public.entity_search_index;

  -- ── official ──────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, photo_url, search_tsv, is_synthetic,
    jurisdiction_level, state, party, chamber, status, committee_ids,
    amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'official', o.id, o.full_name, o.role_title, o.photo_url,
    to_tsvector('english', coalesce(o.full_name,'') || ' ' || coalesce(o.role_title,'')),
    coalesce(o.is_synthetic, false),
    CASE lower(coalesce(j.type::text, oj.type::text))
      WHEN 'country' THEN 'federal'
      WHEN 'state'   THEN 'state'
      WHEN 'county'  THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL
    END,
    o.metadata->>'state',
    o.party::text,
    CASE WHEN o.role_title = 'Senator' THEN 'senate'
         WHEN o.role_title ILIKE 'Representative%' THEN 'house' ELSE NULL END,
    'active',
    oc.committee_ids,
    -- FIX-942: the authoritative per-official donation total is
    -- official_donor_totals.total_cents, NOT officials.total_received_cents.
    -- Both sum the same quantity (FR rows, to_type='official',
    -- relationship_type='donation'), but the column lost its writer when the
    -- nightly moved to the FIX-836 bulk regime and has been frozen since.
    -- Prod 2026-09-05: 4,131 officials disagreed, $2,745,805,506 of |gap|.
    -- Missing rollup row = 0, which is what an official with no donations has.
    COALESCE(odt.total_cents, 0),
    CASE WHEN odt.total_cents IS NOT NULL THEN 'received' ELSE NULL END,
    coalesce(cn.c, 0),
    o.updated_at,
    CASE WHEN o.source_ids ? 'congress_gov' OR o.source_ids ? 'bioguide_id' THEN 'congress.gov'
         WHEN o.source_ids ? 'openstates' THEN 'openstates' ELSE NULL END,
    now()
  FROM public.officials o
  LEFT JOIN public.governing_bodies gb ON gb.id = o.governing_body_id
  LEFT JOIN public.jurisdictions j     ON j.id = gb.jurisdiction_id
  LEFT JOIN public.jurisdictions oj    ON oj.id = o.jurisdiction_id
  LEFT JOIN _conn cn                    ON cn.entity_id = o.id
  LEFT JOIN _off_committees oc          ON oc.official_id = o.id
  LEFT JOIN public.official_donor_totals odt ON odt.official_id = o.id
  WHERE o.is_active
    -- FIX-939 - merge stubs never surface. A FIX-933 merge neutralises a
    -- same-person duplicate: the money moves to the elected survivor and the
    -- candidate row keeps its retired FEC id purely as provenance. What is
    -- left is a $0 official that duplicates a real person, and all 86 of them
    -- on prod (2026-09-05) were being offered by search, typeahead and the
    -- browse facets as people you could look up. All three read this table, so
    -- this predicate is what covers them; the TS mirror for the readers that
    -- hit `officials` directly is isMergeStubSourceIds() in @civitics/db.
    --
    -- PRESENCE of any marker key, not equality with a particular id:
    --   merged_fec_candidate_id   legacy scalar (86 prod rows today)
    --   merged_fec_candidate_ids  the FIX-956 array writers now emit
    --   merged_into               the survivor pointer, written by a later
    --                             data pass - accepted here already so
    --                             nothing changes when it lands.
    AND NOT (o.source_ids ?| ARRAY[
      'merged_fec_candidate_id', 'merged_fec_candidate_ids', 'merged_into']);

  -- ── proposal (non-initiative) ───────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, proposal_type, amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'proposal', p.id, p.title, p.type::text,
    to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.type::text,'')),
    coalesce(p.is_synthetic, false),
    p.status::text, p.type::text,
    NULL, NULL, coalesce(cn.c, 0),
    p.introduced_at::timestamptz,
    CASE WHEN p.type::text = 'regulation' THEN 'regulations.gov' ELSE 'congress.gov' END,
    now()
  FROM public.proposals p
  LEFT JOIN _conn cn ON cn.entity_id = p.id
  WHERE p.type <> 'initiative';

  -- ── initiative ──────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, initiative_stage, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'initiative', p.id, p.title, id2.stage::text,
    to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(id2.stage::text,'')),
    coalesce(p.is_synthetic, false),
    p.status::text, id2.stage::text,
    coalesce(cn.c, 0), p.created_at, 'civitics', now()
  FROM public.proposals p
  LEFT JOIN public.initiative_details id2 ON id2.proposal_id = p.id
  LEFT JOIN _conn cn ON cn.entity_id = p.id
  WHERE p.type = 'initiative';

  -- ── agency ──────────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    agency_type, status, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'agency', a.id, a.name, a.acronym,
    to_tsvector('english', coalesce(a.name,'') || ' ' || coalesce(a.acronym,'')),
    coalesce(a.is_synthetic, false),
    a.agency_type, 'active', coalesce(cn.c, 0), a.updated_at, NULL, now()
  FROM public.agencies a
  LEFT JOIN _conn cn ON cn.entity_id = a.id
  WHERE a.is_active;

  -- ── financial (non-individual) — FIX-667 amount precedence ──────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    financial_type, industry, amount_cents, amount_label, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'financial', f.id, f.display_name, f.entity_type,
    to_tsvector('english', coalesce(f.display_name,'') || ' ' || coalesce(f.entity_type,'')),
    coalesce(f.is_synthetic, false),
    f.entity_type, fi.tag,
    amt.amount_cents, amt.amount_label,
    coalesce(cn.c, 0),
    f.created_at,   -- FIX-699: updated_at is stale (lost trigger) — created_at is the defensible column
    CASE WHEN amt.amount_label IN ('contract','grant') THEN 'usaspending' ELSE 'fec' END,
    now()
  FROM public.financial_entities f
  LEFT JOIN _conn cn ON cn.entity_id = f.id
  LEFT JOIN _fe_industry fi ON fi.entity_id = f.id
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN ie > 0 THEN ie
           WHEN spend > 0 AND f.entity_type = ANY (c_spend_types) THEN spend
           ELSE don END AS amount_cents,
      CASE WHEN ie > 0 THEN 'independent_expenditure'
           WHEN spend > 0 AND f.entity_type = ANY (c_spend_types)
             THEN CASE WHEN contract_c >= grant_c THEN 'contract' ELSE 'grant' END
           ELSE 'donation' END AS amount_label
    FROM (SELECT
            coalesce(f.total_ie_support_cents,0) + coalesce(f.total_ie_oppose_cents,0) AS ie,
            coalesce(f.total_contract_cents,0)   + coalesce(f.total_grant_cents,0)     AS spend,
            coalesce(f.total_contract_cents,0)   AS contract_c,
            coalesce(f.total_grant_cents,0)      AS grant_c,
            coalesce(f.total_donated_cents,0)    AS don) v
  ) amt
  WHERE f.entity_type <> 'individual';

  -- ── jurisdiction ────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    jurisdiction_level, status, connection_count, activity_at, primary_source, refreshed_at)
  SELECT
    'jurisdiction', jr.id, jr.name, jr.type::text,
    to_tsvector('english', coalesce(jr.name,'') || ' ' || coalesce(jr.short_name,'')),
    coalesce(jr.is_synthetic, false),
    CASE lower(jr.type::text)
      WHEN 'country' THEN 'federal' WHEN 'state' THEN 'state'
      WHEN 'county' THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL END,
    'active', coalesce(cn.c, 0), jr.updated_at, 'census', now()
  FROM public.jurisdictions jr
  LEFT JOIN _conn cn ON cn.entity_id = jr.id
  WHERE jr.is_active;

  -- ── institution (governing bodies) ──────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    jurisdiction_level, institution_type, status, connection_count, activity_at, refreshed_at)
  SELECT
    'institution', g.id, g.name, g.type::text,
    to_tsvector('english', coalesce(g.name,'') || ' ' || coalesce(g.short_name,'')),
    coalesce(g.is_synthetic, false),
    CASE lower(gj.type::text)
      WHEN 'country' THEN 'federal' WHEN 'state' THEN 'state'
      WHEN 'county' THEN 'local' WHEN 'city' THEN 'local'
      WHEN 'district' THEN 'local' WHEN 'precinct' THEN 'local' WHEN 'other' THEN 'local'
      ELSE NULL END,
    g.type::text, 'active', coalesce(cn.c, 0), g.updated_at, now()
  FROM public.governing_bodies g
  LEFT JOIN public.jurisdictions gj ON gj.id = g.jurisdiction_id
  LEFT JOIN _conn cn ON cn.entity_id = g.id
  WHERE g.is_active;

  -- ── meeting ──────────────────────────────────────────────────────────────────
  INSERT INTO public.entity_search_index (
    kind, entity_id, display_name, secondary_label, search_tsv, is_synthetic,
    status, connection_count, activity_at, refreshed_at)
  SELECT
    'meeting', m.id, m.title, m.meeting_type,
    to_tsvector('english', coalesce(m.title,'') || ' ' || coalesce(m.meeting_type,'')),
    false,  -- meetings have no is_synthetic column
    m.status, coalesce(cn.c, 0), m.scheduled_at, now()
  FROM public.meetings m
  LEFT JOIN _conn cn ON cn.entity_id = m.id
  WHERE m.title IS NOT NULL;

  -- ── facet rollup ──
  PERFORM public.rebuild_browse_facet_counts();

  SELECT count(*) INTO v_count FROM public.entity_search_index;
  RETURN v_count;
END;
$function$;


-- Re-assert the GRANT posture (rule 34): Supabase default-grants EXECUTE on new
-- functions to anon/authenticated, and CREATE OR REPLACE re-runs those defaults.
-- This is a nightly rebuild driven by pg_cron, never by a request.
REVOKE ALL ON FUNCTION public.rebuild_entity_search_index() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rebuild_entity_search_index() FROM anon;
REVOKE ALL ON FUNCTION public.rebuild_entity_search_index() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_search_index() TO service_role;

-- FIX-942: deprecate the two writers of officials.total_received_cents.
--
-- NOT dropped. Three repair scripts still name them as break-glass full
-- rebuilds (merge-same-person-official-dupes, remediate-bound-cross-person,
-- remediate-cross-person-misattribution - the routine calls are removed in the
-- same commit), so a DROP would break a manual recovery path for no gain.
COMMENT ON FUNCTION public.rebuild_official_donation_totals() IS
  'DEPRECATED (FIX-942). Writes officials.total_received_cents, which has no reader left: the treemap, /api/graph/small-dollar and rebuild_entity_search_index all read official_donor_totals.total_cents, maintained incrementally by the jobid 24 donor rollup. Break-glass only; do not call from scheduled work.';

COMMENT ON FUNCTION public.rebuild_official_donation_totals_full() IS
  'DEPRECATED (FIX-942). Full-table variant of rebuild_official_donation_totals(); same disposition - no reader, break-glass only. Read official_donor_totals.total_cents instead.';

-- The column keeps its data and its index. The FIX-942 drop gate required zero
-- drift against the rollup before dropping, and prod has $2.75bn of it - all of
-- it staleness, but a DROP is irreversible and the column is now merely inert.
-- Filed as a follow-up rather than forced here.
COMMENT ON COLUMN public.officials.total_received_cents IS
  'DEPRECATED (FIX-942) - frozen; no writer since the FIX-836 bulk regime. Read public.official_donor_totals.total_cents, which sums the identical quantity and is maintained incrementally. Prod 2026-09-05: 4,131 rows drift, $2,745,805,506 total. Drop (with index officials_total_received_cents) is a follow-up once the deploy has confirmed no reader remains.';
