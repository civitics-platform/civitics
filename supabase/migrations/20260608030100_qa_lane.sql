-- FIX-536 (C1 Wave D): citizen↔official Q&A lane.
--
-- Q&A is a MODE over the unified entity_comments substrate — NO new content
-- tables (decision 1). A question is an entity_comment with kind='question'; an
-- official answer is a reply (parent_id → the question) with kind='answer',
-- gated to holders of an active 'official' grant for that official. Threading,
-- ratings, flagging, constituent badge and bridge scoring are all reused.
--
-- This migration depends on 20260608030000_grant_role_official.sql having
-- committed the 'official' enum values (a new enum value can't be referenced in
-- the same transaction that adds it — hence the split).
--
-- Replay-safe on an EMPTY database: no seed-data dependencies; every statement
-- is idempotent (CREATE OR REPLACE / DROP ... IF EXISTS / IF NOT EXISTS); the
-- answered-stamp trigger no-ops on 0 rows. search_path is UNQUOTED comma form on
-- every function (the quoted form breaks on prod Pro); per-function
-- statement_timeout matches house discipline.

-- ---------------------------------------------------------------------------
-- a. has_active_official_grant() — the answer-side gate (mirrors
--    has_active_constituent_grant). True iff the user holds an active, unexpired
--    'official' grant targeting this official.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_active_official_grant(
  p_user_id     uuid,
  p_official_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.entity_grants
    WHERE user_id     = p_user_id
      AND role        = 'official'
      AND target_type = 'official'
      AND target_id   = p_official_id
      AND status      = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  );
$$;

ALTER FUNCTION public.has_active_official_grant(uuid, uuid)
  SET statement_timeout = '2s';

GRANT EXECUTE ON FUNCTION public.has_active_official_grant(uuid, uuid)
  TO authenticated, anon;

-- ---------------------------------------------------------------------------
-- b. Answer-gate: replace the entity_comments INSERT policy (decision 4).
--    The C0 policy was WITH CHECK (author_id = auth.uid()) — any authenticated
--    user could insert any kind via direct PostgREST. kind='answer' must be
--    insertable ONLY by a holder of an active 'official' grant for that
--    official, enforced AT THE DATABASE (an app-layer-only check is forgeable
--    via a raw REST call). For an answer, entity_id IS the official's id, so the
--    same column the question carries is the grant target.
--
--    Non-answer inserts are unchanged: kind <> 'answer' short-circuits the AND
--    to (author_id = auth.uid()), exactly the C0 behaviour.
--
--    Route handlers write via the service_role admin client (bypasses RLS) and
--    do their own has_active_official_grant pre-check for a clean 403 — this
--    policy is the real guard for the direct-REST path.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS entity_comments_insert_own ON public.entity_comments;
CREATE POLICY entity_comments_insert_own ON public.entity_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND (kind <> 'answer' OR public.has_active_official_grant(auth.uid(), entity_id))
  );

-- ---------------------------------------------------------------------------
-- c. Answered-stamp trigger (decision 5): stamp metadata.answered_at on the
--    parent question the first time a VISIBLE kind='answer' child is inserted.
--    Cheap (single PK update) and non-recursive (fires on INSERT only; the
--    UPDATE it issues fires no INSERT trigger). Authoritative "answered" is
--    still derived (EXISTS) in the read RPC; this stamp is for cheap
--    entity-level counts / display.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.entity_comments_stamp_answered()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
BEGIN
  IF NEW.kind = 'answer' AND NEW.status = 'visible' AND NEW.parent_id IS NOT NULL THEN
    UPDATE public.entity_comments
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                             '{answered_at}', to_jsonb(NEW.created_at), true)
    WHERE id = NEW.parent_id
      AND NOT (metadata ? 'answered_at');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_comments_stamp_answered_ai ON public.entity_comments;
CREATE TRIGGER entity_comments_stamp_answered_ai
  AFTER INSERT ON public.entity_comments
  FOR EACH ROW EXECUTE FUNCTION public.entity_comments_stamp_answered();

-- Make the answered-EXISTS and the per-question answer fetch cheap.
CREATE INDEX IF NOT EXISTS entity_comments_parent_kind_idx
  ON public.entity_comments (parent_id, kind);

-- ---------------------------------------------------------------------------
-- d. get_entity_questions() — the one Q&A read (decision 9).
--    Returns a jsonb object { can_answer, total, awaiting, questions[] }:
--      * questions: bounded page (cap 100) of root questions, each with the
--        want-answered count (rating_summary.valuable_up — decision 6), the
--        derived answered flag, answered_at, asker display_name + constituent
--        badge, and the inline VISIBLE official answer(s).
--      * total / awaiting: entity-level counts over the FULL match set (not the
--        page) for the header ("14 questions · 9 awaiting response" — decision 7).
--      * can_answer: true iff the caller holds the official grant (decision 9).
--    sort: 'wanted' (valuable_up desc — default), 'newest', 'unanswered'
--    (awaiting first). lens: 'all' | 'constituents' (C0 convention).
--    SECURITY DEFINER, anon-readable; the visible-status filter is baked in.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_entity_questions(
  p_official_id uuid,
  p_lens        text DEFAULT 'all',
  p_sort        text DEFAULT 'wanted'
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
  v_result     jsonb;
BEGIN
  IF v_user IS NOT NULL THEN
    v_can_answer := public.has_active_official_grant(v_user, p_official_id);
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
  page AS (
    SELECT * FROM base
    ORDER BY
      (CASE WHEN v_sort = 'unanswered' THEN answered::int ELSE 0 END) ASC,
      (CASE WHEN v_sort IN ('wanted','unanswered') THEN want_count ELSE 0 END) DESC,
      created_at DESC
    LIMIT 100
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
        ORDER BY
          (CASE WHEN v_sort = 'unanswered' THEN p.answered::int ELSE 0 END) ASC,
          (CASE WHEN v_sort IN ('wanted','unanswered') THEN p.want_count ELSE 0 END) DESC,
          p.created_at DESC
      )
      FROM page p
      LEFT JOIN public.users u ON u.id = p.author_id
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_entity_questions(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_entity_questions(uuid, text, text)
  TO anon, authenticated;

COMMENT ON FUNCTION public.get_entity_questions(uuid, text, text) IS
  'C1 Wave D (FIX-536): Q&A lane read. Root kind=question comments for an official with want-answered count (rating_summary.valuable_up), derived answered flag + inline visible kind=answer replies, asker badge, entity-level total/awaiting counts, and the caller''s can_answer grant flag. Bounded page (cap 100).';
