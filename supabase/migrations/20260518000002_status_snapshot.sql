-- 20260518000002_status_snapshot.sql
-- FIX-297 + FIX-298 — materialize /api/claude/status/core into a snapshot table.
--
-- 1. status_snapshot
--    Snapshot of the 11-section status payload that /api/claude/status/core +
--    /quality + the dashboard SSR were each computing live. Populated every
--    10 min by /api/cron/platform-snapshot (alongside platform_usage_snapshot,
--    FIX-281). The routes + dashboard read the latest row instead of running
--    the section queries on every request — the long pole was a 16-iteration
--    count:'exact' fan-out on the 5.1M-row entity_connections table (~9.5s).
--    Plain table (not MV) because the computation includes RPC calls + the
--    Anthropic Admin API HTTP, which SQL views can't express. Rolling history
--    (24h, INSERT-per-tick) matches platform_usage_snapshot.
--
-- 2. get_connection_type_counts()
--    Single GROUP BY scan over entity_connections replacing the 16 sequential
--    count:'exact' queries in apps/civitics/app/api/claude/status/_lib/sections.ts's
--    getConnectionTypes(). Index entity_connections_type (connection_type) on
--    the same table already exists from 0001_initial_schema.sql:321, so the
--    GROUP BY is an index scan, not a seq scan. FIX-298.

-- ── 1. status_snapshot ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.status_snapshot (
  id              BIGSERIAL PRIMARY KEY,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  query_time_ms   INTEGER     NOT NULL,
  payload         JSONB       NOT NULL,
  -- Non-null when any section failed to compute. Payload may be partial
  -- (the offending section's value is a {error, partial:true} object) but
  -- the snapshot still lands so the dashboard never sees an empty table.
  error           TEXT
);

CREATE INDEX IF NOT EXISTS status_snapshot_fetched_at_idx
  ON public.status_snapshot (fetched_at DESC);

-- Admin-only read. The dashboard hits /api/claude/status/* which already
-- gates on admin email at the page layer, and the routes use createAdminClient
-- (bypasses RLS). Mirrors the kill_switch_events pattern (FIX-287).
ALTER TABLE public.status_snapshot ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'status_snapshot'
      AND policyname = 'no public read status_snapshot'
  ) THEN
    CREATE POLICY "no public read status_snapshot" ON public.status_snapshot
      FOR SELECT USING (false);
  END IF;
END$$;

-- Prune snapshots older than 24 hours. Called nightly from runNightlySync()
-- alongside prune_platform_usage_snapshot (FIX-281) + prune_kill_switch_events
-- (FIX-287). 24h is enough for a "what changed mid-day" debug pass; long-term
-- history isn't useful for a summary-state payload.
CREATE OR REPLACE FUNCTION public.prune_status_snapshot()
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE deleted BIGINT;
BEGIN
  DELETE FROM public.status_snapshot
  WHERE fetched_at < NOW() - INTERVAL '24 hours';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.prune_status_snapshot()
  TO authenticated, service_role;

-- ── 2. get_connection_type_counts ─────────────────────────────────────────────
--
-- Replaces the 16-iteration count:'exact' fan-out in getConnectionTypes
-- (apps/civitics/app/api/claude/status/_lib/sections.ts). A single GROUP BY
-- over entity_connections's connection_type index returns all type totals in
-- one round-trip. Result is exact (PostgreSQL counts the rows it scans)
-- rather than estimated — at ~5.1M rows the indexed scan is sub-200 ms in
-- practice, well under the previous ~9000 ms wall-clock for the 16-query
-- variant.

CREATE OR REPLACE FUNCTION public.get_connection_type_counts()
RETURNS TABLE(connection_type TEXT, total BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT connection_type, COUNT(*)::BIGINT AS total
  FROM public.entity_connections
  GROUP BY connection_type
  ORDER BY total DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_connection_type_counts()
  TO authenticated, service_role;
