-- FIX-594 (Commons/Desk MVP, PR1 backend) — cross-entity "discussion ledger".
--
-- The homepage Commons module needs the most *bridging* root comment threads
-- across the WHOLE platform, but every C1 comment read surface is per-entity
-- (/api/comments 400s without an entity_id) and the IOWait-bound Pro Small
-- cannot take a request-path cross-table scan. So this is the one cross-entity
-- aggregation: a nightly MV, one row per bridge-ranked root comment ("thread"),
-- read MV-only + fail-soft from apps/civitics/app/page.tsx (FIX-595).
--
-- Pattern matches the homepage MVs (20260510000001_homepage_stats_mvs.sql,
-- 20260523010000_homepage_agency_counts_mv.sql): pre-aggregate nightly, REFRESH
-- CONCURRENTLY via a UNIQUE index, served from indexed point reads. Refresh is
-- wired into the daily pipeline AFTER scoreComments (packages/data/src/pipelines
-- /index.ts) so it reads fresh bridge_score.
--
-- Ranking is bridge x recency, NEVER raw volume / trending — court-of-record,
-- not an engagement feed (design decision 2).
--
-- Replay-safe on an EMPTY database: CREATE MATERIALIZED VIEW IF NOT EXISTS /
-- CREATE OR REPLACE FUNCTION; the population query over 0 rows yields an empty
-- MV with no error. No seed-data dependency.

-- ---------------------------------------------------------------------------
-- a. commons_active_threads — one row per bridge-ranked root comment
-- ---------------------------------------------------------------------------
-- Population (design decisions 2-4):
--   parent_id IS NULL AND status='visible' AND kind <> 'answer'
--     (answers surface under their question; questions are kept + chipped).
--   Synthetic-quarantine: users.is_synthetic does NOT exist yet (the
--     State-of-Franklin sandbox lands it later, parent design §2). When it does,
--     add  AND NOT author.is_synthetic  at the WHERE clause below.
--   ORDER BY bridge_score DESC NULLS LAST, last_activity_at DESC; cap top 50.
--
-- rater_count: rating_summary carries per-axis vote COUNTS (agree_up/down,
--   valuable_up/down) that double-count anyone who rated both axes, so it has no
--   honest distinct-rater key to reuse. We match the scorer's `total_raters`
--   semantics instead (recompute_comment_bridge_scores: count(*) over
--   comment_ratings) — exact, and free here on the nightly batch path. The MV
--   exposes only the aggregate count, never per-rater rows, preserving the
--   "ratings private, aggregate public" contract (comment_ratings RLS is
--   bypassed at refresh because the refresh fn is SECURITY DEFINER).
CREATE MATERIALIZED VIEW IF NOT EXISTS public.commons_active_threads AS
WITH roots AS (
  SELECT
    c.id, c.entity_type, c.entity_id, c.author_id, c.kind, c.body,
    c.bridge_score, c.created_at
  FROM public.entity_comments c
  WHERE c.parent_id IS NULL
    AND c.status = 'visible'
    AND c.kind <> 'answer'
    -- TODO(synthetic-quarantine): AND NOT author.is_synthetic once the sandbox lands
),
child_agg AS (
  SELECT
    parent_id,
    count(*)::int             AS reply_count,
    max(created_at)           AS last_child_at,
    bool_or(kind = 'answer')  AS has_answer
  FROM public.entity_comments
  WHERE parent_id IS NOT NULL
  GROUP BY parent_id
),
ratings_agg AS (
  -- Distinct raters = one comment_ratings row per (comment, rater); matches the
  -- scorer's total_raters. count(*) is already distinct via the PK.
  SELECT comment_id, count(*)::int AS rater_count
  FROM public.comment_ratings
  GROUP BY comment_id
)
SELECT
  r.id                                              AS comment_id,
  r.entity_type,
  r.entity_id,
  r.author_id,
  r.kind,
  left(r.body, 140)                                 AS excerpt,
  r.bridge_score                                    AS bridge_score,
  COALESCE(ca.reply_count, 0)                       AS reply_count,
  COALESCE(ra.rater_count, 0)                       AS rater_count,
  COALESCE(ca.has_answer, false)                    AS has_answer,
  greatest(r.created_at, COALESCE(ca.last_child_at, r.created_at)) AS last_activity_at,
  r.created_at
FROM roots r
LEFT JOIN child_agg  ca ON ca.parent_id = r.id
LEFT JOIN ratings_agg ra ON ra.comment_id = r.id
ORDER BY r.bridge_score DESC NULLS LAST, last_activity_at DESC
LIMIT 50;

-- Required for REFRESH ... CONCURRENTLY (matches the homepage MV pattern).
CREATE UNIQUE INDEX IF NOT EXISTS commons_active_threads_pk
  ON public.commons_active_threads (comment_id);

GRANT SELECT ON public.commons_active_threads
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- b. refresh_commons_active_threads_mv()
-- ---------------------------------------------------------------------------
-- Mirrors refresh_homepage_stats_mv etc. CREATE MATERIALIZED VIEW above
-- populates on creation, so REFRESH CONCURRENTLY is safe from the first call.
-- Wired into the daily refresh block in packages/data/src/pipelines/index.ts,
-- positioned after the comment bridge scorer (scoreComments) so it reads fresh
-- bridge_score.
CREATE OR REPLACE FUNCTION public.refresh_commons_active_threads_mv()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.commons_active_threads;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_commons_active_threads_mv()
  TO authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.commons_active_threads IS
  'FIX-594 (Commons/Desk MVP PR1): cross-entity discussion ledger. One row per bridge-ranked root comment (parent_id IS NULL, status=visible, kind<>answer), top 50 by bridge_score DESC NULLS LAST, last_activity_at DESC. Read MV-only + fail-soft from the homepage Commons module (FIX-595). Refreshed nightly after the comment bridge scorer.';
