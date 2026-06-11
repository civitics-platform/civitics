-- FIX-540 (C1 polish): keyset pagination for get_entity_statements and
-- get_entity_questions.
--
-- get_entity_statements was an uncapped jsonb_agg; get_entity_questions a flat
-- LIMIT 100. Both gain p_limit (default 50, clamp 1..100) + p_cursor params and
-- a `next_cursor` key, keyset-paginating in SQL on the existing sort with an id
-- tiebreak appended:
--   * statements — vote-volume total DESC, created_at DESC, id DESC
--   * questions  — the p_sort-dependent keys, normalized to all-DESC so a
--     row-wise comparison works: ord1 ((NOT answered)::int when 'unanswered',
--     else 0 — identical ordering to the old answered ASC), ord2 (want_count
--     when 'wanted'/'unanswered', else 0), created_at, id.
--
-- Return shape stays a SINGLE jsonb object (never SETOF — PostgREST caps SETOF
-- at max_rows=1000): statements returns { statements: [...], next_cursor },
-- questions keeps { can_answer, total, awaiting, questions: [...] } + next_cursor.
-- The cursor is the pipe-joined sort-key tuple of the last returned row, opaque
-- to callers; a malformed cursor falls back to page one rather than erroring.
-- Pages are fetched LIMIT+1 so next_cursor is non-null only when more rows
-- actually exist (no trailing empty page).
--
-- The old 3-arg signatures are DROPped (not overloaded): defaults on the new
-- 5-arg form would make a 3-named-param PostgREST call ambiguous between the
-- two overloads (300 Multiple Choices).
--
-- Replay-safe on an EMPTY database: no seed-data dependency; DROP ... IF EXISTS
-- + CREATE OR REPLACE throughout. search_path is the UNQUOTED comma form (the
-- quoted form breaks on prod Pro); per-function statement_timeout per the
-- new-RPC rule.

-- ---------------------------------------------------------------------------
-- a. get_entity_statements(p_entity_type, p_entity_id, p_lens, p_limit, p_cursor)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_entity_statements(text, uuid, text);

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
  -- Cursor = 'total|created_at|id' of the last row of the previous page.
  -- Malformed → treated as absent (page one), never an error.
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
    -- All sort keys are DESC, so "after the cursor" is a single row-wise <.
    -- LIMIT+1: the extra row only signals that a next page exists.
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

REVOKE ALL ON FUNCTION public.get_entity_statements(text, uuid, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_entity_statements(text, uuid, text, int, text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_entity_statements(text, uuid, text, int, text) IS
  'C1 Wave C statement list (FIX-533), paginated in FIX-540: keyset on (vote-volume total DESC, created_at DESC, id DESC), p_limit clamp 1..100 (default 50). Returns a single jsonb { statements: [...], next_cursor } — never SETOF. Cursor = total|created_at|id of the last row; malformed cursors fall back to page one.';

-- ---------------------------------------------------------------------------
-- b. get_entity_questions(p_official_id, p_lens, p_sort, p_limit, p_cursor)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_entity_questions(uuid, text, text);

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

  -- Cursor = 'ord1|ord2|created_at|id' of the last row of the previous page
  -- (the sort-normalized keys, so the same opaque shape works for every
  -- p_sort). Malformed → page one. A cursor minted under a different p_sort
  -- pages wrong, not errors — callers reset the cursor on sort change.
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
    -- Normalize the p_sort-dependent keys to all-DESC: (NOT answered)::int DESC
    -- is the same ordering as the old answered ASC (unanswered first).
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
          'answers',        COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id',          a.id,
                'body',        a.body,
                'created_at',  a.created_at,
                'is_official', true,
                'author_name', COALESCE(NULLIF(btrim(au.display_name), ''),
                                        'citizen-' || left(a.author_id::text, 8))
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

REVOKE ALL ON FUNCTION public.get_entity_questions(uuid, text, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_entity_questions(uuid, text, text, int, text)
  TO anon, authenticated;

COMMENT ON FUNCTION public.get_entity_questions(uuid, text, text, int, text) IS
  'C1 Wave D Q&A lane read (FIX-536), paginated in FIX-540: keyset on the sort-normalized all-DESC keys (ord1, ord2, created_at, id), p_limit clamp 1..100 (default 50). total/awaiting stay full-set counts. Returns a single jsonb { can_answer, total, awaiting, questions: [...], next_cursor } — never SETOF. Cursor = ord1|ord2|created_at|id of the last row; malformed cursors fall back to page one.';
