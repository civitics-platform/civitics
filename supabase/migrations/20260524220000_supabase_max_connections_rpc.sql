-- FIX-357: expose Postgres max_connections to the platform-snapshot job.
--
-- The db_connections gauge measures pg_stat_database_num_backends — bounded by
-- Postgres's max_connections, not PgBouncer's default_pool_size. FIX-354's
-- tier→pool-size lookup was the wrong axis (15 vs the real 60 on Micro produced
-- a 120% red bar at 18 backends). Querying max_connections directly is
-- self-correcting on tier upgrades and removes the Management API call + tier
-- cache + lookup table maintained in supabase-usage.ts.
--
-- Same SECURITY DEFINER + STABLE + SET search_path shape as
-- get_supabase_auth_mau() (FIX-295).

CREATE OR REPLACE FUNCTION public.get_supabase_max_connections()
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT current_setting('max_connections')::INT;
$$;

GRANT EXECUTE ON FUNCTION public.get_supabase_max_connections()
  TO authenticated, service_role;
