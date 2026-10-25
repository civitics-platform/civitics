-- FIX-1345 (cc-248) — the job_registry row for .github/workflows/fixes-housekeep.yml
--
-- The weekly FIXES.md housekeeping bot (Mondays 10:00Z) is a scheduled
-- workflow, and FIX-1307 keeps the registry in parity with every workflow that
-- has an on.schedule block (check:job-registry, rule iii). One catalog row in
-- the same shape as the other `gha:` rows (refresh-disposable-emails): an `at`
-- rule and a `gha:` unit_call, so the dispatcher never admits it (it admits a
-- github_actions row only for a `gha-dispatch:` unit_call) and prod_op_gate
-- never reads it (its vacuum-spacing rows come from cron.job).
--
-- The workflow touches no database: it runs fixes:clean --older-than 7 and
-- fixes:archive on the checkout and commits docs/FIXES.md + the archive.
--
-- Class P (one registry INSERT, expected wall < 1 s). Idempotent: ON CONFLICT
-- (job) DO NOTHING. Revert: DELETE FROM public.job_registry WHERE job = 'fixes-housekeep';

-- job-registry-seed:begin
INSERT INTO public.job_registry (job, runner, pipeline, unit_shape, unit_call, priority, deadline_rule, cost_class, cap_mb, exclusion_group, budget_seconds, gates, idempotent_refire, note) VALUES
  ('fixes-housekeep', 'github_actions', NULL, 'atomic', 'gha:fixes-housekeep.yml', 5, 'at 0 10 * * 1', 'cpu', 128, NULL, 900, '{}', false, 'FIX-1345 — weekly FIXES.md housekeeping: moves bullets closed 7+ d to docs/archive/fixes-archive.md and commits docs; touches no database; no-band')
ON CONFLICT (job) DO NOTHING;
-- job-registry-seed:end
