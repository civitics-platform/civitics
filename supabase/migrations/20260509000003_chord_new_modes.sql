-- =============================================================================
-- New chord-diagram RPCs — four data modes for the chord visualization:
--
--   1. chord_sector_vote_for_officials   — donor sectors × vote outcomes
--                                          for one or more focused officials
--   2. chord_subject_party_flows         — bill topics × party chamber by
--                                          affirmative-vote count (global or
--                                          scoped to a cohort of officials)
--   3. chord_donor_type_party_flows      — donor entity_type × party chamber
--                                          (individual / pac / super_pac /
--                                          corporation / union / etc.)
--   4. chord_donor_state_party_flows     — donor home state × recipient party
--                                          chamber, optionally scoped to one
--                                          focused official
--
-- All four follow the post-cutover polymorphic shape used by the existing
-- restored RPCs in 20260422000008_restore_chord_treemap_rpcs.sql:
--   financial_relationships.from_type='financial_entity', from_id=fe.id
--   financial_relationships.to_type='official',           to_id=officials.id
--   financial_relationships.relationship_type='donation'
--   financial_entities.display_name (was: name)
--   votes.bill_proposal_id (FK to bill_details.proposal_id, == proposals.id)
--   entity_tags.tag_category='topic' for proposal subjects (FIX-137 onwards)
--
-- Federal scoping: same as chord_industry_flows() — restricted to officials
-- with o.source_ids->>'congress_gov' set, which excludes cabinet/judiciary
-- and keeps party_chamber derivation meaningful.
-- =============================================================================

-- ── 1. chord_sector_vote_for_officials(uuid[], numeric) ──────────────────────
-- For each focused official, attribute their donor-industry dollars to vote
-- outcomes proportionally to that official's voting record. Industry is
-- derived from entity_tags (tag_category='industry'), matching the existing
-- chord_industry_flows() approach — financial_relationships.metadata->>'sector'
-- is unpopulated post-cutover so we read tags off the donor entity instead.
--
-- Cell value (sector, vote_outcome) is the sum across officials of:
--   sector_donations_to_official × (votes_with_that_outcome / total_votes)
--
-- Reads: "How much industry X money lined up with outcome Y?"
CREATE OR REPLACE FUNCTION public.chord_sector_vote_for_officials(
  p_official_ids UUID[],
  p_min_usd      NUMERIC DEFAULT 0
)
RETURNS TABLE(
  sector        TEXT,
  display_label TEXT,
  display_icon  TEXT,
  vote_outcome  TEXT,
  total_usd     NUMERIC,
  vote_count    BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH official_vote_breakdown AS (
    SELECT
      v.official_id,
      CASE
        WHEN v.vote IN ('yes', 'paired_yes') THEN 'yes'
        WHEN v.vote IN ('no',  'paired_no')  THEN 'no'
        ELSE 'other'
      END                                AS vote_outcome,
      COUNT(*)::NUMERIC                  AS outcome_count
    FROM public.votes v
    WHERE v.official_id = ANY(p_official_ids)
    GROUP BY v.official_id,
             CASE
               WHEN v.vote IN ('yes', 'paired_yes') THEN 'yes'
               WHEN v.vote IN ('no',  'paired_no')  THEN 'no'
               ELSE 'other'
             END
  ),
  official_total_votes AS (
    SELECT official_id, SUM(outcome_count) AS total_votes
    FROM official_vote_breakdown
    GROUP BY official_id
  ),
  official_sector_dollars AS (
    SELECT
      fr.to_id                                AS official_id,
      COALESCE(et.tag, 'untagged')            AS sector,
      MIN(COALESCE(et.display_label, 'Untagged')) AS display_label,
      MIN(COALESCE(et.display_icon,  ''))         AS display_icon,
      SUM(fr.amount_cents) / 100.0            AS sector_usd
    FROM public.financial_relationships fr
    JOIN public.financial_entities fe
      ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
    LEFT JOIN public.entity_tags et
      ON et.entity_id    = fe.id
     AND et.entity_type  = 'financial_entity'
     AND et.tag_category = 'industry'
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type           = 'official'
      AND fr.to_id             = ANY(p_official_ids)
      AND fr.amount_cents > 0
    GROUP BY fr.to_id, COALESCE(et.tag, 'untagged')
  )
  SELECT
    s.sector,
    MIN(s.display_label) AS display_label,
    MIN(s.display_icon)  AS display_icon,
    b.vote_outcome,
    SUM(s.sector_usd * b.outcome_count / NULLIF(t.total_votes, 0))::NUMERIC AS total_usd,
    SUM(b.outcome_count)::BIGINT AS vote_count
  FROM official_sector_dollars s
  JOIN official_vote_breakdown  b ON b.official_id = s.official_id
  JOIN official_total_votes     t ON t.official_id = s.official_id
  WHERE s.sector != 'untagged'
  GROUP BY s.sector, b.vote_outcome
  HAVING SUM(s.sector_usd * b.outcome_count / NULLIF(t.total_votes, 0)) >= p_min_usd
  ORDER BY total_usd DESC NULLS LAST
  LIMIT 36;
$$;

GRANT EXECUTE ON FUNCTION public.chord_sector_vote_for_officials(UUID[], NUMERIC)
  TO anon, authenticated, service_role;


-- ── 1b. chord_industry_flows_for_official(uuid) ──────────────────────────────
-- Per-official version of chord_industry_flows(). Replaces the legacy
-- inline query in /api/graph/chord/route.ts that read the dropped
-- financial_entities.industry_category column (silent empty result).
-- Returns industry totals for one focused official, ordered DESC.
CREATE OR REPLACE FUNCTION public.chord_industry_flows_for_official(
  p_official_id UUID
)
RETURNS TABLE(
  industry      TEXT,
  display_label TEXT,
  display_icon  TEXT,
  total_cents   BIGINT,
  donor_count   BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    COALESCE(et.tag,           'untagged') AS industry,
    COALESCE(et.display_label, 'Untagged') AS display_label,
    COALESCE(et.display_icon,  '')         AS display_icon,
    SUM(fr.amount_cents)::BIGINT           AS total_cents,
    COUNT(DISTINCT fe.id)::BIGINT          AS donor_count
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
  LEFT JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type           = 'official'
    AND fr.to_id             = p_official_id
    AND fr.amount_cents > 0
  GROUP BY
    COALESCE(et.tag, 'untagged'),
    COALESCE(et.display_label, 'Untagged'),
    COALESCE(et.display_icon, '')
  ORDER BY total_cents DESC;
$$;

GRANT EXECUTE ON FUNCTION public.chord_industry_flows_for_official(UUID)
  TO anon, authenticated, service_role;


-- ── 1c. chord_top_pacs_for_official(uuid, integer) ───────────────────────────
-- Returns the top-N PAC donors for a focused official, with each PAC's
-- industry tag attached. Used by the chord granularity='top-pacs' mode so
-- each PAC becomes its own arc (colored by its industry). Aggregates
-- entity_type IN ('pac','super_pac','party_committee','union','corporation')
-- — i.e. organizational donors, not individuals.
CREATE OR REPLACE FUNCTION public.chord_top_pacs_for_official(
  p_official_id UUID,
  p_limit       INTEGER DEFAULT 20
)
RETURNS TABLE(
  pac_id        UUID,
  pac_name      TEXT,
  industry      TEXT,
  display_label TEXT,
  display_icon  TEXT,
  total_cents   BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    fe.id                                  AS pac_id,
    fe.display_name                        AS pac_name,
    COALESCE(et.tag,           'untagged') AS industry,
    COALESCE(et.display_label, 'Untagged') AS display_label,
    COALESCE(et.display_icon,  '')         AS display_icon,
    SUM(fr.amount_cents)::BIGINT           AS total_cents
  FROM public.financial_relationships fr
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
  LEFT JOIN public.entity_tags et
    ON et.entity_id    = fe.id
   AND et.entity_type  = 'financial_entity'
   AND et.tag_category = 'industry'
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type           = 'official'
    AND fr.to_id             = p_official_id
    AND fr.amount_cents > 0
    AND fe.entity_type IN ('pac', 'super_pac', 'party_committee', 'union', 'corporation')
  GROUP BY fe.id, fe.display_name,
           COALESCE(et.tag,           'untagged'),
           COALESCE(et.display_label, 'Untagged'),
           COALESCE(et.display_icon,  '')
  ORDER BY total_cents DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.chord_top_pacs_for_official(UUID, INTEGER)
  TO anon, authenticated, service_role;


-- ── 1d. chord_donor_brackets_for_official(uuid) ──────────────────────────────
-- Bucket all donations to a focused official into the four standard size
-- brackets used by FORCE_GRAPH (Mega / Major / Mid / Small) and return their
-- totals + donor counts. Used by the chord granularity='by-bracket' mode.
-- Bracket boundaries match BRACKET_TIERS in packages/graph/src/types.ts.
CREATE OR REPLACE FUNCTION public.chord_donor_brackets_for_official(
  p_official_id UUID
)
RETURNS TABLE(
  bracket      TEXT,
  total_cents  BIGINT,
  donor_count  BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  WITH bucketed AS (
    SELECT
      fe.id AS donor_id,
      fr.amount_cents,
      CASE
        WHEN fr.amount_cents >= 1000000 THEN 'mega'   -- $10k+
        WHEN fr.amount_cents >=  250000 THEN 'major'  -- $2.5k-$10k
        WHEN fr.amount_cents >=   50000 THEN 'mid'    -- $500-$2.5k
        ELSE                                  'small' -- < $500
      END AS bracket
    FROM public.financial_relationships fr
    JOIN public.financial_entities fe
      ON fe.id = fr.from_id AND fr.from_type = 'financial_entity'
    WHERE fr.relationship_type = 'donation'
      AND fr.to_type           = 'official'
      AND fr.to_id             = p_official_id
      AND fr.amount_cents > 0
  )
  SELECT
    bracket,
    SUM(amount_cents)::BIGINT AS total_cents,
    COUNT(DISTINCT donor_id)::BIGINT AS donor_count
  FROM bucketed
  GROUP BY bracket;
$$;

GRANT EXECUTE ON FUNCTION public.chord_donor_brackets_for_official(UUID)
  TO anon, authenticated, service_role;


-- ── 2. chord_subject_party_flows(uuid[]) ─────────────────────────────────────
-- Bill subjects (entity_tags.tag_category='topic') × party_chamber, weighted
-- by affirmative votes ('yes' + 'paired_yes'). Scoped to congressional
-- officials only. Pass NULL to get the global flow; pass an array to scope
-- to a cohort of officials.
CREATE OR REPLACE FUNCTION public.chord_subject_party_flows(
  p_official_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(
  subject       TEXT,
  display_label TEXT,
  display_icon  TEXT,
  party_chamber TEXT,
  vote_count    BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    COALESCE(et.tag,           'untagged') AS subject,
    COALESCE(et.display_label, 'Untagged') AS display_label,
    COALESCE(et.display_icon,  '')         AS display_icon,
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )                                      AS party_chamber,
    COUNT(*)::BIGINT                       AS vote_count
  FROM public.votes v
  JOIN public.officials o
    ON o.id = v.official_id
  JOIN public.entity_tags et
    ON et.entity_id    = v.bill_proposal_id
   AND et.entity_type  = 'proposal'
   AND et.tag_category = 'topic'
  WHERE v.vote IN ('yes', 'paired_yes')
    AND o.source_ids->>'congress_gov' IS NOT NULL
    AND (p_official_ids IS NULL OR v.official_id = ANY(p_official_ids))
  GROUP BY
    et.tag,
    et.display_label,
    et.display_icon,
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )
  ORDER BY vote_count DESC
  LIMIT 60;
$$;

GRANT EXECUTE ON FUNCTION public.chord_subject_party_flows(UUID[])
  TO anon, authenticated, service_role;


-- ── 3. chord_donor_type_party_flows(uuid[]) ──────────────────────────────────
-- Donor entity_type × party_chamber. Donor types come from
-- financial_entities.entity_type CHECK enum (individual, pac, super_pac,
-- corporation, union, party_committee, small_donor_aggregate, tribal,
-- 527, other). Pass NULL for global; pass cohort IDs to scope.
CREATE OR REPLACE FUNCTION public.chord_donor_type_party_flows(
  p_official_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(
  donor_type    TEXT,
  party_chamber TEXT,
  total_usd     NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    COALESCE(fe.entity_type, 'other')      AS donor_type,
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )                                      AS party_chamber,
    SUM(fr.amount_cents) / 100.0           AS total_usd
  FROM public.financial_relationships fr
  JOIN public.officials o
    ON o.id = fr.to_id
   AND fr.to_type = 'official'
  LEFT JOIN public.financial_entities fe
    ON fe.id = fr.from_id
   AND fr.from_type = 'financial_entity'
  WHERE fr.relationship_type = 'donation'
    AND fr.amount_cents > 0
    AND o.source_ids->>'congress_gov' IS NOT NULL
    AND (p_official_ids IS NULL OR fr.to_id = ANY(p_official_ids))
  GROUP BY donor_type, party_chamber
  ORDER BY total_usd DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION public.chord_donor_type_party_flows(UUID[])
  TO anon, authenticated, service_role;


-- ── 4. chord_donor_state_party_flows(uuid) ───────────────────────────────────
-- Donor home state × party_chamber. Donor state lives in
-- financial_entities.metadata->>'state'. Index on that JSON path was added
-- in 20260509000000_individuals_state_index.sql for the individuals-by-state
-- treemap; we reuse it here. Pass NULL for the global flow; pass an
-- official UUID to filter to donations to that single official.
CREATE OR REPLACE FUNCTION public.chord_donor_state_party_flows(
  p_official_id UUID DEFAULT NULL
)
RETURNS TABLE(
  donor_state   TEXT,
  party_chamber TEXT,
  total_usd     NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    UPPER(fe.metadata->>'state')           AS donor_state,
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )                                      AS party_chamber,
    SUM(fr.amount_cents) / 100.0           AS total_usd
  FROM public.financial_relationships fr
  JOIN public.officials o
    ON o.id = fr.to_id
   AND fr.to_type = 'official'
  JOIN public.financial_entities fe
    ON fe.id = fr.from_id
   AND fr.from_type = 'financial_entity'
  WHERE fr.relationship_type = 'donation'
    AND fr.amount_cents > 0
    AND o.source_ids->>'congress_gov' IS NOT NULL
    AND fe.metadata->>'state' IS NOT NULL
    AND fe.metadata->>'state' != ''
    AND LENGTH(fe.metadata->>'state') = 2
    AND (p_official_id IS NULL OR fr.to_id = p_official_id)
  GROUP BY UPPER(fe.metadata->>'state'), party_chamber
  ORDER BY total_usd DESC
  LIMIT 60;
$$;

GRANT EXECUTE ON FUNCTION public.chord_donor_state_party_flows(UUID)
  TO anon, authenticated, service_role;
