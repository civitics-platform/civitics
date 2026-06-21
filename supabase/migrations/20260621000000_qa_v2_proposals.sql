-- Q&A v2 PR-2a: community Q&A on proposals (FIX-628 / FIX-629).
--
-- Extends the community-context lane to entity_type='proposal' — the one Q&A
-- surface with NO possible official answerer (a bill is not a grant-holding
-- person or office), so it is community-only: any signed-in user asks a
-- question, and any signed-in user answers with a sourced, citation-required
-- kind='community_note'. has_active_answerer_grant has no 'proposal' branch, so
-- can_answer is always false on proposals and kind='answer' is never valid here.
--
-- Schema-light: NO new tables, NO new columns, NO new kind. 'community_note'
-- already exists (FIX-625); this only makes it valid on 'proposal'.
--
-- This migration CREATE OR REPLACEs submit_comment ONLY. Its body is carried
-- forward VERBATIM from the latest definer 20260620010000 (FIX-625) except a
-- single delta: 'community_note' is APPENDED to the 'proposal' arm of the
-- v_allowed CASE, at the same END position as in ALL_KINDS (comment-kinds.ts).
-- It becomes the new latest definer of submit_comment, so the FIX-543 drift test
-- now parses THIS file's v_allowed — the 'proposal' arm must equal ALL_KINDS
-- exactly (same order). get_entity_questions is UNCHANGED and is deliberately NOT
-- re-emitted (FIX-625 remains its latest definer); it already returns
-- community_notes[] + community_note_count generically for every entity_type.
--
-- The community_note validation block (parent=question + citation required) is
-- entity-type-agnostic, so proposal notes inherit "must reply to a question" +
-- "must cite the record (a link)" for free. Replay-safe on an EMPTY database:
-- CREATE OR REPLACE (the FIX-625 signature is unchanged); search_path is the
-- UNQUOTED comma form; per-function statement_timeout matches house discipline.

-- ---------------------------------------------------------------------------
-- submit_comment() redefinition — adds 'community_note' to the 'proposal' arm.
--    Verbatim from 20260620010000 (FIX-625) except:
--      * v_allowed appends 'community_note' to the 'proposal' arm (END slot).
--    Everything else is byte-identical: the answer-gate, the community_note
--    block, the threading parent-kind guard, the rate-limit blocks, the badge
--    stamp. community_note is kind <> 'answer', so it already counts under the
--    20/day comment cap (decision 6, unchanged).
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
  -- 'community_note' on official + jurisdiction + institution. Q&A v2 PR-2a
  -- (FIX-628): 'community_note' APPENDED to the 'proposal' arm (community-only Q&A
  -- on bills — no official answerer). investigation arm carried forward from FIX-577.
  v_allowed := CASE p_entity_type
    WHEN 'proposal' THEN ARRAY['discussion','concern','amendment','question','evidence',
                               'precedent','tradeoff','stakeholder_impact','experience','cause','solution','community_note']
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
  -- (the cold-start payoff requires this; decision 3). Validity per entity_type is
  -- enforced by v_allowed: official/institution/jurisdiction (FIX-625) AND proposal
  -- (Q&A v2 PR-2a, FIX-628 — community-only Q&A on bills). Bounded by the citation
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
  'C0 hardening (FIX-539); answer rate split (FIX-542); FIX-610; Q&A v2 PR-1 (FIX-625); Q&A v2 PR-2a (FIX-628): the sole INSERT path for entity_comments. SECURITY DEFINER; stamps constituent_jurisdiction_id server-side (unforgeable badge); enforces the generalized answer-gate (kind=answer by the active answerer-grant holder, official/institution/jurisdiction only), the community-context gate (kind=community_note, any signed-in user, parent=question + citation required) — now valid on PROPOSALS too, which are a community-only Q&A surface (no official answerer), as well as official/institution/jurisdiction; kind/stance vocab, body 10..2000, depth ≤ 3, and the per-day rate limits (20/day non-answer incl. community_note, 100/day answer). Direct PostgREST inserts are denied (RLS, no INSERT policy).';
