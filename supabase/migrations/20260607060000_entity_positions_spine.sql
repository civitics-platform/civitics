-- FIX-523 (C1 Wave A): position spine.
--
-- Adds the signal layer on top of the C0 entity_comments substrate (FIX-519):
--   * entity_positions  — one row per (user, entity); intensity smallint -3..+3
--                         (absence = no position; 0 = explicit neutral).
--   * position_events    — append-only ledger; a "delta" IS an event with
--                         attributed_comment_id set. Anti-collusion guards live
--                         in the write RPC, not in client code.
--   * set_entity_position()        — the SINGLE write path (SECURITY DEFINER).
--   * get_entity_position_rollup() — aggregate-only public read, min-n gated.
--   * a trigger that denormalizes per-comment delta counts into
--     entity_comments.rating_summary.deltas.
--   * compute_alignment_score()    — repointed off the frozen civic_comments
--     onto entity_positions (sign-match; neutral excluded from total_votes).
--
-- Public surfaces are AGGREGATES ONLY (same philosophy as C0 ratings): the two
-- tables are own-rows-only SELECT; nobody can attribute an individual stance or
-- persuasion event to a user. Writes never go through INSERT/UPDATE policies —
-- the RPC + service role are the only writers, so the delta guards cannot be
-- bypassed by a creative client.
--
-- Replay-safe on an EMPTY database: no seed-data dependencies; every statement
-- is idempotent (CREATE ... IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF
-- EXISTS). Constants mirrored in packages/db/src/comment-kinds.ts:
--   MIN_POSITIONS_FOR_ROLLUP = 10, DELTA_DAILY_CAP = 5, MIN_ACCOUNT_AGE_DAYS = 7.

-- ---------------------------------------------------------------------------
-- a. entity_positions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entity_positions (
  user_id                     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entity_type                 text NOT NULL
    CHECK (entity_type IN ('proposal','official','jurisdiction','institution','financial_entity','district')),
  entity_id                   uuid NOT NULL,
  stance                      smallint NOT NULL CHECK (stance BETWEEN -3 AND 3),
  conditions_md               text,
  constituent_jurisdiction_id uuid,                       -- snapshot-at-write (decision 6)
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- Rollup scan: all positions for one entity.
CREATE INDEX IF NOT EXISTS entity_positions_entity_idx
  ON public.entity_positions (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- b. position_events (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.position_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  entity_type           text NOT NULL,
  entity_id             uuid NOT NULL,
  from_stance           smallint,                         -- NULL on first position
  to_stance             smallint NOT NULL,
  attributed_comment_id uuid REFERENCES public.entity_comments(id) ON DELETE SET NULL,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Daily-cap + per-user history scan.
CREATE INDEX IF NOT EXISTS position_events_user_idx
  ON public.position_events (user_id, created_at DESC);
-- Delta-count maintenance (only attributed events matter).
CREATE INDEX IF NOT EXISTS position_events_attributed_idx
  ON public.position_events (attributed_comment_id)
  WHERE attributed_comment_id IS NOT NULL;

-- updated_at maintenance (house helper).
DROP TRIGGER IF EXISTS entity_positions_set_updated_at ON public.entity_positions;
CREATE TRIGGER entity_positions_set_updated_at
  BEFORE UPDATE ON public.entity_positions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- c. set_entity_position() — the single write path
-- ---------------------------------------------------------------------------
-- Atomic: upsert the position + append exactly one event + enforce every guard.
-- search_path is UNQUOTED comma-separated (the quoted form breaks on prod Pro).
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
-- d. get_entity_position_rollup() — aggregate-only public read (min-n gated)
-- ---------------------------------------------------------------------------
-- Returns a single row. Below MIN_POSITIONS_FOR_ROLLUP (10) everything is NULL
-- except n — small-n medians presented as "the community's view" is how the
-- metric gets discredited (mirrors the bridge-score NULL rule). buckets is a
-- jsonb object keyed "-3".."3" → count.
CREATE OR REPLACE FUNCTION public.get_entity_position_rollup(
  p_entity_type text,
  p_entity_id   uuid,
  p_lens        text DEFAULT 'all'
) RETURNS TABLE (
  n                   int,
  median              numeric,
  pct_with_conditions numeric,
  buckets             jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '5s'
AS $$
DECLARE
  v_lens text := CASE WHEN p_lens = 'constituents' THEN 'constituents' ELSE 'all' END;
BEGIN
  RETURN QUERY
  WITH rows AS (
    SELECT ep.stance, ep.conditions_md
    FROM public.entity_positions ep
    WHERE ep.entity_type = p_entity_type
      AND ep.entity_id   = p_entity_id
      AND (v_lens = 'all' OR ep.constituent_jurisdiction_id IS NOT NULL)
  ),
  agg AS (
    SELECT
      count(*)::int AS cnt,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY stance)::numeric AS med,
      count(*) FILTER (WHERE conditions_md IS NOT NULL AND btrim(conditions_md) <> '')::numeric AS with_cond
    FROM rows
  ),
  dist AS (
    SELECT jsonb_object_agg(gs.s::text, COALESCE(bc.c, 0)) AS b
    FROM generate_series(-3, 3) AS gs(s)
    LEFT JOIN (SELECT stance, count(*) AS c FROM rows GROUP BY stance) bc ON bc.stance = gs.s
  )
  SELECT
    agg.cnt,
    CASE WHEN agg.cnt < 10 THEN NULL ELSE round(agg.med, 2) END,
    CASE WHEN agg.cnt < 10 THEN NULL ELSE round(agg.with_cond / NULLIF(agg.cnt, 0), 4) END,
    CASE WHEN agg.cnt < 10 THEN NULL ELSE dist.b END
  FROM agg, dist;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_entity_position_rollup(text, uuid, text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- e. Delta-count trigger: denormalize attributed events into the comment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.position_events_bump_delta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
BEGIN
  IF NEW.attributed_comment_id IS NOT NULL THEN
    UPDATE public.entity_comments
    SET rating_summary = jsonb_set(
          COALESCE(rating_summary, '{}'::jsonb),
          '{deltas}',
          to_jsonb(COALESCE((rating_summary ->> 'deltas')::int, 0) + 1),
          true)
    WHERE id = NEW.attributed_comment_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS position_events_delta_ai ON public.position_events;
CREATE TRIGGER position_events_delta_ai
  AFTER INSERT ON public.position_events
  FOR EACH ROW EXECUTE FUNCTION public.position_events_bump_delta();

-- The C0 rating-summary rebuild (FIX-519) reconstructs rating_summary from
-- scratch via jsonb_build_object and would CLOBBER the deltas key written above.
-- Re-define it to preserve deltas the same way it preserves legacy_upvotes.
-- (CREATE OR REPLACE of a function — a new migration, not an edit of the old.)
CREATE OR REPLACE FUNCTION public.entity_comments_refresh_rating_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '2s'
AS $$
DECLARE
  v_comment_id uuid := COALESCE(NEW.comment_id, OLD.comment_id);
  v_agree_up   int;
  v_agree_down int;
  v_val_up     int;
  v_val_down   int;
  v_legacy     jsonb;
  v_deltas     jsonb;
BEGIN
  SELECT
    count(*) FILTER (WHERE agree = 1),
    count(*) FILTER (WHERE agree = -1),
    count(*) FILTER (WHERE valuable = 1),
    count(*) FILTER (WHERE valuable = -1)
  INTO v_agree_up, v_agree_down, v_val_up, v_val_down
  FROM public.comment_ratings
  WHERE comment_id = v_comment_id;

  SELECT
    COALESCE(rating_summary -> 'legacy_upvotes', '0'::jsonb),
    COALESCE(rating_summary -> 'deltas',         '0'::jsonb)
  INTO v_legacy, v_deltas
  FROM public.entity_comments
  WHERE id = v_comment_id;

  UPDATE public.entity_comments
  SET rating_summary = jsonb_build_object(
        'agree_up',       COALESCE(v_agree_up, 0),
        'agree_down',     COALESCE(v_agree_down, 0),
        'valuable_up',    COALESCE(v_val_up, 0),
        'valuable_down',  COALESCE(v_val_down, 0),
        'legacy_upvotes', COALESCE(v_legacy, '0'::jsonb),
        'deltas',         COALESCE(v_deltas, '0'::jsonb)
      )
  WHERE id = v_comment_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------
-- f. RLS — own-rows-only SELECT; no INSERT/UPDATE/DELETE policies at all.
-- ---------------------------------------------------------------------------
ALTER TABLE public.entity_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.position_events  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_positions_select_own ON public.entity_positions;
CREATE POLICY entity_positions_select_own ON public.entity_positions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS position_events_select_own ON public.position_events;
CREATE POLICY position_events_select_own ON public.position_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Only the RPC (SECURITY DEFINER → owner) and service_role ever write.
GRANT SELECT ON public.entity_positions TO authenticated;
GRANT SELECT ON public.position_events  TO authenticated;
GRANT ALL    ON public.entity_positions TO service_role;
GRANT ALL    ON public.position_events  TO service_role;

COMMENT ON TABLE public.entity_positions IS
  'C1 (FIX-523): one row per (user, entity); intensity stance -3..+3 (0 = explicit neutral, no row = no position). Own-rows SELECT; all writes via set_entity_position(). Public reads are aggregates via get_entity_position_rollup().';
COMMENT ON TABLE public.position_events IS
  'C1 (FIX-523): append-only position-change ledger. A delta is an event with attributed_comment_id set; guards enforced in set_entity_position(). Own-rows SELECT only; public exposure is the denormalized rating_summary.deltas count.';

-- ---------------------------------------------------------------------------
-- g. compute_alignment_score() repoint (decision 7)
-- ---------------------------------------------------------------------------
-- IDENTICAL signature and return shape to 20260529150200 (FIX-438) — the
-- user-centric radial chart (/api/graph/my-representatives → AlignmentGraph)
-- must not change. What changes is the SOURCE of the user's position:
--   * civic_comments.position (frozen in C0)  →  entity_positions.stance
--   * aligned = (stance > 0 AND vote 'yes') OR (stance < 0 AND vote 'no')
--   * stance = 0 (explicit neutral) is EXCLUDED from total_votes — a deliberate
--     semantics improvement over the old function, where neutral comments
--     counted as misaligned and dragged the ratio down.
-- vote_details.user_pos is kept as the text label 'support'/'oppose' so the
-- jsonb shape (user_pos: string) the route's type expects is unchanged.
-- Intensity-weighted alignment is deferred (future work): today it is a pure
-- sign match, so a -3 and a -1 against the same 'no' vote count identically.
-- Discipline preserved: vote_category='substantive' filter, 10-row
-- vote_details cap, SET search_path = public, pg_temp, per-function timeout.
CREATE OR REPLACE FUNCTION public.compute_alignment_score(
  p_user_id     uuid,
  p_official_id uuid
) RETURNS TABLE (
  alignment_ratio numeric,
  matched_votes   int,
  total_votes     int,
  vote_details    jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH overlap AS (
    SELECT
      ep.entity_id                       AS proposal_id,
      COALESCE(p.short_title, p.title)   AS proposal_title,
      CASE WHEN ep.stance > 0 THEN 'support' ELSE 'oppose' END AS user_pos,
      v.vote                             AS official_vote,
      CASE
        WHEN ep.stance > 0 AND v.vote = 'yes' THEN true
        WHEN ep.stance < 0 AND v.vote = 'no'  THEN true
        ELSE false
      END                                AS aligned
    FROM entity_positions ep
    JOIN votes     v ON v.bill_proposal_id = ep.entity_id
                     AND v.official_id = p_official_id
    JOIN proposals p ON p.id = ep.entity_id
    WHERE ep.user_id     = p_user_id
      AND ep.entity_type = 'proposal'
      AND ep.stance     <> 0                 -- neutral excluded from total_votes
      AND p.vote_category = 'substantive'
  )
  SELECT
    ROUND(COALESCE(AVG(aligned::int), 0)::numeric, 2),
    COALESCE(SUM(aligned::int), 0)::int,
    COUNT(*)::int,
    COALESCE(
      (SELECT jsonb_agg(row_data ORDER BY (row_data->>'aligned')::boolean DESC)
       FROM (
         SELECT jsonb_build_object(
           'proposal_id',   proposal_id,
           'title',         proposal_title,
           'user_pos',      user_pos,
           'official_vote', official_vote,
           'aligned',       aligned
         ) AS row_data
         FROM overlap
         LIMIT 10
       ) sub),
      '[]'::jsonb
    )
  FROM overlap;
END;
$$;

ALTER FUNCTION public.compute_alignment_score(uuid, uuid) SET statement_timeout = '3s';
GRANT EXECUTE ON FUNCTION public.compute_alignment_score(uuid, uuid) TO authenticated;
