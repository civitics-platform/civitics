-- FIX-510 — server-side pairwise vote-agreement matrix.
--
-- The /api/graph/matrix route previously fetched every vote row for the
-- selected officials (votes.official_id = ANY(ids)) and built the pairwise
-- agreement matrix in JS. For 25 high-volume officials that is ~59k+ rows, but
-- PostgREST silently caps an unpaged SELECT at 1,000 — so the matrix was
-- computed from ~2% of the data with no error. This RPC does the pairwise
-- aggregation server-side and returns at most one row per unordered pair, well
-- under the cap.
--
-- Join key is roll_call_id (text, NOT NULL, 100% populated, UNIQUE per
-- (roll_call_id, official_id)) rather than bill_proposal_id. The old JS keyed
-- its lookup map on bill_proposal_id with last-write-wins, silently collapsing
-- the multiple roll calls that can share one bill (4,267 roll calls vs ~2,139
-- bills locally). Keying on roll_call_id counts every shared decision — an
-- intentional behavior change (more shared decisions counted).
--
-- Vote bucketing mirrors the route's bucket() helper exactly:
--   yes / paired_yes  -> yes  (true)
--   no  / paired_no   -> no   (false)
--   abstain / present / not_voting -> dropped (null, not a yes/no signal)
-- Note the enum value is 'not_voting' (underscore), per the votes CHECK
-- constraint.
--
-- Returns self-pairs too (predicate a <= b, not strictly a < b): a self-pair
-- (official_a = official_b) carries that official's own bucketed-vote count,
-- which the route uses for the matrix diagonal cell. This is a deliberate,
-- minimal superset of the "one row per unordered pair" shape — it still emits
-- no (a,b)+(b,a) duplicates and for 25 officials is <=325 rows, far under the
-- 1,000-row PostgREST cap.
--
-- SECURITY INVOKER: votes has an RLS SELECT policy granting anon/authenticated
-- USING (true), so the function is safe to expose to the publishable key.

CREATE OR REPLACE FUNCTION public.get_vote_agreement_matrix(p_official_ids uuid[])
RETURNS TABLE (
  official_a uuid,
  official_b uuid,
  shared     bigint,
  agreed     bigint,
  yes_a      bigint,
  yes_b      bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bucketed AS (
    SELECT
      v.official_id,
      v.roll_call_id,
      CASE
        WHEN v.vote IN ('yes', 'paired_yes') THEN true
        WHEN v.vote IN ('no',  'paired_no')  THEN false
        ELSE NULL
      END AS is_yes
    FROM public.votes v
    WHERE v.official_id = ANY(p_official_ids)
  ),
  filtered AS (
    SELECT official_id, roll_call_id, is_yes
    FROM bucketed
    WHERE is_yes IS NOT NULL
  )
  SELECT
    a.official_id                                  AS official_a,
    b.official_id                                  AS official_b,
    count(*)                                       AS shared,
    count(*) FILTER (WHERE a.is_yes = b.is_yes)    AS agreed,
    count(*) FILTER (WHERE a.is_yes)               AS yes_a,
    count(*) FILTER (WHERE b.is_yes)               AS yes_b
  FROM filtered a
  JOIN filtered b
    ON a.roll_call_id = b.roll_call_id
   AND a.official_id <= b.official_id
  GROUP BY a.official_id, b.official_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_vote_agreement_matrix(uuid[])
  TO anon, authenticated, service_role;
