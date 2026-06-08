-- FIX-527 / FIX-528 (C1 Wave B): comment bridge scorer + highlights + rollup polish.
--
-- Lights up the dormant entity_comments.bridge_score / map_x / map_y columns
-- (FIX-519 shipped them NULL) by turning two-axis ratings + positions into the
-- "where does this debate stand" picture:
--
--   recompute_comment_bridge_scores(et, eid)  — set-based nightly scorer; the
--     single UPDATE...FROM aggregation that writes the three dedicated columns.
--     Invoked via direct pg.Client (lib/heavy-rebuild.ts) from data:score-comments
--     and the nightly enrichment phase. Writes ONLY bridge_score/map_x/map_y —
--     never rating_summary, which the C0 refresh trigger rebuilds wholesale and
--     would clobber.
--   get_entity_comment_highlights(et, eid, lens) — proportional-representation
--     "highlights" read: common-ground (top bridge_score) + steelman (best of
--     each stance bucket). Pinned strip above the list + map.
--   get_entity_position_rollup(...) — Wave-A polish: median percentile_cont ->
--     percentile_disc so a surfaced median is an actual -3..+3 bucket, not 1.5.
--
-- Replay-safe on an EMPTY database: every statement is CREATE OR REPLACE; the
-- scorer's UPDATE over 0 rows scores 0 with no error. No seed-data dependency.
--
-- search_path is UNQUOTED comma-separated on every function (the quoted form
-- breaks on prod Pro). Per-function statement_timeout matches house discipline.

-- ---------------------------------------------------------------------------
-- a. recompute_comment_bridge_scores() — the nightly set-based scorer
-- ---------------------------------------------------------------------------
-- Bridge math (locked, decision 2). For each status IN ('visible','needs_review')
-- comment c on entity (et,eid):
--   total_raters       = #comment_ratings rows for c
--   valuable_up/down   = those rows with valuable = +1 / -1
--   endorser           = a rater who marked valuable = +1
--   side(endorser)     = sign(stance) from that rater's entity_positions row on
--                        (et,eid) if present; else sign(agree) from their rating
--                        on c; else 0 (ignored)
--   pos / neg          = #endorsers with side > 0 / side < 0
--   map_x  (-1..+1)    = (pos - neg) / (pos + neg)          -- endorser lean
--   map_y  ( 0..+1)    = 2 * min(pos,neg) / (pos + neg)     -- cross-stance balance
--   valuable_rate      = clamp((valuable_up - valuable_down) / total_raters, 0, 1)
--   bridge_score       = valuable_rate * map_y
-- THRESHOLD: all three columns are NULL unless total_raters >= 5 AND pos+neg >= 2
-- (the honest low-volume heuristic — most comments stay unrated and that's
-- correct; never fabricate a score). A comment that was scored and later drops
-- below threshold (lost ratings) resets all three to NULL.
--
-- FUTURE WORK (explicit non-builds this wave): matrix-factorization bridging,
-- Wilson/Bayesian lower-bound smoothing, and folding constituent/district
-- diversity into bridge_score. The current function is the deterministic
-- heuristic; the refinements layer on top of the same columns later.
--
-- Returns the number of comments in scope that currently carry a non-NULL
-- bridge_score ("rows scored"). The UPDATE itself is minimal-write (IS DISTINCT
-- FROM guard) so a no-op re-run touches zero rows and does not bump updated_at.
-- NOT SECURITY DEFINER: runs as the pipeline's direct-pg connection (table
-- owner / service role), mirroring rebuild_financial_entity_size_tags etc.
CREATE OR REPLACE FUNCTION public.recompute_comment_bridge_scores(
  p_entity_type text DEFAULT NULL,
  p_entity_id   uuid DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public, extensions
SET statement_timeout = '120s'
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH scope AS (
    SELECT c.id, c.entity_type, c.entity_id
    FROM public.entity_comments c
    WHERE c.status IN ('visible','needs_review')
      AND (p_entity_type IS NULL OR c.entity_type = p_entity_type)
      AND (p_entity_id   IS NULL OR c.entity_id   = p_entity_id)
  ),
  totals AS (
    SELECT
      s.id                                      AS comment_id,
      count(*)                                  AS total_raters,
      count(*) FILTER (WHERE cr.valuable = 1)   AS valuable_up,
      count(*) FILTER (WHERE cr.valuable = -1)  AS valuable_down
    FROM scope s
    JOIN public.comment_ratings cr ON cr.comment_id = s.id
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
  SELECT count(*) INTO v_count
  FROM public.entity_comments ec
  WHERE ec.bridge_score IS NOT NULL
    AND ec.status IN ('visible','needs_review')
    AND (p_entity_type IS NULL OR ec.entity_type = p_entity_type)
    AND (p_entity_id   IS NULL OR ec.entity_id   = p_entity_id);

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.recompute_comment_bridge_scores(text, uuid) IS
  'C1 Wave B (FIX-527): nightly set-based bridge scorer. Writes entity_comments.bridge_score/map_x/map_y only (never rating_summary). NULL below total_raters>=5 AND pos+neg>=2. Scoped when args non-NULL, full sweep when NULL. Returns #comments currently scored. Called via direct pg.Client (lib/heavy-rebuild.ts).';

-- The scorer is invoked through the direct-pg allow-list in
-- packages/data/src/lib/heavy-rebuild.ts (ALLOWED_REBUILDS) — see that file.

-- ---------------------------------------------------------------------------
-- b. get_entity_comment_highlights() — proportional-representation strip
-- ---------------------------------------------------------------------------
-- Returns {common_ground:[...up to 3...], steelman:{support,oppose,conditional}}.
--   common_ground = up to 3 comments by bridge_score DESC (non-NULL only).
--   steelman.<bucket> = the single highest valuable_net comment with that stance
--     (regardless of bridge_score), or null when the bucket is empty.
-- Each entry carries what the strip renders: id, snippet (first ~120 chars),
-- stance, kind, bridge_score, map_x/map_y, rating_summary, valuable_net,
-- author_name, created_at. SECURITY DEFINER with the visible-status filter baked
-- in (avoids invoker-RLS surprises; entity_comments is anon-readable for visible
-- rows anyway). lens='constituents' restricts to constituent-stamped comments
-- (decision 9) — no second constituent-only bridge_score this wave.
CREATE OR REPLACE FUNCTION public.get_entity_comment_highlights(
  p_entity_type text,
  p_entity_id   uuid,
  p_lens        text DEFAULT 'all'
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_lens text := CASE WHEN p_lens = 'constituents' THEN 'constituents' ELSE 'all' END;
  v_result jsonb;
BEGIN
  WITH base AS (
    SELECT
      c.id, c.stance, c.kind, c.body, c.bridge_score, c.map_x, c.map_y,
      c.rating_summary, c.author_id, c.created_at,
      COALESCE((c.rating_summary ->> 'valuable_up')::int, 0)
        - COALESCE((c.rating_summary ->> 'valuable_down')::int, 0)
        + COALESCE((c.rating_summary ->> 'legacy_upvotes')::int, 0) AS valuable_net
    FROM public.entity_comments c
    WHERE c.entity_type = p_entity_type
      AND c.entity_id   = p_entity_id
      AND c.status IN ('visible','needs_review')
      AND (v_lens = 'all' OR c.constituent_jurisdiction_id IS NOT NULL)
  ),
  enriched AS (
    SELECT
      b.id, b.stance, b.bridge_score, b.valuable_net, b.created_at,
      jsonb_build_object(
        'id',             b.id,
        'stance',         b.stance,
        'kind',           b.kind,
        'snippet',        CASE WHEN char_length(b.body) > 120
                               THEN left(b.body, 120) || '…' ELSE b.body END,
        'bridge_score',   b.bridge_score,
        'map_x',          b.map_x,
        'map_y',          b.map_y,
        'rating_summary', b.rating_summary,
        'valuable_net',   b.valuable_net,
        'author_name',    COALESCE(NULLIF(btrim(u.display_name), ''),
                                   'citizen-' || left(b.author_id::text, 8)),
        'created_at',     b.created_at
      ) AS obj
    FROM base b
    LEFT JOIN public.users u ON u.id = b.author_id
  ),
  cg AS (
    SELECT jsonb_agg(obj ORDER BY ord_bridge DESC, ord_created DESC) AS arr
    FROM (
      SELECT obj, bridge_score AS ord_bridge, created_at AS ord_created
      FROM enriched
      WHERE bridge_score IS NOT NULL
      ORDER BY bridge_score DESC, created_at DESC
      LIMIT 3
    ) t
  ),
  steel AS (
    SELECT DISTINCT ON (e.stance) e.stance AS bucket, e.obj AS obj
    FROM enriched e
    WHERE e.stance IN ('support','oppose','conditional')
    ORDER BY e.stance, e.valuable_net DESC, e.created_at DESC
  )
  SELECT jsonb_build_object(
    'common_ground', COALESCE((SELECT arr FROM cg), '[]'::jsonb),
    'steelman', jsonb_build_object(
      'support',     (SELECT obj FROM steel WHERE bucket = 'support'),
      'oppose',      (SELECT obj FROM steel WHERE bucket = 'oppose'),
      'conditional', (SELECT obj FROM steel WHERE bucket = 'conditional')
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_entity_comment_highlights(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_entity_comment_highlights(text, uuid, text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_entity_comment_highlights(text, uuid, text) IS
  'C1 Wave B (FIX-528): proportional-representation highlights. common_ground = top-3 by bridge_score; steelman = best valuable_net per stance bucket. lens=constituents restricts to constituent-stamped comments.';

-- ---------------------------------------------------------------------------
-- c. get_entity_position_rollup() — Wave-A median polish (percentile_disc)
-- ---------------------------------------------------------------------------
-- IDENTICAL to 20260607060000 except the median uses percentile_disc instead of
-- percentile_cont, so the surfaced median is an actual -3..+3 bucket (a stance
-- with a label) rather than an interpolated 1.5. Same signature, same min-n (10)
-- behaviour, same lens handling. CREATE OR REPLACE in this new migration — the
-- Wave A migration is NOT edited.
CREATE OR REPLACE FUNCTION public.get_entity_position_rollup(
  p_entity_type text,
  p_entity_id   uuid,
  p_lens        text DEFAULT 'all'
) RETURNS TABLE (
  n                   int,
  median              numeric,
  pct_with_conditions numeric,
  buckets             jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
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
$$;

GRANT EXECUTE ON FUNCTION public.get_entity_position_rollup(text, uuid, text) TO anon, authenticated;
