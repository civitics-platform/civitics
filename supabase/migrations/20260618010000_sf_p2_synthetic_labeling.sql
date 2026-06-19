-- SF-P2 (FIX-599) — persistent synthetic labeling, read-path plumbing.
--
-- FIX-572 (20260618000000) landed the is_synthetic columns; nothing reads them.
-- This migration carries author.is_synthetic THROUGH the RPC/MV read surfaces
-- that resolve author identity in SQL (the app-layer surfaces are handled by
-- extending fetchNameMap). No is_synthetic column is changed here.
--
-- Surfaces plumbed:
--   a. commons_active_threads MV   — homepage Commons (Option 2: include+label)
--   b. get_entity_comment_highlights — highlights strip
--   c. get_entity_statements        — statement mode
--   d. get_entity_questions         — Q&A lane (asker + each answerer)
--
-- BEHAVIOR-NEUTRAL on current data: 0 rows have is_synthetic=true today, so
-- every added field is `false` and the MV returns exactly the same rows. The
-- Commons MV does NOT filter on is_synthetic (Option 2, decided 2026-06-18) —
-- synthetic rows surface WITH the SYNTHETIC mark; auto-demotion is SF-P9.
--
-- Replay-safe on an EMPTY database: DROP ... IF EXISTS + CREATE throughout; the
-- population queries over 0 rows yield empty results with no error. search_path
-- is the UNQUOTED comma form (the quoted form breaks on prod Pro); per-function
-- statement_timeout preserved from the originals.

-- ---------------------------------------------------------------------------
-- a. commons_active_threads — recreate carrying author_is_synthetic (Option 2)
-- ---------------------------------------------------------------------------
-- Identical to 20260614040000 EXCEPT: a LEFT JOIN public.users au on the root's
-- author_id, selecting au.is_synthetic AS author_is_synthetic. The Step-2
-- synthetic-quarantine TODO is resolved as Option 2 (include + label): the flag
-- is a SELECTED column, NOT a WHERE filter, so synthetic exemplars fill the
-- empty launch Commons and render with the per-utterance SYNTHETIC mark.
DROP MATERIALIZED VIEW IF EXISTS public.commons_active_threads;

CREATE MATERIALIZED VIEW public.commons_active_threads AS
WITH roots AS (
  SELECT
    c.id, c.entity_type, c.entity_id, c.author_id, c.kind, c.body,
    c.bridge_score, c.created_at
  FROM public.entity_comments c
  WHERE c.parent_id IS NULL
    AND c.status = 'visible'
    AND c.kind <> 'answer'
    -- Synthetic-quarantine resolved as Option 2 (SF-P2, FIX-599): author
    -- is_synthetic is SELECTED below, not filtered, so synthetic exemplars
    -- surface WITH the SYNTHETIC mark. No WHERE clause added here.
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
  SELECT comment_id, count(*)::int AS rater_count
  FROM public.comment_ratings
  GROUP BY comment_id
)
SELECT
  r.id                                              AS comment_id,
  r.entity_type,
  r.entity_id,
  r.author_id,
  COALESCE(au.is_synthetic, false)                  AS author_is_synthetic,
  r.kind,
  left(r.body, 140)                                 AS excerpt,
  r.bridge_score                                    AS bridge_score,
  COALESCE(ca.reply_count, 0)                       AS reply_count,
  COALESCE(ra.rater_count, 0)                       AS rater_count,
  COALESCE(ca.has_answer, false)                    AS has_answer,
  greatest(r.created_at, COALESCE(ca.last_child_at, r.created_at)) AS last_activity_at,
  r.created_at
FROM roots r
LEFT JOIN public.users au ON au.id = r.author_id
LEFT JOIN child_agg  ca ON ca.parent_id = r.id
LEFT JOIN ratings_agg ra ON ra.comment_id = r.id
ORDER BY r.bridge_score DESC NULLS LAST, last_activity_at DESC
LIMIT 50;

CREATE UNIQUE INDEX commons_active_threads_pk
  ON public.commons_active_threads (comment_id);

GRANT SELECT ON public.commons_active_threads
  TO anon, authenticated, service_role;

-- Refresh fn unchanged (re-emitted for self-containment).
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
  'FIX-594 (Commons/Desk MVP PR1), SF-P2/FIX-599 quarantine resolved Option 2: cross-entity discussion ledger, one row per bridge-ranked root comment, top 50. Carries author_is_synthetic (SELECTED, not filtered) so synthetic exemplars surface on the homepage Commons WITH the SYNTHETIC mark.';

-- ---------------------------------------------------------------------------
-- b. get_entity_comment_highlights — add author_is_synthetic to each obj
-- ---------------------------------------------------------------------------
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
        'author_is_synthetic', COALESCE(u.is_synthetic, false),
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

COMMENT ON FUNCTION public.get_entity_comment_highlights(text, uuid, text) IS
  'C1 Wave B (FIX-528); SF-P2/FIX-599: each highlight obj carries author_is_synthetic for the persistent SYNTHETIC mark. common_ground = top-3 by bridge_score; steelman = best valuable_net per stance bucket.';

-- ---------------------------------------------------------------------------
-- c. get_entity_statements — add author_is_synthetic to each statement obj
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_entity_statements(
  p_entity_type text,
  p_entity_id   uuid,
  p_lens        text DEFAULT 'all',
  p_limit       int  DEFAULT 50,
  p_cursor      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_lens      text := CASE WHEN p_lens = 'constituents' THEN 'constituents' ELSE 'all' END;
  v_user      uuid := auth.uid();
  v_limit     int  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_c_total   int;
  v_c_created timestamptz;
  v_c_id      uuid;
  v_result    jsonb;
BEGIN
  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_c_total   := split_part(p_cursor, '|', 1)::int;
      v_c_created := split_part(p_cursor, '|', 2)::timestamptz;
      v_c_id      := split_part(p_cursor, '|', 3)::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_c_total := NULL; v_c_created := NULL; v_c_id := NULL;
    END;
  END IF;

  WITH base AS (
    SELECT
      s.id, s.body, s.status, s.source_comment_id, s.vote_summary,
      s.constituent_jurisdiction_id, s.author_id, s.created_at,
      ( COALESCE((s.vote_summary ->> 'agree')::int, 0)
      + COALESCE((s.vote_summary ->> 'disagree')::int, 0)
      + COALESCE((s.vote_summary ->> 'pass')::int, 0) ) AS total
    FROM public.entity_statements s
    WHERE s.entity_type = p_entity_type
      AND s.entity_id   = p_entity_id
      AND s.status IN ('visible','needs_review')
      AND (v_lens = 'all' OR s.constituent_jurisdiction_id IS NOT NULL)
  ),
  page AS (
    SELECT *, row_number() OVER (ORDER BY total DESC, created_at DESC, id DESC) AS rn
    FROM base
    WHERE v_c_id IS NULL
       OR (total, created_at, id) < (v_c_total, v_c_created, v_c_id)
    ORDER BY total DESC, created_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT jsonb_build_object(
    'statements', COALESCE(
      jsonb_agg(t.obj ORDER BY t.rn) FILTER (WHERE t.rn <= v_limit), '[]'::jsonb),
    'next_cursor', CASE WHEN max(t.rn) > v_limit THEN
        max(t.total::text || '|' || t.created_at::text || '|' || t.id::text)
          FILTER (WHERE t.rn = v_limit)
      ELSE NULL END
  )
  INTO v_result
  FROM (
    SELECT
      p.rn, p.total, p.created_at, p.id,
      jsonb_build_object(
        'id',                p.id,
        'body',              p.body,
        'status',            p.status,
        'source_comment_id', p.source_comment_id,
        'vote_summary',      p.vote_summary,
        'is_constituent',    (p.constituent_jurisdiction_id IS NOT NULL),
        'author_name',       COALESCE(NULLIF(btrim(u.display_name), ''),
                                      'citizen-' || left(p.author_id::text, 8)),
        'author_is_synthetic', COALESCE(u.is_synthetic, false),
        'my_vote',           sv.vote,
        'created_at',        p.created_at
      ) AS obj
    FROM page p
    LEFT JOIN public.users u ON u.id = p.author_id
    LEFT JOIN public.statement_votes sv
      ON sv.statement_id = p.id AND sv.voter_id = v_user
  ) t;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_entity_statements(text, uuid, text, int, text) IS
  'C1 Wave C statement list (FIX-533), paginated FIX-540; SF-P2/FIX-599: each statement obj carries author_is_synthetic. Keyset on (vote-volume total DESC, created_at DESC, id DESC). Returns a single jsonb { statements: [...], next_cursor }.';

-- ---------------------------------------------------------------------------
-- d. get_entity_questions — add asker + per-answer author_is_synthetic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_entity_questions(
  p_official_id uuid,
  p_lens        text DEFAULT 'all',
  p_sort        text DEFAULT 'wanted',
  p_limit       int  DEFAULT 50,
  p_cursor      text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_lens       text := CASE WHEN p_lens = 'constituents' THEN 'constituents' ELSE 'all' END;
  v_sort       text := CASE WHEN p_sort IN ('newest','unanswered') THEN p_sort ELSE 'wanted' END;
  v_user       uuid := auth.uid();
  v_can_answer boolean := false;
  v_limit      int  := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_c_ord1     int;
  v_c_ord2     int;
  v_c_created  timestamptz;
  v_c_id       uuid;
  v_result     jsonb;
BEGIN
  IF v_user IS NOT NULL THEN
    v_can_answer := public.has_active_official_grant(v_user, p_official_id);
  END IF;

  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_c_ord1    := split_part(p_cursor, '|', 1)::int;
      v_c_ord2    := split_part(p_cursor, '|', 2)::int;
      v_c_created := split_part(p_cursor, '|', 3)::timestamptz;
      v_c_id      := split_part(p_cursor, '|', 4)::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_c_ord1 := NULL; v_c_ord2 := NULL; v_c_created := NULL; v_c_id := NULL;
    END;
  END IF;

  WITH base AS (
    SELECT
      q.id, q.body, q.status, q.created_at, q.metadata, q.rating_summary,
      q.author_id, q.constituent_jurisdiction_id,
      COALESCE((q.rating_summary ->> 'valuable_up')::int, 0) AS want_count,
      EXISTS (
        SELECT 1 FROM public.entity_comments a
        WHERE a.parent_id = q.id AND a.kind = 'answer' AND a.status = 'visible'
      ) AS answered
    FROM public.entity_comments q
    WHERE q.entity_type = 'official'
      AND q.entity_id   = p_official_id
      AND q.kind        = 'question'
      AND q.parent_id IS NULL
      AND q.status IN ('visible','needs_review')
      AND (v_lens = 'all' OR q.constituent_jurisdiction_id IS NOT NULL)
  ),
  keyed AS (
    SELECT *,
      (CASE WHEN v_sort = 'unanswered' THEN (NOT answered)::int ELSE 0 END) AS ord1,
      (CASE WHEN v_sort IN ('wanted','unanswered') THEN want_count ELSE 0 END) AS ord2
    FROM base
  ),
  page AS (
    SELECT *, row_number() OVER (ORDER BY ord1 DESC, ord2 DESC, created_at DESC, id DESC) AS rn
    FROM keyed
    WHERE v_c_id IS NULL
       OR (ord1, ord2, created_at, id) < (v_c_ord1, v_c_ord2, v_c_created, v_c_id)
    ORDER BY ord1 DESC, ord2 DESC, created_at DESC, id DESC
    LIMIT v_limit + 1
  )
  SELECT jsonb_build_object(
    'can_answer', v_can_answer,
    'total',      (SELECT count(*)::int FROM base),
    'awaiting',   (SELECT count(*)::int FROM base WHERE NOT answered),
    'questions',  COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id',             p.id,
          'body',           p.body,
          'status',         p.status,
          'created_at',     p.created_at,
          'want_count',     p.want_count,
          'rating_summary', p.rating_summary,
          'answered',       p.answered,
          'answered_at',    p.metadata ->> 'answered_at',
          'is_constituent', (p.constituent_jurisdiction_id IS NOT NULL),
          'asker_name',     COALESCE(NULLIF(btrim(u.display_name), ''),
                                     'citizen-' || left(p.author_id::text, 8)),
          'asker_is_synthetic', COALESCE(u.is_synthetic, false),
          'answers',        COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id',          a.id,
                'body',        a.body,
                'created_at',  a.created_at,
                'is_official', true,
                'author_name', COALESCE(NULLIF(btrim(au.display_name), ''),
                                        'citizen-' || left(a.author_id::text, 8)),
                'author_is_synthetic', COALESCE(au.is_synthetic, false)
              ) ORDER BY a.created_at ASC)
            FROM public.entity_comments a
            LEFT JOIN public.users au ON au.id = a.author_id
            WHERE a.parent_id = p.id AND a.kind = 'answer' AND a.status = 'visible'
          ), '[]'::jsonb)
        )
        ORDER BY p.rn)
      FROM page p
      LEFT JOIN public.users u ON u.id = p.author_id
      WHERE p.rn <= v_limit
    ), '[]'::jsonb),
    'next_cursor', (
      SELECT CASE WHEN max(rn) > v_limit THEN
          max(ord1::text || '|' || ord2::text || '|' || created_at::text || '|' || id::text)
            FILTER (WHERE rn = v_limit)
        ELSE NULL END
      FROM page
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_entity_questions(uuid, text, text, int, text) IS
  'C1 Wave D Q&A lane read (FIX-536), paginated FIX-540; SF-P2/FIX-599: asker_is_synthetic + per-answer author_is_synthetic for the SYNTHETIC mark. Keyset on the sort-normalized all-DESC keys. Returns a single jsonb { can_answer, total, awaiting, questions: [...], next_cursor }.';

-- ---------------------------------------------------------------------------
-- e. institutions view — expose is_synthetic from both unioned tables
-- ---------------------------------------------------------------------------
-- The /institutions/[id] detail page + InstitutionCard read this unified view;
-- it did not carry is_synthetic, so synthetic governing_bodies/agencies could
-- not be marked. Recreate identically + add is_synthetic to both branches.
-- security_invoker stays ON (set by 20260531000100) — CREATE OR REPLACE keeps
-- view options, but we re-assert it below to be explicit. Behavior-neutral.
CREATE OR REPLACE VIEW public.institutions AS
  SELECT
    gb.id,
    gb.jurisdiction_id,
    gb.type::text                     AS type,
    gb.name,
    gb.short_name,
    gb.website_url,
    gb.contact_email,
    gb.is_active,
    gb.slug,
    'governing_body'::text            AS source_table,
    ie.acronym,
    ie.usaspending_agency_id,
    ie.usaspending_subtier_id,
    ie.parent_id,
    gb.primary_source,
    gb.primary_source_url,
    gb.primary_source_last_seen_at,
    gb.metadata,
    gb.created_at,
    gb.updated_at,
    -- SF-P2 (FIX-599): appended LAST — CREATE OR REPLACE VIEW can only add
    -- columns at the end, never reorder/insert mid-list.
    gb.is_synthetic
  FROM public.governing_bodies gb
  LEFT JOIN public.institution_extensions ie
    ON ie.governing_body_id = gb.id

  UNION ALL

  SELECT
    a.id,
    a.jurisdiction_id,
    a.agency_type                     AS type,
    a.name,
    a.short_name,
    a.website_url,
    a.contact_email,
    a.is_active,
    NULL::text                        AS slug,
    'agency'::text                    AS source_table,
    a.acronym,
    a.usaspending_agency_id,
    a.usaspending_subtier_id,
    a.parent_agency_id                AS parent_id,
    a.primary_source,
    a.primary_source_url,
    a.primary_source_last_seen_at,
    a.metadata,
    a.created_at,
    a.updated_at,
    a.is_synthetic
  FROM public.agencies a;

ALTER VIEW public.institutions SET (security_invoker = true);
GRANT SELECT ON public.institutions TO anon, authenticated, service_role;
