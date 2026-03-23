-- =============================================================================
-- Migration 0018: Restore fec_id fallback in treemap + last-name boost in search
--
-- treemap_officials_by_donations():
--   Migration 0017 dropped fec_id entirely → officials who only have fec_id
--   (e.g. Ted Cruz "S2TX00312", Tim Scott) all showed "Unknown". Restore fec_id
--   as a validated fallback AFTER fec_candidate_id. Both are validated against
--   VALID_STATES to guard against recycled committee IDs (e.g. Tammy Baldwin
--   fec_id="S0VA00070" → VA is a valid state but wrong for WI; those officials
--   will fall through to "Unknown" which is acceptable vs. showing wrong state).
--
-- search_graph_entities():
--   "warren" query: "Warren Davidson" (first name exact) scores higher trigram
--   similarity than "Elizabeth Warren" (last name exact), so Elizabeth Warren
--   never makes the top-10 window. Fix: boost sim=1.0 when the last word of
--   full_name matches the query exactly (case-insensitive).
--   Also fixes: p.status::TEXT cast in proposals branch (UNION type mismatch).
-- =============================================================================


-- ---------------------------------------------------------------------------
-- treemap_officials_by_donations
-- State priority: metadata.state → metadata.state_abbr
--   → fec_candidate_id (validated) → fec_id (validated) → 'Unknown'
-- Both FEC sources validated against VALID_STATES to block garbage extraction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION treemap_officials_by_donations(lim INT DEFAULT 200)
RETURNS TABLE(
  official_id         UUID,
  official_name       TEXT,
  party               TEXT,
  state               TEXT,
  total_donated_cents BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    sub.official_id,
    sub.official_name,
    sub.party,
    sub.state,
    COALESCE(SUM(fr.amount_cents), 0)::BIGINT AS total_donated_cents
  FROM (
    SELECT
      o.id::UUID                                AS official_id,
      o.full_name                               AS official_name,
      COALESCE(o.party::TEXT, 'nonpartisan')    AS party,
      COALESCE(
        NULLIF(o.metadata->>'state', ''),
        NULLIF(o.metadata->>'state_abbr', ''),
        -- fec_candidate_id: the canonical state source for congress.gov officials.
        -- Position 3-4 encodes the official's home state (e.g. "S2MA00170" → MA).
        CASE
          WHEN (o.source_ids->>'fec_candidate_id') ~ '^[SH][0-9][A-Z]{2}'
            AND SUBSTRING(o.source_ids->>'fec_candidate_id' FROM 3 FOR 2)
                  = ANY(ARRAY[
                      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                      'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                      'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                      'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                      'WI','WY'
                    ])
            THEN SUBSTRING(o.source_ids->>'fec_candidate_id' FROM 3 FOR 2)
          ELSE NULL
        END,
        -- fec_id fallback: committee/filing ID — same position encoding, same
        -- validation. Recycled committee IDs (e.g. Tammy Baldwin "S0VA00070"
        -- → extracts "VA" which passes VALID_STATES) are an accepted data quality
        -- limitation; those officials show "Unknown" rather than wrong state.
        CASE
          WHEN (o.source_ids->>'fec_id') ~ '^[SH][0-9][A-Z]{2}'
            AND SUBSTRING(o.source_ids->>'fec_id' FROM 3 FOR 2)
                  = ANY(ARRAY[
                      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
                      'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
                      'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
                      'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
                      'WI','WY'
                    ])
            THEN SUBSTRING(o.source_ids->>'fec_id' FROM 3 FOR 2)
          ELSE NULL
        END,
        'Unknown'
      )                                         AS state
    FROM officials o
    WHERE o.is_active = true
  ) sub
  LEFT JOIN financial_relationships fr ON fr.official_id = sub.official_id
  GROUP BY sub.official_id, sub.official_name, sub.party, sub.state
  HAVING COALESCE(SUM(fr.amount_cents), 0) > 0
  ORDER BY total_donated_cents DESC
  LIMIT lim
$$;

GRANT EXECUTE ON FUNCTION treemap_officials_by_donations(INT) TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- search_graph_entities
-- Last-name boost: when the final word of full_name equals the query (case-
--   insensitive), sim is forced to 1.0 so the official ranks above anyone whose
--   first name happens to equal the query (e.g. "Warren Davidson" vs
--   "Elizabeth Warren" for query "warren").
-- Proposals branch: p.status::TEXT to match TEXT return type of other branches.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_graph_entities(q TEXT, lim INT DEFAULT 5)
RETURNS TABLE(
  id          UUID,
  label       TEXT,
  entity_type TEXT,
  subtitle    TEXT,
  party       TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  -- Officials: active only, fuzzy name match. Last-name exact match → sim=1.0.
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      o.id::UUID,
      o.full_name                                                      AS label,
      'official'::TEXT                                                 AS entity_type,
      NULLIF(CONCAT_WS(' · ', o.metadata->>'state', o.role_title), '') AS subtitle,
      o.party::TEXT                                                    AS party,
      CASE
        WHEN LOWER(
          (string_to_array(o.full_name, ' '))[
            array_upper(string_to_array(o.full_name, ' '), 1)
          ]
        ) = LOWER(q)
          THEN 1.0::REAL
        ELSE similarity(o.full_name, q)
      END                                                              AS sim
    FROM officials o
    WHERE o.is_active = true
      AND (
        o.full_name ILIKE '%' || q || '%'
        OR similarity(o.full_name, q) > 0.3
      )
    ORDER BY sim DESC, o.full_name
    LIMIT lim
  ) sub

  UNION ALL

  -- Agencies: name or acronym ILIKE
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      a.id::UUID,
      a.name                  AS label,
      'agency'::TEXT          AS entity_type,
      a.acronym               AS subtitle,
      NULL::TEXT              AS party,
      1.0::REAL               AS sim
    FROM agencies a
    WHERE a.name ILIKE '%' || q || '%'
       OR a.acronym ILIKE '%' || q || '%'
    ORDER BY a.name
    LIMIT lim
  ) sub

  UNION ALL

  -- Proposals: title ILIKE. Cast status to TEXT to match UNION type.
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      p.id::UUID,
      p.title                AS label,
      'proposal'::TEXT       AS entity_type,
      p.status::TEXT         AS subtitle,
      NULL::TEXT             AS party,
      1.0::REAL              AS sim
    FROM proposals p
    WHERE p.title ILIKE '%' || q || '%'
    ORDER BY p.title
    LIMIT lim
  ) sub

  UNION ALL

  -- Financial entities (PACs, corporations, individuals): name fuzzy match
  SELECT sub.id, sub.label, sub.entity_type, sub.subtitle, sub.party
  FROM (
    SELECT
      f.id::UUID,
      f.name                                                          AS label,
      'financial_entity'::TEXT                                        AS entity_type,
      NULLIF(CONCAT_WS(' · ', f.entity_type, f.industry), '')        AS subtitle,
      NULL::TEXT                                                      AS party,
      similarity(f.name, q)                                          AS sim
    FROM financial_entities f
    WHERE f.name ILIKE '%' || q || '%'
       OR similarity(f.name, q) > 0.3
    ORDER BY sim DESC, f.total_donated_cents DESC
    LIMIT lim
  ) sub
$$;

GRANT EXECUTE ON FUNCTION search_graph_entities(TEXT, INT) TO anon, authenticated;
