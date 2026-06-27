-- FIX-675: Materialize financial_entities.total_received_cents — the inbound
-- (money-received) mirror of total_donated_cents.
--
-- The FEC indiv pipeline pre-upserts recipient committee rows (super PACs, party
-- committees, other PACs) so donor → committee `donation` relationships have a
-- `to_id` to point at, but it hardcodes total_received_cents = 0 at write time
-- (packages/data/src/pipelines/fec-bulk/writer.ts) and never recomputes it. So
-- the donor-page "Total received" headline reads $0 for every committee that
-- actually received itemized individual contributions.
--
-- This is the to_id mirror of rebuild_financial_entity_donation_totals()
-- (migration 20260513010000), which sums the from_id side. Same scale and same
-- temp-table-then-UPDATE shape — a direct UPDATE ... FROM (SELECT ... GROUP BY)
-- stuck >30min on Pro's pooler there; materializing the SUM into an indexed TEMP
-- table first turns the UPDATE into a nested-loop pkey probe. The column already
-- exists (no DDL) — this only adds the rebuild + wiring.

CREATE OR REPLACE FUNCTION rebuild_financial_entity_received_totals()
RETURNS void AS $$
BEGIN
  -- Materialize the inbound aggregation once. Mirror of the from_id donation
  -- rebuild, keyed on to_id (the recipient committee).
  CREATE TEMP TABLE _received_totals ON COMMIT DROP AS
  SELECT to_id, SUM(amount_cents)::BIGINT AS total
  FROM financial_relationships
  WHERE to_type = 'financial_entity'
    AND relationship_type = 'donation'
  GROUP BY to_id;

  CREATE INDEX ON _received_totals(to_id);

  -- Two-pass: bump entities that have inbound donation rows, zero entities that
  -- no longer do. IS DISTINCT FROM keeps writes to actual deltas.
  UPDATE financial_entities fe
  SET total_received_cents = rt.total
  FROM _received_totals rt
  WHERE fe.id = rt.to_id
    AND fe.total_received_cents IS DISTINCT FROM rt.total;

  UPDATE financial_entities fe
  SET total_received_cents = 0
  WHERE fe.total_received_cents > 0
    AND NOT EXISTS (SELECT 1 FROM _received_totals rt WHERE rt.to_id = fe.id);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION rebuild_financial_entity_received_totals() TO service_role;

-- Per-function statement_timeout override. Same rationale as the donation-total
-- rebuild — pooled connections on Pro default to a ~2-min cap, and the inbound
-- side is the same ~2M-row aggregated scale as the outbound side. 30min budget
-- gives headroom. (The direct-pg runHeavyRebuild path raises the SESSION timeout
-- too; this ALTER is belt-and-braces for any in-session SELECT call.)
ALTER FUNCTION rebuild_financial_entity_received_totals() SET statement_timeout = '30min';
