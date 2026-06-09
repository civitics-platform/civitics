-- FIX-533 (C1 Wave C): statement mode (Polis-lite) + slow mode.
--
-- Adds the low-friction agree/disagree/pass layer on top of the C0/C1 comment
-- substrate. Statements are a DISTINCT primitive from comments and positions: a
-- short standalone proposition the crowd votes on with +1 / 0 / -1 (decision 1).
--
--   * entity_statements    — one proposition per row; vote_summary {agree,disagree,
--                            pass} maintained by trigger; promoted-from-comment via
--                            source_comment_id (one statement per comment).
--   * statement_votes       — one ballot per (statement, voter); raw vote kept for
--                            future C3 clustering (decision 10). Own-rows-only.
--   * entity_activity_state — per-entity rolling-1h comment counter + slow-mode flag
--                            (decision 5). Single-PK read; no request-path COUNT.
--   * submit_statement / set_statement_vote / get_entity_statements RPCs — the only
--                            write/read paths (mirrors the C0 ratings privacy model:
--                            private ballots, public aggregates — decision 3).
--   * vote-summary trigger on statement_votes; slow-mode activity trigger on
--     entity_comments INSERT; statement flag-autotrip on content_flags.
--
-- Replay-safe on an EMPTY database: no seed-data dependencies; every statement is
-- idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS);
-- the activity + autotrip triggers no-op on 0 rows. Constants mirrored in
-- packages/db/src/comment-kinds.ts: STATEMENT_MIN_LEN=10, STATEMENT_MAX_LEN=200,
-- STATEMENT_SUBMIT_DAILY_CAP=5, SLOW_MODE_COMMENTS_PER_HOUR=20,
-- SLOW_MODE_DURATION_HOURS=2.
--
-- search_path is UNQUOTED comma-separated on every function (the quoted form
-- breaks on prod Pro). Per-function statement_timeout matches house discipline.

-- ---------------------------------------------------------------------------
-- a. entity_statements
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_statements (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type                 text NOT NULL
    CHECK (entity_type IN ('proposal','official','jurisdiction','institution','financial_entity','district')),
  entity_id                   uuid NOT NULL,
  body                        text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 200),
  author_id                   uuid REFERENCES public.users(id) ON DELETE SET NULL,  -- survives author deletion as anonymous crowd content
  source_comment_id           uuid REFERENCES public.entity_comments(id) ON DELETE SET NULL,
  status                      text NOT NULL DEFAULT 'visible'
    CHECK (status IN ('visible','needs_review','hidden_by_jury','withdrawn')),
  vote_summary                jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Snapshot-at-write constituent badge (mirrors entity_comments/entity_positions).
  -- Added beyond the FIX spec column list so get_entity_statements lens='constituents'
  -- reuses the existing stamped-at-write convention rather than a second aggregate.
  constituent_jurisdiction_id uuid,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Page read: visible statements for an entity.
CREATE INDEX IF NOT EXISTS entity_statements_page_idx
  ON public.entity_statements (entity_type, entity_id, status);
-- Daily-cap count + author profile.
CREATE INDEX IF NOT EXISTS entity_statements_author_idx
  ON public.entity_statements (author_id, created_at DESC);
-- One statement per promoted comment.
CREATE UNIQUE INDEX IF NOT EXISTS entity_statements_source_comment_uidx
  ON public.entity_statements (source_comment_id)
  WHERE source_comment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- b. statement_votes (private ballots; public aggregate is vote_summary)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.statement_votes (
  statement_id uuid NOT NULL REFERENCES public.entity_statements(id) ON DELETE CASCADE,
  voter_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  vote         smallint NOT NULL CHECK (vote IN (-1,0,1)),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (statement_id, voter_id)
);

-- ---------------------------------------------------------------------------
-- c. entity_activity_state (per-entity rolling counter + slow-mode flag)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_activity_state (
  entity_type          text NOT NULL,
  entity_id            uuid NOT NULL,
  window_start         timestamptz NOT NULL DEFAULT now(),
  recent_comment_count int NOT NULL DEFAULT 0,
  slow_mode            boolean NOT NULL DEFAULT false,
  slow_mode_until      timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

COMMENT ON TABLE public.entity_activity_state IS
  'C1 Wave C (FIX-533): per-entity rolling-1h comment counter + slow-mode flag. Maintained by the entity_comments INSERT trigger (no request-path COUNT). Slow mode is "on" when slow_mode AND slow_mode_until > now() (expiry derived on read; no clearing job).';

-- ---------------------------------------------------------------------------
-- d. updated_at maintenance (house helper)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS entity_statements_set_updated_at ON public.entity_statements;
CREATE TRIGGER entity_statements_set_updated_at
  BEFORE UPDATE ON public.entity_statements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS statement_votes_set_updated_at ON public.statement_votes;
CREATE TRIGGER statement_votes_set_updated_at
  BEFORE UPDATE ON public.statement_votes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- e. submit_statement() — the single statement-creation path
-- ---------------------------------------------------------------------------
-- Voting is open to any authenticated user; CREATION is gated (decision 2):
-- user submission only, rate-limited, with optional own-comment promotion.
CREATE OR REPLACE FUNCTION public.submit_statement(
  p_entity_type       text,
  p_entity_id         uuid,
  p_body              text,
  p_source_comment_id uuid DEFAULT NULL
) RETURNS public.entity_statements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '3s'
AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_body   text := btrim(COALESCE(p_body, ''));
  v_today  int;
  v_src    public.entity_comments;
  v_juris  uuid;
  v_result public.entity_statements;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_entity_type NOT IN ('proposal','official','jurisdiction','institution','financial_entity','district') THEN
    RAISE EXCEPTION 'invalid entity_type: %', p_entity_type USING ERRCODE = '22023';
  END IF;
  IF char_length(v_body) < 10 OR char_length(v_body) > 200 THEN
    RAISE EXCEPTION 'statement must be between 10 and 200 characters' USING ERRCODE = '22023';
  END IF;

  -- Daily submission cap (rolling 24h; same shape as the position delta cap).
  SELECT count(*) INTO v_today
  FROM public.entity_statements
  WHERE author_id = v_user AND created_at >= now() - interval '1 day';
  IF v_today >= 5 THEN
    RAISE EXCEPTION 'daily statement limit reached (5 per day)' USING ERRCODE = '53400';
  END IF;

  -- Own-comment promotion: the source comment must be the caller's own and on
  -- this entity. No AI extraction from comment prose (deferred to C3).
  IF p_source_comment_id IS NOT NULL THEN
    SELECT * INTO v_src FROM public.entity_comments WHERE id = p_source_comment_id;
    IF v_src.id IS NULL THEN
      RAISE EXCEPTION 'source comment not found' USING ERRCODE = '42704';
    END IF;
    IF v_src.author_id <> v_user THEN
      RAISE EXCEPTION 'can only promote your own comment' USING ERRCODE = '42501';
    END IF;
    IF v_src.entity_type <> p_entity_type OR v_src.entity_id <> p_entity_id THEN
      RAISE EXCEPTION 'source comment does not belong to this entity' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Constituent snapshot (mirror set_entity_position): stamp the entity's
  -- jurisdiction iff the caller holds an active constituent grant there.
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

  INSERT INTO public.entity_statements
    (entity_type, entity_id, body, author_id, source_comment_id, status, constituent_jurisdiction_id)
  VALUES
    (p_entity_type, p_entity_id, v_body, v_user, p_source_comment_id, 'visible', v_juris)
  RETURNING * INTO v_result;

  RETURN v_result;
EXCEPTION
  WHEN unique_violation THEN
    -- partial unique on source_comment_id: one statement per promoted comment.
    RAISE EXCEPTION 'a statement already exists for this comment' USING ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.submit_statement(text, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_statement(text, uuid, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- f. set_statement_vote() — upsert the caller's ballot
-- ---------------------------------------------------------------------------
-- Open to any authenticated user (broad cheap input — the whole point). Returns
-- the recomputed vote_summary so the caller doesn't need a second read.
CREATE OR REPLACE FUNCTION public.set_statement_vote(
  p_statement_id uuid,
  p_vote         smallint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_user    uuid := auth.uid();
  v_status  text;
  v_summary jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_vote IS NULL OR p_vote NOT IN (-1, 0, 1) THEN
    RAISE EXCEPTION 'vote must be -1, 0, or 1' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_status FROM public.entity_statements WHERE id = p_statement_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'statement not found' USING ERRCODE = '42704';
  END IF;
  IF v_status NOT IN ('visible','needs_review') THEN
    RAISE EXCEPTION 'statement is not open for voting' USING ERRCODE = '42501';
  END IF;

  -- A pass (0) is a real, stored ballot — counted as 'pass', never absence.
  INSERT INTO public.statement_votes (statement_id, voter_id, vote)
  VALUES (p_statement_id, v_user, p_vote)
  ON CONFLICT (statement_id, voter_id) DO UPDATE
    SET vote = EXCLUDED.vote, updated_at = now();

  -- The vote-summary trigger has recomputed it; return the fresh value.
  SELECT vote_summary INTO v_summary FROM public.entity_statements WHERE id = p_statement_id;
  RETURN v_summary;
END;
$$;

REVOKE ALL ON FUNCTION public.set_statement_vote(uuid, smallint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_statement_vote(uuid, smallint) TO authenticated;

-- ---------------------------------------------------------------------------
-- g. get_entity_statements() — public ordered list (caller's own vote included)
-- ---------------------------------------------------------------------------
-- Ordered by total vote volume (most-engaged first), simple agreement bar data
-- via vote_summary. NO clustering / consensus-divisive ranking (decision 4 — C3).
-- SECURITY DEFINER with the visible-status filter baked in; lens='constituents'
-- restricts to constituent-stamped statements (same convention as C0).
CREATE OR REPLACE FUNCTION public.get_entity_statements(
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
  v_lens   text := CASE WHEN p_lens = 'constituents' THEN 'constituents' ELSE 'all' END;
  v_user   uuid := auth.uid();
  v_result jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(obj ORDER BY total DESC, created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      s.created_at,
      ( COALESCE((s.vote_summary ->> 'agree')::int, 0)
      + COALESCE((s.vote_summary ->> 'disagree')::int, 0)
      + COALESCE((s.vote_summary ->> 'pass')::int, 0) ) AS total,
      jsonb_build_object(
        'id',                s.id,
        'body',              s.body,
        'status',            s.status,
        'source_comment_id', s.source_comment_id,
        'vote_summary',      s.vote_summary,
        'is_constituent',    (s.constituent_jurisdiction_id IS NOT NULL),
        'author_name',       COALESCE(NULLIF(btrim(u.display_name), ''),
                                      'citizen-' || left(s.author_id::text, 8)),
        'my_vote',           sv.vote,
        'created_at',        s.created_at
      ) AS obj
    FROM public.entity_statements s
    LEFT JOIN public.users u ON u.id = s.author_id
    LEFT JOIN public.statement_votes sv
      ON sv.statement_id = s.id AND sv.voter_id = v_user
    WHERE s.entity_type = p_entity_type
      AND s.entity_id   = p_entity_id
      AND s.status IN ('visible','needs_review')
      AND (v_lens = 'all' OR s.constituent_jurisdiction_id IS NOT NULL)
  ) t;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_entity_statements(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_entity_statements(text, uuid, text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- h. Vote-summary trigger (mirror comment_ratings → rating_summary)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.statement_votes_refresh_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_statement_id uuid := COALESCE(NEW.statement_id, OLD.statement_id);
  v_agree    int;
  v_disagree int;
  v_pass     int;
BEGIN
  SELECT
    count(*) FILTER (WHERE vote = 1),
    count(*) FILTER (WHERE vote = -1),
    count(*) FILTER (WHERE vote = 0)
  INTO v_agree, v_disagree, v_pass
  FROM public.statement_votes
  WHERE statement_id = v_statement_id;

  UPDATE public.entity_statements
  SET vote_summary = jsonb_build_object(
        'agree',    COALESCE(v_agree, 0),
        'disagree', COALESCE(v_disagree, 0),
        'pass',     COALESCE(v_pass, 0)
      )
  WHERE id = v_statement_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS statement_votes_summary_aiud ON public.statement_votes;
CREATE TRIGGER statement_votes_summary_aiud
  AFTER INSERT OR UPDATE OR DELETE ON public.statement_votes
  FOR EACH ROW EXECUTE FUNCTION public.statement_votes_refresh_summary();

-- ---------------------------------------------------------------------------
-- i. Slow-mode activity trigger on entity_comments INSERT (decision 5)
-- ---------------------------------------------------------------------------
-- Maintains a rolling 1-hour counter via UPSERT — NO time-window COUNT over the
-- comments table (the read path forbids fan-out aggregation). Trips slow mode
-- when the counter crosses the threshold. Fires during the exact spike it
-- measures, so it stays cheap: one upsert + one conditional update, both PK.
-- The bridge-rescore-on-trip (decision 7) is wired from the API layer, NOT here:
-- recompute_comment_bridge_scores UPDATEs entity_comments, and calling it from an
-- AFTER INSERT trigger ON entity_comments risks recursion / write amplification
-- during the spike (see /api/comments POST).
CREATE OR REPLACE FUNCTION public.entity_comments_bump_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_threshold constant int      := 20;                 -- SLOW_MODE_COMMENTS_PER_HOUR
  v_duration  constant interval := interval '2 hours'; -- SLOW_MODE_DURATION_HOURS
  v_count int;
BEGIN
  INSERT INTO public.entity_activity_state
    (entity_type, entity_id, window_start, recent_comment_count, updated_at)
  VALUES (NEW.entity_type, NEW.entity_id, now(), 1, now())
  ON CONFLICT (entity_type, entity_id) DO UPDATE
    SET recent_comment_count = CASE
          WHEN entity_activity_state.window_start < now() - interval '1 hour' THEN 1
          ELSE entity_activity_state.recent_comment_count + 1
        END,
        window_start = CASE
          WHEN entity_activity_state.window_start < now() - interval '1 hour' THEN now()
          ELSE entity_activity_state.window_start
        END,
        updated_at = now()
  RETURNING recent_comment_count INTO v_count;

  -- Trip (or extend) slow mode when the rolling count crosses the threshold.
  IF v_count >= v_threshold THEN
    UPDATE public.entity_activity_state
    SET slow_mode       = true,
        slow_mode_until = now() + v_duration,
        updated_at      = now()
    WHERE entity_type = NEW.entity_type AND entity_id = NEW.entity_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS entity_comments_activity_ai ON public.entity_comments;
CREATE TRIGGER entity_comments_activity_ai
  AFTER INSERT ON public.entity_comments
  FOR EACH ROW EXECUTE FUNCTION public.entity_comments_bump_activity();

-- ---------------------------------------------------------------------------
-- j. Statement flag-autotrip (reuse C0 content_flags machinery, decision 9)
-- ---------------------------------------------------------------------------
-- Separate function from entity_comments_flag_autotrip (don't touch that one):
-- at >= 3 unresolved flags, collapse a visible statement to needs_review. Never
-- auto-hide. Full jury moderation is C2.
CREATE OR REPLACE FUNCTION public.entity_statements_flag_autotrip()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_unresolved int;
BEGIN
  IF NEW.content_type <> 'entity_statement' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
  INTO v_unresolved
  FROM public.content_flags
  WHERE content_type = 'entity_statement'
    AND content_id = NEW.content_id
    AND resolved = false;

  IF v_unresolved >= 3 THEN
    UPDATE public.entity_statements
    SET status = 'needs_review'
    WHERE id = NEW.content_id
      AND status = 'visible';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_flags_entity_statement_autotrip ON public.content_flags;
CREATE TRIGGER content_flags_entity_statement_autotrip
  AFTER INSERT ON public.content_flags
  FOR EACH ROW EXECUTE FUNCTION public.entity_statements_flag_autotrip();

-- ---------------------------------------------------------------------------
-- k. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.entity_statements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statement_votes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_activity_state ENABLE ROW LEVEL SECURITY;

-- entity_statements: public reads visible/needs_review; authors always see own.
-- No INSERT/UPDATE policies — submit_statement (SECURITY DEFINER) + service role
-- are the only writers.
DROP POLICY IF EXISTS entity_statements_select ON public.entity_statements;
CREATE POLICY entity_statements_select ON public.entity_statements
  FOR SELECT TO anon, authenticated
  USING (status IN ('visible','needs_review') OR author_id = auth.uid());

-- statement_votes: own-rows-only for every command (writes go through the RPC,
-- but the policies are belt-and-braces for direct REST).
DROP POLICY IF EXISTS statement_votes_select_own ON public.statement_votes;
DROP POLICY IF EXISTS statement_votes_insert_own ON public.statement_votes;
DROP POLICY IF EXISTS statement_votes_update_own ON public.statement_votes;
DROP POLICY IF EXISTS statement_votes_delete_own ON public.statement_votes;
CREATE POLICY statement_votes_select_own ON public.statement_votes
  FOR SELECT TO authenticated USING (voter_id = auth.uid());
CREATE POLICY statement_votes_insert_own ON public.statement_votes
  FOR INSERT TO authenticated WITH CHECK (voter_id = auth.uid());
CREATE POLICY statement_votes_update_own ON public.statement_votes
  FOR UPDATE TO authenticated USING (voter_id = auth.uid());
CREATE POLICY statement_votes_delete_own ON public.statement_votes
  FOR DELETE TO authenticated USING (voter_id = auth.uid());

-- entity_activity_state: public SELECT (just a flag + count); no client writes
-- (trigger / service role only).
DROP POLICY IF EXISTS entity_activity_state_select ON public.entity_activity_state;
CREATE POLICY entity_activity_state_select ON public.entity_activity_state
  FOR SELECT TO anon, authenticated USING (true);

-- Table privileges (RLS still gates rows).
GRANT SELECT ON public.entity_statements    TO anon, authenticated;
GRANT ALL    ON public.entity_statements    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.statement_votes TO authenticated;
GRANT ALL    ON public.statement_votes      TO service_role;
GRANT SELECT ON public.entity_activity_state TO anon, authenticated;
GRANT ALL    ON public.entity_activity_state TO service_role;

COMMENT ON TABLE public.entity_statements IS
  'C1 Wave C (FIX-533): Polis-lite statement primitive. One proposition per row; vote_summary {agree,disagree,pass} maintained by trigger. Public reads visible/needs_review; ballots live in statement_votes (own-rows). Creation via submit_statement (user submission / own-comment promotion only — no AI extraction this wave).';
COMMENT ON TABLE public.statement_votes IS
  'C1 Wave C (FIX-533): one ballot per (statement, voter); raw vote (-1/0/+1) kept for future C3 opinion clustering. Own-rows SELECT; writes via set_statement_vote(). Public exposure is the denormalized entity_statements.vote_summary.';
