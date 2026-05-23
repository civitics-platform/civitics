-- 20260523020000_get_quality_counts.sql
-- FIX-333 — single-RPC replacement for getQuality's 8-round-trip fan-out
-- (apps/civitics/app/api/claude/status/_lib/sections.ts:308). Per FIX-328
-- instrumentation the quality section was the second-longest at ~9.2 s.
--
-- Same split shape as FIX-298 (get_connection_type_counts) and FIX-303
-- (get_proposal_counts_by_agency): one SQL function returning a single
-- wide row, sibling migration sets the function-level statement_timeout.
--
-- The vote_category counts collapse 5 sequential count:'exact' queries
-- into one GROUP BY scan backed by idx_proposals_vote_category (FIX-019).
-- The PAC sampling bias (2000-row LIMIT cap) is eliminated — the new RPC
-- computes tagged_pacs over ALL PACs via EXISTS subquery, which is free
-- to do correctly SQL-side.

CREATE OR REPLACE FUNCTION public.get_quality_counts()
RETURNS TABLE (
  vote_category_counts  JSONB,
  total_pacs            BIGINT,
  tagged_pacs           BIGINT,
  vote_connection_total BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (SELECT COALESCE(
       jsonb_object_agg(vote_category, c),
       '{}'::jsonb
     )
     FROM (
       SELECT vote_category, COUNT(*)::BIGINT AS c
       FROM public.proposals
       WHERE vote_category IS NOT NULL
       GROUP BY vote_category
     ) sub) AS vote_category_counts,

    (SELECT COUNT(*)::BIGINT
     FROM public.financial_entities
     WHERE entity_type = 'pac') AS total_pacs,

    (SELECT COUNT(*)::BIGINT
     FROM public.financial_entities fe
     WHERE fe.entity_type = 'pac'
       AND EXISTS (
         SELECT 1 FROM public.entity_tags et
         WHERE et.entity_type = 'financial_entity'
           AND et.entity_id = fe.id
           AND et.tag_category = 'industry'
       )) AS tagged_pacs,

    (SELECT COUNT(*)::BIGINT
     FROM public.entity_connections
     WHERE connection_type IN (
       'vote_yes', 'vote_no', 'vote_abstain',
       'nomination_vote_yes', 'nomination_vote_no'
     )) AS vote_connection_total;
$$;

GRANT EXECUTE ON FUNCTION public.get_quality_counts()
  TO authenticated, service_role;
