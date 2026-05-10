-- =============================================================================
-- FIX-223 — Precompute homepage stats off the request path.
--
-- The homepage Server Component (apps/civitics/app/page.tsx) was running:
--   Wave 1: 4× count: 'exact' queries on full tables (officials, proposals,
--           financial_relationships ×2 for donations and contracts/grants)
--   Wave 3: ~20 featured officials × 3 sub-queries (vote count, donor count,
--           donation sum) — the donation sum fetched every donation row and
--           reduced in JS.
--
-- The donor records count intermittently timed out and fell back to 0,
-- producing the "Coming soon" placeholder. The whole page was slow.
--
-- Pattern matches FIX-222 chord global MVs (20260510000000): pre-aggregate
-- nightly, refresh CONCURRENTLY, served from a single-row read.
--
-- Notes on schema:
--   - financial_relationships is polymorphic post-cutover: donations TO an
--     official are (to_type='official', to_id=<official.id>). There is NO
--     official_id column. The pre-MV Wave 3 code queried .eq("official_id"),
--     which silently returned 0 since the cutover.
--   - votes.official_id does exist (FK to officials.id).
-- =============================================================================


-- ── 1. Single-row hero stats ─────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.homepage_stats_mv AS
SELECT
  (SELECT COUNT(*) FROM public.officials WHERE is_active = true)::BIGINT
    AS officials_count,

  (SELECT COUNT(*) FROM public.proposals
    WHERE status IN ('open_comment', 'introduced', 'in_committee', 'floor_vote')
  )::BIGINT AS active_proposals_count,

  (SELECT COUNT(*) FROM public.financial_relationships
    WHERE relationship_type = 'donation'
  )::BIGINT AS donor_records_count,

  (SELECT COUNT(*) FROM public.financial_relationships
    WHERE relationship_type IN ('contract', 'grant')
  )::BIGINT AS spending_records_count,

  NOW() AS refreshed_at;

-- No unique index here: REFRESH CONCURRENTLY needs one over a real column,
-- not a constant expression. Single-row MV → non-CONCURRENT refresh takes
-- milliseconds and only runs nightly at 2am, so the brief lock is invisible.

GRANT SELECT ON public.homepage_stats_mv
  TO anon, authenticated, service_role;


-- ── 2. Per-official stats (replaces Wave 3 .map loop) ────────────────────────
-- Uses CTEs with LEFT JOINs to avoid the votes × donations cross-product
-- that a single GROUP BY would produce. Donor count is strict (donations
-- only); financial_relationship_count is exposed for callers that want the
-- broader number including contracts/grants.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.official_homepage_stats_mv AS
WITH
  vote_counts AS (
    SELECT official_id, COUNT(*)::BIGINT AS vote_count
    FROM public.votes
    GROUP BY official_id
  ),
  donor_counts AS (
    SELECT to_id AS official_id, COUNT(*)::BIGINT AS donor_count
    FROM public.financial_relationships
    WHERE to_type = 'official'
      AND relationship_type = 'donation'
    GROUP BY to_id
  ),
  fin_counts AS (
    SELECT to_id AS official_id, COUNT(*)::BIGINT AS financial_relationship_count
    FROM public.financial_relationships
    WHERE to_type = 'official'
    GROUP BY to_id
  ),
  donation_sums AS (
    SELECT to_id AS official_id, SUM(amount_cents)::BIGINT AS total_donations_cents
    FROM public.financial_relationships
    WHERE to_type = 'official'
      AND relationship_type = 'donation'
      AND amount_cents IS NOT NULL
    GROUP BY to_id
  )
SELECT
  o.id                                              AS official_id,
  COALESCE(vc.vote_count,                  0)::BIGINT AS vote_count,
  COALESCE(dc.donor_count,                 0)::BIGINT AS donor_count,
  COALESCE(fc.financial_relationship_count, 0)::BIGINT AS financial_relationship_count,
  COALESCE(ds.total_donations_cents,       0)::BIGINT AS total_donations_cents,
  NOW()                                              AS refreshed_at
FROM public.officials o
LEFT JOIN vote_counts    vc ON vc.official_id = o.id
LEFT JOIN donor_counts   dc ON dc.official_id = o.id
LEFT JOIN fin_counts     fc ON fc.official_id = o.id
LEFT JOIN donation_sums  ds ON ds.official_id = o.id;

CREATE UNIQUE INDEX IF NOT EXISTS official_homepage_stats_mv_pk
  ON public.official_homepage_stats_mv (official_id);

GRANT SELECT ON public.official_homepage_stats_mv
  TO anon, authenticated, service_role;


-- ── Refresh helpers (called from runNightlySync step 7) ──────────────────────
-- CREATE MATERIALIZED VIEW above populates on creation, so subsequent
-- REFRESH MATERIALIZED VIEW CONCURRENTLY calls are safe.

CREATE OR REPLACE FUNCTION public.refresh_homepage_stats_mv()
RETURNS void
LANGUAGE sql
AS $$
  -- Non-CONCURRENT: single-row MV, refresh in <1s, nightly cron only.
  REFRESH MATERIALIZED VIEW public.homepage_stats_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_homepage_stats_mv()
  TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.refresh_official_homepage_stats_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.official_homepage_stats_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_official_homepage_stats_mv()
  TO authenticated, service_role;
