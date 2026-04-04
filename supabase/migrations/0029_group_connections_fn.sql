-- Migration 0029: RPC for group entity_connections (avoids large .in() URL limit)

CREATE OR REPLACE FUNCTION get_group_connections(
  p_member_ids UUID[],
  p_limit      INT DEFAULT 500
)
RETURNS TABLE (
  connection_type TEXT,
  to_id           UUID,
  strength        NUMERIC,
  amount_cents    BIGINT,
  from_id         UUID
) AS $$
  SELECT
    ec.connection_type,
    ec.to_id,
    ec.strength,
    ec.amount_cents,
    ec.from_id
  FROM entity_connections ec
  WHERE ec.from_id = ANY(p_member_ids)
  ORDER BY
    ec.amount_cents DESC NULLS LAST,
    ec.strength DESC
  LIMIT p_limit
$$ LANGUAGE SQL STABLE;
