-- =============================================================================
-- FIX-437 — Financial-entity rule-tagger rollup RPCs
--
-- The rule-based tagger (packages/data/src/pipelines/tags/rules.ts) had two
-- functions still loading from PostgREST without pagination, silently truncating
-- at the 1,000-row cap (supabase/config.toml max_rows) — the last two unbounded
-- silent-zeros after FIX-426/427 (tagOfficials) and FIX-436 (tagProposals):
--
--   • tagFinancialEntities — two unbounded selects:
--       - financial_relationships WHERE from_type='financial_entity' (~1.9M rows)
--         feeds donation-size tags (SUM(amount_cents) per from_id) and NAICS
--         industry tags (metadata.naics_code on contract/grant rows).
--       - financial_entities (~1.15M rows) feeds display_name keyword industry
--         tags.
--     Truncated at 1,000, size + industry tags were computed from ~0.07% of the
--     data (baseline: 477 size, 308 industry rows).
--   • tagPreVoteConnections — three unbounded selects (financial_relationships
--     ~1.37M, votes ~592k, proposals) feeding a Node cross-join that attempted
--     ONE upsert per qualifying donation×vote pair (~65M) — all collapsing to a
--     single internal-visibility 'pre_vote_timing' tag per distinct financial
--     entity (~371k). Truncated, it wrote 1 tag.
--
-- Fix: push the heavy aggregations into SQL. Two SECURITY DEFINER RPCs, each
-- returning its whole result set as a SINGLE jsonb array (one row). A
-- RETURNS TABLE / SETOF shape would itself be capped at 1,000 rows by PostgREST,
-- and paginating it with .range() would re-execute the multi-million-row
-- aggregation once per page. One jsonb row → the aggregation runs exactly once
-- and nothing is truncated. statement_timeout is raised per-function via
-- ALTER FUNCTION because these scans exceed the service_role role's short
-- default request budget on Pro. Mirrors 20260529130000_official_tag_rollups_426_427.sql.
--
-- Tag thresholds, vocabulary, and visibility are unchanged — only the underlying
-- data is corrected. (The Node side additionally scopes the display_name keyword
-- matcher to non-individual entities, since keyword-matching 1.05M individual
-- donors by surname produced false positives — see rules.ts. That scoping is
-- Node-side; this migration is purely the data rollups.)
-- =============================================================================

-- ── 1. Financial-entity donation totals + first NAICS ────────────────────────
--   One element per financial_entity that has ≥1 donation OR ≥1 contract/grant
--   carrying a NAICS code. total_cents is the donation outflow sum (NULL when the
--   entity has no donation rows — so the caller skips the size tag); naics_code
--   is one NAICS from this entity's contract/grant rows (NULL when none). The
--   original Node code used the "first NAICS found" in arbitrary row order; MIN()
--   is an equally-arbitrary but deterministic pick. donation/contract subsets are
--   FULL-OUTER-JOINed so an entity with only contract NAICS (no donations) still
--   surfaces for its industry tag, and a pure donor still surfaces for its size
--   tag.
DROP FUNCTION IF EXISTS public.get_financial_entity_donation_totals();
CREATE OR REPLACE FUNCTION public.get_financial_entity_donation_totals()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH don AS (
    SELECT fr.from_id AS entity_id,
           SUM(COALESCE(fr.amount_cents, 0))::BIGINT AS total_cents
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type = 'donation'
    GROUP BY fr.from_id
  ),
  naics AS (
    SELECT fr.from_id AS entity_id,
           MIN(fr.metadata->>'naics_code') AS naics_code
    FROM public.financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.relationship_type IN ('contract', 'grant')
      AND fr.metadata->>'naics_code' IS NOT NULL
    GROUP BY fr.from_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'entity_id',   COALESCE(d.entity_id, n.entity_id),
           'total_cents', d.total_cents,
           'naics_code',  n.naics_code
         )), '[]'::jsonb)
  FROM don d
  FULL OUTER JOIN naics n ON n.entity_id = d.entity_id;
$$;

ALTER FUNCTION public.get_financial_entity_donation_totals() SET statement_timeout = '300s';
GRANT EXECUTE ON FUNCTION public.get_financial_entity_donation_totals() TO service_role;

-- Composite index so the EXISTS probe below is an index range scan per official
-- rather than a full per-official vote scan. Without it the correlated subquery
-- runs ~290s and times out at the PostgREST gateway (the function's own
-- statement_timeout is irrelevant — the proxy gives up first). With it the whole
-- RPC is ~4s. votes already has separate (official_id) and (voted_at DESC)
-- indexes but no composite; the planner needs both columns together here.
CREATE INDEX IF NOT EXISTS votes_official_voted_at
  ON public.votes (official_id, voted_at);

-- ── 2. Pre-vote timing entities ──────────────────────────────────────────────
--   Distinct financial_entity ids (donation.from_id) having ≥1 donation in
--   (0, 90] days BEFORE any vote cast by the recipient official. Reproduces the
--   Node window exactly: the old code kept a pair when
--   daysBefore = floor((voted_at - occurred_at)/1 day) was in [1, 90]. That is
--   algebraically identical to voted_at ∈ [occurred_at + 1 day, occurred_at + 91
--   days), which is the SARGABLE form used here so the votes_official_voted_at
--   index applies (the floor/extract(epoch) form is not index-usable and scans
--   every vote per donation → ~290s). occurred_at is a DATE anchored at UTC
--   midnight (AT TIME ZONE 'UTC') to match JS `new Date('YYYY-MM-DD')`. EXISTS
--   (not a join+DISTINCT) avoids the ~65M-row donation×vote fan-out — each
--   donation short-circuits on its first qualifying vote. Verified: both the old
--   floor form and this range form return exactly 371,111 entities on local.
DROP FUNCTION IF EXISTS public.get_pre_vote_timing_entities();
CREATE OR REPLACE FUNCTION public.get_pre_vote_timing_entities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(entity_id), '[]'::jsonb)
  FROM (
    SELECT DISTINCT fr.from_id AS entity_id
    FROM public.financial_relationships fr
    WHERE fr.to_type = 'official'
      AND fr.relationship_type = 'donation'
      AND fr.occurred_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.votes v
        WHERE v.official_id = fr.to_id
          AND v.voted_at >= (fr.occurred_at::timestamp AT TIME ZONE 'UTC') + interval '1 day'
          AND v.voted_at <  (fr.occurred_at::timestamp AT TIME ZONE 'UTC') + interval '91 days'
      )
  ) q;
$$;

ALTER FUNCTION public.get_pre_vote_timing_entities() SET statement_timeout = '300s';
GRANT EXECUTE ON FUNCTION public.get_pre_vote_timing_entities() TO service_role;

-- ── 3. Authoritative-clear helper for the financial_entity rule tags ─────────
--   tagFinancialEntities (~928k tags) and tagPreVoteConnections (~371k tags) now
--   write enough rows that the authoritative-rebuild DELETE preceding the upsert
--   exceeds the 8s statement_timeout pinned on the authenticator/authenticated
--   roles (service_role inherits it — verified via pg_roles.rolconfig). The
--   officials/proposals DELETEs in FIX-426/427/436 stayed under 8s only because
--   those tables hold ~2k–5k rule tags. A clean DELETE here is ~2s, but under
--   nightly contention it spikes past 8s (this is exactly how the first
--   re-run failed: "canceling statement due to statement timeout"). Wrapping the
--   DELETE in a SECURITY DEFINER function with a raised statement_timeout removes
--   the ceiling — same discipline the rollup RPCs above use for their long scans.
--   Parameterized by category array so both call sites share one function.
DROP FUNCTION IF EXISTS public.clear_financial_entity_rule_tags(text[]);
CREATE OR REPLACE FUNCTION public.clear_financial_entity_rule_tags(p_categories text[])
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM public.entity_tags
  WHERE entity_type = 'financial_entity'
    AND generated_by = 'rule'
    AND tag_category = ANY(p_categories);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER FUNCTION public.clear_financial_entity_rule_tags(text[]) SET statement_timeout = '120s';
GRANT EXECUTE ON FUNCTION public.clear_financial_entity_rule_tags(text[]) TO service_role;
