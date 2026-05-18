-- 20260518000001_egress_stale_after_14d.sql
-- FIX-296: set the manual-update cadence for Supabase egress to 14 days.
--
-- Egress is the one platform_usage row with no public API path
-- (has_public_api=false on the row's matching platform_limits — set when egress
-- was first seeded). The 14-day window matches how often Craig is willing to
-- pull the number from supabase.com/dashboard manually. The dashboard's
-- ManualMetricsPanel (FIX-296) reads stale_after_days off this row and
-- renders an "overdue" banner once verified_at is older than that.

UPDATE public.platform_usage
   SET stale_after_days = 14
 WHERE service = 'supabase'
   AND metric = 'egress_bytes'
   AND (stale_after_days IS DISTINCT FROM 14);
