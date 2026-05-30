-- FIX-H: get_institution_recent_votes
--
-- Powers the "Recent Votes" section on /institutions/[id] for governing-body
-- types (legislatures). Returns one row per roll call (grouped by roll_call_id)
-- with SQL-side yes/no/abstain/not_voting tallies plus computed party-line and
-- unanimous indicators.
--
-- Schema reality (verified against live DB, not 0001_initial_schema.sql):
--   * votes has NO governing_body_id and NO proposal_id. It carries
--     bill_proposal_id + official_id + roll_call_id + vote_question (a real
--     column, not metadata->>'vote_question').
--   * An institution's votes are reached via the voting members:
--     officials.governing_body_id = p_institution_id. roll_call_id is fully
--     populated and is the natural per-event grouping key.
--   * officials.party is a lowercase enum ('democrat','republican',
--     'independent','libertarian','green','other','nonpartisan'), NOT
--     'Democratic'/'Republican'.
--   * Live vote values are yes/no/not_voting/present ('abstain' is in the
--     CHECK enum but unused today; lumped with 'present' for forward-compat).
--   * bill_number lives in bill_details(proposal_id) — metadata->>'legis_num'
--     is unpopulated.

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
  WITH vote_groups AS (
    SELECT
      v.roll_call_id,
      v.bill_proposal_id,
      v.voted_at,
      v.vote_question,
      COUNT(*) FILTER (WHERE v.vote = 'yes')                  AS yes_count,
      COUNT(*) FILTER (WHERE v.vote = 'no')                   AS no_count,
      COUNT(*) FILTER (WHERE v.vote IN ('abstain','present')) AS abstain_count,
      COUNT(*) FILTER (WHERE v.vote = 'not_voting')           AS not_voting_count,
      -- Party-line: >=90% of each major party's yes/no votes on opposite sides.
      -- Denominator is that party's yes+no votes (non-voters don't dilute).
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
      -- Unanimous: no abstain/present/not_voting and a single side cast.
      (
        COUNT(*) FILTER (WHERE v.vote IN ('abstain','present','not_voting')) = 0
        AND (
          COUNT(*) FILTER (WHERE v.vote = 'no')  = 0 OR
          COUNT(*) FILTER (WHERE v.vote = 'yes') = 0
        )
      ) AS unanimous
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
    WHERE o.governing_body_id = p_institution_id
    GROUP BY v.roll_call_id, v.bill_proposal_id, v.voted_at, v.vote_question
    ORDER BY v.voted_at DESC NULLS LAST
    LIMIT p_limit
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
