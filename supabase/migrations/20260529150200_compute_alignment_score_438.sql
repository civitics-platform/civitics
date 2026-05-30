-- =============================================================================
-- FIX-438 — compute_alignment_score: votes.proposal_id → votes.bill_proposal_id
--
-- Part of the repo-wide votes.proposal_id → bill_proposal_id rename completeness
-- sweep (sibling of FIX-426/427). Post-cutover public.votes has NO `proposal_id`
-- column — the real FK is `bill_proposal_id` (→ bill_details(proposal_id), whose
-- value equals proposals.id). The original function joined
--   JOIN votes v ON v.proposal_id = cc.proposal_id
-- which referenced a non-existent column. As a SECURITY DEFINER plpgsql function
-- the missing-column error surfaced at call time (not a silent zero like the
-- swallowed PostgREST selects), so the USER-node alignment tooltip (FIX-042)
-- raised instead of populating. Fix: join on v.bill_proposal_id; the value is a
-- proposals.id so cc.proposal_id = v.bill_proposal_id is the correct equality and
-- the proposals join for titles is unchanged.
--
-- Discipline mirrors 20260529130000_official_tag_rollups_426_427.sql: explicit
-- SET search_path on the function and a per-function statement_timeout via
-- ALTER FUNCTION. Only the join column changes — ratio/count/detail semantics,
-- substantive-vote filter, and the 10-row vote_details cap are identical.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.compute_alignment_score(
  p_user_id     UUID,
  p_official_id UUID
) RETURNS TABLE (
  alignment_ratio  NUMERIC,   -- 0.0–1.0; 0 if no overlap
  matched_votes    INT,
  total_votes      INT,
  vote_details     JSONB      -- [{proposal_id, title, user_pos, official_vote, aligned}] up to 10 rows
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH overlap AS (
    SELECT
      cc.proposal_id,
      COALESCE(p.short_title, p.title) AS proposal_title,
      cc.position                       AS user_pos,
      v.vote                            AS official_vote,
      CASE
        WHEN cc.position = 'support' AND v.vote = 'yes' THEN true
        WHEN cc.position = 'oppose'  AND v.vote = 'no'  THEN true
        ELSE false
      END                               AS aligned
    FROM civic_comments cc
    JOIN votes     v ON v.bill_proposal_id = cc.proposal_id
                     AND v.official_id = p_official_id
    JOIN proposals p ON p.id = cc.proposal_id
    WHERE cc.user_id      = p_user_id
      AND p.vote_category = 'substantive'
  )
  SELECT
    ROUND(COALESCE(AVG(aligned::int), 0)::numeric, 2),
    COALESCE(SUM(aligned::int), 0)::int,
    COUNT(*)::int,
    COALESCE(
      (SELECT jsonb_agg(row_data ORDER BY (row_data->>'aligned')::boolean DESC)
       FROM (
         SELECT jsonb_build_object(
           'proposal_id',   proposal_id,
           'title',         proposal_title,
           'user_pos',      user_pos,
           'official_vote', official_vote,
           'aligned',       aligned
         ) AS row_data
         FROM overlap
         LIMIT 10
       ) sub),
      '[]'::jsonb
    )
  FROM overlap;
END;
$$;

ALTER FUNCTION public.compute_alignment_score(UUID, UUID) SET statement_timeout = '3s';
GRANT EXECUTE ON FUNCTION public.compute_alignment_score(UUID, UUID) TO authenticated;
