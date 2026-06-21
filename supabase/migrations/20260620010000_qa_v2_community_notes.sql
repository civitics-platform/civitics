-- Q&A v2 PR-1: the "Community context" lane (FIX-625 / FIX-626 / FIX-627).
--
-- Adds a new app-layer kind='community_note': any signed-in user may post a
-- sourced, FROM-THE-RECORD response to a kind='question' — clearly NOT the
-- official's voice, citation-required, ranked by bridge score, surfaced BELOW the
-- pinned official answer. It keeps the Q&A lane alive on unclaimed entities (most
-- entities have no answerer grant) and turns speculation risk into sourced context.
--
-- Schema-light: NO new tables, NO new columns. community_note is a TEXT kind, the
-- citation lives in the body, bridge_score/map_x/map_y already exist (the nightly
-- scorer scopes on status not kind, so it already scores notes), and ratings ride
-- the existing comment_ratings table.
--
-- This migration CREATE OR REPLACEs the two functions whose latest definition was
-- 20260619070000 (FIX-610). It becomes the new latest definer of both, so the
-- FIX-543 drift test reads THIS file's v_allowed CASE — the three answerer arms
-- must stay byte-identical (same order) to ALLOWED_KINDS in comment-kinds.ts,
-- which now appends 'community_note' to official / jurisdiction / institution.
--
-- Both bodies are carried forward verbatim from 20260619070000 except the deltas
-- called out inline. Two NON-community-note deltas in get_entity_questions restore
-- the SF-P2/FIX-599 synthetic labeling (asker_is_synthetic + per-answer
-- author_is_synthetic) that FIX-610 dropped when it rebuilt the function from the
-- pre-SF-P2 FIX-540 body under a new signature — QASection reads those fields, so
-- without this restore synthetic Franklin askers/answerers render unmarked.
--
-- Replay-safe on an EMPTY database: CREATE OR REPLACE throughout; no DROP needed
-- (the FIX-610 signature is unchanged). search_path is the UNQUOTED comma form;
-- per-function statement_timeout matches house discipline.

-- ---------------------------------------------------------------------------
-- a. submit_comment() redefinition — adds the community_note path.
--    Verbatim from 20260619070000 (FIX-610) except:
--      * v_allowed appends 'community_note' to official + jurisdiction + institution.
--      * a community_note validation block (parent required + citation required),
--        mirroring the answer block's shape minus the grant check.
--      * the threading parent-kind guard now covers community_note too.
--    Rate-limit blocks UNCHANGED: community_note is kind <> 'answer', so it already
--    counts under the 20/day comment cap (decision 6). Drift-tested constants
--    (RATE_LIMITS.comments=20, .answers=100, BODY 10..2000, MAX_THREAD_DEPTH=3).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_comment(
  p_entity_type   text,
  p_entity_id     uuid,
  p_body          text,
  p_kind          text DEFAULT 'discussion',
  p_stance        text DEFAULT NULL,
  p_parent_id     uuid DEFAULT NULL,
  p_conditions_md text DEFAULT NULL
) RETURNS public.entity_comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user         uuid := auth.uid();
  v_kind         text := COALESCE(NULLIF(btrim(p_kind), ''), 'discussion');
  v_body         text := btrim(COALESCE(p_body, ''));
  v_stance       text := NULLIF(p_stance, '');
  v_allowed      text[];
  v_id           uuid := gen_random_uuid();
  v_parent       public.entity_comments;
  v_parent_depth int;
  v_thread_root  uuid;
  v_today        int;
  v_juris        uuid;
  v_result       public.entity_comments;
BEGIN
  -- auth → 401
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- entity_type vocab → 400 (investigation arm carried forward from FIX-577).
  IF p_entity_type NOT IN ('proposal','official','jurisdiction','institution','financial_entity','district','investigation') THEN
    RAISE EXCEPTION 'invalid entity_type: %', p_entity_type USING ERRCODE = '22023';
  END IF;

  -- kind ∈ per-entity-type vocab (mirrors ALLOWED_KINDS in comment-kinds.ts) → 400.
  -- FIX-610: 'answer' on institution + jurisdiction. Q&A v2 PR-1 (FIX-625):
  -- 'community_note' APPENDED to official + jurisdiction + institution (the Q&A
  -- community-context path). investigation arm carried forward from FIX-577.
  v_allowed := CASE p_entity_type
    WHEN 'proposal' THEN ARRAY['discussion','concern','amendment','question','evidence',
                               'precedent','tradeoff','stakeholder_impact','experience','cause','solution']
    WHEN 'official' THEN ARRAY['discussion','concern','question','evidence','stakeholder_impact','answer','community_note']
    WHEN 'jurisdiction' THEN ARRAY['discussion','question','concern','evidence','stakeholder_impact','answer','community_note']
    WHEN 'institution' THEN ARRAY['discussion','question','concern','evidence','stakeholder_impact','answer','community_note']
    WHEN 'financial_entity' THEN ARRAY['discussion']
    WHEN 'district' THEN ARRAY['discussion']
    WHEN 'investigation' THEN ARRAY['discussion','question','concern','evidence']
  END;
  IF NOT (v_kind = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'invalid kind ''%'' for %', v_kind, p_entity_type USING ERRCODE = '22023';
  END IF;

  -- Answer-gate (FIX-610 generalized) → 403/400. kind='answer' is the verified
  -- answerer's Q&A response: only valid on an official / institution / jurisdiction,
  -- only as a reply to a question, only by a holder of the active answerer grant for
  -- that entity (entity_id IS the grant target for every type).
  IF v_kind = 'answer' THEN
    IF p_entity_type NOT IN ('official','institution','jurisdiction') THEN
      RAISE EXCEPTION 'answers are only valid on officials, institutions, or jurisdictions' USING ERRCODE = '22023';
    END IF;
    IF p_parent_id IS NULL THEN
      RAISE EXCEPTION 'an answer must reply to a question' USING ERRCODE = '22023';
    END IF;
    IF NOT public.has_active_answerer_grant(v_user, p_entity_type, p_entity_id) THEN
      RAISE EXCEPTION 'only the verified answerer can answer' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Community-context gate (Q&A v2 PR-1, FIX-625) → 400. kind='community_note' is
  -- any signed-in user's sourced, from-the-record response — NO answerer grant
  -- (the cold-start payoff requires this; decision 3). Validity on only
  -- official/institution/jurisdiction is enforced by v_allowed (no community_note
  -- arm elsewhere — notably NOT proposals; that is PR-2). Bounded by the citation
  -- requirement here + the daily comment cap + the new-account Turnstile challenge.
  IF v_kind = 'community_note' THEN
    IF p_parent_id IS NULL THEN
      RAISE EXCEPTION 'community context must reply to a question' USING ERRCODE = '22023';
    END IF;
    -- Citation required (soft-validate, decision 5): the body must contain ≥1 link
    -- — an absolute http(s):// URL OR an in-app record path. Neither → 400.
    IF v_body !~* 'https?://'
       AND v_body !~* '/(proposals|officials|votes|jurisdictions|institutions|investigations)/' THEN
      RAISE EXCEPTION 'community context must cite the record — include a link' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- stance vocab (mirrors the entity_comments.stance CHECK) → 400
  IF v_stance IS NOT NULL AND v_stance NOT IN ('support','oppose','conditional','neutral') THEN
    RAISE EXCEPTION 'invalid stance: %', v_stance USING ERRCODE = '22023';
  END IF;

  -- body length (mirrors the body CHECK 10..2000) → 400
  IF char_length(v_body) < 10 OR char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'comment must be between 10 and 2000 characters' USING ERRCODE = '22023';
  END IF;

  -- Threading: parent must exist, be on this entity, and keep depth ≤ 3.
  IF p_parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM public.entity_comments WHERE id = p_parent_id;
    IF v_parent.id IS NULL
       OR v_parent.entity_type <> p_entity_type
       OR v_parent.entity_id   <> p_entity_id THEN
      RAISE EXCEPTION 'parent comment not found' USING ERRCODE = '42704';
    END IF;
    -- A Q&A reply (an answer OR a community_note) may only reply to a question.
    IF v_kind IN ('answer','community_note') AND v_parent.kind <> 'question' THEN
      RAISE EXCEPTION 'a Q&A reply must reply to a question' USING ERRCODE = '22023';
    END IF;
    -- Parent's depth = edges from parent up to its root (root = 0). The new reply
    -- sits at parent_depth + 1; reject when that would exceed MAX_THREAD_DEPTH=3.
    WITH RECURSIVE up AS (
      SELECT id, parent_id, 0 AS lvl FROM public.entity_comments WHERE id = p_parent_id
      UNION ALL
      SELECT e.id, e.parent_id, up.lvl + 1
      FROM public.entity_comments e JOIN up ON up.parent_id = e.id
    )
    SELECT max(lvl) INTO v_parent_depth FROM up;
    IF v_parent_depth + 1 > 3 THEN
      RAISE EXCEPTION 'maximum reply depth reached' USING ERRCODE = '22023';
    END IF;
    v_thread_root := COALESCE(v_parent.thread_root_id, v_parent.id);
  ELSE
    v_thread_root := v_id;
  END IF;

  -- Per-day rate limits (rolling 24h) → 429. FIX-542 split: answers have their
  -- own cap (RATE_LIMITS.answers) and no longer count against — or are blocked
  -- by — the plain-comment cap (RATE_LIMITS.comments), which now counts only
  -- non-answer rows. community_note is kind <> 'answer' → it counts here (decision 6).
  IF v_kind = 'answer' THEN
    SELECT count(*) INTO v_today
    FROM public.entity_comments
    WHERE author_id = v_user AND kind = 'answer'
      AND created_at >= now() - interval '1 day';
    IF v_today >= 100 THEN
      RAISE EXCEPTION 'daily answer limit reached (100 per day)' USING ERRCODE = '53400';
    END IF;
  ELSE
    SELECT count(*) INTO v_today
    FROM public.entity_comments
    WHERE author_id = v_user AND kind <> 'answer'
      AND created_at >= now() - interval '1 day';
    IF v_today >= 20 THEN
      RAISE EXCEPTION 'daily comment limit reached (20 per day)' USING ERRCODE = '53400';
    END IF;
  END IF;

  -- Constituent badge snapshot (decision 11; logic moved verbatim from the route):
  -- stamp the entity's jurisdiction IFF the caller holds an active constituent
  -- grant there. financial_entity / district carry no jurisdiction → no badge.
  v_juris := CASE p_entity_type
    WHEN 'jurisdiction' THEN p_entity_id
    WHEN 'proposal'     THEN (SELECT jurisdiction_id FROM public.proposals    WHERE id = p_entity_id)
    WHEN 'official'     THEN (SELECT jurisdiction_id FROM public.officials    WHERE id = p_entity_id)
    WHEN 'institution'  THEN (SELECT jurisdiction_id FROM public.institutions WHERE id = p_entity_id)
    ELSE NULL
  END;
  IF v_juris IS NOT NULL AND NOT public.has_active_constituent_grant(v_user, v_juris) THEN
    v_juris := NULL;
  END IF;

  INSERT INTO public.entity_comments
    (id, entity_type, entity_id, parent_id, thread_root_id, author_id,
     kind, stance, conditions_md, body, status, constituent_jurisdiction_id)
  VALUES
    (v_id, p_entity_type, p_entity_id, p_parent_id, v_thread_root, v_user,
     v_kind, v_stance, p_conditions_md, v_body, 'visible', v_juris)
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL    ON FUNCTION public.submit_comment(text, uuid, text, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_comment(text, uuid, text, text, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.submit_comment(text, uuid, text, text, text, uuid, text) IS
  'C0 hardening (FIX-539); answer rate split (FIX-542); FIX-610; Q&A v2 PR-1 (FIX-625): the sole INSERT path for entity_comments. SECURITY DEFINER; stamps constituent_jurisdiction_id server-side (unforgeable badge); enforces the generalized answer-gate (kind=answer by the active answerer-grant holder), the community-context gate (kind=community_note valid on official/institution/jurisdiction, any signed-in user, parent=question + citation required), kind/stance vocab, body 10..2000, depth ≤ 3, and the per-day rate limits (20/day non-answer incl. community_note, 100/day answer). Direct PostgREST inserts are denied (RLS, no INSERT policy).';

-- ---------------------------------------------------------------------------
-- b. get_entity_questions() redefinition — community notes + synthetic restore.
--    Verbatim from 20260619070000 (FIX-610) except, per question:
--      * 'community_notes' — up to 3 visible kind='community_note' replies, ranked
--        bridge_score DESC NULLS LAST → valuable_net DESC → created_at DESC.
--      * 'community_note_count' — total visible community_note replies (for "+N more").
--      * 'asker_is_synthetic' + per-answer 'author_is_synthetic' — RESTORED from
--        SF-P2/FIX-599 (FIX-610 dropped them rebuilding under the new signature).
--    Signature unchanged → straight CREATE OR REPLACE (no DROP). answered / sort /
--    keyset untouched.
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
      EXISTS (
        SELECT 1 FROM public.entity_comments a
        WHERE a.parent_id = q.id AND a.kind = 'answer' AND a.status = 'visible'
      ) AS answered
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
          'answered_at',    p.metadata ->> 'answered_at',
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
          -- Q&A v2 PR-1 (FIX-625): up to 3 top-ranked community notes per question,
          -- ranked bridge_score DESC NULLS LAST → valuable_net DESC → created_at DESC.
          -- valuable_net mirrors get_entity_comment_highlights exactly.
          'community_notes', COALESCE((
            SELECT jsonb_agg(elem ORDER BY ord_bridge DESC NULLS LAST, ord_valuable DESC, ord_created DESC)
            FROM (
              SELECT
                jsonb_build_object(
                  'id',             cn.id,
                  'body',           cn.body,
                  'created_at',     cn.created_at,
                  'bridge_score',   cn.bridge_score,
                  'rating_summary', cn.rating_summary,
                  'is_constituent', (cn.constituent_jurisdiction_id IS NOT NULL),
                  'author_name',    COALESCE(NULLIF(btrim(cu.display_name), ''),
                                             'citizen-' || left(cn.author_id::text, 8)),
                  'author_is_synthetic', COALESCE(cu.is_synthetic, false)
                ) AS elem,
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
              ORDER BY cn.bridge_score DESC NULLS LAST,
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
  'C1 Wave D Q&A lane read (FIX-536/540); FIX-610 generalized to (p_entity_type, p_entity_id); Q&A v2 PR-1 (FIX-625): each question now carries community_notes (≤3, ranked bridge_score DESC NULLS LAST → valuable_net → created_at) + community_note_count, and the SF-P2/FIX-599 asker_is_synthetic + per-answer author_is_synthetic marks (restored — FIX-610 had dropped them). Keyset on the sort-normalized all-DESC keys (ord1, ord2, created_at, id), p_limit clamp 1..100. Returns a single jsonb { can_answer, total, awaiting, questions: [...], next_cursor }.';
