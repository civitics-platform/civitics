-- FIX-572 / SF-P1 — is_synthetic + confirmed-abuse quarantine predicate.
--
-- Builds the quarantine seam for the upcoming "State of Franklin" AI demonstration
-- jurisdiction: synthetic content must NEVER earn standing. State-of-Franklin bible
-- §2.3 (the quarantine), §5.3, §9.3, §12 (item SF-P1).
--
-- LOCKED RULES (bible §2.3 + phase-2 design §2.3):
--   1. Actor-not-location: the flag lives on the AUTHOR and on the ENTITY, never
--      on the thread/location. A real human is real wherever they post (incl. the
--      sandbox); an AI author is synthetic wherever it posts.
--   2. Two predicate halves, kept distinct and greppable (marker: SF-P1):
--      - STANDING / reputation / ranking / visibility surfaces exclude
--        synthetic authors AND synthetic entities AND confirmed-abuse authors.
--        "No standing is ever built on fiction or on abuse."
--      - MODERATION / admin-review surfaces exclude synthetic authors ONLY —
--        a real human's post on a synthetic entity is still a real post that
--        needs human review (the moderation floor applies in the sandbox).
--   3. Behavior-neutral on current data: every column is NOT NULL DEFAULT false.
--      With zero synthetic/abuse rows today, every gated surface returns
--      identical results before and after this migration.
--
-- WHY the gate lives in compute/aggregate surfaces, not display reads:
--   Bible §9.3/§5.3 lock that seed bridge scores and signature counts are
--   *authored* display-only values, and "the live scorer only ever runs on real,
--   non-synthetic participation." So the live computations EXCLUDE synthetic
--   content (never clobbering the authored seed values / never conferring real
--   standing), while the per-entity display reads (comments/map,
--   get_entity_comment_highlights.common_ground) surface those authored columns
--   unchanged. The scorer is the single writer of bridge_score/map_x/map_y, so
--   gating it gates every downstream visibility read that requires those columns.

-- ─── 1. Author flags (users) ──────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN is_synthetic       boolean NOT NULL DEFAULT false,
  ADD COLUMN is_confirmed_abuse boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.users.is_synthetic IS
  'SF-P1: AI/synthetic author (State of Franklin sandbox). Excluded from every standing computation; excluded from moderation queues. NOT NULL DEFAULT false.';
COMMENT ON COLUMN public.users.is_confirmed_abuse IS
  'SF-P1: confirmed-abuse author (manual admin path, FIX-572). Excluded from every standing computation; RETAINED in moderation queues for review.';

-- ─── 2. is_synthetic on seeded entity tables ──────────────────────────────────
-- Every entity table that can hold a synthetic Franklin entity AND participate
-- in a standing surface. Bible §13.1: "Every synthetic row carries
-- is_synthetic = true (author AND entity). No exceptions."
ALTER TABLE public.officials          ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE public.proposals          ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE public.governing_bodies   ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE public.jurisdictions      ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE public.financial_entities ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE public.agencies           ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE public.investigations     ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
ALTER TABLE public.evidence_cards     ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;

-- ─── 3. The shared predicate — three greppable helpers (marker: SF-P1) ─────────
-- LANGUAGE sql STABLE so the planner can inline the scalar subqueries. These are
-- the single source of truth; every future surface (brigade detector, C2 jury
-- draw) must apply them rather than hand-rolling a WHERE clause.

-- Standing half: synthetic OR confirmed-abuse author → excluded from standing.
CREATE OR REPLACE FUNCTION public.author_excluded_from_standing(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  -- SF-P1 quarantine (standing half): no standing on synthetic or abuse authors.
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_user_id
      AND (u.is_synthetic OR u.is_confirmed_abuse)
  );
$$;

-- Moderation half: synthetic author → excluded. Confirmed-abuse + real authors
-- are RETAINED (a real person's post still needs human review, even in the sandbox).
CREATE OR REPLACE FUNCTION public.author_is_synthetic(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  -- SF-P1 quarantine (moderation half): exclude synthetic authors only.
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_user_id AND u.is_synthetic
  );
$$;

-- Entity half: maps the polymorphic entity_comments/entity_positions discriminator
-- to its backing table(s) and reports whether that entity is synthetic.
--   institution → governing_bodies ∪ agencies  (the public.institutions UNION view)
--   district / jurisdiction → jurisdictions
CREATE OR REPLACE FUNCTION public.is_synthetic_entity(p_entity_type text, p_entity_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  -- SF-P1 quarantine (entity half): no standing on synthetic entities.
  SELECT CASE p_entity_type
    WHEN 'official'         THEN EXISTS (SELECT 1 FROM public.officials          t WHERE t.id = p_entity_id AND t.is_synthetic)
    WHEN 'proposal'         THEN EXISTS (SELECT 1 FROM public.proposals          t WHERE t.id = p_entity_id AND t.is_synthetic)
    WHEN 'financial_entity' THEN EXISTS (SELECT 1 FROM public.financial_entities t WHERE t.id = p_entity_id AND t.is_synthetic)
    WHEN 'jurisdiction'     THEN EXISTS (SELECT 1 FROM public.jurisdictions      t WHERE t.id = p_entity_id AND t.is_synthetic)
    WHEN 'district'         THEN EXISTS (SELECT 1 FROM public.jurisdictions      t WHERE t.id = p_entity_id AND t.is_synthetic)
    WHEN 'investigation'    THEN EXISTS (SELECT 1 FROM public.investigations     t WHERE t.id = p_entity_id AND t.is_synthetic)
    WHEN 'institution'      THEN EXISTS (SELECT 1 FROM public.governing_bodies   t WHERE t.id = p_entity_id AND t.is_synthetic)
                              OR  EXISTS (SELECT 1 FROM public.agencies          t WHERE t.id = p_entity_id AND t.is_synthetic)
    ELSE false
  END;
$$;

GRANT EXECUTE ON FUNCTION public.author_excluded_from_standing(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.author_is_synthetic(uuid)           TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_synthetic_entity(text, uuid)     TO anon, authenticated, service_role;

-- ─── 4. Bridge scorer — the single standing gate (author + rater + entity) ─────
-- Excludes: synthetic/abuse comment AUTHORS (protects authored seed scores +
-- denies synthetic comments computed standing), synthetic/abuse RATERS (no
-- standing from fake endorsements), and synthetic ENTITIES (a real comment on a
-- fake entity earns no computed standing). Body is otherwise the live definition.
CREATE OR REPLACE FUNCTION public.recompute_comment_bridge_scores(
  p_entity_type text DEFAULT NULL::text,
  p_entity_id   uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH scope AS (
    SELECT c.id, c.entity_type, c.entity_id
    FROM public.entity_comments c
    WHERE c.status IN ('visible','needs_review')
      AND (p_entity_type IS NULL OR c.entity_type = p_entity_type)
      AND (p_entity_id   IS NULL OR c.entity_id   = p_entity_id)
      -- SF-P1 quarantine: no computed standing on synthetic/abuse authors or synthetic entities.
      AND NOT public.author_excluded_from_standing(c.author_id)
      AND NOT public.is_synthetic_entity(c.entity_type, c.entity_id)
  ),
  totals AS (
    SELECT
      s.id                                      AS comment_id,
      count(*)                                  AS total_raters,
      count(*) FILTER (WHERE cr.valuable = 1)   AS valuable_up,
      count(*) FILTER (WHERE cr.valuable = -1)  AS valuable_down
    FROM scope s
    JOIN public.comment_ratings cr ON cr.comment_id = s.id
      -- SF-P1 quarantine: synthetic/abuse raters confer no standing.
      AND NOT public.author_excluded_from_standing(cr.rater_id)
    GROUP BY s.id
  ),
  endorsers AS (
    -- one row per (comment, endorser); resolve the endorser's side
    SELECT
      s.id AS comment_id,
      CASE
        WHEN ep.stance IS NOT NULL THEN sign(ep.stance)::int
        WHEN cr.agree  IS NOT NULL THEN sign(cr.agree)::int
        ELSE 0
      END AS side
    FROM scope s
    JOIN public.comment_ratings cr
      ON cr.comment_id = s.id AND cr.valuable = 1
      -- SF-P1 quarantine: synthetic/abuse raters confer no standing.
      AND NOT public.author_excluded_from_standing(cr.rater_id)
    LEFT JOIN public.entity_positions ep
      ON ep.user_id     = cr.rater_id
     AND ep.entity_type = s.entity_type
     AND ep.entity_id   = s.entity_id
  ),
  sides AS (
    SELECT
      comment_id,
      count(*) FILTER (WHERE side > 0) AS pos,
      count(*) FILTER (WHERE side < 0) AS neg
    FROM endorsers
    GROUP BY comment_id
  ),
  computed AS (
    SELECT
      s.id                       AS comment_id,
      t.total_raters,
      t.valuable_up,
      t.valuable_down,
      COALESCE(sd.pos, 0)        AS pos,
      COALESCE(sd.neg, 0)        AS neg
    FROM scope s
    LEFT JOIN totals t ON t.comment_id = s.id
    LEFT JOIN sides  sd ON sd.comment_id = s.id
  ),
  final AS (
    SELECT
      comment_id,
      CASE WHEN qualifies THEN map_x        END AS map_x,
      CASE WHEN qualifies THEN map_y        END AS map_y,
      CASE WHEN qualifies THEN bridge_score END AS bridge_score
    FROM (
      SELECT
        comment_id,
        (COALESCE(total_raters, 0) >= 5 AND (pos + neg) >= 2) AS qualifies,
        CASE WHEN (pos + neg) > 0
             THEN (pos - neg)::numeric / (pos + neg) END AS map_x,
        CASE WHEN (pos + neg) > 0
             THEN 2.0 * least(pos, neg)::numeric / (pos + neg) END AS map_y,
        CASE WHEN (pos + neg) > 0
             THEN greatest(0, least(1,
                    (valuable_up - valuable_down)::numeric / NULLIF(total_raters, 0)))
                  * (2.0 * least(pos, neg)::numeric / (pos + neg))
             END AS bridge_score
      FROM computed
    ) z
  )
  UPDATE public.entity_comments ec
  SET bridge_score = f.bridge_score,
      map_x        = f.map_x,
      map_y        = f.map_y
  FROM final f
  WHERE ec.id = f.comment_id
    AND (ec.bridge_score IS DISTINCT FROM f.bridge_score
      OR ec.map_x        IS DISTINCT FROM f.map_x
      OR ec.map_y        IS DISTINCT FROM f.map_y);

  -- "rows scored" = comments in scope that now carry a non-NULL score. Stable
  -- across idempotent re-runs (the UPDATE above changed nothing on a re-run).
  -- SF-P1: same quarantine predicate so the count reflects only comments WE score.
  SELECT count(*) INTO v_count
  FROM public.entity_comments ec
  WHERE ec.bridge_score IS NOT NULL
    AND ec.status IN ('visible','needs_review')
    AND (p_entity_type IS NULL OR ec.entity_type = p_entity_type)
    AND (p_entity_id   IS NULL OR ec.entity_id   = p_entity_id)
    AND NOT public.author_excluded_from_standing(ec.author_id)
    AND NOT public.is_synthetic_entity(ec.entity_type, ec.entity_id);

  RETURN v_count;
END;
$function$;

-- ─── 5. Position rollup — author-side standing gate ───────────────────────────
-- entity_positions has no authored display column, so the live aggregate is the
-- only standing surface: synthetic/abuse positions never count. Body otherwise live.
CREATE OR REPLACE FUNCTION public.get_entity_position_rollup(
  p_entity_type text,
  p_entity_id   uuid,
  p_lens        text DEFAULT 'all'::text)
RETURNS TABLE(n integer, median numeric, pct_with_conditions numeric, buckets jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
SET statement_timeout TO '5s'
AS $function$
DECLARE
  v_lens text := CASE WHEN p_lens = 'constituents' THEN 'constituents' ELSE 'all' END;
BEGIN
  RETURN QUERY
  WITH rows AS (
    SELECT ep.stance, ep.conditions_md
    FROM public.entity_positions ep
    WHERE ep.entity_type = p_entity_type
      AND ep.entity_id   = p_entity_id
      AND (v_lens = 'all' OR ep.constituent_jurisdiction_id IS NOT NULL)
      -- SF-P1 quarantine: synthetic/abuse positions never count toward standing.
      AND NOT public.author_excluded_from_standing(ep.user_id)
  ),
  agg AS (
    SELECT
      count(*)::int AS cnt,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY stance)::numeric AS med,
      count(*) FILTER (WHERE conditions_md IS NOT NULL AND btrim(conditions_md) <> '')::numeric AS with_cond
    FROM rows
  ),
  dist AS (
    SELECT jsonb_object_agg(gs.s::text, COALESCE(bc.c, 0)) AS b
    FROM generate_series(-3, 3) AS gs(s)
    LEFT JOIN (SELECT stance, count(*) AS c FROM rows GROUP BY stance) bc ON bc.stance = gs.s
  )
  SELECT
    agg.cnt,
    CASE WHEN agg.cnt < 10 THEN NULL ELSE round(agg.med, 2) END,
    CASE WHEN agg.cnt < 10 THEN NULL ELSE round(agg.with_cond / NULLIF(agg.cnt, 0), 4) END,
    CASE WHEN agg.cnt < 10 THEN NULL ELSE dist.b END
  FROM agg, dist;
END;
$function$;

-- ─── 6. Alignment score — author-side standing gate ───────────────────────────
-- A synthetic/abuse user earns no alignment standing → empty result for them.
-- Body otherwise live (FIX-438 definition); no change to the alignment math.
CREATE OR REPLACE FUNCTION public.compute_alignment_score(p_user_id uuid, p_official_id uuid)
RETURNS TABLE(alignment_ratio numeric, matched_votes integer, total_votes integer, vote_details jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '3s'
AS $function$
BEGIN
  RETURN QUERY
  WITH overlap AS (
    SELECT
      ep.entity_id                       AS proposal_id,
      COALESCE(p.short_title, p.title)   AS proposal_title,
      CASE WHEN ep.stance > 0 THEN 'support' ELSE 'oppose' END AS user_pos,
      v.vote                             AS official_vote,
      CASE
        WHEN ep.stance > 0 AND v.vote = 'yes' THEN true
        WHEN ep.stance < 0 AND v.vote = 'no'  THEN true
        ELSE false
      END                                AS aligned
    FROM entity_positions ep
    JOIN votes     v ON v.bill_proposal_id = ep.entity_id
                     AND v.official_id = p_official_id
    JOIN proposals p ON p.id = ep.entity_id
    WHERE ep.user_id     = p_user_id
      AND ep.entity_type = 'proposal'
      AND ep.stance     <> 0                 -- neutral excluded from total_votes
      AND p.vote_category = 'substantive'
      -- SF-P1 quarantine: synthetic/abuse users earn no alignment standing.
      AND NOT public.author_excluded_from_standing(p_user_id)
  )
  SELECT
    ROUND(COALESCE(AVG(aligned::int), 0)::numeric, 2),
    COALESCE(SUM(aligned::int), 0)::int,
    COUNT(*)::int,
    COALESCE(
      (SELECT jsonb_agg(row_data ORDER BY (row_data->>'aligned')::boolean DESC)
       FROM (
         SELECT jsonb_build_object(
           'proposal_id',   proposal_id,
           'title',         proposal_title,
           'user_pos',      user_pos,
           'official_vote', official_vote,
           'aligned',       aligned
         ) AS row_data
         FROM overlap
         LIMIT 10
       ) sub),
      '[]'::jsonb
    )
  FROM overlap;
END;
$function$;

-- ─── 7. Initiative signature count — author-side standing gate (RPC) ───────────
-- Replaces the route's two PostgREST count queries with one gated RPC so the
-- predicate is server-side + greppable. Bible §5.3: synthetic signatures are
-- flagged + non-counting; real users may still sign in place. SECURITY DEFINER
-- because civic_initiative_signatures SELECT is public anyway (civic_sigs_select_all
-- USING true) — counts are unchanged today (behavior-neutral).
CREATE OR REPLACE FUNCTION public.count_initiative_signatures(p_initiative_id uuid)
RETURNS TABLE(total integer, constituent_verified integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- SF-P1 quarantine: synthetic/abuse signers never count toward real standing.
  SELECT
    count(*)::int,
    count(*) FILTER (WHERE s.verification_tier = 'district')::int
  FROM public.civic_initiative_signatures s
  WHERE s.initiative_id = p_initiative_id
    AND NOT public.author_excluded_from_standing(s.user_id);
$$;

GRANT EXECUTE ON FUNCTION public.count_initiative_signatures(uuid) TO anon, authenticated, service_role;
