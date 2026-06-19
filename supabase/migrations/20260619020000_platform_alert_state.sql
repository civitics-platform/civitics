-- FIX-γ — Edge-triggered threshold-crossing alert state.
--
-- The platform-snapshot cron (every 10 min) already emails on kill-switch
-- auto-trip flips. This table debounces per-metric threshold alerts so the cron
-- emails ONCE on escalation (healthy→warning, healthy→critical, warning→critical)
-- instead of every 10 minutes while a metric sits in the same band.
--
-- One row per metric_key ("<service>.<metric>"). The cron compares each metric's
-- current status to last_status: escalation → send + update; de-escalation or
-- unchanged → update silently. source='estimated' metrics are skipped by the
-- caller (e.g. the NIC egress proxy), so they never land here.
--
-- RLS/grants mirror supabase_prometheus_state: deny-all policy, service_role
-- gets SELECT/INSERT/UPDATE (the cron uses the admin/service_role client).

CREATE TABLE IF NOT EXISTS public.platform_alert_state (
  metric_key      TEXT PRIMARY KEY,
  last_status     TEXT NOT NULL,
  last_alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.platform_alert_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin only" ON public.platform_alert_state
  FOR ALL USING (false);

GRANT SELECT, INSERT, UPDATE ON public.platform_alert_state TO service_role;
