-- FIX-269: Recompute financial_entities.total_donated_cents from live
-- financial_relationships. Pre-fix, the FEC pipeline overwrote this column per
-- cycle (onConflict on donor_fingerprint), so individual donors who gave across
-- multiple cycles ended up with only the latest cycle's slice. Compounding
-- that, FIX-236 added donor → committee rows to financial_relationships but the
-- pipeline's per-cycle writer did not retro-update existing entities.
--
-- Net effect on prod: Musk profile showed ~$941k for MUSK, ELON; FIX-236
-- committee contributions raised that to ~$1.12M (the ~$277M America PAC
-- expectation lives under a different Musk entity record — separate
-- entity-resolution issue, FIX-237's downstream). Mirrors
-- rebuild_official_donation_totals() shipped in 20260508000000.
--
-- Implementation note: the first cut wrote UPDATE financial_entities
-- ... FROM (SELECT ... GROUP BY) directly. On Pro's pooler that plan stuck
-- at >30min and never returned. Materializing the SUM into a TEMP table
-- with an index, then UPDATE ... FROM tmp, runs in ~13min for the same
-- ~2M aggregated rows. Same conclusion as FIX-263's chunked rebuild —
-- expensive UPDATEs need help to pick the right plan under pooler timing.

CREATE OR REPLACE FUNCTION rebuild_financial_entity_donation_totals()
RETURNS void AS $$
BEGIN
  -- Materialize the aggregation. Plan reuses the parallel seq scan + hash agg
  -- (~35s on prod) once, then the UPDATE becomes a nested-loop pkey probe
  -- driven by the temp table.
  CREATE TEMP TABLE _donor_totals ON COMMIT DROP AS
  SELECT from_id, SUM(amount_cents)::BIGINT AS total
  FROM financial_relationships
  WHERE from_type = 'financial_entity'
    AND relationship_type = 'donation'
  GROUP BY from_id;

  CREATE INDEX ON _donor_totals(from_id);

  -- Two-pass: bump entities that have donation rows, zero entities that no
  -- longer do. IS DISTINCT FROM keeps the writes to actual deltas instead of
  -- rewriting every matching row.
  UPDATE financial_entities fe
  SET total_donated_cents = dt.total
  FROM _donor_totals dt
  WHERE fe.id = dt.from_id
    AND fe.total_donated_cents IS DISTINCT FROM dt.total;

  UPDATE financial_entities fe
  SET total_donated_cents = 0
  WHERE fe.total_donated_cents > 0
    AND NOT EXISTS (SELECT 1 FROM _donor_totals dt WHERE dt.from_id = fe.id);
END;
$$ LANGUAGE plpgsql;

-- _full() is the one-shot backfill variant. Same code path now — the
-- temp-table pattern already handles both insertions and stale-zero cases.
-- Kept as a separate function name so callers (one-shot backfills, prior
-- runbooks, future audits) keep the same surface as the official rebuild.
CREATE OR REPLACE FUNCTION rebuild_financial_entity_donation_totals_full()
RETURNS void AS $$
BEGIN
  PERFORM rebuild_financial_entity_donation_totals();
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION rebuild_financial_entity_donation_totals()      TO service_role;
GRANT EXECUTE ON FUNCTION rebuild_financial_entity_donation_totals_full() TO service_role;

-- Per-function statement_timeout overrides. Same pattern as FIX-263's chunked
-- rebuild functions — pooled connections on Pro default to a 2-min cap, and
-- the materialized SUM + dual UPDATE total wall-time is ~18min on prod
-- (35s SUM + ~13min positive UPDATE + ~4min zero-pass UPDATE). 30min budget
-- gives headroom.
ALTER FUNCTION rebuild_financial_entity_donation_totals()      SET statement_timeout = '30min';
ALTER FUNCTION rebuild_financial_entity_donation_totals_full() SET statement_timeout = '30min';
