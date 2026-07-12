-- FIX-694 — restore increment_snapshot_view(), lost at the 2026-04-22
-- shadow→public promotion (the pre-cutover definition is preserved in
-- backup.sql lines 472-481). Call sites already exist and are fire-and-forget:
--   apps/civitics/app/api/graph/snapshot/route.ts  (share/embed view)
--   apps/civitics/app/graph/[code]/page.tsx        (shared-graph page)
--
-- SECURITY DEFINER so anon viewers bump the counter without needing an
-- UPDATE policy on graph_snapshots (public-read RLS stays intact).
CREATE OR REPLACE FUNCTION public.increment_snapshot_view(p_code text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.graph_snapshots
     SET view_count = view_count + 1
   WHERE code = p_code;
$$;

GRANT EXECUTE ON FUNCTION public.increment_snapshot_view(text) TO anon, authenticated, service_role;
