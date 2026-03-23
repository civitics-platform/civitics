-- =============================================================================
-- 0010_api_usage_logs_tokens.sql
-- Add per-call token breakdown to api_usage_logs.
-- Fixes inflated cost display caused by Math.ceil() rounding each call to 1¢.
-- cost_cents changed to DECIMAL(10,4) to store fractional cent values.
-- =============================================================================

ALTER TABLE api_usage_logs
  ADD COLUMN IF NOT EXISTS input_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens INTEGER;

-- Allow fractional cents (e.g. 0.0233 for a typical Haiku call)
ALTER TABLE api_usage_logs
  ALTER COLUMN cost_cents TYPE DECIMAL(10,4);

-- DOWN:
--   ALTER TABLE api_usage_logs ALTER COLUMN cost_cents TYPE INTEGER USING cost_cents::INTEGER;
--   ALTER TABLE api_usage_logs DROP COLUMN IF EXISTS input_tokens;
--   ALTER TABLE api_usage_logs DROP COLUMN IF EXISTS output_tokens;
