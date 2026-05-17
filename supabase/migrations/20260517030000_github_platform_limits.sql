-- 20260517030000_github_platform_limits.sql
-- FIX-285 — PR 2.5 of platform monitoring overhaul.
--
-- Seeds the two github.* rows in platform_limits so the snapshot pipeline has
-- a target for the new packages/db/src/github-usage.ts helper. No schema
-- changes — pure additive seed.
--
-- Civitics is a public repo so Actions minutes are unlimited (included_limit
-- = -1, mirrors the Vercel Pro 'function_invocations' pattern at line 141 of
-- 0024_platform_usage_tracking.sql). The row populates for observability but
-- never triggers overage math.
--
-- Storage above 500 MB is billed even on public repos. NOTE: GitHub charges
-- $0.008/GB/DAY (not per month) — this is the only vendor in the model with
-- a per-day overage cost. Downstream overage math in platform-usage.ts
-- treats overage_unit_cost as $/(unit) without month/day knowledge, so the
-- displayed "overage cost" for storage_bytes will under-report by ~30× the
-- real monthly charge until the evaluator is taught the cadence. Documented
-- here so the next reader doesn't try to "fix" the unit-cost number.

INSERT INTO public.platform_limits (
  service, metric, plan, included_limit, unit,
  overage_unit_cost, overage_unit,
  display_label, display_group, sort_order, notes
) VALUES
('github', 'action_minutes', 'free', -1, 'minutes',
  NULL, NULL,
  'Actions Minutes', 'CI', 1,
  'Unlimited on public repos. Private-repo Free: 2000/mo. Private-repo Pro: 3000/mo.'),
('github', 'storage_bytes', 'free', 524288000, 'bytes',
  0.008, 'per_gb',
  'Actions+Packages Storage', 'Storage', 2,
  '500 MB included. $0.008/GB/DAY over (per-day cost — only vendor in our model billed daily not monthly).')
ON CONFLICT (service, metric, plan) DO NOTHING;
