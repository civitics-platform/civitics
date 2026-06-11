-- FIX-542 (C1 polish): official answers get their own rate limit.
--
-- Q&A answers post through submit_comment and shared the 20/day comment cap —
-- an active official answering many questions could exhaust their own lane.
-- Redefinition of submit_comment (current definition: 20260609000000_comment_write_rpc.sql;
-- redefined here in a NEW migration, never by editing the existing one) with
-- exactly one change, the rate-limit split:
--   (a) the existing 20/day count EXCLUDES kind='answer' rows, and
--   (b) kind='answer' posts get a separate 100/day cap counted only over the
--       caller's kind='answer' rows. The answer-gate above already restricts
--       who can reach the answer path (active 'official' grant), so the higher
--       cap is not an open lane.
-- Everything else is verbatim from FIX-539. Constants mirror
-- packages/db/src/comment-kinds.ts (RATE_LIMITS.comments=20,
-- RATE_LIMITS.answers=100, BODY 10..2000, MAX_THREAD_DEPTH=3) and the
-- ALLOWED_KINDS per-entity-type vocab — guarded by the FIX-543 drift test
-- (packages/data/src/__tests__/comment-kinds-drift.test.ts), which parses the
-- LAST migration defining submit_comment, i.e. this file.
--
-- Replay-safe on an EMPTY database: no seed-data dependency; CREATE OR REPLACE
-- (same signature). search_path is the UNQUOTED comma form; per-function
-- statement_timeout per house discipline.

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

  -- entity_type vocab → 400
  IF p_entity_type NOT IN ('proposal','official','jurisdiction','institution','financial_entity','district') THEN
    RAISE EXCEPTION 'invalid entity_type: %', p_entity_type USING ERRCODE = '22023';
  END IF;

  -- kind ∈ per-entity-type vocab (mirrors ALLOWED_KINDS in comment-kinds.ts) → 400
  v_allowed := CASE p_entity_type
    WHEN 'proposal' THEN ARRAY['discussion','concern','amendment','question','evidence',
                               'precedent','tradeoff','stakeholder_impact','experience','cause','solution']
    WHEN 'official' THEN ARRAY['discussion','concern','question','evidence','stakeholder_impact','answer']
    WHEN 'jurisdiction' THEN ARRAY['discussion','question','concern','evidence','stakeholder_impact']
    WHEN 'institution' THEN ARRAY['discussion','question','concern','evidence','stakeholder_impact']
    WHEN 'financial_entity' THEN ARRAY['discussion']
    WHEN 'district' THEN ARRAY['discussion']
  END;
  IF NOT (v_kind = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'invalid kind ''%'' for %', v_kind, p_entity_type USING ERRCODE = '22023';
  END IF;

  -- Answer-gate (was the Wave D INSERT-policy clause; now enforced here) → 403/400.
  -- kind='answer' is the official Q&A response: only valid on an official, only as
  -- a reply to a question, only by a holder of an active 'official' grant for that
  -- official (entity_id IS the official's id).
  IF v_kind = 'answer' THEN
    IF p_entity_type <> 'official' THEN
      RAISE EXCEPTION 'answers are only valid on officials' USING ERRCODE = '22023';
    END IF;
    IF p_parent_id IS NULL THEN
      RAISE EXCEPTION 'an answer must reply to a question' USING ERRCODE = '22023';
    END IF;
    IF NOT public.has_active_official_grant(v_user, p_entity_id) THEN
      RAISE EXCEPTION 'only the verified official can answer' USING ERRCODE = '42501';
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
  'C0 hardening (FIX-539): the sole INSERT path for entity_comments (mirrors submit_statement). SECURITY DEFINER; stamps constituent_jurisdiction_id server-side (never a caller arg → unforgeable badge); enforces the answer-gate, kind/stance vocab, body 10..2000, depth ≤ 3, and the per-day rate limits — FIX-542: 20/day over non-answer rows, a separate 100/day over kind=answer rows (answer-gate holders only). Direct PostgREST inserts are denied (RLS, no INSERT policy).';
