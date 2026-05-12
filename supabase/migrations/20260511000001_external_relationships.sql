-- =============================================================================
-- FIX-251 · external_relationships — polymorphic edge buffer for non-FEC,
-- non-USAspending relationship sources (initially LittleSis; later
-- OpenCorporates, Open Ownership). Mirrors the shape of
-- financial_relationships / entity_connections so rebuild_entity_connections()
-- can aggregate from it the same way.
--
-- LittleSis attribution: rows whose source='littlesis' contain data derived
-- from LittleSis (https://littlesis.org), licensed CC-BY-SA 4.0
-- (https://creativecommons.org/licenses/by-sa/4.0/). Any derivative dataset
-- Civitics publishes that contains these rows must also be licensed
-- CC-BY-SA 4.0 and attribute LittleSis.
-- =============================================================================

-- ── external_relationships ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.external_relationships (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  source            TEXT NOT NULL,                       -- 'littlesis' | 'opencorporates' | ...
  source_id         TEXT NOT NULL,                       -- e.g. LittleSis relationship.id as text
  source_url        TEXT,                                -- back-link, e.g. https://littlesis.org/relationships/12345
  source_updated_at TIMESTAMPTZ,                         -- from LittleSis updated_at

  -- Polymorphic FROM / TO. Same shape as entity_connections.
  from_type         TEXT NOT NULL,                       -- 'official' | 'financial_entity' | 'agency' | 'governing_body'
  from_id           UUID NOT NULL,
  to_type           TEXT NOT NULL,
  to_id             UUID NOT NULL,

  -- Pre-mapped at ingest time using the CATEGORY_TO_CONNECTION_TYPE map in
  -- packages/data/src/pipelines/littlesis/util.ts. Keeps the RPC simple.
  connection_type   public.connection_type NOT NULL,

  raw_category      TEXT NOT NULL,                       -- '1' | '3' | '6' | '7' | '10' | '11' | '12'
  raw_category_name TEXT,                                -- 'Position' | 'Membership' | ...

  description       TEXT,                                -- description1 / description2 joined
  amount_cents      BIGINT,
  occurred_at       DATE,
  ended_at          DATE,
  is_current        BOOLEAN,

  match_confidence  TEXT NOT NULL,                       -- 'high' | 'medium'  (low confidence stays in review queue)
  metadata          JSONB NOT NULL DEFAULT '{}',
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency arbiter: re-running the pipeline on the same dump leaves zero new rows.
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS external_relationships_from
  ON public.external_relationships(from_type, from_id);
CREATE INDEX IF NOT EXISTS external_relationships_to
  ON public.external_relationships(to_type, to_id);
CREATE INDEX IF NOT EXISTS external_relationships_connection_type
  ON public.external_relationships(connection_type);
CREATE INDEX IF NOT EXISTS external_relationships_source
  ON public.external_relationships(source);

COMMENT ON TABLE public.external_relationships IS
  'Polymorphic edge buffer for non-financial, non-government relationship sources (LittleSis CC-BY-SA 4.0, future: OpenCorporates, Open Ownership). rebuild_entity_connections() aggregates this into entity_connections per (from,to,connection_type).';

ALTER TABLE public.external_relationships ENABLE ROW LEVEL SECURITY;
-- service_role bypasses RLS; no public policies. Read access from the app
-- goes via the materialized entity_connections rows (already public-readable).

-- ── external_relationships_review_queue ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.external_relationships_review_queue (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                 TEXT NOT NULL,                  -- 'littlesis'
  source_entity_id       TEXT,                           -- ambiguous LittleSis entity id (when entity match was the blocker)
  source_relationship_id TEXT,                           -- LittleSis rel id (when edge resolution couldn't pick a side)
  source_payload         JSONB NOT NULL,                 -- raw record we couldn't auto-resolve
  candidate_matches      JSONB NOT NULL,                 -- [{civitics_id, civitics_type, score, reason}]
  reason                 TEXT NOT NULL,                  -- 'multi_after_state_narrow' | 'too_many_lastname_hits' | 'multi_canonical_org' | ...
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending | resolved | rejected
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at            TIMESTAMPTZ,
  resolved_to_type       TEXT,
  resolved_to_id         UUID,
  resolution_notes       TEXT,

  -- Same idempotency arbiter as the main table so re-runs don't grow the queue.
  UNIQUE(source, source_entity_id, source_relationship_id)
);

CREATE INDEX IF NOT EXISTS exr_queue_status
  ON public.external_relationships_review_queue(status);
CREATE INDEX IF NOT EXISTS exr_queue_source
  ON public.external_relationships_review_queue(source, source_entity_id);

COMMENT ON TABLE public.external_relationships_review_queue IS
  'Ambiguous matches (multiple candidate Civitics entities, no narrowing breaks the tie) from external_relationships ingest. Drained by a future human-in-the-loop UI; never auto-linked.';

ALTER TABLE public.external_relationships_review_queue ENABLE ROW LEVEL SECURITY;
