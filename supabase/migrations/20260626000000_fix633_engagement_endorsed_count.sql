-- FIX-633: count endorsed community notes toward the engagement rollup.
--
-- Q&A v2 PR-2b (FIX-630/631/632) lets a verified answerer ENDORSE a community note
-- instead of writing an answer; get_entity_questions (20260621010000) already treats an
-- endorsed visible community_note as resolving the question (base.answered); but
-- entity_engagement_rollup_mv (FIX-618) still counted kind='answer' ONLY, so a question
-- resolved purely by an endorsed note never lifted the entity's Responsive badge — the
-- per-question and per-entity states disagreed (decision B2's accepted inconsistency).
--
-- Option A: a SEPARATE endorsed_count keeps the written-answer tier distinguishable.
-- answers_count stays kind='answer' only; the answered CTE now counts a question as
-- resolved by a written answer OR an endorsed visible community note (mirrors
-- get_entity_questions' base.answered), which feeds answered_rate; endorsed_count is its
-- own column for the read layer's base "Responsive" trigger. DISPLAY-ONLY rule unchanged
-- (never feeds standing/integrity; covers synthetic entities for the SF demo).
--
-- Postgres has no CREATE OR REPLACE MATERIALIZED VIEW → DROP + CREATE. No DB object
-- depends on the MV (read only by app helpers), so DROP is safe; CREATE ... AS populates
-- WITH DATA, repopulating on local and prod at apply time. Based verbatim on
-- 20260620000000 except the answered CTE + endorsed_count.

DROP MATERIALIZED VIEW IF EXISTS public.entity_engagement_rollup_mv;

CREATE MATERIALIZED VIEW public.entity_engagement_rollup_mv AS
WITH comments AS (
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
  -- A question is resolved by a written answer OR an endorsed visible community note
  -- (mirrors get_entity_questions' base.answered, 20260621010000). answered_questions
  -- feeds answered_rate; endorsed_count = questions resolved via endorsement.
  SELECT
    qf.entity_type,
    qf.entity_id,
    count(*) FILTER (WHERE qf.has_answer OR qf.has_endorsed)::int AS answered_questions,
    count(*) FILTER (WHERE qf.has_endorsed)::int                  AS endorsed_count
  FROM (
    SELECT
      q.entity_type,
      q.entity_id,
      EXISTS (
        SELECT 1 FROM public.entity_comments a
        WHERE a.parent_id = q.id
          AND a.kind = 'answer'
          AND a.status IN ('visible','needs_review')
      ) AS has_answer,
      EXISTS (
        SELECT 1 FROM public.entity_comments cn
        WHERE cn.parent_id = q.id
          AND cn.kind = 'community_note'
          AND cn.status = 'visible'
          AND (cn.metadata ? 'endorsed_at')
      ) AS has_endorsed
    FROM public.entity_comments q
    WHERE q.entity_type IN ('official','institution','jurisdiction')
      AND q.kind = 'question'
      AND q.parent_id IS NULL
      AND q.status IN ('visible','needs_review')
  ) qf
  GROUP BY qf.entity_type, qf.entity_id
),
claims AS (
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
  COALESCE(a.endorsed_count, 0)                                 AS endorsed_count,
  c.last_answer_at,
  COALESCE(c.community_count_30d, 0)                            AS community_count_30d,
  c.last_activity_at,
  now()                                                         AS refreshed_at
FROM comments c
FULL OUTER JOIN claims   cl ON cl.entity_type = c.entity_type AND cl.entity_id = c.entity_id
LEFT JOIN      answered  a  ON a.entity_type  = c.entity_type AND a.entity_id  = c.entity_id;

CREATE UNIQUE INDEX IF NOT EXISTS entity_engagement_rollup_mv_pk
  ON public.entity_engagement_rollup_mv (entity_type, entity_id);

GRANT SELECT ON public.entity_engagement_rollup_mv
  TO anon, authenticated, service_role;

COMMENT ON MATERIALIZED VIEW public.entity_engagement_rollup_mv IS
  'FIX-618 + FIX-633: per-(entity_type,entity_id) DISPLAY-ONLY engagement rollup over official|institution|jurisdiction. Feeds the Claimed/Engaged/Active-community badges only. answers_count = written answers only; endorsed_count = questions resolved by an endorsed community note; answered_rate counts answer-OR-endorsement resolution. Never feeds standing/integrity (bridge scorer, alignment, position rollups, jury draws, choropleth). Covers synthetic entities by design (SF demo). Refreshed nightly via refresh_entity_engagement_rollup_mv().';

CREATE OR REPLACE FUNCTION public.refresh_entity_engagement_rollup_mv()
RETURNS void
LANGUAGE sql
AS $$
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.entity_engagement_rollup_mv;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_entity_engagement_rollup_mv()
  TO authenticated, service_role;
