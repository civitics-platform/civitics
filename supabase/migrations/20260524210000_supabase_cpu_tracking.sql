-- 20260524210000_supabase_cpu_tracking.sql
-- FIX-355 + FIX-356: Supabase CPU % tracking with windowed max.
--
-- Adds one platform_limits row for the new metric and one RPC that summarises
-- recent platform_usage_snapshot rows. The TS helper (FIX-355) writes the
-- per-tick CPU % via the same counter-delta path FIX-349 introduced for
-- egress; this migration is just the schema + display config.
--
-- supabase_prometheus_state already carries last_scraped_at (FIX-349). The
-- CPU helper uses that to compute the wall-clock interval between scrapes,
-- but the math actually lands as busy_delta / total_delta (both sums of
-- node_cpu_seconds_total across all modes + cores), so num_cores cancels
-- and we never have to read a tier-specific constant.
--
-- Two new rows will appear inside supabase_prometheus_state at first tick
-- (cpu_busy_seconds_total, cpu_total_seconds_total) via applyCounterDelta —
-- no manual seed needed.

INSERT INTO public.platform_limits (
  service, metric, plan, included_limit, unit,
  overage_unit_cost, overage_unit,
  display_label, display_group, sort_order, notes,
  billing_cycle, has_public_api
) VALUES
('supabase', 'cpu_pct', 'free', 100, 'percent',
  NULL, NULL,
  'CPU usage', 'Performance', 10,
  'Current snapshot. Sub-text shows max in last 1h + 24h.',
  'realtime', true),
('supabase', 'cpu_pct', 'pro', 100, 'percent',
  NULL, NULL,
  'CPU usage', 'Performance', 10,
  'Current snapshot. Sub-text shows max in last 1h + 24h.',
  'realtime', true)
ON CONFLICT (service, metric, plan) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_supabase_cpu_max(window_minutes INT)
RETURNS DOUBLE PRECISION
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    MAX((payload->'supabase_cpu'->>'current_pct')::DOUBLE PRECISION),
    0
  )
    FROM platform_usage_snapshot
   WHERE fetched_at >= NOW() - (window_minutes || ' minutes')::INTERVAL
     AND payload ? 'supabase_cpu'
     AND payload->'supabase_cpu' ? 'current_pct';
$$;

ALTER FUNCTION public.get_supabase_cpu_max(INT)
  SET statement_timeout = '5s';

GRANT EXECUTE ON FUNCTION public.get_supabase_cpu_max(INT)
  TO authenticated, service_role;
