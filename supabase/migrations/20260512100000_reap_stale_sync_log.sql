-- FIX-255 — Stale data_sync_log row reaper.
--
-- When Node aborts uncatchably (V8 OOM = SIGABRT, SIGKILL, hard crash) the
-- in-flight pipeline never reaches completeSync() / failSync() and its
-- data_sync_log row strands in status='running' forever, polluting
-- data:status output and the Data Freshness dashboard.
--
-- The in-process signal handler in packages/data/src/pipelines/sync-log.ts
-- covers catchable signals. This RPC is the belt-and-braces fallback for the
-- uncatchable cases, plus a manual escape hatch (`pnpm data:reap-sync-log`).
--
-- Idempotent: only flips rows that are still 'running'; previously-reaped
-- rows are status='failed' and excluded by the WHERE clause.
--
-- The existing idx_data_sync_log_status (status, started_at DESC) index
-- (migration 0022_data_sync_log_and_graph_snapshots.sql) already makes this
-- scan cheap — no new index needed.

CREATE OR REPLACE FUNCTION public.reap_stale_sync_log(stale_minutes INT DEFAULT 10)
RETURNS TABLE(id UUID, pipeline TEXT, reaped_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.data_sync_log AS dsl
     SET status = 'failed',
         error_message = 'reaped_orphan',
         completed_at = NOW()
   WHERE dsl.status = 'running'
     AND dsl.started_at < NOW() - (stale_minutes::text || ' minutes')::interval
  RETURNING dsl.id, dsl.pipeline, dsl.completed_at;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reap_stale_sync_log(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reap_stale_sync_log(INT) TO authenticated;
