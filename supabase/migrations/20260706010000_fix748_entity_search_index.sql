-- =============================================================================
-- 20260705010000_fix748_entity_search_index.sql
-- FIX-748 — Browse Program Wave 0: materialized search substrate.
--
-- Today /api/search fans out to 8 per-kind searchers; 6 use unindexed ILIKE
-- (seq scans on the IOWait-bound Pro Small), 5 use exact COUNTs, and pagination
-- is offset-based. This migration builds the read-path substrate every later
-- browse wave sits on:
--
--   1. entity_search_index  — one row per searchable entity (ALL kinds EXCEPT
--      financial individuals; ~4.9M individual rows stay on the existing
--      FIX-238 financial_entities.canonical_name trigram path and are reached
--      via a capped passthrough in /api/browse — see FIX-749). Lands ~227k rows
--      locally, small enough to stay hot.
--   2. browse_facet_counts  — kind × facet_key × facet_value × count rollup
--      (+ per-kind totals) for zero-query facet counts and the future landing
--      tiles. Never computed via live COUNT(*) on the request path.
--   3. rebuild_entity_search_index() / rebuild_browse_facet_counts() — idempotent
--      full rebuilds, callable ad hoc, env-portable (no hardcoded UUIDs).
--
-- Pattern: packages/db/CLAUDE.md § "Materialization pattern for slow
-- request-path aggregations" (per-entity cache TABLE, not an MV — the source is
-- a heterogeneous UNION across 8 base tables that no single MV query expresses
-- cleanly, and a TABLE lets the rebuild TRUNCATE+INSERT atomically). Reference
-- migration: 20260627000600_fix663_jurisdiction_page_cache.sql.
--
-- NO UI change in this wave — /api/search and the current page stay untouched.
--
-- ── Kinds & row scope (derived from the 8 searchers in
--    apps/civitics/app/api/search/route.ts) ───────────────────────────────────
--   official     officials WHERE is_active        (matches search default +
--                                                   GROUP_TREE People cohorts;
--                                                   keeps senate/party facet
--                                                   counts aligned to the ~100
--                                                   current senators)
--   proposal     proposals WHERE type <> 'initiative'
--   initiative   proposals WHERE type =  'initiative'  (+ initiative_details.stage)
--   agency       agencies  WHERE is_active
--   financial    financial_entities WHERE entity_type <> 'individual'
--   jurisdiction jurisdictions WHERE is_active
--   institution  governing_bodies WHERE is_active  (search "institutions" = GBs)
--   meeting      meetings WHERE title IS NOT NULL
--
-- The By-Branch scope tree shipped in W0 (FIX-749) covers only
-- official/financial/agency/proposal/initiative (current GROUP_TREE roots);
-- jurisdiction/institution/meeting rows are indexed now (superset) and become
-- reachable when their tree roots land in W3.
-- =============================================================================

-- pg_trgm is already installed (verified); guard for a clean local replay.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. entity_search_index
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_search_index (
  kind             text  NOT NULL,   -- official|proposal|initiative|agency|financial|jurisdiction|institution|meeting
  entity_id        uuid  NOT NULL,   -- officials.id / proposals.id / ... (UUIDs globally unique across base tables)
  display_name     text  NOT NULL,   -- primary label (full_name / title / name / display_name)
  secondary_label  text,             -- subtitle (role_title / type / acronym / entity_type / stage / meeting_type)
  photo_url        text,             -- officials only (list avatar)
  search_tsv       tsvector,         -- to_tsvector('english', display_name || ' ' || secondary_label)
  is_synthetic     boolean NOT NULL DEFAULT false,  -- meetings have no column → always false

  -- ── Facet columns (per the FIX-749 registry) — text so enum churn never
  --    breaks the index; NULL where the facet doesn't apply to the kind. ──
  jurisdiction_level text,  -- federal|state|local  (official, jurisdiction, institution)
  state              text,  -- 2-letter            (official: metadata->>'state')
  party              text,  -- (official)
  chamber            text,  -- senate|house         (official)
  status             text,  -- proposal/initiative/meeting status; active/inactive elsewhere
  proposal_type      text,  -- bill|regulation|...  (proposal)
  agency_type        text,  -- (agency)
  financial_type     text,  -- entity_type          (financial)
  industry           text,  -- primary industry tag slug (financial)
  initiative_stage   text,  -- (initiative)
  institution_type   text,  -- governing_bodies.type (institution)  [added beyond the prompt's list — institutions clearly need a type facet]
  committee_ids      uuid[], -- current committee memberships (official) — array_agg(committee_id) WHERE ended_at IS NULL

  -- ── Amount / activity / provenance ──
  amount_cents     bigint,  -- financial: FIX-667 precedence (IE>spending>donation); official: total_received_cents
  amount_label     text,    -- independent_expenditure|contract|grant|donation (financial); received (official)
  connection_count integer NOT NULL DEFAULT 0,  -- entity_connections degree (display cache; lags per FIX-735)
  activity_at      timestamptz,  -- best-available per kind (see rebuild fn); FIX-699: financial uses created_at, NOT the stale updated_at
  primary_source   text,    -- coarse provenance string (NOT the FIX-405 AttributionShape)

  refreshed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, entity_id)
);

ALTER TABLE public.entity_search_index ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_search_index_read ON public.entity_search_index;
CREATE POLICY entity_search_index_read
  ON public.entity_search_index FOR SELECT TO anon, authenticated USING (true);

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Justification per index (measured sizes reported in the FIX-748 closing note):
--
--  trigram GIN on display_name — the primary text path. Replaces the 6 searchers'
--    unindexed ILIKE '%q%' seq scans (proposals/agencies/financial/jurisdictions/
--    institutions/meetings) with an index-backed substring match on ≤227k rows.
CREATE INDEX IF NOT EXISTS entity_search_index_name_trgm
  ON public.entity_search_index USING gin (display_name gin_trgm_ops);

--  GIN on search_tsv — whole-word / websearch FTS path (mirrors the FIX-504
--    proposals.search_vector move); cheap secondary to the trigram substring path.
CREATE INDEX IF NOT EXISTS entity_search_index_tsv
  ON public.entity_search_index USING gin (search_tsv);

--  GIN on committee_ids — committee-cohort membership ("officials on committee X")
--    without the per-request join to official_committee_memberships the graph
--    route does today. Only official rows carry a non-NULL array.
CREATE INDEX IF NOT EXISTS entity_search_index_committee_ids
  ON public.entity_search_index USING gin (committee_ids);

--  Keyset-sort btrees — (kind, <sort>, entity_id) supports both scoped ordering
--    AND the (sort_value, entity_id) keyset cursor (FIX-749). One per sort mode:
CREATE INDEX IF NOT EXISTS entity_search_index_name_sort
  ON public.entity_search_index (kind, display_name, entity_id);
CREATE INDEX IF NOT EXISTS entity_search_index_conn_sort
  ON public.entity_search_index (kind, connection_count DESC, entity_id);
CREATE INDEX IF NOT EXISTS entity_search_index_amount_sort
  ON public.entity_search_index (kind, amount_cents DESC NULLS LAST, entity_id);
CREATE INDEX IF NOT EXISTS entity_search_index_activity_sort
  ON public.entity_search_index (kind, activity_at DESC NULLS LAST, entity_id);

--  High-selectivity facet btrees — the facets that narrow a scope hard enough to
--    beat a (kind, sort) scan + Filter. Lower-selectivity facets (party/chamber/
--    status/*_type) ride the (kind, sort) scans with a Filter — a partial btree
--    per enum value would multiply index count for little gain on ≤227k rows.
CREATE INDEX IF NOT EXISTS entity_search_index_kind_industry
  ON public.entity_search_index (kind, industry) WHERE industry IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_search_index_kind_state
  ON public.entity_search_index (kind, state) WHERE state IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_search_index_kind_finance_type
  ON public.entity_search_index (kind, financial_type) WHERE financial_type IS NOT NULL;

COMMENT ON TABLE public.entity_search_index IS
  'FIX-748 — materialized browse/search substrate (all searchable kinds except '
  'financial individuals). Rebuilt by rebuild_entity_search_index() on the '
  'refresh_derived_mvs(''daily'') pg_cron tail. Read by /api/browse (FIX-749). '
  'Display cache — connection_count lags entity_connections per FIX-735.';

-- ---------------------------------------------------------------------------
-- 2. browse_facet_counts — zero-query facet counts + per-kind totals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.browse_facet_counts (
  kind         text NOT NULL,
  facet_key    text NOT NULL,   -- 'party'|'state'|'chamber'|'financial_type'|'industry'|'agency_type'|'proposal_type'|'initiative_stage'|'jurisdiction_level'|'status'|'institution_type'|'__total__'
  facet_value  text NOT NULL,   -- the value; '__all__' for the __total__ per-kind row
  count        integer NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, facet_key, facet_value)
);

ALTER TABLE public.browse_facet_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS browse_facet_counts_read ON public.browse_facet_counts;
CREATE POLICY browse_facet_counts_read
  ON public.browse_facet_counts FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE public.browse_facet_counts IS
  'FIX-748 — kind × facet_key × facet_value × count rollup over '
  'entity_search_index (+ __total__/__all__ per-kind totals). Serves zero-query '
  'facet counts in /api/browse (counts_mode=exact). Rebuilt by '
  'rebuild_browse_facet_counts(), called at the tail of rebuild_entity_search_index().';

-- ---------------------------------------------------------------------------
-- 3. rebuild_browse_facet_counts() — rollup from the index. Idempotent.
--    One facet_key per (kind,column) pair via an unpivot; __total__ per kind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_browse_facet_counts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '300s'
AS $$
DECLARE
  v_count integer;
BEGIN
  TRUNCATE public.browse_facet_counts;

  INSERT INTO public.browse_facet_counts (kind, facet_key, facet_value, count, refreshed_at)
  WITH unpivoted AS (
    -- one (kind, facet_key, facet_value) row per non-null facet cell
    SELECT kind, 'party'              AS facet_key, party              AS facet_value FROM public.entity_search_index WHERE party IS NOT NULL
    UNION ALL SELECT kind, 'state',              state              FROM public.entity_search_index WHERE state IS NOT NULL
    UNION ALL SELECT kind, 'chamber',            chamber            FROM public.entity_search_index WHERE chamber IS NOT NULL
    UNION ALL SELECT kind, 'financial_type',     financial_type     FROM public.entity_search_index WHERE financial_type IS NOT NULL
    UNION ALL SELECT kind, 'industry',           industry           FROM public.entity_search_index WHERE industry IS NOT NULL
    UNION ALL SELECT kind, 'agency_type',        agency_type        FROM public.entity_search_index WHERE agency_type IS NOT NULL
    UNION ALL SELECT kind, 'proposal_type',      proposal_type      FROM public.entity_search_index WHERE proposal_type IS NOT NULL
    UNION ALL SELECT kind, 'initiative_stage',   initiative_stage   FROM public.entity_search_index WHERE initiative_stage IS NOT NULL
    UNION ALL SELECT kind, 'jurisdiction_level', jurisdiction_level FROM public.entity_search_index WHERE jurisdiction_level IS NOT NULL
    UNION ALL SELECT kind, 'status',             status             FROM public.entity_search_index WHERE status IS NOT NULL
    UNION ALL SELECT kind, 'institution_type',   institution_type   FROM public.entity_search_index WHERE institution_type IS NOT NULL
  ),
  facet_rows AS (
    SELECT kind, facet_key, facet_value, count(*)::int AS count
    FROM unpivoted GROUP BY kind, facet_key, facet_value
  ),
  total_rows AS (
    SELECT kind, '__total__' AS facet_key, '__all__' AS facet_value, count(*)::int AS count
    FROM public.entity_search_index GROUP BY kind
  )
  SELECT kind, facet_key, facet_value, count, now() FROM facet_rows
  UNION ALL
  SELECT kind, facet_key, facet_value, count, now() FROM total_rows;

  SELECT count(*) INTO v_count FROM public.browse_facet_counts;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_browse_facet_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_browse_facet_counts() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. rebuild_entity_search_index() — full idempotent rebuild. TRUNCATE+INSERT
--    is atomic within the call (readers see the prior contents until the caller
--    COMMITs), so there is no empty-index window. Shared derivations (connection
--    degree, current committee memberships, primary industry tag) are staged in
--    ON COMMIT DROP temp tables so entity_connections (~2.4M rows) is scanned
--    once, not once per kind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebuild_entity_search_index()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '1200s'
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Bounded per-statement memory for the GIN builds on the INSERTs.
  SET LOCAL work_mem = '256MB';

  -- ── Shared derivations (built once) ──
  CREATE TEMP TABLE _conn ON COMMIT DROP AS
    SELECT entity_id, count(*)::int AS c
    FROM (
      SELECT from_id AS entity_id FROM public.entity_connections
      UNION ALL
      SELECT to_id   AS entity_id FROM public.entity_connections
    ) u
    GROUP BY entity_id;
  CREATE UNIQUE INDEX ON _conn (entity_id);

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
           WHEN spend > 0 AND f.entity_type IN ('corporation','organization') THEN spend
           ELSE don END AS amount_cents,
      CASE WHEN ie > 0 THEN 'independent_expenditure'
           WHEN spend > 0 AND f.entity_type IN ('corporation','organization')
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
$$;

REVOKE ALL ON FUNCTION public.rebuild_entity_search_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_search_index() TO service_role;

COMMENT ON FUNCTION public.rebuild_entity_search_index() IS
  'FIX-748 — full idempotent rebuild of entity_search_index (+ browse_facet_counts '
  'via rebuild_browse_facet_counts()). TRUNCATE+INSERT is atomic within the call. '
  'Wired into refresh_derived_mvs(''daily'') on pg_cron. Callable ad hoc.';
