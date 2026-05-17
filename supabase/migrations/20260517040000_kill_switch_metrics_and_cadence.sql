-- 20260517040000_kill_switch_metrics_and_cadence.sql
-- FIX-286 — PR 3 of platform monitoring overhaul.
--
-- Two data-only changes (no new columns or tables):
--
-- 1. pipeline_state.kill_switches  → add per-switch `metrics` array.
--    PR 1 seeded auto_trip_threshold_pct on every switch but never wired it.
--    The PR 3 evaluator needs to know which platform_usage rows can trigger
--    each switch, so we add a `metrics` field (format: `service.metric`).
--    Empty array means "no auto-trip available even if a threshold is set".
--    The `cron` switch keeps `metrics: []` because auto-disabling the cron
--    is destructive — it would stop the very pipeline that detects the
--    auto-trip condition.
--    Uses UPDATE (not INSERT) — the row already exists from migration
--    20260517020000 (PR 1).
--
-- 2. platform_limits.billing_cycle for github.storage_bytes → 'per_day_reset'.
--    PR 2.5 left the seed at the default 'monthly_reset', but GitHub bills
--    Actions+Packages storage at $0.008/GB/DAY, not /month. PR 3 teaches
--    calculateOverageCost about this cadence and this row needs to opt into
--    it. 'per_day_reset' joins 'monthly_reset', 'rolling_30d', 'cumulative'
--    as a recognized value of the column declared at 0024 line 36.

-- ── 1. kill_switches.metrics ──────────────────────────────────────────────────

UPDATE public.pipeline_state
SET
  value = '{
    "ai_summaries":          { "enabled": true, "auto_trip_threshold_pct": 90,
                               "metrics": ["anthropic.monthly_spend_usd"] },
    "ai_narrative":          { "enabled": true, "auto_trip_threshold_pct": 90,
                               "metrics": ["anthropic.monthly_spend_usd"] },
    "ai_tagger":             { "enabled": true, "auto_trip_threshold_pct": 90,
                               "metrics": ["anthropic.monthly_spend_usd"] },
    "connection_graph_live": { "enabled": true, "auto_trip_threshold_pct": 95,
                               "metrics": ["supabase.api_requests_7d",
                                           "supabase.disk_used_bytes"] },
    "cron":                  { "enabled": true, "auto_trip_threshold_pct": null,
                               "metrics": [] }
  }'::JSONB,
  updated_at = NOW()
WHERE key = 'kill_switches';

-- ── 2. github.storage_bytes billing cadence ───────────────────────────────────

UPDATE public.platform_limits
SET billing_cycle = 'per_day_reset'
WHERE service = 'github' AND metric = 'storage_bytes';
