-- FIX-1050 — platform_limits touch-ups after the FIX-1044/1046/1047/1049 pass.
--
-- Three config-level corrections, no new machinery. Each one exists because a
-- row was watching the wrong number, not because anything was broken.
--
--  T1. cloudflare.storage_bytes 10 GiB -> 24 GiB. The row has been latched
--      critical at 163% since the FEC pipelines legitimately outgrew the seed
--      limit, which means it stopped being an alarm and started being a
--      permanent red light holding any_critical true on its own. R2 storage is
--      $0.015/GB/mo — 24 GiB of it is ~$0.36 — so the limit's job here is
--      growth detection, not cost control, and a limit you are permanently over
--      detects nothing.
--
--  T2. vercel.billable_overage_usd alerting becomes: email at the first cent of
--      real overage, page at $10.
--
--  T3 rides in code (packages/db/src/platform-snapshot.ts), not here.
--
-- Idempotent: UPDATEs are value-assignments, the INSERT is ON CONFLICT DO
-- NOTHING with a follow-up UPDATE so re-running converges either way.

-- ─────────────────────────────────────────────────────────────────────────────
-- T1 — R2 storage limit: 10 GiB -> 24 GiB
-- ─────────────────────────────────────────────────────────────────────────────
--
-- UNIT BASE MATTERS AND IS BINARY. The seed stored 10737418240 = 10 x 1024^3,
-- and formatMetricValue divides by 1073741824 to render "GB". Using 24e9 here
-- would silently move the goalposts by 7% against a denominator the UI is not
-- using. 24 x 1024^3 = 25769803776.
--
-- Bands stay 80/95. At the 2026-08-16 prod reading of 17,540,513,201 bytes
-- (16.3 GiB) that is 68.1% — healthy, with the warning band landing at 19.2 GiB
-- and critical at 22.8 GiB. Cloudflare is NOT plan-overridden in
-- pipeline_state.platform_plan (only vercel and supabase are), so the 'free'
-- row is the one that renders and there is no 'pro' mirror to keep in step.
UPDATE public.platform_limits
   SET included_limit = 25769803776,
       notes = 'FIX-1050. R2 object storage. Raised 10 GiB -> 24 GiB on '
            || '2026-08-17: the FEC bulk pipelines legitimately grew past the '
            || '10 GiB seed and the row had been latched critical at 163% '
            || 'since, which made it a permanent red light rather than a growth '
            || 'alarm and held any_critical true by itself. R2 is $0.015/GB/mo '
            || 'with no egress fee, so 24 GiB is ~$0.36/mo — this limit exists '
            || 'to detect UNEXPECTED growth, not to cap spend. Binary base '
            || '(24 x 1024^3) to match formatMetricValue''s GB divisor. Warning '
            || 'lands at 19.2 GiB, critical at 22.8 GiB.',
       updated_at = now()
 WHERE service = 'cloudflare'
   AND metric  = 'storage_bytes';

-- ─────────────────────────────────────────────────────────────────────────────
-- T2 — first-cent warning, $10 page
-- ─────────────────────────────────────────────────────────────────────────────
--
-- DESIRED BEHAVIOUR: an email within one snapshot cycle of the first $0.01 of
-- real Vercel overage, exactly once per overage episode; a page at $10.
--
-- WHY IT TAKES TWO ROWS. warning_pct and critical_pct are INTEGER columns.
-- $0.01 against the $20 included credit is 0.05%, which is not representable,
-- and the obvious rounding — warning_pct = 0 — is worse than wrong: the band
-- test is `pct >= warning_pct`, so 0 puts EVERY row in the warning band
-- permanently, including a $0.00 one. There is no integer percentage of $20
-- that means "one cent".
--
-- So the dollar row keeps the dollar question and the boolean question gets its
-- own row, which is the shape upstash.limiter_degraded already established
-- (FIX-1038): included_limit 1, value 0 or 1, so a 1 reads as 100% and rides
-- the SAME edge-triggered alert path every other metric uses. No new alerting
-- substrate — that is the entire reason for doing it this way.

-- The dollar row: page at $10. 50% of the $20 credit. warning_pct is set equal
-- to critical_pct deliberately — the warning band on THIS row would be dead
-- space now that the boolean row owns "any overage at all", and an amber band
-- between $10 and $10 is more honest than one that implies a second threshold
-- nobody chose. $20 (the old critical, "the bill has doubled") stays visible
-- through the projection headline on the card; it needs no alert of its own,
-- because a row already critical at $10 cannot escalate again at $20.
UPDATE public.platform_limits
   SET warning_pct  = 50,
       critical_pct = 50,
       notes = 'FIX-1046 computes this as max(0, projected month-end usage - '
            || '$20 credit) — money actually owed, not the gross list value of '
            || 'consumption. FIX-1050 moved the page from $20 to $10 (50% of '
            || 'the credit). warning_pct = critical_pct on purpose: '
            || 'vercel.overage_present owns the "any overage at all" signal, so '
            || 'an amber band here would be dead space. NOTE THE BASIS — this '
            || 'row is the PROJECTION to month end; overage_present is actual '
            || 'MTD. Different questions: "is month-end heading past $10" vs '
            || '"are we over the credit right now".',
       updated_at = now()
 WHERE service = 'vercel'
   AND metric  = 'billable_overage_usd';

-- The boolean row: email at the first cent.
--
-- BANDS: warning_pct 1, critical_pct 101. A value of 1 reads as 100%, which is
-- >= 1 (warning) and < 101 (never critical) — so this row can only ever email,
-- never page, which is the whole point. limiter_degraded uses 1/100 because it
-- IS a page; this one is the softer signal and must not double-page alongside
-- the dollar row.
--
-- BASIS: actual MTD overage, NOT the projection. This is load-bearing. The
-- projection scales by daysInCycle/windowDays, so on day 1 of a cycle an
-- entirely ordinary $0.71 of usage extrapolates to ~$22 and reports overage —
-- this row would fire a false first-cent email in the first days of most
-- months. billable_overage_mtd_usd can only go positive once real cumulative
-- consumption has genuinely passed $20, and within a cycle it is monotonic, so
-- the healthy->warning edge happens at most once per overage episode.
INSERT INTO public.platform_limits (
  service, metric, plan,
  included_limit, unit,
  overage_unit_cost, overage_unit, overage_cap,
  display_label, display_group,
  warning_pct, critical_pct,
  billing_cycle, sort_order, notes, is_active, has_public_api
) VALUES
  ('vercel', 'overage_present', 'free',
   1, 'state',
   NULL, NULL, NULL,
   'In Overage', 'Cost',
   1, 101,
   'monthly_reset', 22,
   'FIX-1050. 0 = Vercel usage is still inside the $20 included credit this '
   || 'cycle; 1 = it has passed it and every further dollar is billable. Exists '
   || 'because warning_pct is an integer column and $0.01 of $20 is 0.05%, so '
   || 'the first-cent alert could not be expressed as a percentage band on the '
   || 'dollar row. Written each snapshot tick from '
   || 'computeVercelBilling().billable_overage_mtd_usd — ACTUAL month-to-date, '
   || 'not the projection, because the projection reads ~$22 from one ordinary '
   || 'day of usage and would false-fire every month. Warning-only by '
   || 'construction (critical_pct 101): the page belongs to '
   || 'vercel.billable_overage_usd at $10.',
   true, true),
  ('vercel', 'overage_present', 'pro',
   1, 'state',
   NULL, NULL, NULL,
   'In Overage', 'Cost',
   1, 101,
   'monthly_reset', 22,
   'FIX-1050. See the free-tier row. This is the row that actually renders — '
   || 'pipeline_state.platform_plan overrides vercel to ''pro''.',
   true, true)
ON CONFLICT (service, metric, plan) DO NOTHING;

-- Converge an already-seeded row (re-run, or a hand-inserted one) onto the
-- bands above. Without this the ON CONFLICT above would silently keep whatever
-- thresholds were there first.
UPDATE public.platform_limits
   SET warning_pct = 1, critical_pct = 101, included_limit = 1, is_active = true,
       updated_at = now()
 WHERE service = 'vercel'
   AND metric  = 'overage_present';
