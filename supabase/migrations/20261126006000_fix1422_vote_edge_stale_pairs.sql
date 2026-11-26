-- 20261126006000_fix1422_vote_edge_stale_pairs.sql
--
-- FIX-1422 — the incremental votes arm never retires an edge whose
-- (official, bill) pair moved, or whose vote row was deleted.
--
-- THE GAP. rebuild_entity_connections_votes() builds its dirty set from the
-- CURRENT (official_id, bill_proposal_id) of the votes past its watermark. A
-- vote re-attributed to another official, re-pointed to another bill, or
-- deleted leaves its OLD pair's edge in entity_connections until a full
-- _votes_full() merge removes it (cc-283: 1,076 on the clone; cc-288: 1,032 on
-- prod, all Senate). A delete is invisible twice over: the fingerprint
-- (count(*), max(updated_at)) sees it and calls the arm, and the arm finds
-- nothing dirty.
--
-- WHY NOT THE BULLET'S SHAPE ("the dirty set also takes the pairs of the edges
-- whose evidence_ids name a dirty vote"). entity_connections has no index on
-- evidence_ids. On the clone (cc-319 A2), the vote edges naming one House roll's
-- 431 votes cost a Bitmap Heap Scan of all 518,748 vote-type rows: 34,345
-- buffers read, 7.4 s, 413 rows kept — on every cycle with a dirty vote, which
-- is every voting day. Narrowing by dirty official does not help (on a voting
-- day every member is dirty), by dirty bill misses a re-attributed vote, and
-- neither sees a delete. The old pair is known exactly once, cheaply: at the
-- write. So the write captures it and the arm consumes it.
--
-- THE CHANGE (cc-319 D3).
--   1. public.vote_edge_stale_pairs (official_id, bill_proposal_id, captured_at),
--      PK the pair: a queue of old pairs. Service-only in the data_flags shape:
--      RLS on, no policy, ALL revoked from PUBLIC / anon / authenticated /
--      service_role, then SELECT, INSERT, DELETE to service_role — a trigger
--      runs as its caller, and the legistar writer upserts votes as
--      service_role. No FK: a captured pair's official or bill may be gone.
--   2. public.capture_vote_edge_stale_pair(): one INSERT … ON CONFLICT DO
--      NOTHING of the OLD pair. NO EXCEPTION block — a block is a
--      subtransaction per fired row, and a promotion or a re-point moves
--      thousands of votes in one statement (cc-316: 28,522). No SET clause: a
--      SET is a GUC save/restore per fired row; every name is qualified and the
--      function is SECURITY INVOKER.
--   3. rebuild_entity_connections_votes(): 20261117000000's body plus four
--      hunks — the captured pairs are consumed (DELETE … RETURNING) into
--      _dirty_vote_keys beside the watermark's rows; the caught-up return is
--      taken only when nothing was captured either; both watermark writes move
--      it forward only, so a capture-only cycle (a delete, no newer updated_at)
--      leaves last_indexed_at where it was; a NOTICE when anything was
--      consumed. The edge SELECT is untouched: still character-identical to
--      _votes_full()'s but for the INNER JOIN pair (fix1422 test holds it).
--      The returned rows are as before. No SET (FIX-1128); grants restated.
--   4. Two row triggers on public.votes, created LAST so the SHARE ROW
--      EXCLUSIVE lock they take is held for the read-back only:
--        AFTER UPDATE OF official_id, bill_proposal_id, WHEN the pair is
--          DISTINCT and the old pair is whole;
--        AFTER DELETE, WHEN the old pair is whole.
--      The function runs only when a pair really moved or a row went. An
--      upsert that re-sets both columns to their own values fires nothing.
--      CREATE OR REPLACE TRIGGER (PG 14+): a DROP TRIGGER IF EXISTS would take
--      ACCESS EXCLUSIVE on votes, which blocks every reader.
--
-- NOT EDITED: _votes_full() (a full merge makes a queued pair moot; the next
-- incremental cycle consumes it harmlessly), run_entity_connections_rebuild,
-- ec_arm_source_fingerprint, vote_roll_class, any writer in packages/data.
--
-- PROD RISK. lock_timeout 5s bounds the trigger's wait behind an in-flight
-- vote write; a timeout rolls this file back whole. From the push on, every
-- UPDATE naming either column and every vote DELETE evaluates one WHEN per row.
--
-- GUARD: the arm's md5(prosrc) is 20261117000000's (efb7d5f628a1439c23f7be23b20bf9a4,
-- cc-319 read 2) or this file's (76bce60cc492db5465f6c1e1c970de91, re-apply); the table does not already exist
-- unless in this file's shape. REVERT: scripts/fix1422-revert-vote-edge-stale-pairs.sql
-- (drops both triggers, restores the 20261117000000 arm; the table and the
-- function stay, inert).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5
    FROM pg_proc WHERE oid = 'public.rebuild_entity_connections_votes()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'efb7d5f628a1439c23f7be23b20bf9a4'
     AND v_md5 IS DISTINCT FROM '76bce60cc492db5465f6c1e1c970de91' THEN
    RAISE EXCEPTION '[fix1422] rebuild_entity_connections_votes md5 % is neither 20261117000000''s (efb7d5f6…) nor this file''s — prod was changed outside the tree', v_md5;
  END IF;
  -- An existing queue (a re-apply, or a re-apply after the revert, which keeps
  -- it) must be this file's shape: the three columns and the pair as its key.
  -- The queue is named through to_regclass() only, never a ::regclass literal:
  -- a literal is resolved when the statement is parsed, so on a database
  -- without the table it raises 42P01 whatever the IF says (cc-319's first
  -- push, 2026-11-26 19:47:11Z).
  IF to_regclass('public.vote_edge_stale_pairs') IS NOT NULL
     AND (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
            FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.vote_edge_stale_pairs') AND a.attnum > 0 AND NOT a.attisdropped)
         IS DISTINCT FROM 'official_id uuid, bill_proposal_id uuid, captured_at timestamp with time zone'
     OR to_regclass('public.vote_edge_stale_pairs') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = to_regclass('public.vote_edge_stale_pairs') AND contype = 'p'
                        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (official_id, bill_proposal_id)') THEN
    RAISE EXCEPTION '[fix1422] public.vote_edge_stale_pairs exists in another shape — made outside the tree';
  END IF;
  RAISE NOTICE '[fix1422] guard ok: rebuild_entity_connections_votes md5 % before; vote_edge_stale_pairs %',
    v_md5, COALESCE(to_regclass('public.vote_edge_stale_pairs')::text, 'absent');
END $$;

-- ── 1. The queue ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vote_edge_stale_pairs (
  official_id      uuid        NOT NULL,
  bill_proposal_id uuid        NOT NULL,
  captured_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (official_id, bill_proposal_id)
);

ALTER TABLE public.vote_edge_stale_pairs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vote_edge_stale_pairs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.vote_edge_stale_pairs TO service_role;

COMMENT ON TABLE public.vote_edge_stale_pairs IS
  'FIX-1422: the OLD (official_id, bill_proposal_id) of a vote whose pair moved or whose row was deleted, '
  'written by the votes triggers (capture_vote_edge_stale_pair) and consumed by '
  'rebuild_entity_connections_votes(), which retires the old pair''s edge. Rows here between cycles are normal; '
  'nothing is run by hand.';

-- ── 2. The capture ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.capture_vote_edge_stale_pair()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO public.vote_edge_stale_pairs (official_id, bill_proposal_id)
  VALUES (OLD.official_id, OLD.bill_proposal_id)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_vote_edge_stale_pair() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.capture_vote_edge_stale_pair() IS
  'FIX-1422: AFTER UPDATE OF official_id, bill_proposal_id / AFTER DELETE row trigger on public.votes. '
  'Queues the OLD pair in vote_edge_stale_pairs. No EXCEPTION block (a subtransaction per fired row) and '
  'no SET clause (a GUC save/restore per fired row).';

-- ── 3. rebuild_entity_connections_votes() — consumes the queue ───────────────

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
  v_captured             BIGINT;        -- FIX-1422: old pairs consumed from vote_edge_stale_pairs
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
  --
  -- FIX-1422 — and nothing captured: a moved or deleted vote leaves its OLD
  -- pair in vote_edge_stale_pairs, and a delete moves no updated_at.
  IF v_new_max_updated_at <= v_last_indexed_at
     AND NOT EXISTS (SELECT 1 FROM public.vote_edge_stale_pairs) THEN
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

  -- FIX-1422 — the old pairs the votes triggers captured (an official_id or
  -- bill_proposal_id that moved, a row deleted) join the dirty set. The
  -- pair-scoped DELETE below retires their edges; the SELECT re-derives an
  -- edge from any vote still on the pair. Consumed here, so a cycle that
  -- rolls back leaves them queued.
  WITH consumed AS (
    DELETE FROM public.vote_edge_stale_pairs
    RETURNING official_id, bill_proposal_id
  ), added AS (
    INSERT INTO _dirty_vote_keys (official_id, bill_proposal_id)
    SELECT c.official_id, c.bill_proposal_id FROM consumed c
    EXCEPT
    SELECT d.official_id, d.bill_proposal_id FROM _dirty_vote_keys d
    RETURNING 1
  )
  SELECT count(*) INTO v_captured FROM consumed;

  IF v_captured > 0 THEN
    RAISE NOTICE '[votes] FIX-1422: % captured pair(s) consumed into the dirty set', v_captured;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM _dirty_vote_keys) THEN
    -- FIX-1422: forward only (a capture-only cycle leaves it where it was).
    IF v_new_max_updated_at > v_last_indexed_at THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES (
        'entity_connections_votes',
        jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)
      )
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
    END IF;

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

  -- FIX-1422: forward only (a capture-only cycle leaves it where it was).
  IF v_new_max_updated_at > v_last_indexed_at THEN
    INSERT INTO public.pipeline_state (key, value)
    VALUES (
      'entity_connections_votes',
      jsonb_build_object('last_indexed_at', COALESCE(v_new_max_updated_at, v_horizon)::text)
    )
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = NOW();
  END IF;

  connection_type := 'vote_yes';     edges_upserted := v_vote_yes;     RETURN NEXT;
  connection_type := 'vote_no';      edges_upserted := v_vote_no;      RETURN NEXT;
  connection_type := 'vote_abstain'; edges_upserted := v_vote_abstain; RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.rebuild_entity_connections_votes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_entity_connections_votes() TO service_role;

-- ── 4. The triggers — last, so votes' SHARE ROW EXCLUSIVE is held briefly ────

CREATE OR REPLACE TRIGGER votes_capture_stale_pair_update
  AFTER UPDATE OF official_id, bill_proposal_id ON public.votes
  FOR EACH ROW
  WHEN ((OLD.official_id, OLD.bill_proposal_id) IS DISTINCT FROM (NEW.official_id, NEW.bill_proposal_id)
        AND OLD.official_id IS NOT NULL AND OLD.bill_proposal_id IS NOT NULL)
  EXECUTE FUNCTION public.capture_vote_edge_stale_pair();

CREATE OR REPLACE TRIGGER votes_capture_stale_pair_delete
  AFTER DELETE ON public.votes
  FOR EACH ROW
  WHEN (OLD.official_id IS NOT NULL AND OLD.bill_proposal_id IS NOT NULL)
  EXECUTE FUNCTION public.capture_vote_edge_stale_pair();

-- ── 5. read-back — RAISE on any miss ─────────────────────────────────────────

DO $$
DECLARE
  v_arm     oid := 'public.rebuild_entity_connections_votes()'::regprocedure;
  v_cap     oid := 'public.capture_vote_edge_stale_pair()'::regprocedure;
  v_md5     text;
  v_missing text[] := '{}';
  v_trg     text;
  v_rows    bigint;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_arm;
  IF v_md5 IS DISTINCT FROM '76bce60cc492db5465f6c1e1c970de91' THEN
    v_missing := v_missing || format('arm md5 %s (expected 76bce60cc492db5465f6c1e1c970de91)', v_md5);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN (v_arm, v_cap) AND (proconfig IS NOT NULL OR prosecdef)) THEN
    v_missing := v_missing || 'a SET clause or SECURITY DEFINER on the arm or the capture'::text;
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = v_cap) ~* '\mEXCEPTION\M' THEN
    v_missing := v_missing || 'the capture carries an EXCEPTION block'::text;
  END IF;
  IF has_function_privilege('anon', v_arm, 'EXECUTE')
     OR has_function_privilege('authenticated', v_arm, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_arm, 'EXECUTE') THEN
    v_missing := v_missing || 'arm grants (expected anon f / authenticated f / service_role t)'::text;
  END IF;

  SELECT string_agg(t.tgname || ':' || t.tgenabled::text, ', ' ORDER BY t.tgname) INTO v_trg
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.votes'::regclass AND NOT t.tgisinternal
     AND t.tgname IN ('votes_capture_stale_pair_update', 'votes_capture_stale_pair_delete')
     AND t.tgfoid = v_cap;
  IF v_trg IS DISTINCT FROM 'votes_capture_stale_pair_delete:O, votes_capture_stale_pair_update:O' THEN
    v_missing := v_missing || format('triggers %s (expected both, enabled O, on the capture)', v_trg);
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.vote_edge_stale_pairs'::regclass) THEN
    v_missing := v_missing || 'RLS is off on vote_edge_stale_pairs'::text;
  END IF;
  IF has_table_privilege('anon', 'public.vote_edge_stale_pairs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.vote_edge_stale_pairs', 'SELECT')
     OR has_table_privilege('anon', 'public.vote_edge_stale_pairs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.vote_edge_stale_pairs', 'INSERT')
     -- a comma list is true if ANY is held, so one call per privilege
     OR NOT has_table_privilege('service_role', 'public.vote_edge_stale_pairs', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.vote_edge_stale_pairs', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.vote_edge_stale_pairs', 'DELETE') THEN
    v_missing := v_missing || 'table grants (expected anon / authenticated none, service_role SELECT, INSERT, DELETE)'::text;
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1422] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  SELECT count(*) INTO v_rows FROM public.vote_edge_stale_pairs;
  RAISE NOTICE '[fix1422] read-back ok: rebuild_entity_connections_votes md5 %; proconfig NULL on both; no EXCEPTION in the capture; triggers %; vote_edge_stale_pairs RLS on, service_role only, % row(s)',
    v_md5, v_trg, v_rows;
END $$;

COMMIT;
