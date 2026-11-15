-- 20261117000000_fix1409_vote_edge_question_rule.sql
-- FIX-1409 — an official → bill vote edge comes from the member's latest
-- FINAL-class roll on the bill (else an "advance" roll, at half strength),
-- ordered by roll number inside a day; one SQL question rule pinned to
-- passage-questions.json; rebuild_entity_connections_votes_full() becomes a
-- merge (cc-283).
--
-- Design of record: Cowork's FIX-1409 design, D1–D9, ratified by Craig 11-14
-- ("recs good — go on 283"), restated in cc-283's prompt.
--
-- THE FINDING (the clone, 983,626 vote rows; prod 1,019,431 on 11-14).
--   Both arms kept one edge per (official, bill) by
--     DISTINCT ON (official_id, bill_proposal_id)
--     ORDER BY …, voted_at DESC NULLS LAST, id DESC
--   (1) with no question rule, so a cloture, previous-question, recommit or
--   amendment roll could decide the edge; and (2) at random inside a day:
--   voted_at carries a time of day on 46 rows only, so a same-day tie fell to
--   `id`, a uuid. Ordering by the roll number instead changes the deciding
--   roll for 72,788 House and 13,040 Senate pairs on the clone.
--
-- THE RULE (D1–D4, D9).
--   vote_question_class(q): 'final' | 'advance' | 'other', on the question
--   normalised as isPassageQuestion() normalises it. Its literals ARE
--   passage-questions.json's five keys (a test holds them equal as sets):
--     final   = house ∪ senate ∪ nomination ∪ veto_override
--     advance = advance (a yes moves the measure forward)
--   vote_roll_class(q, roll_call_id): the question's class for a FEDERAL roll
--   (`<year>-house-<n>`, `senate-<congress>-<session>-<n>`); 'final' for any
--   other collector's roll (Legistar, a state body), whose questions are not
--   censused. Both are LANGUAGE sql, IMMUTABLE, PARALLEL SAFE, no SET: they
--   inline into the arms' scans.
--   The pick, per (official, bill): the member's final rolls if any, else
--   their advance rolls, else NO edge; inside a tier voted_at DESC, then the
--   roll number (the trailing integer of roll_call_id, NULL when none) DESC,
--   then id DESC. strength 0.500 for a final edge (the old value), 0.250 for
--   an advance edge. No metadata (D5): evidence_ids stays ARRAY[v.id], the
--   deciding vote; occurred_at that roll's date. The tier reads off strength.
--
-- ONE DEFINITION (D6): identical text in both bodies, pinned by
--   fix1409-vote-edge-rule.test.ts — not a view. A DISTINCT ON view is a
--   subquery the planner cannot parameterize: joined to the clone's ten-roll
--   dirty set (2,306 pairs) it built all 507,375 picks first (8.9 s, a 49.7 MB
--   external sort). Reaching votes_derivation_idx through a view needs a
--   LATERAL … OFFSET 0 fence (1.2 s), a planner trick a later edit would undo,
--   and a new relation PostgREST would expose. The shared segment runs from
--   `SELECT DISTINCT ON` to `v.id DESC`; the incremental arm's one extra line
--   pair is its INNER JOIN on _dirty_vote_keys, as before.
--
-- THE MERGE (D7). _votes_full() builds the new set once into a temp table,
--   then, scoped to evidence_source = 'votes' and the three vote types:
--     1. DELETEs the edges whose (official, bill) pair is absent from the set;
--     2. DELETEs the edges whose pair is in the set under another type (the
--        retype: step 4 lays the new row) — never an UPDATE of a key column,
--        so no statement can collide on the unique key;
--     3. UPDATEs the edges equal on the key whose strength, occurred_at or
--        evidence_ids differ (IS DISTINCT FROM), stamping derived_at;
--     4. INSERTs the set rows with no votes edge of their key.
--   A row equal on all four is not written. One NOTICE carries
--   deleted / retyped / updated / inserted / untouched (inserted counts new
--   pairs only; a retyped pair is one row of `retyped`). The signature and the
--   three returned rows are unchanged: each is that type's count in the set,
--   as the delete-all + insert reported it. The watermark write is unchanged.
--   On the clone (cc-283): deleted 10,728 / retyped 33,482 / updated 63,907 /
--   inserted 0 / untouched 410,005 in 31.4 s (a delete-all + insert of the
--   same set: 73.7 s, 1,025,516 rows written); a second call 0 written, 15.9 s.
--   The 10,728 deleted are 9,652 pairs left with only `other` rolls and 1,076
--   edges of 48 Senate officials whose vote rows were re-attributed to 48
--   others on 2026-08-01 (the incremental arm keys its dirty set on a row's
--   NEW pair, so an edge whose pair moved is never retired; only a full pass
--   removes it).
--
-- WHAT IS CUT FROM THE LIVE TEXT. Both bodies are 20260905000100's §3 and §4
--   (clone and prod md5(prosrc) 4e34295b… / 584de460…), every line this
--   change does not touch identical: the watermark read, the horizon clamp,
--   the caught-up returns, _dirty_vote_keys, the pair-scoped DELETE, both
--   watermark writes, the returned rows. No SET clause on either: FIX-1128
--   (20260913000000) RESET their statement_timeout and check:proconfig holds
--   it. Grants restated as 20260905000100 states them.
--
-- NOT ON PROD. cc-283 lands this file on main and does not push it. The prod
--   push and the one supervised _votes_full() merge are the next prompt's.
--   Until then the nightly incremental arm on prod runs the OLD body.
--
-- ROLLBACK: scripts/fix1409-revert-vote-edge-question-rule.sql — the two live
--   bodies verbatim. It drops nothing: vote_question_class() and
--   vote_roll_class() stay (unread by the old bodies).

-- ── 1. vote_question_class(text) — the question's tier ──────────────────────

CREATE OR REPLACE FUNCTION public.vote_question_class(p_vote_question text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE lower(regexp_replace(btrim(coalesce($1, '')), '\s+', ' ', 'g'))
    -- house
    WHEN 'on passage' THEN 'final'
    WHEN 'on passage of the bill' THEN 'final'
    WHEN 'on motion to suspend the rules and pass' THEN 'final'
    WHEN 'on motion to suspend the rules and pass, as amended' THEN 'final'
    WHEN 'on agreeing to the resolution' THEN 'final'
    WHEN 'on agreeing to the resolution, as amended' THEN 'final'
    WHEN 'on motion to suspend the rules and agree' THEN 'final'
    WHEN 'on motion to suspend the rules and agree, as amended' THEN 'final'
    WHEN 'on motion to suspend the rules and agree to the resolution' THEN 'final'
    WHEN 'on motion to suspend the rules and agree to the resolution, as amended' THEN 'final'
    WHEN 'on agreeing to the conference report' THEN 'final'
    WHEN 'on motion to concur in the senate amendment' THEN 'final'
    WHEN 'on motion to concur in the senate amendments' THEN 'final'
    WHEN 'on motion to concur in the senate amendment with an amendment' THEN 'final'
    WHEN 'on motion to suspend the rules and concur in the senate amendment' THEN 'final'
    WHEN 'on motion to suspend the rules and concur in the senate amendments' THEN 'final'
    WHEN 'on concurring in the senate amendments to the house amendment' THEN 'final'
    WHEN 'on concurring in senate amdt with amdt (divisions b,c,f,x,z, titles 2&3 of division n)' THEN 'final'
    WHEN 'on concurring in senate amdt with amdt (remaining divisions)' THEN 'final'
    WHEN 'on motion to concur in the senate adt to the house adt to the senate adt' THEN 'final'
    WHEN 'on motion to suspend the rules and concur in senate adt to house adt to senate adt' THEN 'final'
    -- senate ('on passage of the bill' is listed under house)
    WHEN 'on the joint resolution' THEN 'final'
    WHEN 'on the resolution' THEN 'final'
    WHEN 'on the concurrent resolution' THEN 'final'
    WHEN 'on the conference report' THEN 'final'
    -- nomination
    WHEN 'on the nomination' THEN 'final'
    -- veto_override
    WHEN 'on overriding the veto' THEN 'final'
    WHEN 'passage, objections of the president to the contrary notwithstanding' THEN 'final'
    -- advance
    WHEN 'on the cloture motion' THEN 'advance'
    WHEN 'on cloture on the motion to proceed' THEN 'advance'
    WHEN 'on the motion to proceed' THEN 'advance'
    WHEN 'on the motion to discharge' THEN 'advance'
    WHEN 'on motion to discharge' THEN 'advance'
    ELSE 'other'
  END
$function$;

REVOKE ALL ON FUNCTION public.vote_question_class(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_question_class(text) TO service_role;

COMMENT ON FUNCTION public.vote_question_class(text) IS
  'FIX-1409 — a roll-call question''s tier for the official → bill vote edge: '
  '''final'' (passage-questions.json house ∪ senate ∪ nomination ∪ veto_override), '
  '''advance'' (its advance key: a yes moves the measure forward) or ''other''. '
  'Normalised as isPassageQuestion() normalises (trim, lowercase, whitespace '
  'collapsed). The literals ARE the JSON''s five keys; fix1409-vote-edge-rule.test.ts '
  'holds them equal. LANGUAGE sql IMMUTABLE with no SET, so it inlines. Bill '
  'status does not read it.';

-- ── 2. vote_roll_class(text, text) — D9: only federal rolls are classed ─────

CREATE OR REPLACE FUNCTION public.vote_roll_class(p_vote_question text, p_roll_call_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN $2 ~ '^(?:[0-9]{4}-house|senate-[0-9]+-[0-9]+)-[0-9]+$' THEN public.vote_question_class($1)
    ELSE 'final'
  END
$function$;

REVOKE ALL ON FUNCTION public.vote_roll_class(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_roll_class(text, text) TO service_role;

COMMENT ON FUNCTION public.vote_roll_class(text, text) IS
  'FIX-1409 (D9) — the class of one roll: vote_question_class(question) for a '
  'federal roll (roll_call_id <year>-house-<n> or senate-<congress>-<session>-<n>, '
  'the two shapes votes.ts writes), ''final'' for any other collector''s roll '
  '(Legistar, a state body), whose questions are not censused. TS twin: '
  'voteQuestionClass() in packages/data/src/pipelines/congress/bill-status.ts.';

-- ── 3. rebuild_entity_connections_votes() — the incremental arm ──────────────

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

-- ── 4. rebuild_entity_connections_votes_full() — a merge (D7) ────────────────

CREATE OR REPLACE FUNCTION public.rebuild_entity_connections_votes_full()
 RETURNS TABLE(connection_type text, edges_upserted bigint)
 LANGUAGE plpgsql
AS $function$
#variable_conflict use_column
DECLARE
  v_vote_yes     BIGINT;
  v_vote_no      BIGINT;
  v_vote_abstain BIGINT;
  v_set          BIGINT;   -- FIX-1409: the merge's counts
  v_deleted      BIGINT;
  v_retyped      BIGINT;
  v_updated      BIGINT;
  v_inserted     BIGINT;
BEGIN
  -- FIX-1409 (D7) — the new edge set, built once. Dropped at the end, so a
  -- second call in one transaction can build it again.
  CREATE TEMP TABLE _vote_edge_set (
    from_type       text,
    from_id         uuid,
    to_type         text,
    to_id           uuid,
    connection_type public.connection_type,
    strength        numeric(4,3),
    occurred_at     date,
    evidence_count  integer,
    evidence_source text,
    evidence_ids    uuid[]
  ) ON COMMIT DROP;

  -- FIX-1409 — the edge rule (D1–D4, D9). This SELECT is character-identical
  -- to the incremental arm's but for its INNER JOIN line pair; a test holds it.
  INSERT INTO _vote_edge_set
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
      v.id DESC;

  GET DIAGNOSTICS v_set = ROW_COUNT;
  ANALYZE _vote_edge_set;

  -- 1. A pair absent from the set loses its edge.
  WITH gone AS (
    DELETE FROM public.entity_connections ec
     WHERE ec.connection_type IN ('vote_yes', 'vote_no', 'vote_abstain')
       AND ec.evidence_source = 'votes'
       AND NOT EXISTS (
         SELECT 1 FROM _vote_edge_set s
          WHERE s.from_type = ec.from_type AND s.from_id = ec.from_id
            AND s.to_type = ec.to_type AND s.to_id = ec.to_id)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM gone;

  -- 2. A pair whose type changes: its old row goes here, step 4 lays the new
  --    one. A key column is never UPDATEd, so no statement meets the unique key.
  WITH replaced AS (
    DELETE FROM public.entity_connections ec
     USING _vote_edge_set s
     WHERE ec.connection_type IN ('vote_yes', 'vote_no', 'vote_abstain')
       AND ec.evidence_source = 'votes'
       AND s.from_type = ec.from_type AND s.from_id = ec.from_id
       AND s.to_type = ec.to_type AND s.to_id = ec.to_id
       AND ec.connection_type <> s.connection_type
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_retyped FROM replaced;

  -- 3. Same key, a value moved. A row equal on all four is not written.
  --    derived_at is stamped because ec_arm_source_fingerprint() reads
  --    count(*) + max(derived_at) for the stats arm: a changed row must move
  --    it. It costs HOT (derived_at is indexed), on the changed rows only.
  WITH changed AS (
    UPDATE public.entity_connections ec
       SET strength     = s.strength,
           occurred_at  = s.occurred_at,
           evidence_ids = s.evidence_ids,
           derived_at   = NOW()
      FROM _vote_edge_set s
     WHERE ec.evidence_source = 'votes'
       AND s.from_type = ec.from_type AND s.from_id = ec.from_id
       AND s.to_type = ec.to_type AND s.to_id = ec.to_id
       AND ec.connection_type = s.connection_type
       AND (ec.strength     IS DISTINCT FROM s.strength
         OR ec.occurred_at  IS DISTINCT FROM s.occurred_at
         OR ec.evidence_ids IS DISTINCT FROM s.evidence_ids)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM changed;

  -- 4. The set rows with no votes edge of their key: new pairs and retypes.
  WITH added AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, occurred_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT s.from_type, s.from_id, s.to_type, s.to_id, s.connection_type,
           s.strength, s.occurred_at,
           s.evidence_count, s.evidence_source, s.evidence_ids
      FROM _vote_edge_set s
     WHERE NOT EXISTS (
       SELECT 1 FROM public.entity_connections ec
        WHERE ec.from_type = s.from_type AND ec.from_id = s.from_id
          AND ec.to_type = s.to_type AND ec.to_id = s.to_id
          AND ec.connection_type = s.connection_type
          AND ec.evidence_source = 'votes')
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM added;

  RAISE NOTICE '[votes_full] merge: deleted % / retyped % / updated % / inserted % / untouched %',
    v_deleted, v_retyped, v_updated, v_inserted - v_retyped,
    v_set - v_updated - v_inserted;

  SELECT
    COUNT(*) FILTER (WHERE s.connection_type = 'vote_yes'),
    COUNT(*) FILTER (WHERE s.connection_type = 'vote_no'),
    COUNT(*) FILTER (WHERE s.connection_type = 'vote_abstain')
  INTO v_vote_yes, v_vote_no, v_vote_abstain
  FROM _vote_edge_set s;

  DROP TABLE _vote_edge_set;

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

-- ── 5. Guard ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad text[];
BEGIN
  -- No SET on any of the four (FIX-1128; the two helpers must inline).
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('rebuild_entity_connections_votes', 'rebuild_entity_connections_votes_full',
                      'vote_question_class', 'vote_roll_class')
    AND p.proconfig IS NOT NULL;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[fix1409] routine(s) carry a SET clause: %', v_bad;
  END IF;

  -- The two helpers are inlinable: LANGUAGE sql, IMMUTABLE, PARALLEL SAFE.
  SELECT array_agg(p.proname ORDER BY p.proname) INTO v_bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname IN ('vote_question_class', 'vote_roll_class')
    AND NOT (l.lanname = 'sql' AND p.provolatile = 'i' AND p.proparallel = 's'
             AND NOT p.prosecdef AND NOT p.proisstrict);

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[fix1409] helper(s) cannot inline: %', v_bad;
  END IF;

  -- The rule, one row per branch.
  IF public.vote_roll_class('On Passage', '2026-house-001') IS DISTINCT FROM 'final'
     OR public.vote_roll_class('On the Nomination', 'senate-119-1-00001') IS DISTINCT FROM 'final'
     OR public.vote_roll_class('  On   the Cloture Motion ', 'senate-119-1-00002') IS DISTINCT FROM 'advance'
     OR public.vote_roll_class('On Motion to Recommit', '2026-house-002') IS DISTINCT FROM 'other'
     OR public.vote_roll_class(NULL, '2026-house-003') IS DISTINCT FROM 'other'
     OR public.vote_roll_class('On Motion to Recommit', 'franklin-prop-hb03-passage') IS DISTINCT FROM 'final'
     OR public.vote_roll_class(NULL, '12345') IS DISTINCT FROM 'final' THEN
    RAISE EXCEPTION '[fix1409] vote_roll_class() disagrees with the rule';
  END IF;

  RAISE NOTICE '[fix1409] vote edges: final, else advance at 0.250, by roll number inside a day; _votes_full() merges';
END $$;
