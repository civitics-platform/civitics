-- =============================================================================
-- TEMPORARY bgworker census sampler — catch the Monday/Wednesday starvation
-- window live.
--
-- WHAT THE LOGS ALREADY ESTABLISHED (Supabase Analytics postgres_logs, window
-- 2026-08-17 13:50-16:25 UTC). The mechanism is background-worker / postmaster
-- fork starvation, and it is visible in THREE independent message classes that
-- all mean "a process could not be started in time":
--
--   cron job 40 starting: SELECT public.enforce_derived_mvs_unit_budget();
--   cron job 40 job startup timeout                 <- exactly 10s later, every
--                                                      firing, for hours
--   autovacuum worker took too long to start; canceled
--   autovacuum worker started without a worker entry
--   could not accept SSL connection: EOF detected   <- clients abandoning during
--                                                      the TLS handshake
--
-- THE DECISIVE NEGATIVE RESULT: auto_explain.log_min_duration is 10000, so every
-- statement over 10s in that window WAS logged — and the only ones that appear
-- are Supabase's own platform telemetry (`SELECT SUM(pg_database_size(...))` at
-- 10.4s and 17.6s; the pg_stat_statements roll-ups at 12.7s, 13.5s, 13.9s,
-- 16.5s). No pipeline query, no user query, nothing of ours. That is exactly why
-- data_sync_log is silent for the 14:00-16:08 tail: none of our work was
-- running. The box was not busy with a query — it could not START processes.
--
-- THE STRUCTURAL OVER-SUBSCRIPTION, measured on prod:
--
--   max_worker_processes             12   (configuration file)
--   cron.max_running_jobs            32   (default — NOT overridable on Supabase)
--   max_parallel_workers              2
--   max_logical_replication_workers   4
--
-- pg_cron is permitted 32 concurrent job workers out of a 12-slot pool it shares
-- with parallel query and logical replication. Nothing enforces the difference,
-- so the ceiling is discovered at runtime as `job startup timeout`.
--
-- WHAT IS STILL UNKNOWN, AND WHY THIS SAMPLER EXISTS. The logs name the
-- MECHANISM but not the CONSUMER: they do not say which backends held the slots
-- from 14:00 to 16:08, after the EC rebuild's own backend was cancelled. Nothing
-- in pg_stat_activity is retained after the fact, so the only way to answer it
-- is to be sampling while it happens. Wednesday's 08:00 firing is the next
-- occurrence.
--
-- SELF-LIMITING BY CONSTRUCTION. This is diagnostic scaffolding, not a feature:
--   * the sampler no-ops after `expires_at` (48h), so a forgotten cron job costs
--     one trivial function call every 2 minutes and writes nothing;
--   * each sample is a handful of narrow rows (one per backend_type /
--     application_name / state / wait_event_type group), so 48h of sampling is
--     a few thousand small rows;
--   * the table is UNLOGGED — this is throwaway diagnostic data and it must not
--     add WAL to a box whose problem is that it cannot keep up.
--
-- Teardown is one line, recorded in the FIX bullet:
--   SELECT cron.unschedule('bgworker-census'); DROP TABLE public.bgworker_census;
-- =============================================================================

CREATE UNLOGGED TABLE IF NOT EXISTS public.bgworker_census (
  sampled_at       timestamptz NOT NULL DEFAULT now(),
  backend_type     text,
  application_name text,
  state            text,
  wait_event_type  text,
  n                int         NOT NULL,
  max_query_age_s  int
);

CREATE INDEX IF NOT EXISTS bgworker_census_sampled_at
  ON public.bgworker_census (sampled_at DESC);

COMMENT ON TABLE public.bgworker_census IS
  'TEMPORARY diagnostic (2026-08-18). Per-2-minute census of pg_stat_activity '
  'grouped by backend_type/application_name/state, to identify WHICH backends '
  'hold the background-worker slots during the Monday/Wednesday starvation '
  'window. Self-limiting: sample_bgworker_census() no-ops after its expires_at. '
  'Teardown: SELECT cron.unschedule(''bgworker-census''); DROP TABLE public.bgworker_census;';

CREATE OR REPLACE FUNCTION public.sample_bgworker_census()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_expires timestamptz;
BEGIN
  -- Self-limit. Absent key => never expire is WRONG for scaffolding, so an
  -- absent key means "expired": the sampler only runs while the marker says so.
  SELECT (value->>'expires_at')::timestamptz INTO v_expires
    FROM public.pipeline_state WHERE key = 'bgworker_census';

  IF v_expires IS NULL OR now() >= v_expires THEN
    RETURN;   -- no-op; costs one function call every 2 minutes
  END IF;

  INSERT INTO public.bgworker_census
    (sampled_at, backend_type, application_name, state, wait_event_type, n, max_query_age_s)
  SELECT now(),
         a.backend_type,
         left(COALESCE(a.application_name, ''), 40),
         a.state,
         a.wait_event_type,
         count(*)::int,
         COALESCE(max(EXTRACT(epoch FROM (clock_timestamp() - a.query_start)))::int, 0)
    FROM pg_stat_activity a
   WHERE a.pid <> pg_backend_pid()
   GROUP BY 1, 2, 3, 4, 5;
END;
$$;

REVOKE ALL ON FUNCTION public.sample_bgworker_census() FROM PUBLIC;
-- FIX-834: Supabase default-grants EXECUTE on new functions to anon/authenticated.
REVOKE EXECUTE ON FUNCTION public.sample_bgworker_census() FROM anon, authenticated;

COMMENT ON FUNCTION public.sample_bgworker_census() IS
  'TEMPORARY (2026-08-18). Writes one pg_stat_activity census row-group into '
  'bgworker_census. No-ops unless pipeline_state.bgworker_census.expires_at is '
  'in the future, so it disarms itself even if the cron job outlives the '
  'investigation.';

-- Arm for 48h — long enough to cover Wednesday 2026-08-19 08:00 UTC and its
-- tail, and to expire on its own well before the following Monday.
INSERT INTO public.pipeline_state (key, value)
VALUES ('bgworker_census', jsonb_build_object(
          'expires_at', (now() + interval '48 hours'),
          'armed_at',   now(),
          'why',        'FIX-1056 companion: identify which backends hold the bgworker '
                        'slots during the Mon/Wed starvation window. Read the census '
                        'Thursday, then unschedule and drop.'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- Every 2 minutes. Deliberately the same cadence as the jobid-40 watchdog whose
-- `job startup timeout` is the symptom being chased, so a sample either lands
-- alongside a failed launch or is itself missing — and a MISSING sample is data:
-- it means this job could not get a worker either.
SELECT cron.unschedule('bgworker-census')
  FROM cron.job WHERE jobname = 'bgworker-census';

SELECT cron.schedule(
  'bgworker-census',
  '*/2 * * * *',
  $$SELECT public.sample_bgworker_census();$$
);
