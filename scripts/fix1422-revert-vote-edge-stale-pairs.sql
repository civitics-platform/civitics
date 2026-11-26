-- scripts/fix1422-revert-vote-edge-stale-pairs.sql
-- FIX-1422 ROLLBACK (cc-319) — undoes 20261126006000_fix1422_vote_edge_stale_pairs.sql:
--   1. drops the two votes triggers it created, by name
--      (votes_capture_stale_pair_update, votes_capture_stale_pair_delete);
--   2. puts back rebuild_entity_connections_votes() as 20261117000000 §3 left it,
--      VERBATIM (md5(prosrc) efb7d5f628a1439c23f7be23b20bf9a4), no SET clause
--      (FIX-1128), grants as that file states them.
-- public.vote_edge_stale_pairs and public.capture_vote_edge_stale_pair() STAY,
-- inert: nothing writes the queue once the triggers are gone and the old arm
-- does not read it. Pairs still queued are moot after the next _votes_full().
--
-- DROP TRIGGER takes ACCESS EXCLUSIVE on public.votes for an instant; lock_timeout
-- bounds the wait behind an in-flight vote write or read.
--
-- Apply:  node scripts/db-query.mjs --local --file scripts/fix1422-revert-vote-edge-stale-pairs.sql
-- (prod: through the primary checkout's gate, as the cc-319 STOP table names it).

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS votes_capture_stale_pair_update ON public.votes;
DROP TRIGGER IF EXISTS votes_capture_stale_pair_delete ON public.votes;

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
#variable_conflict use_column
DECLARE
  v_vote_yes             BIGINT;
  v_vote_no              BIGINT;
  v_vote_abstain         BIGINT;
  v_last_indexed_at      TIMESTAMPTZ;
  v_new_max_updated_at   TIMESTAMPTZ;
  v_horizon              TIMESTAMPTZ;   -- FIX-1139
BEGIN
  SELECT (value->>'last_indexed_at')::timestamptz
    INTO v_last_indexed_at
  FROM public.pipeline_state
  WHERE key = 'entity_connections_votes';

  IF v_last_indexed_at IS NULL THEN
    RETURN QUERY SELECT * FROM public.rebuild_entity_connections_votes_full();
    RETURN;
  END IF;

  -- FIX-1139 (a)+(b) — capture the target BEFORE the dirty set and clamp it to
  -- the head-lag horizon, so the dirty set can be bounded above by it.
  SELECT MAX(v.updated_at) INTO v_new_max_updated_at
  FROM public.votes v
  WHERE v.bill_proposal_id IS NOT NULL
    AND v.official_id IS NOT NULL;

  v_horizon            := public.watermark_horizon();
  v_new_max_updated_at := LEAST(COALESCE(v_new_max_updated_at, v_horizon), v_horizon);

  -- FIX-1139 (d) — nothing old enough to read yet. Report zero and leave the
  -- watermark exactly where it is; writing v_new_max_updated_at here would move
  -- it BACKWARDS. The rows are returned (not RAISEd, not skipped) so the
  -- orchestrator logs a 'complete' cycle — FIX-1140: check_rollup_freshness
  -- counts only 'complete', so a caught-up run that reported anything else
  -- would freeze the freshness clock.
  IF v_new_max_updated_at <= v_last_indexed_at THEN
    connection_type := 'vote_yes';     edges_upserted := 0; RETURN NEXT;
    connection_type := 'vote_no';      edges_upserted := 0; RETURN NEXT;
    connection_type := 'vote_abstain'; edges_upserted := 0; RETURN NEXT;
    RETURN;
  END IF;

  CREATE TEMP TABLE _dirty_vote_keys ON COMMIT DROP AS
  SELECT DISTINCT v.official_id, v.bill_proposal_id
  FROM public.votes v
  WHERE v.updated_at >  v_last_indexed_at
    AND v.updated_at <= v_new_max_updated_at   -- FIX-1139 (c)
    AND v.bill_proposal_id IS NOT NULL
    AND v.official_id IS NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM _dirty_vote_keys) THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES (
      'entity_connections_votes',
      jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW();

    connection_type := 'vote_yes';     edges_upserted := 0; RETURN NEXT;
    connection_type := 'vote_no';      edges_upserted := 0; RETURN NEXT;
    connection_type := 'vote_abstain'; edges_upserted := 0; RETURN NEXT;
    RETURN;
  END IF;

  DELETE FROM public.entity_connections ec
  USING _dirty_vote_keys d
  WHERE ec.connection_type IN ('vote_yes', 'vote_no', 'vote_abstain')
    AND ec.from_type = 'official'
    AND ec.from_id = d.official_id
    AND ec.to_type = 'proposal'
    AND ec.to_id = d.bill_proposal_id;

  -- FIX-1409 — the edge rule (D1–D4, D9). This SELECT is character-identical
  -- to _votes_full()'s but for the INNER JOIN line pair; a test holds it.
  WITH inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT DISTINCT ON (v.official_id, v.bill_proposal_id)
      'official', v.official_id, 'proposal', v.bill_proposal_id,
      (CASE v.vote
         WHEN 'yes'     THEN 'vote_yes'
         WHEN 'no'      THEN 'vote_no'
         WHEN 'abstain' THEN 'vote_abstain'
       END)::public.connection_type,
      (CASE public.vote_roll_class(v.vote_question, v.roll_call_id)
         WHEN 'final' THEN 0.500
         ELSE 0.250
       END)::numeric(4,3),
      v.voted_at::date,
      1, 'votes', ARRAY[v.id]
    FROM public.votes v
    INNER JOIN _dirty_vote_keys d
      ON d.official_id = v.official_id AND d.bill_proposal_id = v.bill_proposal_id
    WHERE v.bill_proposal_id IS NOT NULL
      AND v.official_id IS NOT NULL
      AND v.vote IN ('yes', 'no', 'abstain')
      AND public.vote_roll_class(v.vote_question, v.roll_call_id) IN ('final', 'advance')
    ORDER BY v.official_id, v.bill_proposal_id,
      -- the tier: a final roll (0.500) before an advance roll (0.250)
      (CASE public.vote_roll_class(v.vote_question, v.roll_call_id)
         WHEN 'final' THEN 0.500
         ELSE 0.250
       END)::numeric(4,3) DESC,
      v.voted_at DESC NULLS LAST,
      -- the roll number: the order inside a day
      substring(v.roll_call_id FROM '([0-9]+)$')::numeric DESC NULLS LAST,
      v.id DESC
    RETURNING entity_connections.connection_type AS ct
  )
  SELECT
    COUNT(*) FILTER (WHERE ct = 'vote_yes'),
    COUNT(*) FILTER (WHERE ct = 'vote_no'),
    COUNT(*) FILTER (WHERE ct = 'vote_abstain')
  INTO v_vote_yes, v_vote_no, v_vote_abstain
  FROM inserted;

  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_votes',
    jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'vote_yes';     edges_upserted := v_vote_yes;     RETURN NEXT;
  connection_type := 'vote_no';      edges_upserted := v_vote_no;      RETURN NEXT;
  connection_type := 'vote_abstain'; edges_upserted := v_vote_abstain; RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_votes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes() TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_trg int;
BEGIN
  SELECT md5(prosrc) INTO v_md5
    FROM pg_proc WHERE oid = 'public.rebuild_entity_connections_votes()'::regprocedure;
  SELECT count(*) INTO v_trg FROM pg_trigger
   WHERE tgrelid = 'public.votes'::regclass
     AND tgname IN ('votes_capture_stale_pair_update', 'votes_capture_stale_pair_delete');
  IF v_md5 IS DISTINCT FROM 'efb7d5f628a1439c23f7be23b20bf9a4' OR v_trg <> 0 THEN
    RAISE EXCEPTION '[fix1422-revert] arm md5 % (expected efb7d5f6…), % capture trigger(s) left', v_md5, v_trg;
  END IF;
  RAISE NOTICE '[fix1422-revert] triggers gone; rebuild_entity_connections_votes back to 20261117000000 (md5 %)', v_md5;
END $$;

COMMIT;
