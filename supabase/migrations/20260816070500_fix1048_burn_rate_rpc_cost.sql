-- FIX-1049 — get_platform_daily_cost_deltas was scanning every snapshot payload.
--
-- NB the FILENAME says fix1048 and the FIX is 1049. `pnpm fix:add` allocated
-- 1049 because a parallel session took 1048 (the Upstash management-API work)
-- between this file being written and the bullet being filed. The name is left
-- alone deliberately: version 20260816070500 is already recorded in the local
-- migration history under it, and migrations are append-only. Grep FIX-1049.
--
-- MEASURED ON PROD, 2026-08-16, from pg_stat_statements:
--
--   calls 9   mean 427.4 ms   max 966.7 ms   109,087 buffer blocks
--   → ~12,000 blocks (~95 MB of buffer traffic) PER CALL, every snapshot tick
--
-- The FIX-1044 implementation read every platform_usage_snapshot row in a
-- 14-day window (276 rows, 4.6 MB of payload, 17 kB average — so nearly all of
-- them TOASTed) and ran jsonb_array_elements over the `metrics` array of each,
-- purely to take max() per MTD day at the end. On an instance with 256 MB
-- shared_buffers and a ~54% cache hit rate this is exactly the churn the
-- playbook warns about: the compute was never profiled, only the read.
--
-- THE INSIGHT THAT MAKES IT CHEAP. Vercel's counters are cumulative and step
-- ONCE PER DAY at ~07:00 UTC (midnight Pacific — ChargePeriodStart days are
-- Pacific days). Consecutive snapshots inside a day are byte-identical to 16
-- decimal places; the 2026-08-15 audit established this. So ~19 of every 20
-- rows carry information already present in one of the others, and the whole
-- 14-day series is recoverable from ONE row per Vercel billing day: the last.
--
-- So: bucket by the Pacific day (`fetched_at - 7h`)::date, take the latest row
-- in each with DISTINCT ON — which touches only fetched_at, no payload — and
-- only THEN do the expensive jsonb extraction, on ~14 rows instead of ~276.
--
-- Same output, ~20x fewer payload detoasts. The result is if anything more
-- correct than max(): the last snapshot of a day is the settled end-of-day
-- value, whereas max() would have quietly preferred a larger mid-day reading
-- had one ever occurred.
--
-- Everything else is unchanged from 20260816060000, including the COALESCE
-- that prefers the FIX-1046 `vercel_billing.plan_base_mtd_usd` and falls back to
-- de-projecting the `Pro` line for rows written before it existed.

CREATE OR REPLACE FUNCTION public.get_platform_daily_cost_deltas(p_days integer DEFAULT 12)
RETURNS TABLE (mtd_day integer, gross_usd numeric, base_usd numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bucketed AS (
    -- Bucket by Pacific day. This CTE touches only fetched_at — no payload is
    -- detoasted to make the selection, which is the whole point.
    SELECT id, payload, ((fetched_at - interval '7 hours')::date) AS pac_day, fetched_at
      FROM public.platform_usage_snapshot
     WHERE fetched_at >= now() - make_interval(days => GREATEST(p_days, 1) + 2)
  ), candidates AS (
    -- BOTH ends of each bucket, not just the last. Insurance, not a bug fix —
    -- no skip has been observed, and the bracketing is here to keep it that way.
    --
    -- The audit dates the counter step at "~06:00-07:00 UTC", i.e. it JITTERS
    -- around the Pacific midnight this buckets on. Measured on the local clone,
    -- the step currently lands cleanly: the last row carrying an old
    -- window_days is 03:45-06:29 UTC and the first carrying the new one is
    -- 07:07-09:32, so a 07:00 boundary separates them every time. But a step at
    -- 06:00 — the early end of the audit's own range — would put a row bearing
    -- the NEW window_days into the OLD bucket, where being last would make it
    -- that bucket's sole representative and silently drop a whole MTD day from
    -- the series.
    --
    -- Bracketing costs one extra detoast per day (~28 rows instead of ~14,
    -- against ~276 before) and captures both window_days values across any
    -- boundary jitter. Duplicates are harmless — the GROUP BY below folds them.
    SELECT id, payload FROM (
      SELECT DISTINCT ON (pac_day) id, payload FROM bucketed ORDER BY pac_day, fetched_at DESC
    ) last_of_day
    UNION
    SELECT id, payload FROM (
      SELECT DISTINCT ON (pac_day) id, payload FROM bucketed ORDER BY pac_day, fetched_at ASC
    ) first_of_day
  ), per_day AS (
    SELECT
      (c.payload->'vercel_breakdown'->>'window_days')::int AS wd,
      (SELECT (e->'metadata'->>'raw_window_value')::numeric
         FROM jsonb_array_elements(c.payload->'metrics') e
        WHERE e->>'service' = 'vercel'
          AND e->>'metric'  = 'monthly_spend_usd'
        LIMIT 1) AS gross,
      (c.payload->'vercel_billing'->>'plan_base_mtd_usd')::numeric AS base_new,
      (SELECT (svc->>'usd')::numeric
                * NULLIF((c.payload->'vercel_breakdown'->>'window_days')::numeric, 0) / 31.0
         FROM jsonb_array_elements(c.payload->'vercel_breakdown'->'services') svc
        WHERE lower(svc->>'service') IN ('pro', 'hobby', 'enterprise')
        LIMIT 1) AS base_legacy
    FROM candidates c
    WHERE c.payload ? 'vercel_breakdown'
  )
  SELECT wd AS mtd_day,
         max(gross) AS gross_usd,
         COALESCE(max(base_new), max(base_legacy), 0) AS base_usd
    FROM per_day
   WHERE wd IS NOT NULL
     AND gross IS NOT NULL
   GROUP BY wd
   ORDER BY wd;
$$;

COMMENT ON FUNCTION public.get_platform_daily_cost_deltas(integer) IS
  'FIX-1044, cost-reduced by FIX-1049. One row per Vercel month-to-date day: '
  'cumulative gross EffectiveCost and the plan-subscription share. '
  'packages/db/src/burn-rate.ts differentiates these into per-day consumption. '
  'Selects ONE snapshot per Pacific billing day before touching any payload — '
  'the original scanned all ~276 rows in the window at 427 ms and ~12k buffer '
  'blocks per call, every tick. SECURITY DEFINER because '
  'platform_usage_snapshot is admin-read; EXECUTE stays revoked from '
  'anon/authenticated (FIX-834).';

-- Grants are not reset by CREATE OR REPLACE, but restate them so this migration
-- is self-contained if ever replayed onto a fresh database.
REVOKE EXECUTE ON FUNCTION public.get_platform_daily_cost_deltas(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_platform_daily_cost_deltas(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_platform_daily_cost_deltas(integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_platform_daily_cost_deltas(integer) TO service_role;
