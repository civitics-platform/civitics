-- =============================================================================
-- FIX-1452 — proposal_actions gets a key that cannot collide (cc-327 D4, one
-- class-P file: DDL on an EMPTY table, no rewrite, no data).
--
-- THE FINDING (cc-327 read 3, the congress.gov action lists of HR 1 and SJRES
-- 55 / 18 of the 119th and HR 21 of the 118th). The table's only unique key,
-- (proposal_id, action_type, action_at), merges real actions on every list:
-- HR 1 35 rows in 6 groups, SJRES 55 18 in 2, SJRES 18 13 in 6, 118-HR-21 5 in
-- 2. Senate floor actions carry no time, no action code and no source-system
-- code, so a day's motions differ only by their text; and the Library of
-- Congress lists "Became Public Law" and "Signed by President" under one type,
-- one code and one date.
--
-- THE KEY. source_key is the walker's hash of the action's own fields (source
-- system, action code, date, time, whitespace-collapsed text —
-- packages/data/src/pipelines/congress/bill-details-parse.ts actionSourceKey):
-- zero collisions on the same four lists. Unique per (proposal_id, source,
-- source_key), so a second source keys its own rows. NOT NULL: the table is
-- empty (the guard below) and the walker is its only writer, so a NULL key
-- would only ever be a row that escapes the uniqueness.
--
-- The guard refuses when the table holds any row (cc-327's STOP row: prod read
-- 1 read 0 rows, 2026-11-26 04:28Z). The promotion and merge routines that
-- re-point proposal_actions.performed_by_id are not touched.
-- =============================================================================

SET lock_timeout = '5s';

DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.proposal_actions;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'FIX-1452: public.proposal_actions holds % row(s); this file re-keys an EMPTY table only — STOP and read who wrote them', v_n;
  END IF;
END $$;

ALTER TABLE public.proposal_actions
  ADD COLUMN source_key text NOT NULL;

COMMENT ON COLUMN public.proposal_actions.source_key IS
  'FIX-1452: the source''s own identity for the action — for congress_gov, md5 of (source system, action code, date, time, text). Unique per (proposal_id, source, source_key).';

ALTER TABLE public.proposal_actions
  DROP CONSTRAINT proposal_actions_proposal_id_action_type_action_at_key;

ALTER TABLE public.proposal_actions
  ADD CONSTRAINT proposal_actions_proposal_id_source_source_key_key
  UNIQUE (proposal_id, source, source_key);

RESET lock_timeout;

-- ── read-back ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_new  text;
  v_old  boolean;
  v_col  text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_new
    FROM pg_constraint
   WHERE conrelid = 'public.proposal_actions'::regclass
     AND conname  = 'proposal_actions_proposal_id_source_source_key_key';
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.proposal_actions'::regclass
       AND conname  = 'proposal_actions_proposal_id_action_type_action_at_key'
  ) INTO v_old;
  SELECT data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'proposal_actions' AND column_name = 'source_key';
  IF v_new IS NULL OR v_old OR v_col IS DISTINCT FROM 'text NOT NULL' THEN
    RAISE EXCEPTION 'FIX-1452 read-back: new=% old_still_present=% source_key=%', v_new, v_old, v_col;
  END IF;
  RAISE NOTICE 'FIX-1452 read-back: % ; old (proposal_id, action_type, action_at) key gone ; source_key %', v_new, v_col;
END $$;
