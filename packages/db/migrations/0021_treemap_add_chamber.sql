-- 0021_treemap_add_chamber.sql
-- Add chamber (senate | house | unknown) to treemap_officials_by_donations.
-- Derived from fec_candidate_id/fec_id first character:
--   'S' → senate  (U.S. Senate)
--   'H' → house   (U.S. House of Representatives)
--   else → unknown

CREATE OR REPLACE FUNCTION treemap_officials_by_donations(lim INT DEFAULT 200)
RETURNS TABLE(
  official_id         UUID,
  official_name       TEXT,
  party               TEXT,
  state               TEXT,
  chamber             TEXT,
  total_donated_cents BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    sub.official_id,
    sub.official_name,
    sub.party,
    sub.state,
    sub.chamber,
    COALESCE(SUM(fr.amount_cents), 0)::BIGINT AS total_donated_cents
  FROM (
    SELECT
      o.id::UUID                                AS official_id,
      o.full_name                               AS official_name,
      COALESCE(o.party::TEXT, 'nonpartisan')    AS party,
      COALESCE(
        NULLIF(o.metadata->>'state', ''),
        NULLIF(o.metadata->>'state_abbr', ''),
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
      )                                         AS state,
      -- chamber: derived from fec_candidate_id first char, then fec_id, then role_title
      CASE
        WHEN LEFT(o.source_ids->>'fec_candidate_id', 1) = 'S' THEN 'senate'
        WHEN LEFT(o.source_ids->>'fec_candidate_id', 1) = 'H' THEN 'house'
        WHEN LEFT(o.source_ids->>'fec_id', 1) = 'S'           THEN 'senate'
        WHEN LEFT(o.source_ids->>'fec_id', 1) = 'H'           THEN 'house'
        WHEN o.role_title ILIKE '%senator%'                    THEN 'senate'
        WHEN o.role_title ILIKE '%representative%'             THEN 'house'
        ELSE 'unknown'
      END                                       AS chamber
    FROM officials o
    WHERE o.is_active = true
  ) sub
  LEFT JOIN financial_relationships fr ON fr.official_id = sub.official_id
  GROUP BY sub.official_id, sub.official_name, sub.party, sub.state, sub.chamber
  HAVING COALESCE(SUM(fr.amount_cents), 0) > 0
  ORDER BY total_donated_cents DESC
  LIMIT lim
$$;

GRANT EXECUTE ON FUNCTION treemap_officials_by_donations(INT) TO anon, authenticated;
