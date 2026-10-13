-- Fixture for scripts/test-check-job-registry.mjs (FIX-1307). Not a migration:
-- it lives under scripts/__fixtures__/job-registry/, the tree the suite points
-- checkRegistry({ root }) at. Same fence shape as 20261014230000.
-- job-registry-seed:begin
INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, note) VALUES
  ('job-a', 'pg_cron', 'pipe_a', 'atomic', 'CALL public.proc_a();', 2, 'at 0 1 * * *', 'io', 128, 'grp', 600, '{prod_session}', false, 'banded'),
  ('job-vac', 'pg_cron', NULL, 'bare', 'VACUUM (ANALYZE) public.some_table;', 4, 'at 0 2 * * *', 'io', 64, 'grp', NULL, '{}', true, 'no-band'),
  ('job-sel', 'pg_cron', NULL, 'atomic', 'SELECT public.probe_b(''x'', ARRAY[''y''])', 1, 'at * * * * *', 'cpu', 128, NULL, NULL, '{}', false, 'it''s a probe, with commas; no-band'),
  ('job-old', 'pg_cron', NULL, 'atomic', 'CALL public.proc_a();', 3, 'at 0 8 * * 1', 'io', 128, NULL, NULL, '{}', false, 'INACTIVE on prod (jobid 9 parked): no-band'),
  ('wf-scheduled', 'github_actions', NULL, 'atomic', 'gha:wf-scheduled.yml', 3, 'at 0 4 * * 1', 'io', 128, NULL, 1800, '{}', false, 'no-band'),
  ('wf-dispatched', 'github_actions', NULL, 'atomic', 'gha-dispatch:wf-dispatched', 2, 'at 0 21 * * *', 'mixed', 128, NULL, 18000, '{}', false, 'no-band')
ON CONFLICT (job) DO NOTHING;
-- job-registry-seed:end
