-- Q&A v2 PR-2b: official endorsement of a community note (FIX-A / FIX-C backend).
--
-- A verified answerer (holder of the active answerer grant for the note's entity)
-- can endorse the best community note on a question — a one-click "the office
-- confirms this reflects the record" — instead of writing their own answer. The
-- endorsed note pins to the top of the community lane with a distinct mark, and
-- the question reads as ANSWERED (decision 1).
--
-- Schema-light: NO new tables, NO new columns. Endorsement lives in the note's
-- existing metadata jsonb (endorsed_at timestamptz, endorsed_by uuid), written
-- ONLY by the new SECURITY DEFINER RPC below. This mirrors the existing
-- answered_at-in-metadata pattern. The FIX-539 entity_comments_pin_immutable
-- trigger pins author_id / entity_type / entity_id / kind /
-- constituent_jurisdiction_id only — metadata is EXPLICITLY mutable — so the
-- metadata UPDATE below passes the trigger cleanly.
--
-- Replay-safe on an EMPTY database: CREATE OR REPLACE throughout; the new RPC is
-- brand new; get_entity_questions keeps its FIX-610 (text,uuid,text,text,int,text)
-- signature → straight CREATE OR REPLACE (no DROP). search_path is the UNQUOTED
-- comma form; per-function statement_timeout matches house discipline.

-- ---------------------------------------------------------------------------
-- a. set_community_note_endorsement() — the gated endorse/withdraw write.
--    Mirrors the submit_comment SECURITY DEFINER write model: auth.uid() resolves
--    from the caller's JWT, the active-answerer grant is the gate, the only write
--    is a metadata merge/strip on the note row. Toggleable + idempotent: last
--    write wins, one endorsement state per note. The pin trigger fires on this
--    UPDATE and PASSES (metadata is not a pinned column).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_community_note_endorsement(
  p_note_id   uuid,
  p_endorsed  boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user uuid := auth.uid();
  -- RECORD (not public.entity_comments rowtype): a partial-column SELECT INTO a
  -- rowtype assigns POSITIONALLY (kind would land in parent_id); a record maps by
  -- the selected column names.
  v_note record;
BEGIN
  -- auth → 401
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Load the target note. Must exist AND be a community_note → 404.
  SELECT id, entity_type, entity_id, kind, status, metadata
    INTO v_note
    FROM public.entity_comments
   WHERE id = p_note_id;

  IF v_note.id IS NULL OR v_note.kind <> 'community_note' THEN
    RAISE EXCEPTION 'community note not found' USING ERRCODE = '42704';
  END IF;

  -- Only a publicly-visible note may be endorsed → 400 (hidden/withdrawn excluded).
  IF v_note.status NOT IN ('visible','needs_review') THEN
    RAISE EXCEPTION 'cannot endorse a hidden note' USING ERRCODE = '22023';
  END IF;

  -- Grant check → 403. Only the verified answerer for the note's entity may
  -- endorse (entity_id IS the grant target for every supported type).
  IF NOT public.has_active_answerer_grant(v_user, v_note.entity_type, v_note.entity_id) THEN
    RAISE EXCEPTION 'only the verified answerer can endorse' USING ERRCODE = '42501';
  END IF;

  IF p_endorsed THEN
    UPDATE public.entity_comments
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || jsonb_build_object('endorsed_at', to_jsonb(now()),
                                            'endorsed_by', to_jsonb(v_user))
     WHERE id = p_note_id;
  ELSE
    UPDATE public.entity_comments
       SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'endorsed_at' - 'endorsed_by')
     WHERE id = p_note_id;
  END IF;

  RETURN jsonb_build_object(
    'id',          p_note_id,
    'is_endorsed', p_endorsed,
    'endorsed_at', CASE WHEN p_endorsed THEN now() ELSE NULL END
  );
END;
$$;

REVOKE ALL    ON FUNCTION public.set_community_note_endorsement(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_community_note_endorsement(uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.set_community_note_endorsement(uuid, boolean) IS
  'Q&A v2 PR-2b (FIX-A): the sole endorse/withdraw path for a community note. SECURITY DEFINER; auth.uid() from the caller JWT; gated on has_active_answerer_grant for the note''s entity. Toggleable + idempotent (last write wins); stores endorsed_at/endorsed_by in the note''s metadata jsonb (no new table/column). The entity_comments_pin_immutable trigger passes — metadata is not a pinned column. Errors: 28000→401, 42704→404 (not a community_note), 22023→400 (hidden), 42501→403 (not the answerer).';

-- ---------------------------------------------------------------------------
-- b. get_entity_questions() redefinition — endorsement read derivation.
--    Carried forward VERBATIM from 20260620010000 (FIX-625, the latest definer)
--    except, per PR-2b:
--      * base.answered — also true when a visible community_note carries endorsed_at.
--      * community_notes elements — add 'is_endorsed' (metadata ? 'endorsed_at').
--      * community_notes ordering — endorsed first, then the existing keys (applied
--        in BOTH the inner ORDER BY … LIMIT 3 and the outer jsonb_agg ORDER BY).
--      * answered_at — COALESCE the official answered_at with the max endorsed_at.
--    Signature unchanged → straight CREATE OR REPLACE (no DROP). Everything else
--    (synthetic fields, community_note_count, keyset, caps) byte-identical.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_entity_questions(
  p_entity_type text,
  p_entity_id   uuid,
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
    v_can_answer := public.has_active_answerer_grant(v_user, p_entity_type, p_entity_id);
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
      -- Q&A v2 PR-2b (FIX-A): a question is answered by a written official answer
      -- OR by an ENDORSED visible community note (the endorsement flips answered).
      (EXISTS (
        SELECT 1 FROM public.entity_comments a
        WHERE a.parent_id = q.id AND a.kind = 'answer' AND a.status = 'visible'
      )
      OR EXISTS (
        SELECT 1 FROM public.entity_comments cn
        WHERE cn.parent_id = q.id AND cn.kind = 'community_note'
          AND cn.status = 'visible' AND (cn.metadata ? 'endorsed_at')
      )) AS answered
    FROM public.entity_comments q
    WHERE q.entity_type = p_entity_type
      AND q.entity_id   = p_entity_id
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
          -- Q&A v2 PR-2b (FIX-A): fall back to the latest endorsement timestamp
          -- when there is no written official answer.
          'answered_at',    COALESCE(
                              p.metadata ->> 'answered_at',
                              (SELECT max(cn.metadata ->> 'endorsed_at')
                                 FROM public.entity_comments cn
                                WHERE cn.parent_id = p.id
                                  AND cn.kind = 'community_note'
                                  AND cn.status = 'visible'
                                  AND (cn.metadata ? 'endorsed_at'))),
          'is_constituent', (p.constituent_jurisdiction_id IS NOT NULL),
          'asker_name',     COALESCE(NULLIF(btrim(u.display_name), ''),
                                     'citizen-' || left(p.author_id::text, 8)),
          -- SF-P2/FIX-599 restore: persistent SYNTHETIC mark on synthetic askers.
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
                -- SF-P2/FIX-599 restore: SYNTHETIC mark on a synthetic answerer.
                'author_is_synthetic', COALESCE(au.is_synthetic, false)
              ) ORDER BY a.created_at ASC)
            FROM public.entity_comments a
            LEFT JOIN public.users au ON au.id = a.author_id
            WHERE a.parent_id = p.id AND a.kind = 'answer' AND a.status = 'visible'
          ), '[]'::jsonb),
          -- Q&A v2 PR-1 (FIX-625) + PR-2b (FIX-A): up to 3 top-ranked community
          -- notes per question. ENDORSED first, then bridge_score DESC NULLS LAST
          -- → valuable_net DESC → created_at DESC. valuable_net mirrors
          -- get_entity_comment_highlights exactly.
          'community_notes', COALESCE((
            SELECT jsonb_agg(elem ORDER BY ord_endorsed DESC, ord_bridge DESC NULLS LAST, ord_valuable DESC, ord_created DESC)
            FROM (
              SELECT
                jsonb_build_object(
                  'id',             cn.id,
                  'body',           cn.body,
                  'created_at',     cn.created_at,
                  'bridge_score',   cn.bridge_score,
                  'rating_summary', cn.rating_summary,
                  'is_constituent', (cn.constituent_jurisdiction_id IS NOT NULL),
                  'is_endorsed',    (cn.metadata ? 'endorsed_at'),
                  'author_name',    COALESCE(NULLIF(btrim(cu.display_name), ''),
                                             'citizen-' || left(cn.author_id::text, 8)),
                  'author_is_synthetic', COALESCE(cu.is_synthetic, false)
                ) AS elem,
                (cn.metadata ? 'endorsed_at') AS ord_endorsed,
                cn.bridge_score AS ord_bridge,
                ( COALESCE((cn.rating_summary ->> 'valuable_up')::int, 0)
                  - COALESCE((cn.rating_summary ->> 'valuable_down')::int, 0)
                  + COALESCE((cn.rating_summary ->> 'legacy_upvotes')::int, 0) ) AS ord_valuable,
                cn.created_at AS ord_created
              FROM public.entity_comments cn
              LEFT JOIN public.users cu ON cu.id = cn.author_id
              WHERE cn.parent_id = p.id
                AND cn.kind = 'community_note'
                AND cn.status = 'visible'
              ORDER BY (cn.metadata ? 'endorsed_at') DESC,
                       cn.bridge_score DESC NULLS LAST,
                       ( COALESCE((cn.rating_summary ->> 'valuable_up')::int, 0)
                         - COALESCE((cn.rating_summary ->> 'valuable_down')::int, 0)
                         + COALESCE((cn.rating_summary ->> 'legacy_upvotes')::int, 0) ) DESC,
                       cn.created_at DESC
              LIMIT 3
            ) top_notes
          ), '[]'::jsonb),
          'community_note_count', (
            SELECT count(*) FROM public.entity_comments cn
            WHERE cn.parent_id = p.id
              AND cn.kind = 'community_note'
              AND cn.status = 'visible'
          )::int
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

REVOKE ALL ON FUNCTION public.get_entity_questions(text, uuid, text, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_entity_questions(text, uuid, text, text, int, text)
  TO anon, authenticated;

COMMENT ON FUNCTION public.get_entity_questions(text, uuid, text, text, int, text) IS
  'C1 Wave D Q&A lane read (FIX-536/540); FIX-610 generalized to (p_entity_type, p_entity_id); Q&A v2 PR-1 (FIX-625): community_notes (≤3) + community_note_count + SF-P2 synthetic marks; PR-2b (FIX-A): a question is answered by a written answer OR an ENDORSED visible community note, each note carries is_endorsed (metadata ? endorsed_at) and endorsed notes sort first, answered_at falls back to the latest endorsement timestamp. Keyset on the sort-normalized all-DESC keys (ord1, ord2, created_at, id), p_limit clamp 1..100. Returns a single jsonb { can_answer, total, awaiting, questions: [...], next_cursor }.';
