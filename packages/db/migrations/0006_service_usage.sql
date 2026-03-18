-- =============================================================================
-- Civitics Platform — Service Usage Tracking
-- Phase 1: Track usage for services whose APIs don't expose free-tier metrics.
--
-- Tracks: Mapbox map loads, R2 read/write ops, Vercel deployments.
-- Mapbox is the primary driver — 50k loads/month free, then $0.50/1k.
-- Dashboard reads this table to show usage vs. free tier limits.
--
-- Pattern: upsert by (service, metric, period) incrementing count.
-- period format: 'YYYY-MM' (e.g. '2026-03')
-- =============================================================================

CREATE TABLE IF NOT EXISTS service_usage (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  service    TEXT        NOT NULL,   -- 'mapbox', 'r2', 'vercel'
  metric     TEXT        NOT NULL,   -- 'map_load', 'file_read', 'file_write', 'deployment'
  count      INTEGER     NOT NULL DEFAULT 1,
  period     TEXT        NOT NULL,   -- 'YYYY-MM'
  metadata   JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service, metric, period)
);

CREATE INDEX service_usage_period_idx ON service_usage (period);

-- RLS: public read (dashboard is public), writes via admin client only
ALTER TABLE service_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_usage_public_read"
  ON service_usage FOR SELECT TO anon USING (true);
