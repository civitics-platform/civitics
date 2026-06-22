-- FIX-645: expose plum_book_state.last_change to anon via a narrow RPC.
--
-- institutions/[id] (AgencyView) read pipeline_state->'plum_book_state' through
-- createAdminClient() (the row is RLS service-role-only, no SELECT policy) just
-- to show a "data freshness" date on official cards (FIX-432). That admin read
-- forced the page to be force-dynamic. Exposing ONLY the last_change date via a
-- SECURITY DEFINER function lets the page render with the publishable client so
-- it can be ISR'd (FIX-645). No other pipeline_state contents are disclosed.

CREATE OR REPLACE FUNCTION public.get_plum_book_last_change()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (value->>'last_change')
    FROM public.pipeline_state
   WHERE key = 'plum_book_state'
   LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_plum_book_last_change() TO anon, authenticated, service_role;
