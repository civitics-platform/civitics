-- =============================================================================
-- Migration 0017: Fix treemap state — only use fec_candidate_id for extraction
--
-- Root cause: fec_id is a committee/filing ID that can encode a different state
-- than the official's home state (e.g. Tammy Baldwin fec_id="S0VA00070" → VA
-- but she represents WI; Adam Gray fec_id="H2WY01032" → WY but represents CA).
--
-- Fix: only fec_candidate_id is a reliable state source. Add VALID_STATES
-- validation as a defence layer to prevent garbage extraction.
-- =============================================================================

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
      COALESCE(o.party, 'nonpartisan')          AS party,
      COALESCE(
        NULLIF(o.metadata->>'state', ''),
        NULLIF(o.metadata->>'state_abbr', ''),
        -- Only fec_candidate_id encodes the official's home state reliably.
        -- fec_id is excluded: it's a committee ID that can have a wrong state
        -- (e.g. S0VA00070 for a Wisconsin senator).
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
