-- Migration 0026: get_pac_donations_by_party function
--
-- Aggregates PAC donations from financial_relationships grouped by recipient
-- party (from officials table). Used by the treemap-pac API for party mode.
--
-- Returns one row per (party, donor_name) pair with total USD and count.

CREATE OR REPLACE FUNCTION get_pac_donations_by_party()
RETURNS TABLE (
  party          TEXT,
  donor_name     TEXT,
  total_usd      NUMERIC,
  donation_count BIGINT
) AS $$
  SELECT
    COALESCE(o.party::TEXT, 'other')  AS party,
    fr.donor_name,
    SUM(fr.amount_cents) / 100.0      AS total_usd,
    COUNT(*)                          AS donation_count
  FROM financial_relationships fr
  JOIN officials o ON fr.official_id = o.id
  WHERE fr.donor_type = 'pac'
    AND fr.donor_name IS NOT NULL
  GROUP BY o.party, fr.donor_name
  ORDER BY total_usd DESC
$$ LANGUAGE SQL STABLE;

GRANT EXECUTE ON FUNCTION get_pac_donations_by_party() TO anon, authenticated;
