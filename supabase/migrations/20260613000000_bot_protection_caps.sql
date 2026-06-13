-- FIX-569 (bot-protection gate, PR 2/3): close the two uncapped aggregate-skewing
-- write paths + progressive new-account trust.
--
-- WHY: plain set_entity_position had NO daily cap (only the *attribution* path was
-- capped, via DELTA_DAILY_CAP=5), and set_statement_vote had no cap at all. A
-- single account could therefore set a stance on EVERY entity and vote on EVERY
-- statement → direct skew of the position rollups and statement vote_summary, the
-- highest-value integrity hit. This redefines both RPCs (CREATE OR REPLACE, EXACT
-- same signatures — an in-place replace, never a drop/recreate) to add a per-user
-- rolling-24h cap mirroring the submit_comment pattern, HALVED for new accounts.
--
--   * set_entity_position  — cap plain sets at RATE_LIMITS.positions (60/day).
--                            The existing no-op early-return, attribution guards
--                            (DELTA_DAILY_CAP=5, 7-day age), and constituent
--                            snapshot are preserved EXACTLY.
--   * set_statement_vote   — cap NET-NEW ballots at RATE_LIMITS.statement_votes
--                            (200/day). Re-voting an already-voted statement (a
--                            mind-change) is exempt — it adds no new aggregate
--                            volume.
--
-- New-account trust (FIX-569): an account younger than NEW_ACCOUNT_AGE_HOURS (24h)
-- gets HALVED caps. Keyed on users.created_at — one cheap read on the write path;
-- NO cross-table action count here (that lower bound is applied only in the
-- app-layer first-writes challenge, apps/civitics/src/lib/turnstile.ts). This is
-- an internal multiplier, never surfaced (brand rule #3 — no public karma/tier).
--
-- Constants are MIRRORED here as literals from packages/db/src/comment-kinds.ts
-- (RATE_LIMITS.positions=60, RATE_LIMITS.statement_votes=200,
-- NEW_ACCOUNT_AGE_HOURS=24) and guarded by the FIX-543 drift test, which parses
-- the LATEST migration that defines each RPC — i.e. this file for both.
--
-- Both RAISE the same stable over-limit SQLSTATE the comment path uses (53400 →
-- 429 at the route). Replay-safe on an EMPTY database: no seed-data dependency;
-- CREATE OR REPLACE (same signatures). search_path is the UNQUOTED comma form
-- (the quoted form breaks on prod Pro); per-function statement_timeout preserved.

-- ---------------------------------------------------------------------------
-- a. set_entity_position() — re-emit of 20260607060000 + the positions cap.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_entity_position(
  p_entity_type          text,
  p_entity_id            uuid,
  p_stance               smallint,
  p_conditions_md        text DEFAULT NULL,
  p_attributed_comment_id uuid DEFAULT NULL,
  p_note                 text DEFAULT NULL
) RETURNS public.entity_positions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_user     uuid := auth.uid();
  v_existing public.entity_positions;
  v_attr     public.entity_comments;
  v_juris    uuid;
  v_age      interval;
  v_today    int;
  v_result   public.entity_positions;
  v_is_new   boolean;     -- FIX-569: account younger than NEW_ACCOUNT_AGE_HOURS
  v_pos_cap  int;         -- FIX-569: RATE_LIMITS.positions (halved if new)
  v_pos_today int;        -- FIX-569: caller's position-change events in 24h
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_entity_type NOT IN ('proposal','official','jurisdiction','institution','financial_entity','district') THEN
    RAISE EXCEPTION 'invalid entity_type: %', p_entity_type USING ERRCODE = '22023';
  END IF;
  IF p_stance IS NULL OR p_stance < -3 OR p_stance > 3 THEN
    RAISE EXCEPTION 'stance must be between -3 and 3' USING ERRCODE = '22023';
  END IF;

  -- Prior position (drives from_stance + the attribution stance-on-record rule).
  SELECT * INTO v_existing
  FROM public.entity_positions
  WHERE user_id = v_user AND entity_type = p_entity_type AND entity_id = p_entity_id;

  -- No-op: nothing actually changes → write no event (decision c). Attribution
  -- on an unchanged position is ignored rather than farmed into a phantom delta.
  IF v_existing.user_id IS NOT NULL
     AND v_existing.stance = p_stance
     AND v_existing.conditions_md IS NOT DISTINCT FROM p_conditions_md THEN
    RETURN v_existing;
  END IF;

  -- FIX-569: per-user daily cap on plain position sets (RATE_LIMITS.positions=60,
  -- halved for new accounts < NEW_ACCOUNT_AGE_HOURS). Counts every position-change
  -- EVENT in the rolling 24h; the no-op above returned without writing one, so it
  -- never counts. The attribution DELTA_DAILY_CAP (5) below is a separate, stricter
  -- sub-limit on the attributed subset.
  SELECT (now() - created_at < interval '24 hours') INTO v_is_new
  FROM public.users WHERE id = v_user;
  v_pos_cap := 60;  -- RATE_LIMITS.positions
  IF COALESCE(v_is_new, false) THEN
    v_pos_cap := v_pos_cap / 2;  -- new-account halving
  END IF;
  SELECT count(*) INTO v_pos_today
  FROM public.position_events
  WHERE user_id = v_user AND created_at >= now() - interval '1 day';
  IF v_pos_today >= v_pos_cap THEN
    RAISE EXCEPTION 'daily position limit reached (% per day)', v_pos_cap USING ERRCODE = '53400';
  END IF;

  -- Attribution guards (delta = a persuasion event credited to a comment).
  IF p_attributed_comment_id IS NOT NULL THEN
    -- Account-age gate applies to attribution only; plain position-setting has none.
    SELECT now() - created_at INTO v_age FROM public.users WHERE id = v_user;
    IF v_age IS NULL OR v_age < interval '7 days' THEN
      RAISE EXCEPTION 'account must be at least 7 days old to attribute a position change'
        USING ERRCODE = '42501';
    END IF;
    -- Stance-on-record rule: you can only credit a comment for changing a mind
    -- you had already put on record for this entity.
    IF v_existing.user_id IS NULL THEN
      RAISE EXCEPTION 'attribution requires a prior position on this entity'
        USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_attr FROM public.entity_comments WHERE id = p_attributed_comment_id;
    IF v_attr.id IS NULL THEN
      RAISE EXCEPTION 'attributed comment not found' USING ERRCODE = '42501';
    END IF;
    IF v_attr.entity_type <> p_entity_type OR v_attr.entity_id <> p_entity_id THEN
      RAISE EXCEPTION 'attributed comment does not belong to this entity'
        USING ERRCODE = '42501';
    END IF;
    IF v_attr.author_id = v_user THEN
      RAISE EXCEPTION 'cannot attribute your own comment' USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO v_today
    FROM public.position_events
    WHERE user_id = v_user
      AND attributed_comment_id IS NOT NULL
      AND created_at >= now() - interval '1 day';
    IF v_today >= 5 THEN
      RAISE EXCEPTION 'daily attribution limit reached (5 per day)' USING ERRCODE = '53400';
    END IF;
  END IF;

  -- Constituent snapshot (decision 6): stamp the entity's jurisdiction iff the
  -- user holds an active constituent grant there at write time.
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

  INSERT INTO public.entity_positions
    (user_id, entity_type, entity_id, stance, conditions_md, constituent_jurisdiction_id)
  VALUES
    (v_user, p_entity_type, p_entity_id, p_stance, p_conditions_md, v_juris)
  ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE
    SET stance                      = EXCLUDED.stance,
        conditions_md               = EXCLUDED.conditions_md,
        constituent_jurisdiction_id = EXCLUDED.constituent_jurisdiction_id,
        updated_at                  = now()
  RETURNING * INTO v_result;

  INSERT INTO public.position_events
    (user_id, entity_type, entity_id, from_stance, to_stance, attributed_comment_id, note)
  VALUES
    (v_user, p_entity_type, p_entity_id, v_existing.stance, p_stance, p_attributed_comment_id, p_note);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.set_entity_position(text, uuid, smallint, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_entity_position(text, uuid, smallint, text, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- b. set_statement_vote() — re-emit of 20260608020000 + the statement_votes cap.
-- ---------------------------------------------------------------------------
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
  v_is_new  boolean;    -- FIX-569: account younger than NEW_ACCOUNT_AGE_HOURS
  v_vote_cap int;       -- FIX-569: RATE_LIMITS.statement_votes (halved if new)
  v_today   int;        -- FIX-569: caller's ballots cast in 24h
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

  -- FIX-569: per-user daily cap on NET-NEW ballots (RATE_LIMITS.statement_votes=200,
  -- halved for new accounts < NEW_ACCOUNT_AGE_HOURS). Re-voting a statement the
  -- caller has already voted on is a mind-change (the upsert below updates in
  -- place) — it adds no new aggregate volume, so it is EXEMPT from the cap.
  IF NOT EXISTS (
    SELECT 1 FROM public.statement_votes
    WHERE statement_id = p_statement_id AND voter_id = v_user
  ) THEN
    SELECT (now() - created_at < interval '24 hours') INTO v_is_new
    FROM public.users WHERE id = v_user;
    v_vote_cap := 200;  -- RATE_LIMITS.statement_votes
    IF COALESCE(v_is_new, false) THEN
      v_vote_cap := v_vote_cap / 2;  -- new-account halving
    END IF;
    SELECT count(*) INTO v_today
    FROM public.statement_votes
    WHERE voter_id = v_user AND created_at >= now() - interval '1 day';
    IF v_today >= v_vote_cap THEN
      RAISE EXCEPTION 'daily statement-vote limit reached (% per day)', v_vote_cap USING ERRCODE = '53400';
    END IF;
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
