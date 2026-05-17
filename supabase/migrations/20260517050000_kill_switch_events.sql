-- 20260517050000_kill_switch_events.sql
-- FIX-287 — PR 3 of platform monitoring overhaul.
--
-- Auditable log of every kill-switch flip — both manual (admin POST) and
-- automatic (snapshot-cron evaluator from FIX-286). PR 1 anticipated this
-- audit need but parked it as a TODO inside pipeline_state JSONB; the
-- dashboard banner introduced here needs an indexable table.
--
-- Schema:
--   trigger_metric / trigger_value / threshold_pct are NULL for manual
--   flips (the operator's intent is the trigger). They carry the metric
--   key (e.g. "anthropic.monthly_spend_usd"), the value at the moment of
--   the flip, and the auto_trip_threshold_pct percent for auto flips.
--
--   source CHECK enforces the (auto | manual) split — protects the
--   dashboard banner from rendering rogue values if we add a third source
--   without thinking through the UI consequence.
--
--   RLS: USING(false) for the public anon role. The dashboard banner reads
--   via createAdminClient (RLS-bypassing service-role key) on SSR, so
--   forbidding anon access is the correct contract. There is no banner
--   path that hits PostgREST from a browser session.
--
-- Retention: 90 days. prune_kill_switch_events() runs nightly from
-- runNightlySync(), alongside the other prune_* RPCs.

CREATE TABLE IF NOT EXISTS public.kill_switch_events (
  id              BIGSERIAL    PRIMARY KEY,
  switch_name     TEXT         NOT NULL,
  trigger_metric  TEXT,        -- NULL for manual flips
  trigger_value   NUMERIC,
  threshold_pct   INTEGER,
  flipped_to      BOOLEAN      NOT NULL,
  source          TEXT         NOT NULL CHECK (source IN ('auto', 'manual')),
  flipped_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kill_switch_events_flipped_at_idx
  ON public.kill_switch_events (flipped_at DESC);

ALTER TABLE public.kill_switch_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'kill_switch_events'
      AND policyname = 'admin-read kill_switch_events'
  ) THEN
    -- Block anon entirely; service-role (createAdminClient) bypasses RLS,
    -- which is the only path the dashboard banner uses.
    CREATE POLICY "admin-read kill_switch_events" ON public.kill_switch_events
      FOR SELECT USING (false);
  END IF;
END$$;

CREATE OR REPLACE FUNCTION public.prune_kill_switch_events()
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE deleted BIGINT;
BEGIN
  DELETE FROM public.kill_switch_events
  WHERE flipped_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.prune_kill_switch_events()
  TO authenticated, service_role;
