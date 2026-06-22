-- FIX-642: track Vercel monthly spend as a first-class platform metric.
--
-- getVercelUsage() already parses charges_total_usd from /v1/billing/charges
-- but platform-snapshot.ts never persisted it (only the 9 quantity metrics).
-- This adds the platform_limits threshold row so the snapshot writer's new
-- updateUsage(db,'vercel','monthly_spend_usd', charges_total_usd, 'api') write
-- has a limit to render/alert against on the Platform Costs card.
--
-- Threshold ladder is anchored on Vercel Spend Management's hard backstop
-- ($10 overage above plan-included usage → project auto-pause):
--   Pro base subscription ........ ~$20/mo
--   + $10 Spend-Management cap .... = ~$30 billed before auto-pause
-- included_limit = 30  → normal $20 bill ≈ 67% (healthy)
-- warning_pct   = 73  → ~$22 (≈ $2 into overage — first dollars over base)
-- critical_pct  = 90  → ~$27 (≈ $7 over base, approaching the $10 auto-pause)
--
-- NOTE: charges_total_usd is the FOCUS BilledCost total. Whether it includes
-- the $20 base line or only metered overages is unconfirmed until a real token
-- with usage+billing scope flows data (FIX-606). Recalibrate included_limit
-- once the first live BilledCost values land. No auto-trip is wired to this
-- metric — Vercel's native Spend Management pause is the enforcement backstop;
-- this row is the earlier, finer-grained warning layer only.
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
  ('vercel', 'monthly_spend_usd', 'free',
   30.00, 'usd',
   NULL, NULL, NULL,
   'Monthly Spend', 'Cost',
   73, 90,
   'monthly_reset', 0,
   'Live BilledCost total from /v1/billing/charges (charges_total_usd). '
   || 'Threshold ladder anchored on the $10 Spend-Management overage cap '
   || '(~$30 billed before auto-pause). Recalibrate once real data flows (FIX-606).',
   true, true),
  ('vercel', 'monthly_spend_usd', 'pro',
   30.00, 'usd',
   NULL, NULL, NULL,
   'Monthly Spend', 'Cost',
   73, 90,
   'monthly_reset', 0,
   'Live BilledCost total from /v1/billing/charges (charges_total_usd). '
   || 'Threshold ladder anchored on the $10 Spend-Management overage cap '
   || '(~$30 billed before auto-pause). Recalibrate once real data flows (FIX-606).',
   true, true)
ON CONFLICT (service, metric, plan) DO NOTHING;
