-- 20260517020000_platform_usage_snapshot_and_kill_switches.sql
-- FIX-281 / FIX-282 — PR 1 of platform monitoring overhaul.
--
-- Two changes:
--
-- 1. platform_usage_snapshot
--    Rolling per-fetch snapshots of the /api/platform/usage payload.
--    Populated by /api/cron/platform-snapshot every 10 minutes. The dashboard
--    GET reads the latest row instead of recomputing the vendor-API +
--    DB-sum aggregation on every page load. Plain table (not MV) because
--    the underlying computation includes external HTTP calls a SQL view
--    can't express. Hybrid schema: full payload in JSONB, plus promoted
--    scalars (any_critical, any_warning, total_overage_cost) for future
--    charting and auto-trip evaluation.
--
-- 2. pipeline_state.kill_switches
--    Single JSONB row holding runtime kill switches for AI features, the
--    cron canary, and the live connection-graph pipeline. Layered with env
--    overrides (env=false > DB=false > on) by packages/db/src/kill-switches.ts.
--    auto_trip_threshold_pct is stored but unused in PR 1 — the evaluator
--    lands in PR 3.

-- ── 1. platform_usage_snapshot ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.platform_usage_snapshot (
  id                  BIGSERIAL PRIMARY KEY,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  any_critical        BOOLEAN     NOT NULL DEFAULT false,
  any_warning         BOOLEAN     NOT NULL DEFAULT false,
  total_overage_cost  NUMERIC     NOT NULL DEFAULT 0,
  payload             JSONB       NOT NULL,
  -- Non-null when refresh partially failed; payload may be stale or
  -- reflect whatever pieces did succeed. The cron writes a row either way
  -- so the dashboard never sees an empty snapshot table.
  error               TEXT
);

CREATE INDEX IF NOT EXISTS platform_usage_snapshot_fetched_at_idx
  ON public.platform_usage_snapshot (fetched_at DESC);

-- Public-read matches the existing platform_limits / platform_usage policy;
-- the dashboard already serves these numbers anonymously.
ALTER TABLE public.platform_usage_snapshot ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'platform_usage_snapshot'
      AND policyname = 'public read snapshot'
  ) THEN
    CREATE POLICY "public read snapshot" ON public.platform_usage_snapshot
      FOR SELECT USING (true);
  END IF;
END$$;

-- Prune snapshots older than 30 days. Called nightly from runNightlySync().
CREATE OR REPLACE FUNCTION public.prune_platform_usage_snapshot()
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE deleted BIGINT;
BEGIN
  DELETE FROM public.platform_usage_snapshot
  WHERE fetched_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.prune_platform_usage_snapshot()
  TO authenticated, service_role;

-- ── 2. pipeline_state.kill_switches seed ──────────────────────────────────────
--
-- Field set tracks the env-var kill switches that already exist plus the
-- AI sub-features that share AI_SUMMARIES_ENABLED. auto_trip_threshold_pct
-- is null on every switch (manual only); PR 3 will populate per-switch
-- thresholds and add the evaluator.

INSERT INTO public.pipeline_state (key, value, updated_at)
VALUES (
  'kill_switches',
  '{
    "ai_summaries":          { "enabled": true, "auto_trip_threshold_pct": null },
    "ai_narrative":          { "enabled": true, "auto_trip_threshold_pct": null },
    "ai_tagger":             { "enabled": true, "auto_trip_threshold_pct": null },
    "connection_graph_live": { "enabled": true, "auto_trip_threshold_pct": null },
    "cron":                  { "enabled": true, "auto_trip_threshold_pct": null }
  }'::JSONB,
  NOW()
)
ON CONFLICT (key) DO NOTHING;
