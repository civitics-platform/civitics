-- FIX-666: Materialize super-PAC independent-expenditure (Schedule E) totals.
--
-- IE-only super PACs (e.g. United Democracy Project / "UDP", FEC C00799031)
-- legally make no direct candidate contributions, so total_donated_cents — which
-- sums only relationship_type='donation' (migration 20260513010000) — is ~$0 for
-- them, even though the FEC Schedule E pipeline (FIX-240) already writes their
-- spending as financial_relationships rows with relationship_type 'ie_support' /
-- 'ie_oppose'. UDP shows ~$0 spending everywhere while FEC reports ~$35.6M of
-- 2024 outside spending.
--
-- This mirrors the total_donated_cents materialization end-to-end: two new
-- BIGINT columns + a temp-table-pivot rebuild function. IE is kept OUT of
-- total_donated_cents on purpose — "donated to candidates" and "spent
-- independently" are different things, and ie_support is already counted as a
-- donation EDGE by rebuild_entity_connections(), so folding it into the total
-- too would double-count and conflate the two concepts.
--
-- Support and oppose stay split: the support-vs-oppose breakdown is the
-- politically meaningful number, and a live SUM across ~78k financial entities
-- on the search sort path is too slow — hence materialized columns.

ALTER TABLE financial_entities
  ADD COLUMN IF NOT EXISTS total_ie_support_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_ie_oppose_cents  BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION rebuild_financial_entity_ie_totals()
RETURNS void AS $$
BEGIN
  -- Materialize the support/oppose pivot once. IE volume is far smaller than
  -- the donation set (thousands of rows, not millions), so the aggregation is
  -- cheap; the temp table still gives the UPDATE a clean nested-loop pkey probe.
  CREATE TEMP TABLE _ie_totals ON COMMIT DROP AS
  SELECT
    from_id,
    SUM(amount_cents) FILTER (WHERE relationship_type = 'ie_support')::BIGINT AS sup,
    SUM(amount_cents) FILTER (WHERE relationship_type = 'ie_oppose')::BIGINT  AS opp
  FROM financial_relationships
  WHERE from_type = 'financial_entity'
    AND relationship_type IN ('ie_support', 'ie_oppose')
  GROUP BY from_id;

  CREATE INDEX ON _ie_totals(from_id);

  -- Two-pass: set entities that have IE rows, zero entities that no longer do.
  -- IS DISTINCT FROM keeps writes to actual deltas. COALESCE handles the case
  -- where an entity has only support or only oppose rows (the other FILTER
  -- aggregate is NULL).
  UPDATE financial_entities fe
  SET total_ie_support_cents = COALESCE(it.sup, 0),
      total_ie_oppose_cents  = COALESCE(it.opp, 0)
  FROM _ie_totals it
  WHERE fe.id = it.from_id
    AND (fe.total_ie_support_cents IS DISTINCT FROM COALESCE(it.sup, 0)
      OR fe.total_ie_oppose_cents  IS DISTINCT FROM COALESCE(it.opp, 0));

  UPDATE financial_entities fe
  SET total_ie_support_cents = 0,
      total_ie_oppose_cents  = 0
  WHERE (fe.total_ie_support_cents > 0 OR fe.total_ie_oppose_cents > 0)
    AND NOT EXISTS (SELECT 1 FROM _ie_totals it WHERE it.from_id = fe.id);
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION rebuild_financial_entity_ie_totals() TO service_role;

-- Per-function statement_timeout override. Same rationale as the donation-total
-- rebuild — pooled connections on Pro default to a ~2-min cap. IE volume is a
-- small fraction of the donation set, so 10min is ample headroom. (Note the
-- direct-pg runHeavyRebuild path raises the SESSION timeout too; this ALTER is
-- belt-and-braces for any in-session SELECT rebuild_financial_entity_ie_totals().)
ALTER FUNCTION rebuild_financial_entity_ie_totals() SET statement_timeout = '10min';
