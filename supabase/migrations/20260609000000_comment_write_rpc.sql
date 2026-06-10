-- FIX-539 (C0 hardening): route entity_comments writes through a SECURITY DEFINER
-- submit_comment RPC; drop the direct-insert RLS policy; pin immutable columns.
--
-- WHY: entity_comments was the LAST write path still using direct-insert-with-RLS.
-- Its INSERT policy validated only author_id + the Wave D answer-gate, leaving
-- constituent_jurisdiction_id / kind / entity_id unvalidated. Any authenticated
-- user could INSERT directly via PostgREST (bypassing /api/comments) and FORGE a
-- ✓ Constituent badge (the route stamps it correctly server-side; a raw REST call
-- forges it). The constituent lens is load-bearing — the C1a position rollup reads
-- constituent_jurisdiction_id — so the badge must be unforgeable.
--
-- This brings comments into line with entity_statements / entity_positions, which
-- already work the right way: RLS ON, NO INSERT policy, all writes through a
-- SECURITY DEFINER submit RPC (mirrors submit_statement / set_entity_position).
--   * submit_comment()  — the SOLE insert path. Stamps constituent_jurisdiction_id
--                         SERVER-SIDE (never accepts it from the caller); enforces
--                         the answer-gate, kind/stance/body/depth/rate-limit.
--   * DROP entity_comments_insert_own — RLS default-deny now blocks direct REST
--                         inserts. The answer-gate moves from the policy into the RPC.
--   * entity_comments_pin_immutable — BEFORE UPDATE trigger pinning author_id,
--                         entity_type, entity_id, kind, constituent_jurisdiction_id
--                         so "edit my comment to forge a badge / escalate to answer"
--                         is impossible. body / conditions_md / status / the
--                         denormalized columns stay mutable (route PATCH + the
--                         rating-summary / flag-autotrip / scorer / answered-stamp
--                         triggers all keep working).
--
-- Replay-safe on an EMPTY database: no seed-data dependency; no data backfill
-- (0 rows). Every statement is idempotent (CREATE OR REPLACE / DROP ... IF EXISTS).
-- search_path is UNQUOTED comma form on the function (the quoted form breaks on
-- prod Pro); per-function statement_timeout matches house discipline. Constants
-- mirror packages/db/src/comment-kinds.ts (RATE_LIMITS.comments=20, BODY 10..2000,
-- MAX_THREAD_DEPTH=3) and the ALLOWED_KINDS per-entity-type vocab.

-- ---------------------------------------------------------------------------
-- a. submit_comment() — the single comment-insert path (mirrors submit_statement)
-- ---------------------------------------------------------------------------
-- Logic, in order: require auth; validate entity_type; validate kind ∈ the
-- per-entity-type vocab; enforce the answer-gate (kind='answer' ⇒ official entity
-- + parent question + active 'official' grant); validate stance; body 10..2000;
-- resolve/validate parent (same entity, depth ≤ 3) + thread_root_id; per-day
-- comment rate limit (20/rolling-24h); compute constituent_jurisdiction_id
-- server-side via the entity's jurisdiction + has_active_constituent_grant
-- (the EXACT logic moved out of /api/comments — a client-supplied badge is
-- impossible because it is not a parameter); INSERT with author_id = auth.uid().
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

  -- Per-day comment rate limit (rolling 24h; RATE_LIMITS.comments) → 429.
  SELECT count(*) INTO v_today
  FROM public.entity_comments
  WHERE author_id = v_user AND created_at >= now() - interval '1 day';
  IF v_today >= 20 THEN
    RAISE EXCEPTION 'daily comment limit reached (20 per day)' USING ERRCODE = '53400';
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
  'C0 hardening (FIX-539): the sole INSERT path for entity_comments (mirrors submit_statement). SECURITY DEFINER; stamps constituent_jurisdiction_id server-side (never a caller arg → unforgeable badge); enforces the answer-gate, kind/stance vocab, body 10..2000, depth ≤ 3, and the 20/day rate limit. Direct PostgREST inserts are denied (RLS, no INSERT policy).';

-- ---------------------------------------------------------------------------
-- b. Drop the direct-insert RLS policy (the answer-gate now lives in the RPC).
--    With RLS ON and NO INSERT policy, anon/authenticated direct inserts are
--    denied — identical to entity_statements / entity_positions.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS entity_comments_insert_own ON public.entity_comments;

-- Belt-and-suspenders, matching the statements model (which grants only SELECT to
-- authenticated): revoke the table-level INSERT grant so REST inserts can't even
-- attempt. The SECURITY DEFINER RPC runs as owner and is unaffected. The UPDATE
-- grant + entity_comments_update_own policy stay (author edit/withdraw via REST is
-- still allowed — and now constrained by the immutability trigger below).
REVOKE INSERT ON public.entity_comments FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- c. Immutability trigger: pin the columns a row owner must never be able to
--    change via UPDATE (decision 3). Blocks "edit my comment to forge a badge"
--    and "edit my comment to escalate kind to 'answer'". Only body / conditions_md
--    / status (visible→withdrawn) / the denormalized columns + updated_at may
--    change — so the PATCH route and every maintenance trigger keep working.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entity_comments_pin_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  IF NEW.author_id                   IS DISTINCT FROM OLD.author_id
     OR NEW.entity_type              IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id                IS DISTINCT FROM OLD.entity_id
     OR NEW.kind                     IS DISTINCT FROM OLD.kind
     OR NEW.constituent_jurisdiction_id IS DISTINCT FROM OLD.constituent_jurisdiction_id THEN
    RAISE EXCEPTION 'entity_comments immutable column changed (author_id / entity_type / entity_id / kind / constituent_jurisdiction_id are pinned)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_comments_pin_immutable ON public.entity_comments;
CREATE TRIGGER entity_comments_pin_immutable
  BEFORE UPDATE ON public.entity_comments
  FOR EACH ROW EXECUTE FUNCTION public.entity_comments_pin_immutable();
