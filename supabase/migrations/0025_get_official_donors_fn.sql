-- =============================================================================
-- Migration 0025: get_official_donors RPC function
--
-- financial_relationships and financial_entities are joined by donor_name
-- convention only (no FK constraint), so PostgREST auto-join syntax fails.
-- This function aggregates donor rows directly from financial_relationships,
-- using a LEFT JOIN to financial_entities to pick up entity IDs where they exist.
-- =============================================================================

CREATE OR REPLACE FUNCTION get_official_donors(p_official_id UUID)
RETURNS TABLE (
  financial_entity_id UUID,
  entity_name         TEXT,
  entity_type         TEXT,
  industry_category   TEXT,
  total_amount_usd    NUMERIC,
  transaction_count   BIGINT
) AS $$
  SELECT
    (array_agg(fe.id) FILTER (WHERE fe.id IS NOT NULL))[1]        AS financial_entity_id,
    fr.donor_name                                                  AS entity_name,
    fr.donor_type::TEXT                                            AS entity_type,
    COALESCE(fr.industry, (array_agg(fe.industry) FILTER (WHERE fe.industry IS NOT NULL))[1], 'Other') AS industry_category,
    SUM(fr.amount_cents) / 100.0                                   AS total_amount_usd,
    COUNT(*)::BIGINT                                               AS transaction_count
  FROM financial_relationships fr
  LEFT JOIN financial_entities fe ON fe.name = fr.donor_name
  WHERE fr.official_id = p_official_id
  GROUP BY
    fr.donor_name,
    fr.donor_type,
    fr.industry
  ORDER BY total_amount_usd DESC
  LIMIT 100
$$ LANGUAGE SQL STABLE SECURITY DEFINER;
