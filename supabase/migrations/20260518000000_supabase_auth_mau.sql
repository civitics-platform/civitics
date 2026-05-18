-- 20260518000000_supabase_auth_mau.sql
-- FIX-295: track Supabase Auth MAUs alongside db_size / storage / api_requests.
--
-- Pro tier includes 100k MAUs and bills $0.00325 per MAU above that. Free tier
-- is a hard 50k cap. Without this row the dashboard reports overage_cost=$0 for
-- auth usage, which underrepresents the actual Supabase line item as the user
-- base grows.
--
-- Counting strategy: a thin SECURITY DEFINER RPC over auth.users counts every
-- user whose last_sign_in_at is within the last 30 days. Mirrors the
-- get_supabase_self_metrics() pattern (FIX-281) — service_role calls the RPC,
-- saves a round trip through the Management API, and dodges the per-token
-- analytics rate-limit budget.
--
-- The 30-day rolling window matches Supabase's internal billing-MAU definition
-- ("active user" = signed in at least once in the last 30 days). Resets
-- nominally each calendar month for billing, but the count itself is rolling.

CREATE OR REPLACE FUNCTION public.get_supabase_auth_mau()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COUNT(*)::BIGINT
    FROM auth.users
   WHERE last_sign_in_at >= NOW() - INTERVAL '30 days';
$$;

GRANT EXECUTE ON FUNCTION public.get_supabase_auth_mau()
  TO authenticated, service_role;

-- Free: 50k included, hard cap (no overage column → NULL).
-- Pro:  100k included, $0.00325/MAU over. Source: supabase.com/pricing.
INSERT INTO public.platform_limits (
  service, metric, plan, included_limit, unit,
  overage_unit_cost, overage_unit,
  display_label, display_group, sort_order, notes,
  billing_cycle, has_public_api
) VALUES
('supabase', 'auth_mau', 'free', 50000, 'users',
  NULL, NULL,
  'Auth MAUs (rolling 30d)', 'Auth', 8,
  '50k included on Free, hard limit',
  'monthly_reset', true),
('supabase', 'auth_mau', 'pro', 100000, 'users',
  0.00325, 'per_request',
  'Auth MAUs (rolling 30d)', 'Auth', 8,
  '100k included on Pro, $0.00325/MAU above',
  'monthly_reset', true)
ON CONFLICT (service, metric, plan) DO NOTHING;
