-- FIX-610: generalize the citizen↔answerer Q&A lane from officials-only to every
-- accountable entity that can hold an answerer grant — official, institution
-- (agencies + governing bodies ride the institutions UNION view), and
-- jurisdiction (the "regulations.gov for cities" clerk role).
--
-- The Q&A lane already EXISTS for officials (FIX-536/537/540). `institution` and
-- `jurisdiction` already accept kind='question' (ALLOWED_KINDS / submit_comment's
-- v_allowed) — they were just missing the ANSWER path. This migration closes that
-- gap once, keyed on the per-entity-type answerer role, instead of patching
-- agencies and leaving the identical hole one entity-type over.
--
-- Per-entity-type answerer-role mapping (every enum value already exists from the
-- v1 role_claim_spine + v2 grant_spine_v2_enums — NO enum-split migration needed):
--
--   official     → role 'official'           target_type 'official'
--   institution  → role 'institution_admin'  target_type 'institution'   (= agency.id / gb.id)
--   jurisdiction → role 'jurisdiction_admin' target_type 'jurisdiction'
--
-- Three pieces:
--   a. has_active_answerer_grant(user, entity_type, entity_id) — the generalized
--      answer-side gate (dispatches to the right role/target per entity_type).
--   b. submit_comment redefinition — the answer-gate now accepts the three types
--      and calls (a); v_allowed adds 'answer' to institution + jurisdiction. This
--      is the LATEST migration defining submit_comment, so the FIX-543 drift test
--      reads its v_allowed CASE + both rate-limit guards — carried forward verbatim
--      from 20260610000100 (FIX-542) except the generalized answer-gate + vocab.
--   c. get_entity_questions redefinition — takes (p_entity_type, p_entity_id, …)
--      instead of a hardcoded official id; can_answer dispatches via (a).
--
-- The answered-stamp trigger (20260608030100) is already entity-type-agnostic
-- (fires on any visible kind='answer' with a parent) — unchanged.
--
-- Replay-safe on an EMPTY database: no seed-data dependency; CREATE OR REPLACE
-- throughout; DROP ... IF EXISTS for the changed get_entity_questions signature.
-- search_path is the UNQUOTED comma form (the quoted form breaks on prod Pro);
-- per-function statement_timeout matches house discipline.

-- ---------------------------------------------------------------------------
-- a. has_active_answerer_grant() — the generalized answer-side gate.
--    True iff the user holds an active, unexpired grant whose (role, target_type)
--    is the answerer pair for p_entity_type and whose target_id = p_entity_id.
--    Generalizes has_active_official_grant (which stays defined for any other
--    caller). For every type, entity_id IS the grant target (the official id,
--    the institution-view id = agency/gb id, or the jurisdiction id).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_active_answerer_grant(
  p_user_id     uuid,
  p_entity_type text,
  p_entity_id   uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.entity_grants
    WHERE user_id = p_user_id
      AND status  = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (
           (p_entity_type = 'official'     AND role = 'official'           AND target_type = 'official'     AND target_id = p_entity_id)
        OR (p_entity_type = 'institution'  AND role = 'institution_admin'  AND target_type = 'institution'  AND target_id = p_entity_id)
        OR (p_entity_type = 'jurisdiction' AND role = 'jurisdiction_admin' AND target_type = 'jurisdiction' AND target_id = p_entity_id)
      )
  );
$$;

ALTER FUNCTION public.has_active_answerer_grant(uuid, text, uuid)
  SET statement_timeout = '2s';

GRANT EXECUTE ON FUNCTION public.has_active_answerer_grant(uuid, text, uuid)
  TO authenticated, anon;

COMMENT ON FUNCTION public.has_active_answerer_grant(uuid, text, uuid) IS
  'FIX-610: generalized Q&A answer-side gate. True iff the user holds an active grant whose (role, target_type) is the answerer pair for the entity_type (official→official, institution→institution_admin, jurisdiction→jurisdiction_admin) targeting entity_id. Generalizes has_active_official_grant.';

-- ---------------------------------------------------------------------------
-- b. submit_comment() redefinition — generalized answer-gate + vocab.
--    Verbatim from 20260610000100 (FIX-542) except:
--      * v_allowed adds 'answer' to the institution + jurisdiction arms.
--      * the answer-gate accepts official|institution|jurisdiction and calls
--        has_active_answerer_grant instead of the official-only check.
--    Constants mirror packages/db/src/comment-kinds.ts (RATE_LIMITS.comments=20,
--    RATE_LIMITS.answers=100, BODY 10..2000, MAX_THREAD_DEPTH=3) — guarded by the
--    FIX-543 drift test, which parses THIS file as the latest submit_comment def.
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
  -- FIX-610: 'answer' added to institution + jurisdiction (the Q&A answer path).
  -- investigation arm carried forward verbatim from FIX-577 (20260614000100).
  v_allowed := CASE p_entity_type
    WHEN 'proposal' THEN ARRAY['discussion','concern','amendment','question','evidence',
                               'precedent','tradeoff','stakeholder_impact','experience','cause','solution']
    WHEN 'official' THEN ARRAY['discussion','concern','question','evidence','stakeholder_impact','answer']
    WHEN 'jurisdiction' THEN ARRAY['discussion','question','concern','evidence','stakeholder_impact','answer']
    WHEN 'institution' THEN ARRAY['discussion','question','concern','evidence','stakeholder_impact','answer']
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
    -- An answer may only reply to a question (decision 1).
    IF v_kind = 'answer' AND v_parent.kind <> 'question' THEN
      RAISE EXCEPTION 'an answer must reply to a question' USING ERRCODE = '22023';
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
  -- non-answer rows.
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
  'C0 hardening (FIX-539); answer rate split (FIX-542); FIX-610: the sole INSERT path for entity_comments. SECURITY DEFINER; stamps constituent_jurisdiction_id server-side (unforgeable badge); enforces the GENERALIZED answer-gate (kind=answer valid on official/institution/jurisdiction, by the active answerer-grant holder via has_active_answerer_grant), kind/stance vocab, body 10..2000, depth ≤ 3, and the per-day rate limits (20/day non-answer, 100/day answer). Direct PostgREST inserts are denied (RLS, no INSERT policy).';

-- ---------------------------------------------------------------------------
-- c. get_entity_questions() redefinition — entity_type-parameterized.
--    Verbatim from 20260610000000 (FIX-540) except: takes (p_entity_type,
--    p_entity_id, …) instead of a hardcoded official id; the base CTE filters on
--    the passed entity_type; can_answer dispatches via has_active_answerer_grant.
--    The old (uuid, text, text, int, text) signature is DROPped (not overloaded):
--    a different first-param type + the new arity would make a named-param
--    PostgREST call ambiguous.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_entity_questions(uuid, text, text, int, text);

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

REVOKE ALL ON FUNCTION public.get_entity_questions(text, uuid, text, text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_entity_questions(text, uuid, text, text, int, text)
  TO anon, authenticated;

COMMENT ON FUNCTION public.get_entity_questions(text, uuid, text, text, int, text) IS
  'C1 Wave D Q&A lane read (FIX-536/540); FIX-610: generalized from officials-only to (p_entity_type, p_entity_id) for official | institution | jurisdiction. Keyset on the sort-normalized all-DESC keys (ord1, ord2, created_at, id), p_limit clamp 1..100 (default 50). can_answer dispatches via has_active_answerer_grant. Returns a single jsonb { can_answer, total, awaiting, questions: [...], next_cursor } — never SETOF.';
