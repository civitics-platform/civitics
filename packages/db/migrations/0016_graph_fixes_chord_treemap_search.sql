-- =============================================================================
-- Migration 0016: Fix chord industry join + treemap state extraction
--
-- chord_industry_flows(): new function — joins entity_tags for industry instead
--   of reading the mostly-null financial_relationships.industry column.
--
-- treemap_officials_by_donations(): fixed state extraction — congress.gov
--   officials have empty metadata{}; state is encoded in FEC candidate/member
--   ID (positions 3-4: "S2MA00170" → "MA", "H6OH08315" → "OH").
-- =============================================================================

-- ---------------------------------------------------------------------------
-- chord_industry_flows
-- Aggregates donation flows by (industry from entity_tags × party+chamber).
-- Replaces the broken financial_relationships.industry column (mostly null).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION chord_industry_flows()
RETURNS TABLE(
  industry       TEXT,
  display_label  TEXT,
  display_icon   TEXT,
  party_chamber  TEXT,
  total_cents    BIGINT,
  official_count BIGINT,
  donor_count    BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    COALESCE(et.tag, 'untagged')                                  AS industry,
    COALESCE(et.display_label, 'Untagged')                        AS display_label,
    COALESCE(et.display_icon, '')                                 AS display_icon,
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )                                                             AS party_chamber,
    SUM(fr.amount_cents)::BIGINT                                  AS total_cents,
    COUNT(DISTINCT fr.official_id)::BIGINT                        AS official_count,
    COUNT(DISTINCT fr.donor_name)::BIGINT                         AS donor_count
  FROM financial_relationships fr
  JOIN officials o
    ON o.id = fr.official_id
  LEFT JOIN financial_entities fe
    ON fe.name = fr.donor_name
  LEFT JOIN entity_tags et
    ON et.entity_id = fe.id
   AND et.entity_type = 'financial_entity'
   AND et.tag_category = 'industry'
  WHERE fr.amount_cents > 0
    AND o.source_ids->>'congress_gov' IS NOT NULL
  GROUP BY
    COALESCE(et.tag, 'untagged'),
    COALESCE(et.display_label, 'Untagged'),
    COALESCE(et.display_icon, ''),
    CONCAT_WS(' ',
      INITCAP(COALESCE(o.party::TEXT, 'other')),
      CASE
        WHEN o.role_title ILIKE '%representative%' THEN 'House'
        ELSE 'Senate'
      END
    )
  ORDER BY total_cents DESC
$$;

GRANT EXECUTE ON FUNCTION chord_industry_flows() TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- treemap_officials_by_donations (replacement)
-- State priority: metadata.state → metadata.state_abbr → FEC ID extraction
--   FEC IDs: "S2MA00170" (senator) → MA, "H6OH08315" (house) → OH
--   Both Senate (S) and House (H) encode state at positions 3-4.
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
      o.id::UUID                                 AS official_id,
      o.full_name                                AS official_name,
      COALESCE(o.party, 'nonpartisan')           AS party,
      COALESCE(
        NULLIF(o.metadata->>'state', ''),
        NULLIF(o.metadata->>'state_abbr', ''),
        CASE
          WHEN (o.source_ids->>'fec_candidate_id') ~ '^[SH][0-9][A-Z]{2}'
            THEN SUBSTRING(o.source_ids->>'fec_candidate_id' FROM 3 FOR 2)
          WHEN (o.source_ids->>'fec_id') ~ '^[SH][0-9][A-Z]{2}'
            THEN SUBSTRING(o.source_ids->>'fec_id' FROM 3 FOR 2)
          ELSE NULL
        END,
        'Unknown'
      )                                          AS state
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
