-- =============================================================================
-- FIX-985 — two riders on jobid 9's remaining units, both read off the LIVE
-- prod bodies (pg_get_functiondef, md5-matched against the local clone) so the
-- only textual delta from what is running is the intended edit.
--
-- (a) The three zero-source EC arms DELETE other arms' edges.
--     rebuild_entity_connections_{lobbying,gifts,holds} each open with
--     `DELETE FROM entity_connections WHERE connection_type = X` and then
--     re-INSERT with evidence_source = 'financial_relationships'. The DELETE is
--     unscoped, so it also removes the external_relationships arm's edges of the
--     same type. That is not hypothetical: prod carries 10,431 'lobbying' edges
--     with evidence_source = 'external_relationships' and ZERO
--     financial_relationships rows of relationship_type 'lobbying_spend' — so
--     the lobbying arm, if it ran, would delete all 10,431 and insert nothing.
--     ('gift_received' and 'holds_position' have no edges on prod today, but the
--     same shape.)
--
--     What is holding it back is FIX-1117's fingerprint gate: a zero-row source
--     banks `n=0;t=-` and the arm is skipped thereafter. Prod
--     pipeline_state 'ec_arm_source_fingerprints' as of 2026-09-02:
--         rebuild_entity_connections_lobbying  n=0;t=-  (banked 2026-08-28 08:15)
--         rebuild_entity_connections_gifts     n=0;t=-  (banked 2026-08-28 07:45)
--         rebuild_entity_connections_holds     n=0;t=-  (banked 2026-08-28 07:30)
--     The defect is dormant, not fixed — it fires the first time any of those
--     three FR relationship types gains a row.
--
--     Fix: scope each DELETE by the evidence_source that arm's own INSERT
--     writes, per the FIX-692/808 rule already applied to appointment edges.
--     The arms otherwise keep their bodies verbatim; the contracts arm and the
--     arm ordering are untouched.
--
-- (b) rebuild_entity_search_index gates contract/grant amount precedence on
--     `f.entity_type IN ('corporation','organization')`. The live
--     financial_entities.entity_type CHECK domain is
--       individual, pac, super_pac, corporation, union, party_committee,
--       small_donor_aggregate, tribal, 527, nonprofit, other
--     — 'organization' is not in it and no row has ever carried it (prod count:
--     0). So every non-corporation spender fell through to total_donated_cents.
--     Prod population: 35 'other' + 2 'nonprofit' financial entities with
--     contract+grant > 0 and no independent expenditure, 1,317,782,700 cents
--     ($13,177,827.00), all of them rendering amount_cents = 0 today (their
--     total_donated_cents is 0).
--
--     Fix: the domain-correct set ('corporation','other','nonprofit'), declared
--     once as c_spend_types so the two predicate sites cannot drift, plus an
--     assertion at the top of the function that every literal is in the CHECK
--     domain. FIX-1123's sixteen bounded _conn windows, the SET LOCAL work_mem,
--     the SECURITY DEFINER search_path and the (inert) SET statement_timeout are
--     all preserved exactly.
--
-- NOT changed here: jobid 9's unit list, the FIX-1123 windows, the work_mem SET,
-- or cron_job_budget — which already carries 'refresh-derived-mvs-daily' at
-- 5,400 s (verified on prod 2026-09-02; the FIX-1125 bullet's "has NO row" is
-- stale).
-- =============================================================================


-- -- (a) The three arms: DELETE scoped to the evidence_source they own --------
-- rebuild_entity_connections_lobbying: was `WHERE connection_type = 'lobbying'`, now also
-- `AND evidence_source = 'financial_relationships'` — the value its own
-- INSERT below writes.
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_lobbying()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '10min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'lobbying'
     AND entity_connections.evidence_source = 'financial_relationships';  -- FIX-985

  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.started_at)                AS first_at,
      MAX(COALESCE(fr.ended_at, CURRENT_DATE)) AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.started_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type = 'lobbying_spend'
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'lobbying'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'lobbying'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_lobbying() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_lobbying() TO service_role;


-- rebuild_entity_connections_gifts: was `WHERE connection_type = 'gift_received'`, now also
-- `AND evidence_source = 'financial_relationships'` — the value its own
-- INSERT below writes.
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_gifts()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '10min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'gift_received'
     AND entity_connections.evidence_source = 'financial_relationships';  -- FIX-985

  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.occurred_at)               AS first_at,
      MAX(fr.occurred_at)               AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('gift', 'honorarium')
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'gift_received'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 6.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'gift_received'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_gifts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_gifts() TO service_role;


-- rebuild_entity_connections_holds: was `WHERE connection_type = 'holds_position'`, now also
-- `AND evidence_source = 'financial_relationships'` — the value its own
-- INSERT below writes.
CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_holds()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
 SET statement_timeout TO '10min'
AS $function$
DECLARE v_count BIGINT;
BEGIN
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type = 'holds_position'
     AND entity_connections.evidence_source = 'financial_relationships';  -- FIX-985

  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                          AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0)) AS total_cents,
      MIN(fr.started_at)                AS first_at,
      (ARRAY_AGG(fr.id ORDER BY fr.started_at DESC NULLS LAST))[1:50] AS evidence_ids
    FROM public.financial_relationships fr
    WHERE fr.relationship_type IN ('owns_stock', 'owns_bond', 'property')
      AND fr.ended_at IS NULL
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'holds_position'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        0.4 + LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 16.0
      ))::numeric(4,3),
      NULLIF(a.total_cents, 0), a.first_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  connection_type := 'holds_position'; edges_upserted := v_count; RETURN NEXT;

  ANALYZE public.entity_connections;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_holds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_holds() TO service_role;


-- -- (b) rebuild_entity_search_index: domain-correct spend vocabulary -------
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
    o.total_received_cents,
    CASE WHEN o.total_received_cents IS NOT NULL THEN 'received' ELSE NULL END,
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
  WHERE o.is_active;

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

REVOKE ALL ON FUNCTION public.rebuild_entity_search_index() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_search_index() TO service_role;
