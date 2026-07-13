-- FIX-695: install the increment_service_usage RPC.
--
-- Called at apps/civitics/app/api/track-usage/route.ts:32 as
--   rpc("increment_service_usage", { p_service, p_metric, p_period })
-- but the function was never installed (confirmed ABSENT on local + prod
-- 2026-07-12). Service usage was therefore never recorded: the call errored
-- silently behind `db as any` and the route's catch-all `return { ok: true }`.
--
-- Upserts into the existing service_usage table (0006_service_usage.sql). Its
-- real unique constraint is service_usage_service_metric_period_key
-- UNIQUE (service, metric, period) — verified on prod + local 2026-07-12. First
-- hit of a (service, metric, period) tuple inserts a row with count = 1 (column
-- DEFAULT); every repeat increments count. No change to the service_usage shape.
--
-- The route calls this exclusively through createAdminClient() (service_role,
-- which bypasses RLS), so EXECUTE is restricted to service_role — usage counters
-- must not be publicly incrementable by anon/authenticated.

CREATE OR REPLACE FUNCTION public.increment_service_usage(
  p_service text,
  p_metric  text,
  p_period  text
)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO public.service_usage (service, metric, period, count)
  VALUES (p_service, p_metric, p_period, 1)
  ON CONFLICT (service, metric, period)
  DO UPDATE SET count = service_usage.count + 1;
$$;

-- Supabase default privileges GRANT EXECUTE on every new public function to
-- anon + authenticated + service_role. This is a write-counter that must only be
-- driven server-side by the track-usage route's admin client (service_role), so
-- strip anon + authenticated explicitly (REVOKE FROM PUBLIC alone does NOT remove
-- the per-role grants the default-privilege rule adds). Otherwise anyone holding
-- the publishable key could POST /rest/v1/rpc/increment_service_usage directly and
-- bypass the route's service/metric allow-list.
REVOKE ALL ON FUNCTION public.increment_service_usage(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_service_usage(text, text, text) TO service_role;
