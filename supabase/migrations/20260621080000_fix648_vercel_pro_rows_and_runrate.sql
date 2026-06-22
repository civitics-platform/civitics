-- FIX-648: correct the Vercel Platform-Costs numbers + watch the fluid cost driver.
--
-- Investigation (live prod /v1/billing/charges, 2026-06-21) found the prompt's
-- suspected causes were NOT the bug: unit conversions are correct (every
-- hardcoded conversion matches the real ConsumedUnit) and there is no
-- double-counting (147 lines = 7 days x 21 regions, all leaves). The real bugs:
--
--  1. platform_plan = {"vercel":"pro"} but only 4 of the 9 vercel quantity
--     metrics had a `pro` platform_limits row. computePlatformUsagePayload's
--     plan-override REPLACES the free vercel rows with the pro set, so the 6
--     metrics WITHOUT a pro row (incl. fluid_memory_gb_hrs, the actual cost
--     driver) were dropped off the card entirely. This migration adds the
--     missing 6 pro rows so all 9 render.
--
--  2. /v1/billing/charges returns only a trailing ~7-day window, never
--     month-to-date. The snapshot writer now projects that window to a 30-day
--     run-rate (source='estimated', code change), so monthly_spend's ladder is
--     retuned here to run-rate semantics.
--
-- Vercel Pro is CREDIT-BASED ($20 monthly credit, then on-demand) — it has no
-- per-metric GB-hr/CPU-hour/invocation allotment. The only real fixed Pro
-- allocations are 1 TB Fast Data Transfer and 10,000,000 Edge Requests. So the
-- 6 new pro rows use:
--   - edge_requests        -> 10,000,000  (the real Pro included allocation)
--   - everything else      -> the Hobby included amount as a capacity-context
--                             denominator (clearly noted). The true ceiling for
--                             these is DOLLARS vs the $20 credit, watched
--                             separately by monthly_spend_usd + the new
--                             leading-signal fluid alert (code change).
--
-- Idempotent: ON CONFLICT (service, metric, plan) DO NOTHING for inserts.

-- ── 1. Missing vercel PRO rows (so all 9 metrics render under the pro override) ──

INSERT INTO platform_limits (
  service, metric, plan,
  included_limit, unit,
  overage_unit_cost, overage_unit, overage_cap,
  display_label, display_group,
  warning_pct, critical_pct,
  billing_cycle, sort_order, notes, is_active, has_public_api
) VALUES
  ('vercel', 'edge_requests', 'pro',
   10000000, 'requests',
   NULL, NULL, NULL,
   'Edge Requests', 'Networking',
   80, 95,
   'monthly_reset', 4,
   'Pro includes 10M Edge Requests/mo (a real fixed Pro allocation). '
   || 'Value is a 30-day run-rate projected from the trailing ~7-day '
   || 'billing/charges window (FIX-648).',
   true, true),

  ('vercel', 'edge_cpu_ms', 'pro',
   3600000, 'ms',
   NULL, NULL, NULL,
   'Edge Request CPU', 'Compute',
   80, 95,
   'monthly_reset', 5,
   'No fixed Pro allotment (credit-based); denominator is the Hobby 1h '
   || 'reference for capacity context. Real ceiling is $ vs the $20 credit. '
   || 'Run-rate projected from the trailing ~7-day window (FIX-648).',
   true, true),

  ('vercel', 'build_minutes', 'pro',
   20000, 'minutes',
   NULL, NULL, NULL,
   'Build Minutes', 'Build',
   80, 95,
   'monthly_reset', 6,
   'No fixed Pro allotment (builds are $0.0035/CPU-min on-demand). The Hobby '
   || '6000 reference would chronic-warn against the deploy-driven build CPU '
   || 'run-rate, so this is a self-imposed soft budget (20k CPU-min/mo ~ $70) '
   || 'for context only. Real cost is the $ in the spend breakdown. '
   || 'Run-rate projected from the trailing ~7-day window (FIX-648).',
   true, true),

  ('vercel', 'web_analytics_events', 'pro',
   50000, 'events',
   NULL, NULL, NULL,
   'Web Analytics Events', 'Analytics',
   80, 95,
   'monthly_reset', 7,
   'No fixed Pro allotment (Pro Web Analytics is $0.03/1K, no included); '
   || 'denominator is the Hobby reference for capacity context. '
   || 'Run-rate projected from the trailing ~7-day window (FIX-648).',
   true, true),

  ('vercel', 'isr_reads', 'pro',
   1000000, 'reads',
   NULL, NULL, NULL,
   'ISR Reads', 'Edge Cache',
   80, 95,
   'monthly_reset', 8,
   'No fixed Pro allotment (credit-based); denominator is the Hobby '
   || 'reference for capacity context. Real ceiling is $ vs the $20 credit. '
   || 'Run-rate projected from the trailing ~7-day window (FIX-648).',
   true, true),

  ('vercel', 'fluid_memory_gb_hrs', 'pro',
   360, 'gb_hours',
   NULL, NULL, NULL,
   'Fluid Provisioned Memory', 'Compute',
   80, 95,
   'monthly_reset', 9,
   'THE cost driver. No fixed Pro allotment (credit-based); denominator is '
   || 'the Hobby 360 GB-hr reference for capacity context. Real ceiling is $ '
   || 'vs the $20 credit — watched by the FIX-648 leading-signal fluid alert. '
   || 'Run-rate projected from the trailing ~7-day window.',
   true, true)
ON CONFLICT (service, metric, plan) DO NOTHING;

-- ── 2. Retune monthly_spend_usd to run-rate semantics (free + pro) ───────────────
-- FIX-644 anchored this on a raw 7-day EffectiveCost (~$8). The snapshot writer
-- now PROJECTS that window to a 30-day run-rate (~$35/mo: ~$20 prorated Pro base
-- + ~$15 usage). New ceiling gives headroom above the recurring base so a
-- genuine elevation warns without chronic false-warns from the fixed base.
UPDATE platform_limits
   SET included_limit = 60.00,
       warning_pct    = 70,
       critical_pct   = 90,
       display_label  = 'Monthly Spend (run-rate)',
       notes = 'Projected 30-day run-rate of EffectiveCost (list value of all '
            || 'consumption incl. the prorated $20 Pro base), projected from the '
            || 'trailing ~7-day billing/charges window. BilledCost (actual '
            || 'overage the $10 Spend-Management cap watches) is shown separately '
            || 'as a metadata sub-label and is $0 within plan. Ceiling is a '
            || 'run-rate budget; recalibrate after a full observed cycle (FIX-648).'
 WHERE service = 'vercel'
   AND metric  = 'monthly_spend_usd'
   AND plan IN ('free', 'pro');
