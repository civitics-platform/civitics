-- FIX-986 — homepage_stats_mv is the only MV refreshed non-CONCURRENTLY, and it
-- is the one the homepage reads.
--
-- THE DEFECT. Of the 13 `relkind='m'` relations in `public`, homepage_stats_mv
-- is the ONLY one with no unique index. The other 7 of 7 MVs in
-- refresh_derived_mvs('daily')'s unit array — proposal_trending_24h,
-- proposal_popularity_24h, official_homepage_stats_mv,
-- entity_engagement_rollup_mv, homepage_agency_counts_mv,
-- commons_active_threads, pipeline_runtime_stats_mv — all carry one and are all
-- refreshed CONCURRENTLY. Unit 3 alone is not: the live body of
-- refresh_homepage_stats_mv() is literally
--     REFRESH MATERIALIZED VIEW public.homepage_stats_mv;
-- (verified against prod before this migration).
--
-- `REFRESH ... CONCURRENTLY` REQUIRES a unique index, so the missing index is
-- the CAUSE and the ACCESS EXCLUSIVE lock is the CONSEQUENCE — held for the
-- whole refresh, on a materialized view the homepage reads.
--
-- WHY THIS IS NOT HYPOTHETICAL. This exact object is the receipt behind
-- playbook C4 ("runtime measurements are floors — design to survive the miss"):
-- refresh_homepage_stats_mv() takes 0.7 s on local and ran 22 MINUTES against
-- an otherwise-idle prod on 2026-07-31, pushing the homepage to 18.5 s. What
-- this migration adds to that record is WHY it blocked rather than merely ran
-- long — a CONCURRENTLY refresh holds no exclusive lock and the homepage would
-- have kept serving the previous snapshot for all 22 minutes.
--
-- THE FIX IS CHEAP FOR THE RISK IT REMOVES. The MV is a SINGLE ROW, 16 kB on
-- prod, so the index costs nothing.
--
-- WHY refreshed_at IS THE KEY. CONCURRENTLY requires a unique index built from
-- PLAIN COLUMN NAMES — expression indexes (the usual single-row `((1))` trick)
-- and partial indexes are both rejected. refreshed_at is `now()` in the MV's
-- own definition, so it is never NULL and is trivially unique across one row.
-- Verified end-to-end on local: index created, then
-- `REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_stats_mv` succeeded
-- and the row was rewritten with a fresh timestamp.
--
-- ORDER MATTERS: the index must exist before the refresh can be CONCURRENT, so
-- it is created first in this same migration. CONCURRENTLY also requires the MV
-- to be already populated, which it is on every environment that has run the
-- daily job once; a never-populated MV would need one plain REFRESH first.

CREATE UNIQUE INDEX IF NOT EXISTS homepage_stats_mv_singleton_idx
  ON public.homepage_stats_mv (refreshed_at);

-- Signature preserved exactly as it is on prod — LANGUAGE sql, RETURNS void, no
-- args, not SECURITY DEFINER, no proconfig. The only change is the one word.
CREATE OR REPLACE FUNCTION public.refresh_homepage_stats_mv()
RETURNS void
LANGUAGE sql
AS $$
  -- FIX-986: CONCURRENTLY, matching the other seven daily units. Trades a
  -- longer refresh for not holding ACCESS EXCLUSIVE on a homepage read path.
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.homepage_stats_mv;
$$;

COMMENT ON FUNCTION public.refresh_homepage_stats_mv() IS
  'FIX-986 — refreshes homepage_stats_mv CONCURRENTLY. Was the only one of 13 '
  'MVs without a unique index and therefore the only one refreshed '
  'non-CONCURRENTLY, holding ACCESS EXCLUSIVE on a homepage-read MV for the '
  'whole refresh. That is the playbook C4 receipt: 0.7s local / 22 min prod on '
  '2026-07-31 / homepage 18.5s.';
