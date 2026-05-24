-- 20260524090929_supabase_prometheus.sql
-- FIX-349 + FIX-350: Supabase Prometheus metrics + autopopulate egress.
--
-- Three changes:
--
-- 1. New table `supabase_prometheus_state` — single-row-per-tracked-counter
--    helper that turns Prometheus monotonic counters into a month-to-date
--    delta. Only counters need a state row; gauges are read directly. Today
--    that means one row, for `node_network_transmit_bytes_total` (egress).
--    Schema mirrors the helper logic in
--    packages/db/src/supabase-prometheus.ts.
--
-- 2. Flip `platform_limits.has_public_api = true` on
--    (service='supabase', metric='egress_bytes'). The inline comment in
--    supabase-usage.ts (May 2026) called egress "not exposed by any public
--    Supabase API" — the Prometheus endpoint at
--    /customer/v1/privileged/metrics rebuts that. SourceDisplay rendering
--    in PlatformCostsSection will start treating the row as live-sourced.
--    Cross-ref: FIX-190 (original "egress is manual-only" investigation),
--    FIX-296 (the ManualMetricsPanel deletion which removed the
--    manual-entry UI fallback this PR replaces).
--
-- 3. New `platform_limits` row: (supabase, db_connections, pro). Surfaces
--    pg_stat_database_num_backends as a pure gauge in the Performance
--    display_group. No overage cost (auto-trip wiring is deliberately
--    deferred — see prompt decision #7 + the FIX-286 evaluator pattern).
--    Pro 8 GB compute pool default is 60 direct connections + 200 via
--    pgBouncer per https://supabase.com/docs/guides/database/connection-management
--    — included_limit set to 60 since the Prometheus metric counts direct
--    Postgres backends.

CREATE TABLE IF NOT EXISTS public.supabase_prometheus_state (
  metric            TEXT PRIMARY KEY,
  baseline_value    BIGINT NOT NULL,
  baseline_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_raw_value    BIGINT NOT NULL,
  last_scraped_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.supabase_prometheus_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin only" ON public.supabase_prometheus_state
  FOR ALL USING (false);

GRANT SELECT, INSERT, UPDATE ON public.supabase_prometheus_state TO service_role;

UPDATE public.platform_limits
   SET has_public_api = true
 WHERE service = 'supabase'
   AND metric  = 'egress_bytes';

INSERT INTO public.platform_limits (
  service, metric, plan, included_limit, unit,
  overage_unit_cost, overage_unit,
  display_label, display_group, sort_order, notes,
  billing_cycle, has_public_api
) VALUES
('supabase', 'db_connections', 'free', 60, 'connections',
  NULL, NULL,
  'DB connections (active)', 'Performance', 9,
  'Approx. direct Postgres backend slots on Free compute',
  'realtime', true),
('supabase', 'db_connections', 'pro', 60, 'connections',
  NULL, NULL,
  'DB connections (active)', 'Performance', 9,
  'Approx. direct Postgres backend slots on Pro 8 GB compute. Pure gauge — no overage.',
  'realtime', true)
ON CONFLICT (service, metric, plan) DO NOTHING;
