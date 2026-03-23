-- =============================================================================
-- Migration 0004: financial_entities table + entity_connections unique constraint
--
-- financial_entities: graph nodes representing donor entities (PACs, corporations,
-- individuals). Separate from financial_relationships (the raw transactions).
-- These become the diamond-shaped nodes in the connection graph.
--
-- entity_connections unique constraint: required for upsert in the connections
-- derivation pipeline. Each (from_id, to_id, connection_type) triple is unique.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- financial_entities
-- Donors as first-class graph nodes. Created by the connections pipeline.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS financial_entities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  entity_type         TEXT NOT NULL,  -- individual | pac | super_pac | corporation | party | other
  industry            TEXT,
  total_donated_cents BIGINT NOT NULL DEFAULT 0,
  source_ids          JSONB NOT NULL DEFAULT '{}',
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, entity_type)
);

CREATE INDEX IF NOT EXISTS financial_entities_name ON financial_entities(name);
CREATE INDEX IF NOT EXISTS financial_entities_entity_type ON financial_entities(entity_type);
CREATE INDEX IF NOT EXISTS financial_entities_total_donated ON financial_entities(total_donated_cents DESC);
CREATE INDEX IF NOT EXISTS financial_entities_updated_at ON financial_entities(updated_at);

CREATE TRIGGER financial_entities_updated_at
  BEFORE UPDATE ON financial_entities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE financial_entities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_financial_entities_select"
  ON financial_entities FOR SELECT
  USING (true);

-- ---------------------------------------------------------------------------
-- entity_connections: unique constraint for upsert support
-- One connection record per (from_id, to_id, connection_type) triple.
-- Strength and evidence are updated on conflict.
-- ---------------------------------------------------------------------------

ALTER TABLE entity_connections
  ADD CONSTRAINT entity_connections_unique_triple
  UNIQUE (from_id, to_id, connection_type);