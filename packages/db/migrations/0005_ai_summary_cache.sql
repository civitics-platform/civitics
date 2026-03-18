-- =============================================================================
-- Civitics Platform — AI Summary Cache
-- Phase 1: Plain language summaries generated once on ingestion, served free.
--
-- Cache key: entity_type + entity_id + summary_type (composite unique).
-- Summaries are generated once and read by unlimited users at no cost.
-- Never regenerate if a row exists — check cache first.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_summary_cache (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT        NOT NULL,   -- 'proposal', 'official', 'agency'
  entity_id    UUID        NOT NULL,   -- FK to the source entity
  summary_type TEXT        NOT NULL,   -- 'bill', 'regulation', 'official'
  summary_text TEXT        NOT NULL,
  model        TEXT        NOT NULL,   -- model used to generate
  tokens_used  INTEGER,                -- input + output tokens
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_id, summary_type)
);

CREATE INDEX ai_summary_cache_entity_idx
  ON ai_summary_cache (entity_type, entity_id);

-- RLS: publicly readable (summaries are a public good), no public writes
ALTER TABLE ai_summary_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_summary_cache_public_read"
  ON ai_summary_cache FOR SELECT TO anon USING (true);
