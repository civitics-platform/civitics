-- scripts/fix1409-revert-vote-edge-question-rule.sql
-- FIX-1409 ROLLBACK (cc-283) — puts back the two vote arms as prod runs them
-- before 20261117000000_fix1409_vote_edge_question_rule.sql: the bodies of
-- 20260905000100_fix1139_votes_watermark_horizon.sql §3 and §4 VERBATIM
-- (md5(prosrc) 4e34295bee6f343f78800e82a58404de / 584de460d563ff8531cd37161d26a361),
-- with no SET clause: FIX-1128 (20260913000000) RESET their statement_timeout,
-- so the live proconfig is NULL, and check:proconfig holds it there.
-- Grants as 20260905000100 states them.
--
-- It DROPS NOTHING. public.vote_question_class(text) and
-- public.vote_roll_class(text, text) stay; the old bodies do not read them.
-- The edges are not reverted either: after a merge has run, the next
-- _votes_full() under these bodies is a delete-all + insert of the OLD rule.
--
-- Apply:  node scripts/db-query.mjs --local --file scripts/fix1409-revert-vote-edge-question-rule.sql
-- (prod: only under a supervised session, through the primary checkout).

-- ── 1. rebuild_entity_connections_votes() — 20260905000100 §3 ─────────────────

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
      0.500::numeric(4,3),
      v.voted_at::date,
      1, 'votes', ARRAY[v.id]
    FROM public.votes v
    INNER JOIN _dirty_vote_keys d
      ON d.official_id = v.official_id AND d.bill_proposal_id = v.bill_proposal_id
    WHERE v.bill_proposal_id IS NOT NULL
      AND v.official_id IS NOT NULL
      AND v.vote IN ('yes', 'no', 'abstain')
    ORDER BY v.official_id, v.bill_proposal_id, v.voted_at DESC NULLS LAST, v.id DESC
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

-- ── 2. rebuild_entity_connections_votes_full() — 20260905000100 §4 ────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes_full()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
#variable_conflict use_column
DECLARE
  v_vote_yes     BIGINT;
  v_vote_no      BIGINT;
  v_vote_abstain BIGINT;
BEGIN
  -- FIX-1136: scoped to this arm's own source (was a bare connection_type match).
  DELETE FROM public.entity_connections
   WHERE entity_connections.connection_type IN ('vote_yes', 'vote_no', 'vote_abstain')
     AND entity_connections.evidence_source = 'votes';

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
      0.500::numeric(4,3),
      v.voted_at::date,
      1, 'votes', ARRAY[v.id]
    FROM public.votes v
    WHERE v.bill_proposal_id IS NOT NULL
      AND v.official_id IS NOT NULL
      AND v.vote IN ('yes', 'no', 'abstain')
    ORDER BY v.official_id, v.bill_proposal_id, v.voted_at DESC NULLS LAST, v.id DESC
    RETURNING entity_connections.connection_type AS ct
  )
  SELECT
    COUNT(*) FILTER (WHERE ct = 'vote_yes'),
    COUNT(*) FILTER (WHERE ct = 'vote_no'),
    COUNT(*) FILTER (WHERE ct = 'vote_abstain')
  INTO v_vote_yes, v_vote_no, v_vote_abstain
  FROM inserted;

  -- FIX-1139: the horizon, not NOW().
  INSERT INTO public.pipeline_state (key, value)
  VALUES (
    'entity_connections_votes',
    jsonb_build_object('last_indexed_at', public.watermark_horizon()::text)
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = NOW();

  connection_type := 'vote_yes';     edges_upserted := v_vote_yes;     RETURN NEXT;
  connection_type := 'vote_no';      edges_upserted := v_vote_no;      RETURN NEXT;
  connection_type := 'vote_abstain'; edges_upserted := v_vote_abstain; RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_votes_full() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes_full() TO service_role;
