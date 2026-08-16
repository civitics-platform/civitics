-- FIX-1044 / FIX-1045 / FIX-1046 — cost detection revamp.
--
-- The 2026-08-15 crawl burned ~$21/day for 16 hours and the platform's own
-- alerting could not see it. Not because it was broken — it was healthy — but
-- because of what it was WATCHING: monthly-cumulative thresholds (a $21/day
-- burn takes days to cross an MTD band), one fast-moving leading signal aimed
-- at Supabase CPU rather than request volume, and vendor data whose finest
-- resolution is one day. What actually stopped the burn was a vendor email read
-- by a human. See docs/audits/2026-08-15-traffic-cost-spike.md.
--
-- Three things land here.
--
--  1. FIX-1044 — Cloudflare edge volume as a first-class metric. Cloudflare is
--     the ONLY near-real-time, script-readable counter in this stack and every
--     downstream dollar follows it.
--  2. FIX-1045 — durable state + kill switch for the closed loop that raises
--     the zone's security_level by itself on a sustained spike.
--  3. FIX-1046 — the Vercel billing correction: Pro is $20/mo AND that $20 buys
--     $20 of included usage, so billable = max(0, usage - 20).
--
-- Idempotent throughout: ON CONFLICT DO NOTHING on the seeds, CREATE OR REPLACE
-- on the function, jsonb merge on the kill switch.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FIX-1044 — Cloudflare edge-volume rows
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ORIGIN-REACHING REQUESTS IS THE ALARM. `originResponseStatus != 0` in the CF
-- GraphQL API means the request actually reached Vercel; anything else was
-- blocked, challenged or served from the CF cache. Only origin-reaching
-- requests cost money (~$1.23e-4 each, measured), and keying on them makes the
-- whole system self-limiting: while a mitigation is absorbing a crawl, origin
-- counts collapse and the alarm correctly goes quiet.
--
-- THE 3,000/hr LIMIT IS DERIVED, NOT PICKED. Census of 147 complete hours of
-- Cloudflare history (2026-08-09 03:00 -> 2026-08-15 05:00 UTC — every hour
-- before the crawl onset, and the whole of what this Free zone retains, which
-- is 8 days):
--
--     p50 77   p75 141   p90 283   p95 841   p99 1,508   max 2,218
--
-- versus the unmitigated crawl: min 7,158, p50 7,233, max 7,548. There is a
-- 3.2x gap between the busiest legitimate hour ever recorded and the quietest
-- crawl hour, so anything in [2,500, 7,000] separates them perfectly. 3,000 is
-- max-legit x 1.35: zero false positives across all 147 legitimate hours, and
-- 2.4x below the crawl floor so it also catches a crawl at 40% of this one's
-- rate. Sustained, it is ~$8.85/day — ~27x a baseline day's $0.33.
--
-- The metric is written as a RATE (requests in the last complete clock hour),
-- not a cumulative counter, so billing_cycle is 'none': there is nothing to
-- reset. warning_pct 50 puts the amber band at 1,500/hr, which is above p99 of
-- the legitimate distribution and therefore still a real signal rather than
-- noise.
INSERT INTO platform_limits (
  service, metric, plan,
  included_limit, unit,
  overage_unit_cost, overage_unit, overage_cap,
  display_label, display_group,
  warning_pct, critical_pct,
  billing_cycle, sort_order, notes, is_active, has_public_api
) VALUES
  ('cloudflare', 'origin_requests_hourly', 'free',
   3000, 'requests_per_hour',
   NULL, NULL, NULL,
   'Origin Requests / hr', 'Traffic',
   50, 100,
   'none', 10,
   'FIX-1044. Requests that REACHED the origin in the last complete clock hour '
   || '(Cloudflare originResponseStatus != 0) — the only near-real-time cost '
   || 'signal in the stack, and the trigger for the FIX-1045 auto-mitigation '
   || 'loop. Threshold 3000/hr derived from a 147-hour census of legitimate '
   || 'traffic (p50 77, p99 1508, max 2218) against a measured crawl floor of '
   || '7158/hr. At the measured $1.23e-4 per origin-reaching request, 3000/hr '
   || 'sustained is ~$8.85/day. Re-derive from a longer baseline once the zone '
   || 'has a clean month, and revisit if real human traffic ever grows.',
   true, true),
  ('cloudflare', 'edge_requests_hourly', 'free',
   -1, 'requests_per_hour',
   NULL, NULL, NULL,
   'Edge Requests / hr', 'Traffic',
   80, 100,
   'none', 11,
   'FIX-1044. EVERY request Cloudflare saw in the last complete clock hour, '
   || 'whether or not it reached the origin. Context only — included_limit -1 '
   || 'means no threshold and no alerting, because edge requests are free and '
   || 'absorbing a crawl at the edge is the DESIRED state, not a problem. Its '
   || 'value is the contrast with origin_requests_hourly: on 2026-08-15 both '
   || 'read ~7,300/hr at 21:00 UTC, then at 23:00 UTC edge stayed at 7,313 '
   || 'while origin fell to 36. Same traffic, 99% cheaper.',
   true, true),
  ('cloudflare', 'edge_mitigated_pct', 'free',
   100, 'percent',
   NULL, NULL, NULL,
   'Absorbed at Edge', 'Traffic',
   101, 102,
   'none', 12,
   'FIX-1044. Share of the last complete hour that never reached the origin — '
   || 'blocked, challenged, or CF-cached. HIGH IS GOOD, which is why the '
   || 'warning/critical bands are set above 100 and can never fire: this row '
   || 'exists to make a working mitigation visible on the card, and an alarm on '
   || 'it would be an alarm on the defence succeeding.',
   true, true)
ON CONFLICT (service, metric, plan) DO NOTHING;

-- Same three rows for the 'pro' plan so a pipeline_state.platform_plan override
-- of the cloudflare service cannot make them silently vanish from the card.
INSERT INTO platform_limits (
  service, metric, plan,
  included_limit, unit,
  overage_unit_cost, overage_unit, overage_cap,
  display_label, display_group,
  warning_pct, critical_pct,
  billing_cycle, sort_order, notes, is_active, has_public_api
)
SELECT service, metric, 'pro',
       included_limit, unit,
       overage_unit_cost, overage_unit, overage_cap,
       display_label, display_group,
       warning_pct, critical_pct,
       billing_cycle, sort_order, notes || ' (pro-plan mirror of the free row)',
       is_active, has_public_api
  FROM platform_limits
 WHERE service = 'cloudflare'
   AND plan = 'free'
   AND metric IN ('origin_requests_hourly', 'edge_requests_hourly', 'edge_mitigated_pct')
ON CONFLICT (service, metric, plan) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FIX-1046 — the Vercel billing correction
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT WAS WRONG. `vercel.monthly_spend_usd` holds the projected sum of
-- EffectiveCost across every charge line, which includes both within-allotment
-- consumption AND the prorated `Pro` subscription line. The dashboard displayed
-- that number as the money owed. Measured on prod 2026-08-16 it read $31.38/mo
-- when the true billable overage was $0.00 with $8.62 of credit unspent.
--
-- WHY THAT MATTERS BEYOND COSMETICS: a headline that reads "$31" on a perfectly
-- normal month cannot alarm. There is no band you can put on it that
-- distinguishes healthy from burning.
--
-- THE MODEL (Craig-stated 2026-08-16):
--     usage    = EffectiveCost total - the `Pro` subscription line
--     billable = max(0, usage - 20)
--     bill     = 20 + billable
-- The `Pro` line is the SUBSCRIPTION, not consumption, so it does not draw down
-- the credit the subscription buys. Leaving it in would peg the account at
-- "100% of credit" from the first of every month.
--
-- included_usage_usd IS the credit: its included_limit of 20 is simultaneously
-- the config value the collector reads and the denominator of the % bar, so
-- retuning the credit is one UPDATE and no deploy.
INSERT INTO platform_limits (
  service, metric, plan,
  included_limit, unit,
  overage_unit_cost, overage_unit, overage_cap,
  display_label, display_group,
  warning_pct, critical_pct,
  billing_cycle, sort_order, notes, is_active, has_public_api
) VALUES
  ('vercel', 'included_usage_usd', 'pro',
   20, 'usd',
   NULL, NULL, NULL,
   'Usage vs $20 Credit', 'Cost',
   80, 100,
   'monthly_reset', 20,
   'FIX-1046. Projected month-end METERED CONSUMPTION (EffectiveCost total '
   || 'MINUS the `Pro` subscription line) against the $20 of usage that Pro '
   || 'includes. included_limit is BOTH the alert denominator and the config '
   || 'value packages/db/src/platform-snapshot.ts reads for the credit, so '
   || 'changing the credit is one UPDATE. Crossing 100% here means real money '
   || 'starts being owed, which is exactly when a warning is useful. '
   || 'CYCLE BASIS CAVEAT: the charges API is queried from the first of the '
   || 'CALENDAR month and the `Pro` line prorates over 31 days, so the '
   || 'projection is calendar-month; the Vercel usage page separately describes '
   || 'an Aug 14 - Sep 14 cycle. Nothing in the API discriminates. If the true '
   || 'cycle is not the calendar month, the projection is off by the phase '
   || 'difference, never by more than one cycle length.',
   true, true),
  ('vercel', 'billable_overage_usd', 'pro',
   20, 'usd',
   NULL, NULL, NULL,
   'Billable Overage', 'Cost',
   50, 100,
   'monthly_reset', 21,
   'FIX-1046. THE HEADLINE: projected month-end money actually owed above the '
   || 'included credit, i.e. max(0, projected usage - 20). $0.00 on a normal '
   || 'month — prod read $0.00 on 2026-08-16 while the card was claiming '
   || '$31.38. The included_limit of 20 here is a PROVISIONAL page-me ceiling '
   || '("overage equal to the subscription, i.e. the bill has doubled") pending '
   || 'Craig confirming a real number; it is deliberately a platform_limits row '
   || 'rather than a constant so answering that question is an UPDATE. '
   || 'warning_pct 50 = page at $10/mo of true overage.',
   true, true)
ON CONFLICT (service, metric, plan) DO NOTHING;

-- Free-plan mirrors: the vercel service runs on a 'pro' override today, but a
-- missing free row makes the metric vanish if that override is ever removed.
INSERT INTO platform_limits (
  service, metric, plan,
  included_limit, unit,
  overage_unit_cost, overage_unit, overage_cap,
  display_label, display_group,
  warning_pct, critical_pct,
  billing_cycle, sort_order, notes, is_active, has_public_api
)
SELECT service, metric, 'free',
       included_limit, unit,
       overage_unit_cost, overage_unit, overage_cap,
       display_label, display_group,
       warning_pct, critical_pct,
       billing_cycle, sort_order, notes || ' (free-plan mirror of the pro row)',
       is_active, has_public_api
  FROM platform_limits
 WHERE service = 'vercel'
   AND plan = 'pro'
   AND metric IN ('included_usage_usd', 'billable_overage_usd')
ON CONFLICT (service, metric, plan) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. FIX-1045 — kill switch for the closed loop
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Arms the Cloudflare zone-settings WRITE. Off = detection, metrics and every
-- alert stay fully live and only the PATCH is disarmed, so disabling the loop
-- can never make the platform blinder than it was before FIX-1045 shipped.
--
-- NOTE auto_trip_threshold_pct is NULL and `metrics` is empty ON PURPOSE. Every
-- other switch here can be auto-tripped by a cost metric crossing a band; this
-- one must not be. A cost metric switching off the machinery that DEFENDS
-- against cost is a failure mode that writes itself.
--
-- jsonb || merge, so re-running never disturbs the six existing switches.
UPDATE public.pipeline_state
   SET value = value || jsonb_build_object(
         'cf_auto_mitigation',
         jsonb_build_object(
           'enabled', true,
           'auto_trip_threshold_pct', NULL,
           'metrics', '[]'::jsonb
         )
       ),
       updated_at = now()
 WHERE key = 'kill_switches'
   AND NOT (value ? 'cf_auto_mitigation');

INSERT INTO public.pipeline_state (key, value)
SELECT 'kill_switches',
       jsonb_build_object(
         'cf_auto_mitigation',
         jsonb_build_object('enabled', true, 'auto_trip_threshold_pct', NULL, 'metrics', '[]'::jsonb)
       )
 WHERE NOT EXISTS (SELECT 1 FROM public.pipeline_state WHERE key = 'kill_switches');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. FIX-1044 D2 — daily cost deltas out of the snapshot history
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The 2026-08-15 audit established the spike was 3.7x baseline by hand-writing
-- a window function over payload->'metrics'. This is that query, promoted to a
-- function so the burn-rate rule can run every tick.
--
-- WHY IT RUNS IN THE DATABASE. `platform_usage_snapshot` takes ~150 rows/day
-- and each payload is a large jsonb document. Shipping a fortnight of them to a
-- Vercel function to pluck two numbers out of each would be absurd; this
-- returns one small row per MTD day.
--
-- WHY TWO SOURCES FOR base_usd. Going forward `payload->'vercel_billing'` (this
-- PR) carries the plan-base split directly. For rows written BEFORE this PR the
-- only record of it is the projected `Pro` line inside vercel_breakdown, which
-- de-projects as `usd * window_days / 31` — the identity the audit validated
-- against prod (day 15 read exactly $9.6774 = 0.6452 x 15). COALESCE prefers
-- the new path and falls back to the old, so the burn-rate rule has usable
-- history from the moment it deploys instead of waiting a week to arm.
--
-- Vercel's counters step ONCE PER DAY at ~07:00 UTC, so max() over all snapshots
-- sharing a window_days is the settled end-of-day value for that MTD day.
CREATE OR REPLACE FUNCTION public.get_platform_daily_cost_deltas(p_days integer DEFAULT 12)
RETURNS TABLE (mtd_day integer, gross_usd numeric, base_usd numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH s AS (
    SELECT payload
      FROM public.platform_usage_snapshot
     WHERE fetched_at >= now() - make_interval(days => GREATEST(p_days, 1) + 2)
       AND payload ? 'vercel_breakdown'
  ), per_snapshot AS (
    SELECT
      (s.payload->'vercel_breakdown'->>'window_days')::int AS wd,
      -- Gross: Σ EffectiveCost MTD, un-projected. Lives on the
      -- monthly_spend_usd metric's metadata as raw_window_value.
      (SELECT (e->'metadata'->>'raw_window_value')::numeric
         FROM jsonb_array_elements(s.payload->'metrics') e
        WHERE e->>'service' = 'vercel'
          AND e->>'metric'  = 'monthly_spend_usd'
        LIMIT 1) AS gross,
      -- Base, new path: written un-projected by FIX-1046.
      (s.payload->'vercel_billing'->>'plan_base_mtd_usd')::numeric AS base_new,
      -- Base, legacy path: the `Pro` line is stored PROJECTED, so de-project it.
      (SELECT (svc->>'usd')::numeric * NULLIF((s.payload->'vercel_breakdown'->>'window_days')::numeric, 0) / 31.0
         FROM jsonb_array_elements(s.payload->'vercel_breakdown'->'services') svc
        WHERE lower(svc->>'service') IN ('pro', 'hobby', 'enterprise')
        LIMIT 1) AS base_legacy
    FROM s
  )
  SELECT wd AS mtd_day,
         max(gross) AS gross_usd,
         COALESCE(max(base_new), max(base_legacy), 0) AS base_usd
    FROM per_snapshot
   WHERE wd IS NOT NULL
     AND gross IS NOT NULL
   GROUP BY wd
   ORDER BY wd;
$$;

COMMENT ON FUNCTION public.get_platform_daily_cost_deltas(integer) IS
  'FIX-1044. One row per Vercel month-to-date day: cumulative gross EffectiveCost '
  'and the plan-subscription share. packages/db/src/burn-rate.ts differentiates '
  'these into per-day consumption and compares against the trailing median. '
  'SECURITY DEFINER because platform_usage_snapshot is admin-read; EXECUTE is '
  'revoked from anon/authenticated below (FIX-834).';

-- FIX-834: Supabase default-grants EXECUTE on new functions to anon and
-- authenticated. This one reads internal cost history and is called only by the
-- snapshot collector on the service-role key, so both are revoked.
REVOKE EXECUTE ON FUNCTION public.get_platform_daily_cost_deltas(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_platform_daily_cost_deltas(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_platform_daily_cost_deltas(integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_platform_daily_cost_deltas(integer) TO service_role;
