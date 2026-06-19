-- FIX-600 — Pre-seed synthetic cleanup (SF-P1/SF-P2 follow-up).
--
-- Two gap classes left open by FIX-572 (SF-P1, is_synthetic columns + standing
-- predicates) and FIX-599 (SF-P2, persistent labeling). Both are behavior-neutral
-- on current data (0 synthetic rows) and both MUST land before any State of
-- Franklin seeding.
--
--   Part A — EXCLUDE synthetic entities from PLATFORM-WIDE real totals so seeding
--            Franklin can never inflate the platform's advertised numbers.
--   Part B — CARRY is_synthetic through the get_topic_proposal_page projection so
--            topic-filtered proposal cards light up the SYNTHETIC mark.
--
-- SCOPE GUARD: only platform-wide totals get the filter. Jurisdiction/entity-
-- scoped reads (the Franklin jurisdiction page's own ~10 officials / ~11
-- proposals, per-entity detail pages, topic-filtered card LISTS) are left alone —
-- they must still SHOW synthetic content, labeled. This migration only touches
-- the global aggregate surfaces + the one projection SF-P2 missed.
--
-- PERFORMANCE: the financial totals are computed GROSS − SYNTHETIC, never by
-- anti-joining every donation/contract row against the synthetic set (that plan
-- measured 86s on the homepage_stats_mv refresh). Gross is the original fast
-- exact count; the synthetic side is driven FROM the tiny synthetic_entities set
-- through the financial_relationships (type,id) indexes (≈ms at 0 synthetic rows,
-- cheap at Franklin scale). Partial `WHERE is_synthetic` indexes + an ANALYZE
-- give the planner the cardinality + access path it needs on a freshly-cloned DB
-- (the is_synthetic columns had no stats locally — n_live_tup 0 — which produced
-- the 32s blind-plan RPC before this).
--
-- Replay-safe: DROP ... IF EXISTS + CREATE throughout. search_path uses the
-- UNQUOTED comma form (the quoted form breaks on prod Pro, per SF-P2).

-- ---------------------------------------------------------------------------
-- 1. Partial indexes + ANALYZE so the planner can see the synthetic set is tiny
-- ---------------------------------------------------------------------------
-- One partial index per is_synthetic-bearing table (FIX-572 list). Tiny (0 rows
-- today); gives an instant access path to enumerate synthetic rows and lets the
-- planner estimate ~0 → nested-loop/anti-join over the small side rather than a
-- full financial_relationships scan. ANALYZE so the stats exist immediately on a
-- restored/cloned DB instead of waiting for autovacuum.
CREATE INDEX IF NOT EXISTS officials_is_synthetic_idx          ON public.officials          (id) WHERE is_synthetic;
CREATE INDEX IF NOT EXISTS proposals_is_synthetic_idx          ON public.proposals          (id) WHERE is_synthetic;
CREATE INDEX IF NOT EXISTS financial_entities_is_synthetic_idx ON public.financial_entities (id) WHERE is_synthetic;
CREATE INDEX IF NOT EXISTS agencies_is_synthetic_idx           ON public.agencies           (id) WHERE is_synthetic;
CREATE INDEX IF NOT EXISTS governing_bodies_is_synthetic_idx   ON public.governing_bodies   (id) WHERE is_synthetic;
CREATE INDEX IF NOT EXISTS jurisdictions_is_synthetic_idx      ON public.jurisdictions      (id) WHERE is_synthetic;
CREATE INDEX IF NOT EXISTS investigations_is_synthetic_idx     ON public.investigations     (id) WHERE is_synthetic;
CREATE INDEX IF NOT EXISTS evidence_cards_is_synthetic_idx     ON public.evidence_cards     (id) WHERE is_synthetic;

ANALYZE public.officials, public.proposals, public.financial_entities,
        public.agencies, public.governing_bodies, public.jurisdictions,
        public.investigations, public.evidence_cards;

-- ---------------------------------------------------------------------------
-- 2. synthetic_entities — single source of truth (marker: SF-P1)
-- ---------------------------------------------------------------------------
-- Set-returning companion to is_synthetic_entity(text,uuid): every synthetic
-- (entity_type, entity_id) pair, one row each, so aggregate surfaces drive FROM
-- it instead of hand-rolling a per-table WHERE. Owner-rights view
-- (security_invoker stays OFF) so anon callers of the gated RPCs below read the
-- synthetic id set without direct grants on every backing table — the ids are
-- not sensitive. With 0 synthetic rows today every consumer is unchanged.
DROP VIEW IF EXISTS public.synthetic_entities;
CREATE VIEW public.synthetic_entities AS
            SELECT 'official'::text         AS entity_type, id AS entity_id FROM public.officials          WHERE is_synthetic
  UNION ALL SELECT 'proposal'::text,         id                            FROM public.proposals          WHERE is_synthetic
  UNION ALL SELECT 'financial_entity'::text, id                            FROM public.financial_entities WHERE is_synthetic
  UNION ALL SELECT 'agency'::text,           id                            FROM public.agencies           WHERE is_synthetic
  UNION ALL SELECT 'governing_body'::text,   id                            FROM public.governing_bodies   WHERE is_synthetic
  UNION ALL SELECT 'jurisdiction'::text,     id                            FROM public.jurisdictions      WHERE is_synthetic
  UNION ALL SELECT 'investigation'::text,    id                            FROM public.investigations     WHERE is_synthetic
  UNION ALL SELECT 'evidence_card'::text,    id                            FROM public.evidence_cards     WHERE is_synthetic;

GRANT SELECT ON public.synthetic_entities TO anon, authenticated, service_role;

COMMENT ON VIEW public.synthetic_entities IS
  'SF-P1/FIX-600: set-returning roster of every synthetic (entity_type, entity_id). Single source of truth for aggregate surfaces that anti-join synthetic content out of platform-wide totals. Owner-rights view; ids are not sensitive.';

-- ---------------------------------------------------------------------------
-- 3. Synthetic financial-record counters (driven FROM the tiny synthetic set)
-- ---------------------------------------------------------------------------
-- Exact count of financial_relationships of the given relationship_type(s) that
-- touch a synthetic endpoint on EITHER side. Driven from synthetic_entities via
-- the FR (from_type,from_id)/(to_type,to_id) indexes; UNION (not UNION ALL)
-- dedupes rows synthetic on both ends. ≈ms at 0 synthetic rows.
CREATE OR REPLACE FUNCTION public.count_synthetic_financial_records(p_rel_types text[])
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT count(*) FROM (
    SELECT fr.id
      FROM public.synthetic_entities se
      JOIN public.financial_relationships fr
        ON fr.from_type = se.entity_type AND fr.from_id = se.entity_id
     WHERE fr.relationship_type::text = ANY(p_rel_types)
    UNION
    SELECT fr.id
      FROM public.synthetic_entities se
      JOIN public.financial_relationships fr
        ON fr.to_type = se.entity_type AND fr.to_id = se.entity_id
     WHERE fr.relationship_type::text = ANY(p_rel_types)
  ) x;
$$;

GRANT EXECUTE ON FUNCTION public.count_synthetic_financial_records(text[])
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.count_synthetic_financial_records(text[]) IS
  'FIX-600: exact count of financial_relationships of the given type(s) touching a synthetic endpoint, driven from synthetic_entities (cheap). Used GROSS-minus-this to keep the homepage financial totals real. Returns 0 on current data.';

-- App-facing wrapper for the FIX-503 live-donor fallback in page.tsx: the
-- estimated (planner-reltuples) gross count there is unfilterable, so the app
-- subtracts this exact synthetic donor-record count rather than re-advertising
-- fakes. Behavior-neutral today (returns 0).
CREATE OR REPLACE FUNCTION public.count_synthetic_donor_records()
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.count_synthetic_financial_records(ARRAY['donation']);
$$;

GRANT EXECUTE ON FUNCTION public.count_synthetic_donor_records()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.count_synthetic_donor_records() IS
  'FIX-600: donation-only wrapper around count_synthetic_financial_records, subtracted from the FIX-503 estimated live-donor fallback so the hero never advertises synthetic donor records.';

-- ---------------------------------------------------------------------------
-- Part A.1 — homepage_stats_mv: exclude synthetic from the four hero totals
-- ---------------------------------------------------------------------------
-- Recreate (MVs have no CREATE OR REPLACE). officials/proposals add NOT
-- is_synthetic; donor/spending are GROSS − SYNTHETIC (see PERFORMANCE header).
DROP MATERIALIZED VIEW IF EXISTS public.homepage_stats_mv;

CREATE MATERIALIZED VIEW public.homepage_stats_mv AS
SELECT
  (SELECT COUNT(*) FROM public.officials
    WHERE is_active = true
      AND NOT is_synthetic                       -- FIX-600: real officials only
  )::BIGINT AS officials_count,

  (SELECT COUNT(*) FROM public.proposals
    WHERE status IN ('open_comment', 'introduced', 'in_committee', 'floor_vote')
      AND NOT is_synthetic                       -- FIX-600: real proposals only
  )::BIGINT AS active_proposals_count,

  -- FIX-600: gross donations minus donations touching a synthetic endpoint.
  (
    (SELECT COUNT(*) FROM public.financial_relationships
       WHERE relationship_type = 'donation')
    - public.count_synthetic_financial_records(ARRAY['donation'])
  )::BIGINT AS donor_records_count,

  -- FIX-600: gross contracts+grants minus those touching a synthetic endpoint.
  (
    (SELECT COUNT(*) FROM public.financial_relationships
       WHERE relationship_type IN ('contract', 'grant'))
    - public.count_synthetic_financial_records(ARRAY['contract', 'grant'])
  )::BIGINT AS spending_records_count,

  NOW() AS refreshed_at;

GRANT SELECT ON public.homepage_stats_mv
  TO anon, authenticated, service_role;

-- Refresh fn re-emitted for self-containment (REFRESH in a sql-language body
-- holds no hard dependency on the MV, so the DROP above is safe; re-creating
-- keeps the migration idempotent).
CREATE OR REPLACE FUNCTION public.refresh_homepage_stats_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW public.homepage_stats_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_homepage_stats_mv()
  TO authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.homepage_stats_mv IS
  'FIX-223 hero stats; FIX-600: synthetic entities excluded from all four platform-wide totals (officials/active proposals via NOT is_synthetic; donor/spending via gross-minus-synthetic). Behavior-neutral on current data.';

-- ---------------------------------------------------------------------------
-- Part A.2 — homepage_agency_counts_mv: exclude synthetic proposals + agencies
-- ---------------------------------------------------------------------------
-- COUNT(proposals) keyed per agency. Exclude synthetic proposals (a real
-- agency's count can't be inflated by a fake proposal) AND drop rows whose
-- agency itself is synthetic (a synthetic agency never appears in the
-- platform-wide agencies overview). The Franklin jurisdiction page reads its own
-- scoped query, not this MV, so its synthetic agencies still render there.
DROP MATERIALIZED VIEW IF EXISTS public.homepage_agency_counts_mv;

CREATE MATERIALIZED VIEW public.homepage_agency_counts_mv AS
SELECT
  p.metadata->>'agency_id' AS agency_id,
  COUNT(*)::BIGINT AS total,
  COUNT(*) FILTER (
    WHERE p.status = 'open_comment'
      AND (p.metadata->>'comment_period_end')::timestamptz > NOW()
  )::BIGINT AS open,
  NOW() AS refreshed_at
FROM public.proposals p
WHERE p.metadata->>'agency_id' IS NOT NULL
  AND NOT p.is_synthetic                          -- FIX-600: real proposals only
  -- FIX-600: also drop any row whose agency is synthetic. The join key is
  -- agencies.acronym, NOT agencies.id — proposals.metadata->>'agency_id' stores
  -- the regulations.gov agency CODE (e.g. 'ATF'), matched to agencies.acronym
  -- (same key agencies/page.tsx uses: `agency.acronym ?? agency.name`). In
  -- practice a synthetic agency's proposals are themselves synthetic, so the
  -- NOT is_synthetic above already removes them; this is defense-in-depth for a
  -- real proposal that references a synthetic agency's code.
  AND NOT EXISTS (
    SELECT 1 FROM public.agencies a
    WHERE a.acronym = p.metadata->>'agency_id'
      AND a.is_synthetic
  )
GROUP BY 1;

CREATE UNIQUE INDEX IF NOT EXISTS homepage_agency_counts_mv_pk
  ON public.homepage_agency_counts_mv (agency_id);

GRANT SELECT ON public.homepage_agency_counts_mv
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_homepage_agency_counts_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_agency_counts_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_homepage_agency_counts_mv()
  TO authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.homepage_agency_counts_mv IS
  'FIX-330 per-agency proposal counts; FIX-600: synthetic proposals + synthetic agencies excluded from the platform-wide agencies overview. Behavior-neutral on current data.';

-- ---------------------------------------------------------------------------
-- Part A.3 — get_proposal_counts_by_agency: gate the MV's fallback RPC too
-- ---------------------------------------------------------------------------
-- /agencies + homepage fall back to this RPC when the MV is empty (fresh DB /
-- post-truncate). Without the same exclusion the fallback would reintroduce
-- inflated counts. CREATE OR REPLACE re-asserts the FIX-303 statement_timeout
-- (set by 20260520000001) — it would otherwise reset to the role default.
CREATE OR REPLACE FUNCTION public.get_proposal_counts_by_agency()
RETURNS TABLE(agency_id TEXT, total BIGINT, open BIGINT)
LANGUAGE sql
STABLE
SET statement_timeout = '60s'
AS $$
  SELECT
    p.metadata->>'agency_id' AS agency_id,
    COUNT(*)::BIGINT AS total,
    COUNT(*) FILTER (
      WHERE p.status = 'open_comment'
        AND (p.metadata->>'comment_period_end')::timestamptz > NOW()
    )::BIGINT AS open
  FROM public.proposals p
  WHERE p.metadata->>'agency_id' IS NOT NULL
    AND NOT p.is_synthetic                        -- FIX-600: parity with the MV
    AND NOT EXISTS (                              -- acronym join key (see MV above)
      SELECT 1 FROM public.agencies a
      WHERE a.acronym = p.metadata->>'agency_id'
        AND a.is_synthetic
    )
  GROUP BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_proposal_counts_by_agency()
  TO authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- Part B — get_topic_proposal_page: carry is_synthetic into the projection
-- ---------------------------------------------------------------------------
-- toCardShape() in proposals/page.tsx already reads r.is_synthetic (defaulting
-- to false); the RPC just never supplied it, so topic-filtered cards stayed
-- unmarked. RETURN-SIGNATURE change ⇒ DROP + CREATE (this Postgres rejects an
-- OUT-column change via CREATE OR REPLACE). Body otherwise identical to
-- 20260607010000 (FIX-514); is_synthetic appended before total_count.
DROP FUNCTION IF EXISTS public.get_topic_proposal_page(text[], text, text, text, text, text, int, int);

CREATE FUNCTION public.get_topic_proposal_page(
  p_tags   text[],
  p_status text,
  p_type   text,
  p_agency text,
  p_q      text,
  p_sort   text,
  p_offset int,
  p_limit  int
)
RETURNS TABLE (
  id            uuid,
  title         text,
  type          text,
  status        text,
  summary_plain text,
  summary_model text,
  introduced_at date,
  metadata      jsonb,
  is_synthetic  boolean,
  total_count   bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.title,
    p.type::text,
    p.status::text,
    p.summary_plain,
    p.summary_model,
    p.introduced_at,
    p.metadata,
    p.is_synthetic,                               -- FIX-600 / SF-P2: light up the mark
    count(*) OVER() AS total_count
  FROM proposals p
  WHERE
    (
      (p_status <> 'open' AND p_status <> 'closed')
      OR (
        p_status = 'open'
        AND p.status = 'open_comment'
        AND p.metadata->>'comment_period_end'
              > to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      OR (
        p_status = 'closed'
        AND (
          p.status = 'comment_closed'
          OR (
            p.status = 'open_comment'
            AND p.metadata->>'comment_period_end'
                  < to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        )
      )
    )
    AND (p_type IS NULL OR p_type = '' OR p.type::text = p_type)
    AND (p_agency IS NULL OR p_agency = '' OR p.metadata->>'agency_id' = p_agency)
    AND (p_q IS NULL OR p_q = '' OR p.title ILIKE '%' || p_q || '%')
    AND (
      p_tags IS NULL
      OR cardinality(p_tags) = 0
      OR EXISTS (
        SELECT 1 FROM entity_tags et
        WHERE et.entity_type = 'proposal'
          AND et.entity_id = p.id
          AND et.tag = ANY(p_tags)
      )
    )
  ORDER BY
    CASE WHEN p_sort = 'newest' THEN p.introduced_at END DESC NULLS LAST,
    CASE WHEN p_sort = 'title'  THEN p.title END ASC NULLS LAST,
    CASE WHEN p_sort NOT IN ('newest', 'title')
         THEN p.metadata->>'comment_period_end' END ASC NULLS LAST
  OFFSET GREATEST(p_offset, 0)
  LIMIT  LEAST(GREATEST(p_limit, 1), 100)
$$;

ALTER FUNCTION public.get_topic_proposal_page(text[], text, text, text, text, text, int, int) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.get_topic_proposal_page(text[], text, text, text, text, text, int, int) TO anon, authenticated, service_role;
