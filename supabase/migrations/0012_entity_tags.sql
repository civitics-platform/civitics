-- Migration 0012: entity_tags table + pipeline_state table
-- Run in Supabase SQL editor before running tag pipelines.
--
-- DOWN: DROP TABLE entity_tags; DROP TABLE pipeline_state;

-- ── entity_tags ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entity_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  entity_type TEXT NOT NULL,
  -- 'proposal', 'official', 'agency', 'financial_entity'

  entity_id UUID NOT NULL,

  tag TEXT NOT NULL,
  -- always lowercase_with_underscores
  -- e.g. 'climate', 'closing_soon', 'pac_heavy', 'bipartisan'

  tag_category TEXT NOT NULL,
  -- 'topic'    : climate, healthcare
  -- 'urgency'  : closing_soon, urgent
  -- 'scope'    : national, local, state
  -- 'audience' : veterans, small_business
  -- 'pattern'  : bipartisan, pac_heavy
  -- 'industry' : pharma, oil_gas, finance
  -- 'size'     : large_donor, grassroots
  -- 'quality'  : technical, accessible
  -- 'internal' : pipeline metadata, confidence scores, debug info

  display_label TEXT NOT NULL,
  -- Human readable: 'Climate' not 'climate', 'Closing Soon' not 'closing_soon'

  display_icon TEXT,
  -- Single emoji for visual scanning; null for internal tags

  visibility TEXT NOT NULL DEFAULT 'secondary',
  -- 'primary'  : always shown, max 3 per card, confidence >= 0.8
  -- 'secondary': shown on expand (+N more), confidence >= 0.7
  -- 'internal' : two clicks deep, researchers only, with warning blurb

  generated_by TEXT NOT NULL,
  -- 'rule'   : deterministic rule, confidence always 1.0
  -- 'ai'     : Claude Haiku classified
  -- 'manual' : human added

  confidence DECIMAL(3,2) DEFAULT 1.0,
  -- 0.00 to 1.00
  -- rule-based: always 1.0
  -- ai: model's confidence score
  -- < 0.7 → forced to internal regardless of visibility setting

  ai_model TEXT,
  -- 'claude-haiku-4-5-20251001' if generated_by = 'ai'
  -- null if rule-based or manual

  pipeline_version TEXT,
  -- 'v1', 'v2' etc. for debugging tag quality over time

  metadata JSONB DEFAULT '{}',
  -- timing flags: {"days_before_vote": 65}
  -- ai reasoning: {"reasoning": "Title mentions clean water standards"}

  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (entity_type, entity_id, tag, tag_category)
  -- Prevent duplicate tags. Safe to upsert on this constraint.
);

-- ── Row-level security ────────────────────────────────────────────────────────

ALTER TABLE entity_tags ENABLE ROW LEVEL SECURITY;

-- Public can read all tags — transparency is the mission
CREATE POLICY "public_read_tags"
ON entity_tags FOR SELECT
TO anon, authenticated
USING (true);

-- Only service role (admin client) can write — pipelines only

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_entity_tags_entity
  ON entity_tags (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_tags_tag
  ON entity_tags (tag, tag_category);

CREATE INDEX IF NOT EXISTS idx_entity_tags_visibility
  ON entity_tags (visibility, confidence);

CREATE INDEX IF NOT EXISTS idx_entity_tags_topic
  ON entity_tags (tag_category, tag)
  WHERE tag_category = 'topic';

-- ── pipeline_state ────────────────────────────────────────────────────────────
-- Stores key-value state for the data pipeline system.
-- Used by the delta connections runner to know what has already been processed.

CREATE TABLE IF NOT EXISTS pipeline_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pipeline_state ENABLE ROW LEVEL SECURITY;

-- No public read — internal pipeline metadata only
-- Only service role (admin client) can read/write
