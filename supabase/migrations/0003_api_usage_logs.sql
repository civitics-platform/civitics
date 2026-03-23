-- =============================================================================
-- Civitics Platform — API Usage Logs
-- Phase 1: Accountability dashboard cost tracking
--
-- Records every external API call made by the platform.
-- Powers the public accountability dashboard's cost/usage sections.
-- Enables transparent reporting of what the platform spends on AI and services.
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_usage_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  service       TEXT        NOT NULL,    -- 'anthropic', 'resend', 'mapbox', 'vercel', etc.
  endpoint      TEXT,                    -- specific endpoint or operation called
  model         TEXT,                    -- for Anthropic: 'claude-haiku-4-5', 'claude-sonnet-4-6', etc.
  tokens_used   INTEGER,                 -- input + output tokens (Anthropic)
  input_tokens  INTEGER,                 -- input tokens (added to table from 0010)
  output_tokens INTEGER,                 -- output tokens (added to table from 0010)
  cost_cents    INTEGER     NOT NULL DEFAULT 0,  -- cost in US cents (integer, never float)
  metadata      JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_usage_logs_service_idx    ON api_usage_logs(service);
CREATE INDEX IF NOT EXISTS api_usage_logs_created_at_idx ON api_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS api_usage_logs_model_idx      ON api_usage_logs(model) WHERE model IS NOT NULL;

-- RLS: publicly readable (dashboard is public), no public writes
ALTER TABLE api_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_usage_logs_public_read"
  ON api_usage_logs FOR SELECT USING (true);

-- =============================================================================
-- HELPER: get_database_size_bytes()
-- Returns current database size in bytes.
-- Used by the accountability dashboard for Supabase tier tracking.
-- SECURITY DEFINER so it can be called with publishable key via RPC.
-- =============================================================================

CREATE OR REPLACE FUNCTION get_database_size_bytes()
RETURNS BIGINT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_database_size(current_database());
$$;
