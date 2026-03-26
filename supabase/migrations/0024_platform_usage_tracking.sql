-- 0024_platform_usage_tracking.sql
-- DB-driven platform usage tracking system
-- Replaces the static Monthly Spend Tracker on the dashboard

-- ── platform_limits ──────────────────────────────────────────────────────────
-- Stores what each service allows at each plan tier

CREATE TABLE IF NOT EXISTS platform_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
    -- 'vercel', 'supabase', 'anthropic', 'cloudflare', 'mapbox', 'resend'
  metric TEXT NOT NULL,
    -- 'fluid_cpu_seconds', 'egress_bytes', etc.
  plan TEXT NOT NULL DEFAULT 'free',
    -- 'free', 'pro', 'team', 'enterprise'

  -- Included before charges
  included_limit NUMERIC NOT NULL,
  unit TEXT NOT NULL,
    -- 'bytes', 'seconds', 'requests', 'usd', 'minutes', 'events'

  -- Overage pricing
  -- NULL = hard limit (no overages, service restricts/stops)
  overage_unit_cost NUMERIC DEFAULT NULL,
    -- cost per overage_unit, e.g. 0.09 (dollars)
  overage_unit TEXT DEFAULT NULL,
    -- 'per_gb', 'per_1m_requests', 'per_minute', 'per_usd'
  overage_cap NUMERIC DEFAULT NULL,
    -- NULL = no cap on overages; set value = spend cap limit

  -- Display
  display_label TEXT,       -- "Fluid Active CPU"
  display_group TEXT,       -- "Compute", "Networking", "Storage"
  warning_pct INTEGER DEFAULT 80,
  critical_pct INTEGER DEFAULT 95,
  billing_cycle TEXT DEFAULT 'monthly_reset',
    -- 'monthly_reset', 'rolling_30d', 'cumulative'
  sort_order INTEGER DEFAULT 0,
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(service, metric, plan)
);

-- ── platform_usage ────────────────────────────────────────────────────────────
-- Stores actual measured values

CREATE TABLE IF NOT EXISTS platform_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
  metric TEXT NOT NULL,
  value NUMERIC NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,

  -- SOURCE FLAG (critical):
  -- Shows HOW we got this number so users know how to trust it
  source TEXT NOT NULL DEFAULT 'manual',
    -- 'api'       = fetched live from service API (most accurate)
    -- 'webhook'   = pushed to us by the service (very accurate)
    -- 'estimated' = calculated from our own logs (accuracy ~±15%)
    -- 'manual'    = hand-entered from service dashboard (needs re-verification)

  -- Verification tracking (only relevant for 'manual' source entries)
  verified_at TIMESTAMPTZ DEFAULT NULL,
    -- NULL = never verified; set when admin confirms value against service UI
  verified_by TEXT DEFAULT NULL,
    -- 'admin' for now; future: user email

  -- Stale threshold in days
  -- After this: show warning. NULL = never goes stale (for api/webhook sources)
  stale_after_days INTEGER DEFAULT NULL,

  recorded_at TIMESTAMPTZ DEFAULT NOW(),

  -- Only one entry per service+metric per period
  UNIQUE(service, metric, period_start)
);

-- RLS: public read (transparency page is public)
ALTER TABLE platform_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read limits" ON platform_limits FOR SELECT USING (true);
CREATE POLICY "public read usage" ON platform_usage FOR SELECT USING (true);

-- ── Helper function ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_current_usage(
  p_service TEXT,
  p_metric TEXT
)
RETURNS TABLE(
  value NUMERIC,
  source TEXT,
  verified_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ,
  stale_after_days INTEGER
) AS $$
  SELECT
    value, source, verified_at, recorded_at, stale_after_days
  FROM platform_usage
  WHERE service = p_service
    AND metric = p_metric
    AND period_start = date_trunc('month', NOW())
  ORDER BY recorded_at DESC
  LIMIT 1;
$$ LANGUAGE SQL STABLE;

-- ── Seed: Vercel FREE limits ──────────────────────────────────────────────────

INSERT INTO platform_limits (
  service, metric, plan, included_limit, unit,
  overage_unit_cost, overage_unit,
  display_label, display_group, sort_order, notes
) VALUES
('vercel','fluid_cpu_seconds','free', 14400, 'seconds',
  NULL, NULL, 'Fluid Active CPU', 'Compute', 1,
  '4 hours = 14,400 seconds. Hard limit.'),
('vercel','function_invocations','free', 1000000, 'requests',
  NULL, NULL, 'Function Invocations', 'Compute', 2, NULL),
('vercel','origin_transfer_bytes','free', 10737418240, 'bytes',
  NULL, NULL, 'Fast Origin Transfer', 'Networking', 3, '10 GB hard limit'),
('vercel','edge_requests','free', 1000000, 'requests',
  NULL, NULL, 'Edge Requests', 'Networking', 4, NULL),
('vercel','edge_cpu_ms','free', 3600000, 'ms',
  NULL, NULL, 'Edge Request CPU', 'Compute', 5, '1 hour = 3,600,000ms'),
('vercel','build_minutes','free', 6000, 'minutes',
  NULL, NULL, 'Build Minutes', 'Build', 6, NULL),
('vercel','web_analytics_events','free', 50000, 'events',
  NULL, NULL, 'Web Analytics Events', 'Analytics', 7, NULL),
('vercel','isr_reads','free', 1000000, 'reads',
  NULL, NULL, 'ISR Reads', 'Edge Cache', 8, NULL),
('vercel','fluid_memory_gb_hrs','free', 360, 'gb_hours',
  NULL, NULL, 'Fluid Provisioned Memory', 'Compute', 9, '360 GB-Hrs'),

-- Vercel PRO limits (for future upgrade)
('vercel','fluid_cpu_seconds','pro', 3600000, 'seconds',
  NULL, NULL, 'Fluid Active CPU', 'Compute', 1, '1000 hours'),
('vercel','function_invocations','pro', -1, 'requests',
  NULL, NULL, 'Function Invocations', 'Compute', 2, 'Unlimited (-1)'),
('vercel','origin_transfer_bytes','pro', 1099511627776, 'bytes',
  0.15, 'per_gb', 'Fast Origin Transfer', 'Networking', 3,
  '1 TB included, $0.15/GB over'),

-- Supabase FREE limits
('supabase','egress_bytes','free', 5368709120, 'bytes',
  NULL, NULL, 'Database Egress', 'Networking', 1, '5 GB hard limit'),
('supabase','db_size_bytes','free', 524288000, 'bytes',
  NULL, NULL, 'Database Size', 'Storage', 2, '500 MB hard limit'),
('supabase','storage_bytes','free', 1073741824, 'bytes',
  NULL, NULL, 'File Storage', 'Storage', 3, '1 GB hard limit'),

-- Supabase PRO limits
('supabase','egress_bytes','pro', 268435456000, 'bytes',
  0.09, 'per_gb', 'Database Egress', 'Networking', 1,
  '250 GB included, $0.09/GB over'),
('supabase','db_size_bytes','pro', 8589934592, 'bytes',
  0.125, 'per_gb', 'Database Size', 'Storage', 2,
  '8 GB included, $0.125/GB over'),

-- Anthropic (self-imposed budget)
('anthropic','monthly_spend_usd','free', 3.50, 'usd',
  1.00, 'per_usd', 'Monthly AI Spend', 'AI', 1,
  'Self-imposed budget. Overage = actual cost.'),

-- Cloudflare R2 FREE
('cloudflare','storage_bytes','free', 10737418240, 'bytes',
  0.015, 'per_gb', 'R2 Storage', 'Storage', 1,
  '10 GB free, $0.015/GB over'),
('cloudflare','class_a_ops','free', 1000000, 'requests',
  0.0045, 'per_1m', 'R2 Write Operations', 'Storage', 2,
  '1M free, $0.0045/1M over'),
('cloudflare','class_b_ops','free', 10000000, 'requests',
  0.00036, 'per_1m', 'R2 Read Operations', 'Storage', 3,
  '10M free, $0.00036/1M over'),

-- Mapbox FREE
('mapbox','map_loads','free', 50000, 'requests',
  0.0005, 'per_request', 'Monthly Map Loads', 'Maps', 1,
  '50K free, $0.50/1K over')

ON CONFLICT (service, metric, plan) DO NOTHING;

-- ── Seed: current known usage ─────────────────────────────────────────────────
-- From Vercel/Supabase dashboards as of March 24, 2026

INSERT INTO platform_usage (
  service, metric, value,
  source, verified_at, verified_by,
  stale_after_days, period_start
) VALUES
-- Vercel (manually entered from dashboard Mar 24)
('vercel','fluid_cpu_seconds', 29220, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),
  -- 8h7m = 29,220 seconds
('vercel','function_invocations', 1500000, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),
('vercel','origin_transfer_bytes', 10027008819, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),
  -- 9.34 GB
('vercel','edge_requests', 810000, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),
('vercel','web_analytics_events', 347, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),
('vercel','isr_reads', 453, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),
('vercel','fluid_memory_gb_hrs', 155, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),

-- Supabase (from dashboard)
('supabase','egress_bytes', 3758096384, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),
  -- 3.5 GB (was 7.1GB but billing cycle may reset)
('supabase','db_size_bytes', 148373504, 'manual',
  NOW(), 'admin', 7, date_trunc('month', NOW())),
  -- 141.5 MB

-- Anthropic (from API — will be overwritten by route on each request)
('anthropic','monthly_spend_usd', 0.5982, 'api',
  NOW(), 'system', NULL, date_trunc('month', NOW())),

-- Mapbox (from service_usage table)
('mapbox','map_loads', 8, 'estimated',
  NULL, NULL, 30, date_trunc('month', NOW()))

ON CONFLICT (service, metric, period_start)
DO UPDATE SET
  value = EXCLUDED.value,
  source = EXCLUDED.source,
  verified_at = EXCLUDED.verified_at,
  recorded_at = NOW();
