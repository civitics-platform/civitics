-- FIX-1038: make the Upstash edge limiter visible to platform_usage_snapshot.
--
-- On 2026-08-15 a crawler spent the Upstash free-tier allotment (500,000
-- commands) in 15.5 hours. Every rate-limit bucket built by FIX-637 /
-- FIX-683 / FIX-797 began erroring, the limiter went fully open, and NOTHING
-- ANYWHERE NOTICED — Upstash was the one vendor in the cost chain that
-- platform-snapshot.ts did not track (anthropic, supabase, cloudflare, github,
-- vercel; no upstash). A hard $0-ceiling cost control switched itself off in
-- silence. See docs/audits/2026-08-15-traffic-cost-spike.md.
--
-- Two rows, doing two different jobs.
--
-- 1. upstash.limiter_degraded — THE ALARM.
--    Written every snapshot tick by packages/db/src/upstash-usage.ts from a
--    single PING against the REST endpoint (~144 commands/day, 0.03% of the
--    allotment it watches). 0 = healthy, 1 = quota exhausted or unreachable.
--    included_limit = 1 so a degraded limiter reads 100% and trips the SAME
--    critical path every other metric already uses — no new alerting substrate,
--    which is the whole point of putting it here rather than inventing one.
--    warning_pct = 1 exists only so the ladder is well-formed; the metric is
--    boolean in practice and goes straight from healthy to critical.
--
-- 2. upstash.daily_commands — THE CEILING, and an honest gap.
--    Upstash exposes command counts ONLY through its management API
--    (api.upstash.com/v2/redis/stats/{id}), which needs an account-level
--    UPSTASH_EMAIL + UPSTASH_API_KEY. This repo holds only the per-database
--    REST credentials — verified against .env.example, .env.local and
--    .env.local.prod. So has_public_api = false: the permanent gray
--    "Manual (no API)" badge is CORRECT here and is not a backlog item.
--    Deliberately seeded with NO platform_usage row, so the card renders
--    "unknown" rather than an invented 0. The ONE moment a real number is
--    observable is Upstash's own quota error — "Limit: 500000, Usage: 500002"
--    — which upstash-usage.ts parses and writes. NB the counter FREEZES on
--    crossing, so that value confirms the cap was reached and dates nothing.
--
-- No overage pricing on either row: the Upstash free tier with auto-upgrade OFF
-- is a HARD limit by design (it rate-limits the database instead of billing),
-- so overage_unit_cost stays NULL and calculateOverageCost returns 0.
--
-- Rows are added for both 'free' and 'pro' so a future
-- pipeline_state.platform_plan override of the upstash service cannot make the
-- metric silently vanish from the card.
--
-- Idempotent: ON CONFLICT (service, metric, plan) DO NOTHING.

INSERT INTO platform_limits (
  service, metric, plan,
  included_limit, unit,
  overage_unit_cost, overage_unit, overage_cap,
  display_label, display_group,
  warning_pct, critical_pct,
  billing_cycle, sort_order, notes, is_active, has_public_api
) VALUES
  ('upstash', 'limiter_degraded', 'free',
   1, 'state',
   NULL, NULL, NULL,
   'Edge Limiter', 'Reliability',
   1, 100,
   'monthly_reset', 0,
   'FIX-1038. 0 = Upstash reachable and within quota; 1 = quota exhausted or '
   || 'unreachable, i.e. every rate-limit bucket has failed over to the '
   || 'per-instance in-memory limiter. Probed once per snapshot tick by '
   || 'getUpstashHealth(). The durable state-transition history (when it '
   || 'degraded, when it recovered) lives in '
   || 'pipeline_state.upstash_limiter_health and rides in the snapshot payload '
   || 'under payload->upstash.',
   true, true),
  ('upstash', 'limiter_degraded', 'pro',
   1, 'state',
   NULL, NULL, NULL,
   'Edge Limiter', 'Reliability',
   1, 100,
   'monthly_reset', 0,
   'FIX-1038. See the free-tier row.',
   true, true),
  ('upstash', 'period_commands', 'free',
   500000, 'commands',
   NULL, NULL, NULL,
   'Upstash Commands', 'Cost',
   80, 100,
   'monthly_reset', 1,
   'Upstash free-tier allotment: 500,000 commands per billing period, '
   || 'auto-upgrade OFF (hard $0 ceiling — exhaustion rate-limits the DATABASE '
   || 'rather than billing). Measured 2026-08-15: a ~7,200 req/hr crawl spent '
   || 'the whole allotment in 15.5 hours (~9 commands/sec) against ~55 days at '
   || 'baseline traffic. THE PERIOD IS DELIBERATELY NOT CALLED "DAILY": the '
   || 'triage prompt assumed a daily allotment, but a live probe at 2026-08-16 '
   || '03:08 UTC still returned "Limit: 500000, Usage: 500002" — 5h38m after '
   || 'exhaustion and AFTER the 00:00 UTC boundary, so it did not reset '
   || 'daily-at-midnight-UTC. The audit''s own "~55 days at baseline" figure '
   || 'only makes sense for a per-period (monthly) allotment too. This matters: '
   || 'if the period is monthly, ONE crawl disables the limiter for the rest of '
   || 'the cycle, which is a much stronger argument for the FIX-1038 fail-over '
   || 'than a daily reset would be. Confirm against the Upstash console. '
   || 'has_public_api = false because command counts require an Upstash '
   || 'MANAGEMENT API key (UPSTASH_EMAIL + UPSTASH_API_KEY) that this repo does '
   || 'not hold; only the per-database REST credentials are configured. A value '
   || 'is written ONLY when Upstash''s quota error discloses one.',
   true, false),
  ('upstash', 'period_commands', 'pro',
   500000, 'commands',
   NULL, NULL, NULL,
   'Upstash Commands', 'Cost',
   80, 100,
   'monthly_reset', 1,
   'See the free-tier row. Recalibrate included_limit if the Upstash tier ever '
   || 'changes — raising the tier was explicitly NOT part of FIX-1038.',
   true, false)
ON CONFLICT (service, metric, plan) DO NOTHING;
