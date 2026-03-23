-- Migration 0015: pipeline_cost_history table
-- Tracks AI pipeline runs with pre/post cost estimates for budget control.
-- Enables the cost gate system in @civitics/ai to show estimates, request
-- approval, and verify actual vs. estimated costs after each run.

-- UP:

CREATE TABLE IF NOT EXISTS pipeline_cost_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  pipeline_name TEXT NOT NULL,
  -- 'ai_summaries', 'ai_tagger', 'ai_classifier', etc.

  run_at TIMESTAMPTZ DEFAULT NOW(),

  entity_count INTEGER NOT NULL,
  -- how many entities were processed (or approved to process)

  -- Estimate (from sampling 3 real API calls before the run):
  estimated_cost_usd   DECIMAL(10, 6) NOT NULL,
  estimated_tokens_input  INTEGER,
  estimated_tokens_output INTEGER,
  sample_size INTEGER DEFAULT 3,

  -- Actual (recorded after the run completes):
  actual_cost_usd      DECIMAL(10, 6),  -- null until verified
  actual_tokens_input  INTEGER,
  actual_tokens_output INTEGER,

  -- Variance (actual / estimated; calculated after run):
  variance_ratio       DECIMAL(6, 4),
  -- 1.0 = perfect estimate, 1.5 = 50% over estimate, null until verified

  -- Run metadata:
  status TEXT DEFAULT 'running',
  -- 'running' | 'complete' | 'paused' | 'cancelled' | 'budget_exceeded'

  was_auto_approved    BOOLEAN DEFAULT false,
  paused_for_variance  BOOLEAN DEFAULT false,

  notes TEXT,
  -- any warnings or flags generated during the run

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_cost_history_pipeline
  ON pipeline_cost_history(pipeline_name, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_cost_history_run_at
  ON pipeline_cost_history(run_at DESC);

-- RLS: readable by dashboard (anon/authenticated), writable by service role only
ALTER TABLE pipeline_cost_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_cost_history"
  ON pipeline_cost_history
  FOR SELECT TO anon, authenticated
  USING (true);

-- DOWN:
-- DROP TABLE pipeline_cost_history;
