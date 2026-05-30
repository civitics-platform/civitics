-- FIX-439 (follow-up): get_institution_recent_votes v2 — perf + scope correction.
--
-- The v1 body (20260529140000) scoped votes via officials.governing_body_id and
-- aggregated ALL of the chamber's votes before limiting. On prod that timed out
-- (3s) because the data has ~1952 officials mis-linked to the US Senate
-- governing_body (some of whom actually cast House votes), inflating the scan AND
-- polluting the scope — deriving a chamber from officials.governing_body_id even
-- returned "House" for the Senate.
--
-- v2 fixes both:
--   * SCOPE by votes.chamber (the intrinsic, origin-independent partition: a roll
--     call belongs to exactly one chamber regardless of which chamber owns the
--     bill). This is complete — it includes a chamber's votes on bills that
--     originated in the OTHER chamber — and immune to the officials mis-linking.
--   * Map institution → chamber from governing_bodies.type (legislature_upper →
--     'Senate', legislature_lower → 'House'). Only US Congress has roll-call vote
--     data today; every other body type maps to NULL and returns no rows (correct
--     — they have no votes). When state legislatures gain vote data with different
--     chamber labels, extend this CASE (or add a chamber column to
--     governing_bodies). votes.chamber is 'House'/'Senate', no nulls, both local
--     and prod.
--   * Two-step: find the p_limit most recent roll calls within a 180-day window
--     (votes_voted_at DESC index keeps the scan small — both chambers have >80
--     roll calls in 180 days), THEN aggregate only those ~p_limit roll calls'
--     rows via votes_roll_call. Measured on prod: ~75ms warm, ~730ms cold (was a
--     3.4s timeout for the House on v1).
--
-- party_line uses officials.party (reliable — only governing_body_id is polluted)
-- with the lowercase enum ('democrat'/'republican'). Unchanged from v1.

CREATE OR REPLACE FUNCTION public.get_institution_recent_votes(
  p_institution_id UUID,
  p_limit INT DEFAULT 10
) RETURNS TABLE(
  proposal_id      UUID,
  proposal_title   TEXT,
  bill_number      TEXT,
  vote_question    TEXT,
  voted_at         TIMESTAMPTZ,
  yes_count        INT,
  no_count         INT,
  abstain_count    INT,
  not_voting_count INT,
  party_line       BOOLEAN,
  unanimous        BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH params AS (
    SELECT CASE gb.type
             WHEN 'legislature_upper' THEN 'Senate'
             WHEN 'legislature_lower' THEN 'House'
             ELSE NULL
           END AS chamber
    FROM public.governing_bodies gb
    WHERE gb.id = p_institution_id
  ),
  recent_calls AS (
    SELECT v.roll_call_id
    FROM public.votes v
    WHERE v.chamber = (SELECT chamber FROM params)
      AND v.voted_at > now() - interval '180 days'
    GROUP BY v.roll_call_id
    ORDER BY MAX(v.voted_at) DESC
    LIMIT p_limit
  ),
  vote_groups AS (
    SELECT
      v.roll_call_id,
      v.bill_proposal_id,
      v.voted_at,
      v.vote_question,
      COUNT(*) FILTER (WHERE v.vote = 'yes')                  AS yes_count,
      COUNT(*) FILTER (WHERE v.vote = 'no')                   AS no_count,
      COUNT(*) FILTER (WHERE v.vote IN ('abstain','present')) AS abstain_count,
      COUNT(*) FILTER (WHERE v.vote = 'not_voting')           AS not_voting_count,
      (
        COUNT(*) FILTER (WHERE o.party = 'democrat'   AND v.vote = 'yes')::float /
          NULLIF(COUNT(*) FILTER (WHERE o.party = 'democrat'   AND v.vote IN ('yes','no')), 0) >= 0.9
        AND COUNT(*) FILTER (WHERE o.party = 'republican' AND v.vote = 'no')::float /
          NULLIF(COUNT(*) FILTER (WHERE o.party = 'republican' AND v.vote IN ('yes','no')), 0) >= 0.9
      ) OR (
        COUNT(*) FILTER (WHERE o.party = 'democrat'   AND v.vote = 'no')::float /
          NULLIF(COUNT(*) FILTER (WHERE o.party = 'democrat'   AND v.vote IN ('yes','no')), 0) >= 0.9
        AND COUNT(*) FILTER (WHERE o.party = 'republican' AND v.vote = 'yes')::float /
          NULLIF(COUNT(*) FILTER (WHERE o.party = 'republican' AND v.vote IN ('yes','no')), 0) >= 0.9
      ) AS party_line,
      (
        COUNT(*) FILTER (WHERE v.vote IN ('abstain','present','not_voting')) = 0
        AND (
          COUNT(*) FILTER (WHERE v.vote = 'no')  = 0 OR
          COUNT(*) FILTER (WHERE v.vote = 'yes') = 0
        )
      ) AS unanimous
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
    WHERE v.roll_call_id IN (SELECT roll_call_id FROM recent_calls)
    GROUP BY v.roll_call_id, v.bill_proposal_id, v.voted_at, v.vote_question
  )
  SELECT
    vg.bill_proposal_id        AS proposal_id,
    p.title                    AS proposal_title,
    bd.bill_number,
    vg.vote_question,
    vg.voted_at,
    vg.yes_count::int,
    vg.no_count::int,
    vg.abstain_count::int,
    vg.not_voting_count::int,
    COALESCE(vg.party_line, false) AS party_line,
    vg.unanimous
  FROM vote_groups vg
  LEFT JOIN public.proposals    p  ON p.id = vg.bill_proposal_id
  LEFT JOIN public.bill_details bd ON bd.proposal_id = vg.bill_proposal_id
  ORDER BY vg.voted_at DESC NULLS LAST;
$$;

ALTER FUNCTION public.get_institution_recent_votes(UUID, INT) SET statement_timeout = '3s';
GRANT EXECUTE ON FUNCTION public.get_institution_recent_votes(UUID, INT) TO authenticated, anon;
