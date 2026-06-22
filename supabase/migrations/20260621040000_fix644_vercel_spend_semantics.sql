-- FIX-644: retune vercel.monthly_spend_usd now that it tracks EffectiveCost.
--
-- FIX-642 seeded this row anchored on BilledCost ($10 Spend-Management overage
-- cap → ~$30 ceiling). Live prod data (2026-06-21) showed BilledCost is $0 (all
-- usage within Pro allotments) while EffectiveCost — the real run-rate, list
-- value of all consumption incl. the prorated Pro base — is ~$8/mo. The snapshot
-- now persists EffectiveCost as monthly_spend_usd (BilledCost is already watched
-- by Vercel's native cap; no need to duplicate it).
--
-- New ladder is a run-rate budget ceiling, not an overage cap:
--   included_limit = 50  → normal ~$8-24 run-rate sits comfortably healthy
--   warning_pct    = 70  → ~$35 (spend running well above normal)
--   critical_pct   = 90  → ~$45 (investigate before the bill lands)
-- Generous on purpose: avoids chronic monthly false-warns until a full month of
-- real EffectiveCost is observed. Recalibrate once the first full cycle lands.

UPDATE platform_limits
   SET included_limit = 50.00,
       warning_pct    = 70,
       critical_pct   = 90,
       notes = 'Live EffectiveCost total from /v1/billing/charges (sum of '
            || 'EffectiveCost across all charge lines — the run-rate list value '
            || 'of all consumption incl. the prorated Pro base). BilledCost '
            || '(actual overage) is watched by Vercel native Spend Management. '
            || 'Run-rate budget ceiling; recalibrate after a full cycle (FIX-644).'
 WHERE service = 'vercel'
   AND metric  = 'monthly_spend_usd'
   AND plan IN ('free', 'pro');
