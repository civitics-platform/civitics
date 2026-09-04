-- FIX-1130 — declare the front-door watchdog in the rollup registry.
--
-- The watchdog (/api/cron/front-door-watch, every 15 minutes from
-- apps/civitics/vercel.json) writes a best-effort data_sync_log row on each
-- tick whenever Postgres happens to be reachable. That is enough for
-- list_scheduled_rollup_pipelines() to pick `front_door_watch` up in its
-- 90-day census, and it would then be judged against a cadence it has no way
-- to derive: there is no pg_cron row for this job, so the registry would fall
-- back to the 168 h `default` and — because the job is DESIGNED to have gaps
-- whenever the database is down — could escalate it as stale precisely during
-- the outages it exists to report.
--
-- Per the FIX-1059 convention in packages/db/CLAUDE.md, anything the registry
-- cannot derive a schedule for is DECLARED here rather than left to be
-- inferred. cadence_hours 0.25 states the real tick; the note states why no
-- pg_cron schedule can express it.
--
-- This row is a declaration, not a measurement. It does not create, schedule or
-- modify anything — the driver is Vercel cron and lives in vercel.json.

INSERT INTO public.rollup_watch_overrides (pipeline, cadence_hours, note)
VALUES (
  'front_door_watch',
  0.25,
  'FIX-1130 — Postgres-free front-door watchdog. Driven by a Vercel cron '
  '(*' || '/15 * * * *, apps/civitics/vercel.json), NOT pg_cron, because the '
  'failure mode it detects is the front door in front of Postgres wedging '
  'while Postgres itself is healthy — a pg_cron-driven watcher would be dead '
  'in exactly that outage (the FIX-1120/FIX-1125 lesson). Its data_sync_log '
  'rows are a best-effort breadcrumb written AFTER the alert decision and '
  'inside a catch, so gaps in them are expected and are not evidence of a '
  'missed tick. Declared here so the registry stops inferring a 168h default '
  'cadence for it.'
)
ON CONFLICT (pipeline) DO UPDATE
  SET cadence_hours = EXCLUDED.cadence_hours,
      note          = EXCLUDED.note,
      updated_at    = now();
