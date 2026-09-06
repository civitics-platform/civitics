-- FIX-907 — position_events keeps the constituent-district snapshot.
--
-- entity_positions has carried constituent_jurisdiction_id since the FIX-569
-- era: set_entity_position resolves the entity's jurisdiction, keeps it only if
-- the caller holds an ACTIVE constituent grant there at write time, and stamps
-- it on the position row. That column is a SNAPSHOT of a fact that decays --
-- grants expire, people move, districts get redrawn -- so its value is
-- specifically "was this person a verified constituent WHEN they took this
-- position".
--
-- position_events, the append-only history that column exists to make
-- meaningful, did not record it. So the current position knows whether its
-- author was a constituent, and every superseded position in the history does
-- not. A position changed three times keeps one snapshot and discards three.
-- Any question of the form "how did verified constituents move on this over
-- time" is unanswerable, and stays unanswerable for every day this is not
-- fixed.
--
-- One column, one line. Type matches entity_positions.constituent_jurisdiction_id
-- exactly (uuid NULL) and carries NO foreign key, because entity_positions'
-- copy has none either -- its only FK is entity_positions_user_id_fkey. A
-- snapshot that a later jurisdiction delete could cascade away is not a
-- snapshot, so the absence is the correct shape, not an oversight to fix here.
--
-- NO BACKFILL. Historical events are not reconstructable even in principle:
-- has_active_constituent_grant() answers "now", the grant that was active at
-- some past write is not retained, and inferring it from today's grants would
-- manufacture evidence about the past out of the present. Pre-existing rows
-- stay NULL, and the column COMMENT says so, so nobody later reads NULL as
-- "was not a constituent".

ALTER TABLE public.position_events
  ADD COLUMN IF NOT EXISTS constituent_jurisdiction_id uuid NULL;

COMMENT ON COLUMN public.position_events.constituent_jurisdiction_id IS
  'FIX-907. Snapshot of the entity''s jurisdiction at write time, stamped only '
  'when the author held an ACTIVE constituent grant there (same rule as '
  'entity_positions.constituent_jurisdiction_id). NULL means one of two things: '
  'the author was not a verified constituent at write time, OR the row predates '
  'FIX-907 (2026-09-06). Rows before that date are NOT backfilled and cannot be '
  '- the grant state at the historical write is not retained anywhere. Do not '
  'read a NULL on a pre-2026-09-06 row as evidence of non-constituency. No FK, '
  'deliberately: a cascade would erase the snapshot this column exists to keep.';

-- set_entity_position, re-stated verbatim from prod's pg_get_functiondef with a
-- single change: v_juris (already computed for the entity_positions upsert
-- directly above) now also lands on the event row. SECURITY DEFINER and both
-- SET clauses (search_path, statement_timeout=2s) are re-stated because
-- CREATE OR REPLACE silently drops any it omits (rule 34); the proconfig diff
-- before/after this migration must be empty.
CREATE OR REPLACE FUNCTION public.set_entity_position(p_entity_type text, p_entity_id uuid, p_stance smallint, p_conditions_md text DEFAULT NULL::text, p_attributed_comment_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS entity_positions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
 SET statement_timeout TO '2s'
AS $function$
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
    (user_id, entity_type, entity_id, from_stance, to_stance, attributed_comment_id, note,
     constituent_jurisdiction_id)
  VALUES
    (v_user, p_entity_type, p_entity_id, v_existing.stance, p_stance, p_attributed_comment_id, p_note,
     v_juris);

  RETURN v_result;
END;
$function$;

-- Grants re-stated to prod's measured state (2026-09-06): authenticated,
-- service_role and the owner hold EXECUTE; anon does not and must not -- this
-- is SECURITY DEFINER and reads auth.uid(). CREATE OR REPLACE preserves the
-- existing ACL, so this is belt-and-braces against a future DROP+CREATE.
REVOKE ALL ON FUNCTION public.set_entity_position(text, uuid, smallint, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_entity_position(text, uuid, smallint, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_entity_position(text, uuid, smallint, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_entity_position(text, uuid, smallint, text, uuid, text) TO service_role;
