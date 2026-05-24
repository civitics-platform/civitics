-- 20260524200436_platform_limits_display_limit.sql
-- FIX-353: separate billing-overage denominator from capacity-bar denominator.
--
-- platform_limits.included_limit currently doubles as (a) the billing
-- overage threshold that drives cost math and (b) the bar-denominator that
-- drives the dashboard's % display. For most metrics that's correct, but
-- supabase.db_size_bytes legitimately needs different numbers for each:
--   - billing: 8 GB Pro plan included quota → $0.125/GB above
--   - display: ~24 GB provisioned disk size → bar shows real capacity %
--
-- display_limit is an optional override. When NULL, behavior is unchanged
-- (effectiveLimit() falls back to included_limit). When set, getPlatformUsage
-- divides value/display_limit for the pct field while overage_cost continues
-- to use included_limit.

ALTER TABLE public.platform_limits
  ADD COLUMN IF NOT EXISTS display_limit BIGINT;

COMMENT ON COLUMN public.platform_limits.display_limit IS
  'Optional override for the %-bar denominator. When non-NULL, dashboard '
  '% bar uses display_limit instead of included_limit. included_limit '
  'still drives overage cost math. Use when the same metric needs '
  'different denominators for capacity (display) vs billing (cost).';
