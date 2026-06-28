-- FIX-688 — schedule the entity_connections rebuild via pg_cron, de-stacked
-- off Sunday.
--
-- Two jobs, both CALLing FIX-687's procedure (governed by the chunk functions'
-- statement_timeout, so neither can be SIGTERM'd by an external runner):
--   * rebuild-ec-full        Monday    08:00 UTC  → full reconcile. Monday (not
--                            Sunday) so it runs AFTER the Sunday FEC bulk ingest
--                            has landed instead of contending with it.
--   * rebuild-ec-incremental Wednesday 08:00 UTC  → dirty-set-only rebuild.
--
-- The GHA workflow rebuild-entity-connections.yml is neutralized in the same
-- FIX-688 change (schedule: triggers removed, workflow_dispatch kept as manual
-- break-glass).
--
-- Idempotent: unschedule by name first (only for jobs that already exist, so no
-- error on first apply), then (re)schedule. cron.schedule keyed by name upserts
-- in pg_cron ≥1.4, but the explicit unschedule keeps re-applies clean and makes
-- the intent obvious.

SELECT cron.unschedule(jobname)
  FROM cron.job
 WHERE jobname IN ('rebuild-ec-full', 'rebuild-ec-incremental');

SELECT cron.schedule(
  'rebuild-ec-full',
  '0 8 * * 1',
  $$CALL public.run_entity_connections_rebuild('full');$$
);

SELECT cron.schedule(
  'rebuild-ec-incremental',
  '0 8 * * 3',
  $$CALL public.run_entity_connections_rebuild('incremental');$$
);
