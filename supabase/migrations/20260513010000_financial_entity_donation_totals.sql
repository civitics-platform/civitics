-- FIX-269: Recompute financial_entities.total_donated_cents from live
-- financial_relationships. Pre-fix, the FEC pipeline overwrote this column per
-- cycle (onConflict on donor_fingerprint), so individual donors who gave across
-- multiple cycles ended up with only the latest cycle's slice. Compounding
-- that, FIX-236 added donor → committee rows to financial_relationships but the
-- pipeline's per-cycle writer did not retro-update existing entities.
--
-- Net effect on prod: Musk profile showed ~$941k instead of ~$277M (super-PAC
-- contributions to America PAC absent from the headline). Mirrors
-- rebuild_official_donation_totals() shipped in 20260508000000.

CREATE OR REPLACE FUNCTION rebuild_financial_entity_donation_totals()
RETURNS void AS $$
  UPDATE financial_entities fe
  SET total_donated_cents = COALESCE(agg.total, 0)
  FROM (
    SELECT from_id, SUM(amount_cents)::BIGINT AS total
    FROM financial_relationships
    WHERE from_type = 'financial_entity'
      AND relationship_type = 'donation'
    GROUP BY from_id
  ) agg
  WHERE fe.id = agg.from_id;
$$ LANGUAGE SQL;

-- Full recompute: zeroes out first, then repopulates. Use as one-shot backfill.
CREATE OR REPLACE FUNCTION rebuild_financial_entity_donation_totals_full()
RETURNS void AS $$
BEGIN
  UPDATE financial_entities SET total_donated_cents = 0;
  UPDATE financial_entities fe
  SET total_donated_cents = agg.total
  FROM (
    SELECT from_id, SUM(amount_cents)::BIGINT AS total
    FROM financial_relationships
    WHERE from_type = 'financial_entity'
      AND relationship_type = 'donation'
    GROUP BY from_id
  ) agg
  WHERE fe.id = agg.from_id;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION rebuild_financial_entity_donation_totals()      TO service_role;
GRANT EXECUTE ON FUNCTION rebuild_financial_entity_donation_totals_full() TO service_role;
