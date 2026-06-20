-- FIX-618 / SF engagement (PR B) — polymorphic, DISPLAY-ONLY entity engagement
-- rollup feeding up to three independent badges on accountable entities:
--
--   Claimed          — an active answerer grant exists for the entity (binary).
--   Engaged          — the office responds: answers_count / answered_rate /
--                      last_answer_at, surfaced as a tiered "Responsive" label.
--   Active community — citizens active around the entity in the last 30 days:
--                      non-answer comments + last_activity_at, tiered label.
--
-- Keyed (entity_type, entity_id) over entity_type ∈ {official, institution,
-- jurisdiction}. "institution" is the agencies+governing_bodies UNION space
-- (the institutions view id = agency.id / gb.id), which is also the answerer
-- grant target and the entity_comments entity_id for that type — so one keyspace
-- covers all three. This PR surfaces officials only; institution/jurisdiction
-- cards are PR B2 and reuse this rollup unchanged.
--
-- Materialization mirrors 20260510000001_homepage_stats_mvs.sql
-- (official_homepage_stats_mv): a per-entity MV refreshed nightly, read off the
-- request path as an indexed point read, refreshed CONCURRENTLY via a refresh_*
-- function wired into runNightlySync's MV-refresh list.
--
-- DISPLAY-ONLY — the cardinal rule (mirrors synthetic_position_rollup, FIX-614):
-- this MV must NEVER feed any standing/integrity surface — not the bridge
-- scorer, alignment score, position rollups, jury/review draws, or the
-- choropleth. It is read only by the officials index read-layer helper
-- (and PR B2's institution/jurisdiction reads). The rollup deliberately COVERS
-- synthetic entities (is_synthetic is NOT a filter here) so the State of
-- Franklin demo exhibits the badges; the badge confers nothing, exactly like
-- the display-only synthetic_position_rollup precedent. Grep
-- `entity_engagement_rollup_mv` to audit readers.
--
-- Replay-safe: no seed-data dependency; CREATE MATERIALIZED VIEW IF NOT EXISTS
-- populates on creation; the refresh function is CREATE OR REPLACE. now() is
-- evaluated at refresh time (the 30-day community window + grant expiry), which
-- matches the nightly cadence.

-- ─── 1. The per-entity rollup MV ─────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.entity_engagement_rollup_mv AS
WITH comments AS (
  -- One row per (entity_type, entity_id) that has ANY comment activity.
  SELECT
    c.entity_type,
    c.entity_id,
    count(*) FILTER (
      WHERE c.kind = 'answer' AND c.status IN ('visible','needs_review')
    )::int AS answers_count,
    count(*) FILTER (
      WHERE c.kind = 'question' AND c.parent_id IS NULL
        AND c.status IN ('visible','needs_review')
    )::int AS questions_count,
    -- "Active community" = citizens active around the entity in the last 30d.
    -- Everything EXCEPT the office's own answers (those are testimony, not the
    -- surrounding community), among visible/needs_review rows.
    count(*) FILTER (
      WHERE c.kind <> 'answer'
        AND c.status IN ('visible','needs_review')
        AND c.created_at > now() - interval '30 days'
    )::int AS community_count_30d,
    max(c.created_at) FILTER (
      WHERE c.kind = 'answer' AND c.status IN ('visible','needs_review')
    ) AS last_answer_at,
    max(c.created_at) FILTER (
      WHERE c.status IN ('visible','needs_review')
    ) AS last_activity_at
  FROM public.entity_comments c
  WHERE c.entity_type IN ('official','institution','jurisdiction')
  GROUP BY c.entity_type, c.entity_id
),
answered AS (
  -- answered_questions = root questions on the entity with ≥1 visible answer.
  -- Feeds answered_rate = answered_questions / questions_count.
  SELECT
    q.entity_type,
    q.entity_id,
    count(*) FILTER (
      WHERE EXISTS (
        SELECT 1 FROM public.entity_comments a
        WHERE a.parent_id = q.id
          AND a.kind = 'answer'
          AND a.status IN ('visible','needs_review')
      )
    )::int AS answered_questions
  FROM public.entity_comments q
  WHERE q.entity_type IN ('official','institution','jurisdiction')
    AND q.kind = 'question'
    AND q.parent_id IS NULL
    AND q.status IN ('visible','needs_review')
  GROUP BY q.entity_type, q.entity_id
),
claims AS (
  -- Identity-agnostic "Claimed": an active, unexpired answerer grant exists.
  -- Mirrors has_active_answerer_grant's (role, target_type) mapping per type;
  -- target_id IS the entity_id for every type (official id / institution-view
  -- id = agency/gb id / jurisdiction id).
  SELECT
    CASE
      WHEN g.role = 'official'           AND g.target_type = 'official'     THEN 'official'
      WHEN g.role = 'institution_admin'  AND g.target_type = 'institution'  THEN 'institution'
      WHEN g.role = 'jurisdiction_admin' AND g.target_type = 'jurisdiction' THEN 'jurisdiction'
    END AS entity_type,
    g.target_id AS entity_id
  FROM public.entity_grants g
  WHERE g.status = 'active'
    AND (g.expires_at IS NULL OR g.expires_at > now())
    AND (
         (g.role = 'official'           AND g.target_type = 'official')
      OR (g.role = 'institution_admin'  AND g.target_type = 'institution')
      OR (g.role = 'jurisdiction_admin' AND g.target_type = 'jurisdiction')
    )
  GROUP BY 1, g.target_id
)
SELECT
  COALESCE(c.entity_type, cl.entity_type)                       AS entity_type,
  COALESCE(c.entity_id,   cl.entity_id)                         AS entity_id,
  (cl.entity_id IS NOT NULL)                                    AS is_claimed,
  COALESCE(c.answers_count, 0)                                  AS answers_count,
  COALESCE(c.questions_count, 0)                                AS questions_count,
  CASE
    WHEN COALESCE(c.questions_count, 0) > 0
      THEN round(COALESCE(a.answered_questions, 0)::numeric / c.questions_count, 4)
    ELSE 0
  END                                                           AS answered_rate,
  c.last_answer_at,
  COALESCE(c.community_count_30d, 0)                            AS community_count_30d,
  c.last_activity_at,
  now()                                                         AS refreshed_at
FROM comments c
FULL OUTER JOIN claims   cl ON cl.entity_type = c.entity_type AND cl.entity_id = c.entity_id
LEFT JOIN      answered  a  ON a.entity_type  = c.entity_type AND a.entity_id  = c.entity_id;

-- Unique index = PK, and the prerequisite for REFRESH ... CONCURRENTLY. Each
-- (entity_type, entity_id) appears at most once (both source CTEs are grouped
-- unique per key and the FULL OUTER JOIN is on the key).
CREATE UNIQUE INDEX IF NOT EXISTS entity_engagement_rollup_mv_pk
  ON public.entity_engagement_rollup_mv (entity_type, entity_id);

GRANT SELECT ON public.entity_engagement_rollup_mv
  TO anon, authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.entity_engagement_rollup_mv IS
  'FIX-618: per-(entity_type,entity_id) DISPLAY-ONLY engagement rollup over official|institution|jurisdiction. Feeds the Claimed/Engaged/Active-community badges only. Never feeds standing/integrity (bridge scorer, alignment, position rollups, jury draws, choropleth). Covers synthetic entities by design (SF demo). Refreshed nightly via refresh_entity_engagement_rollup_mv().';

-- ─── 2. Refresh helper (wired into runNightlySync MV-refresh list) ───────────
CREATE OR REPLACE FUNCTION public.refresh_entity_engagement_rollup_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.entity_engagement_rollup_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_entity_engagement_rollup_mv()
  TO authenticated, service_role;
