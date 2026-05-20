-- Denormalized total campaign donations received by each official.
-- Populated by rebuild_official_donation_totals(), called at the end of
-- each FEC pipeline run. Same pattern as total_donated_cents on financial_entities.
--
-- financial_relationships uses a graph-edge schema (from_type/from_id, to_type/to_id).
-- Donations TO an official: to_type = 'official', relationship_type = 'donation'.

ALTER TABLE officials
  ADD COLUMN IF NOT EXISTS total_received_cents BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS officials_total_received_cents
  ON officials(total_received_cents DESC);

-- Incremental recompute: updates only officials who have rows in financial_relationships.
-- Run after each FEC pipeline wave.
CREATE OR REPLACE FUNCTION rebuild_official_donation_totals()
RETURNS void AS $$
  UPDATE officials o
  SET total_received_cents = COALESCE(agg.total, 0)
  FROM (
    SELECT to_id AS official_id, SUM(amount_cents)::BIGINT AS total
    FROM financial_relationships
    WHERE to_type = 'official'
      AND relationship_type = 'donation'
    GROUP BY to_id
  ) agg
  WHERE o.id = agg.official_id;
$$ LANGUAGE SQL;

-- Full recompute: zeroes out then repopulates.
-- Use when doing a full FEC reload (not incremental).
CREATE OR REPLACE FUNCTION rebuild_official_donation_totals_full()
RETURNS void AS $$
BEGIN
  UPDATE officials SET total_received_cents = 0;
  UPDATE officials o
  SET total_received_cents = agg.total
  FROM (
    SELECT to_id AS official_id, SUM(amount_cents)::BIGINT AS total
    FROM financial_relationships
    WHERE to_type = 'official'
      AND relationship_type = 'donation'
    GROUP BY to_id
  ) agg
  WHERE o.id = agg.official_id;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION rebuild_official_donation_totals()      TO service_role;
GRANT EXECUTE ON FUNCTION rebuild_official_donation_totals_full() TO service_role;

-- Backfill runs separately (too slow for inline migration on prod).
-- Run manually: SELECT rebuild_official_donation_totals_full();
