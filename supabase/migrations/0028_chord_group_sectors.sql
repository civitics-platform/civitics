-- Migration 0028: RPC functions for group sector totals (avoids large .in() URL)

CREATE OR REPLACE FUNCTION get_group_sector_totals(
  p_member_ids UUID[],
  p_min_usd    NUMERIC DEFAULT 0
)
RETURNS TABLE (
  sector    TEXT,
  total_usd NUMERIC
) AS $$
  SELECT
    fr.metadata->>'sector'          AS sector,
    SUM(fr.amount_cents) / 100.0    AS total_usd
  FROM financial_relationships fr
  WHERE fr.official_id = ANY(p_member_ids)
    AND fr.metadata->>'sector' IS NOT NULL
    AND fr.metadata->>'sector' != 'Other'
    AND fr.donor_name NOT ILIKE '%PAC/Committee%'
  GROUP BY fr.metadata->>'sector'
  HAVING SUM(fr.amount_cents) / 100.0 >= p_min_usd
  ORDER BY total_usd DESC
  LIMIT 12
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION get_crossgroup_sector_totals(
  p_group1_ids UUID[],
  p_group2_ids UUID[]
)
RETURNS TABLE (
  sector     TEXT,
  group1_usd NUMERIC,
  group2_usd NUMERIC
) AS $$
  WITH agg AS (
    SELECT
      fr.metadata->>'sector' AS sector,
      SUM(CASE WHEN fr.official_id = ANY(p_group1_ids) THEN fr.amount_cents / 100.0 ELSE 0 END) AS group1_usd,
      SUM(CASE WHEN fr.official_id = ANY(p_group2_ids) THEN fr.amount_cents / 100.0 ELSE 0 END) AS group2_usd
    FROM financial_relationships fr
    WHERE (
      fr.official_id = ANY(p_group1_ids)
      OR fr.official_id = ANY(p_group2_ids)
    )
      AND fr.metadata->>'sector' IS NOT NULL
      AND fr.metadata->>'sector' != 'Other'
      AND fr.donor_name NOT ILIKE '%PAC/Committee%'
    GROUP BY fr.metadata->>'sector'
  )
  SELECT sector, group1_usd, group2_usd
  FROM agg
  ORDER BY (group1_usd + group2_usd) DESC
  LIMIT 12
$$ LANGUAGE SQL STABLE;
