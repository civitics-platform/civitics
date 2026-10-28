-- FIX-1358 — fe-vacuum-analyze phase_lock false (cc-252).
--
-- WHAT. One row, one column: job_registry fe-vacuum-analyze phase_lock
-- true → false. Its deadline_rule (dead_tuples > 60% of trigger + floor
-- 24 hours), gates and everything else stay. ec-vacuum-analyze keeps its lock.
--
-- WHY — rule 371's mechanism. financial_entities has a THIRD VACUUM owner
-- besides autovacuum and this row: the nightly fec phase's FIX-943
-- vacuum-tail after rebuild_financial_entity_ie_totals (45–97 s) re-anchors
-- last_vacuum ~22:53Z on every night that reaches the IE rebuild (cc-249). So
-- the dispatched floor is a FALLBACK, meant to fire only when 24 h pass with no
-- VACUUM at all. FIX-1323's phase lock (D-b) engages on the first FLOOR arm:
-- the arm writes phase_due_at, and from then on the row's due is
-- phase_due_at + 24 h whatever last_vacuum says. One missed tail therefore
-- ratchets fe onto a locked daily slot beside the tail — a daily double VACUUM
-- of a 245k-page heap on the nights the tail runs.
--
-- IT ALREADY ENGAGED (cc-252 read 7). The fec phase ended at ~21:10Z on both
-- Mon 10-26 and Tue 10-27 (no IE rebuild, no tail), so fe's floor came due:
--   Mon 10-26 22:55:00.19Z armed (dispatch_log 9122, → -00:01:23), reaped
--     22:59:00Z succeeded: VACUUM — the first FLOOR arm; the lock engaged
--   Tue 10-27 22:55:00.24Z armed on the LOCKED slot (9905), reaped 22:59:00Z
--   phase_due_at = 2026-10-27 22:53:36.940046+00 (written by that arm)
-- Without the lock Tuesday's due was last_vacuum 22:58:27Z + 24 h; with it,
-- 22:53:36.94Z + 24 h. No double VACUUM yet, because no tail ran either night.
--
-- phase_due_at IS LEFT AS IT IS (the prompt: say, don't touch). It is inert
-- once phase_lock is false: dispatch_one_unit reads it only under
-- `IF r.phase_lock AND r.phase_due_at IS NOT NULL` (20261027000000, the pick;
-- v_locked resets false per row), and the row's next arm writes it NULL
-- (`phase_due_at = CASE WHEN v_pick_lock AND … END`, written only on change).
-- So no manual NULL is needed.
--
-- NETS. scripts/fix1358-revert-fe-phase-lock.sql sets it back to true.
-- IDEMPOTENT. Matched on phase_lock = true; 0 rows with the row already false
-- is a NOTICE, anything else RAISEs.

DO $$
DECLARE
  v_n    int;
  v_lock boolean;
BEGIN
  UPDATE public.job_registry
     SET phase_lock = false,
         note       = note || '; phase_lock false 2026-10-28 (FIX-1358, cc-252): the fec phase''s vacuum-tail is the third owner; the floor is a fallback, never a slot',
         updated_at = now()
   WHERE job = 'fe-vacuum-analyze'
     AND phase_lock = true;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1358] fe-vacuum-analyze phase_lock true → false (1 row)';
  ELSE
    SELECT j.phase_lock INTO v_lock FROM public.job_registry j WHERE j.job = 'fe-vacuum-analyze';
    IF v_lock IS FALSE THEN
      RAISE NOTICE '[fix1358] fe-vacuum-analyze already phase_lock false — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1358] fe-vacuum-analyze phase_lock reads % — the row is missing or moved', v_lock;
    END IF;
  END IF;
END $$;

-- Read-back: fe false, ec still true, both deadline_rules unchanged.
DO $$
DECLARE
  v_fe record;
  v_ec record;
BEGIN
  SELECT phase_lock, deadline_rule, phase_due_at INTO v_fe FROM public.job_registry WHERE job = 'fe-vacuum-analyze';
  SELECT phase_lock, deadline_rule, phase_due_at INTO v_ec FROM public.job_registry WHERE job = 'ec-vacuum-analyze';
  IF v_fe.phase_lock IS DISTINCT FROM false
     OR v_fe.deadline_rule IS DISTINCT FROM 'dead_tuples > 60% of trigger + floor 24 hours' THEN
    RAISE EXCEPTION '[fix1358] read-back failed: fe-vacuum-analyze %', row_to_json(v_fe);
  END IF;
  IF v_ec.phase_lock IS DISTINCT FROM true
     OR v_ec.deadline_rule IS DISTINCT FROM 'dead_tuples > 60% of trigger + floor 24 hours' THEN
    RAISE EXCEPTION '[fix1358] read-back failed: ec-vacuum-analyze %', row_to_json(v_ec);
  END IF;
  RAISE NOTICE '[fix1358] read-back ok: fe-vacuum-analyze phase_lock false (phase_due_at % — inert, NULLed by its next arm); ec-vacuum-analyze phase_lock true (phase_due_at %)',
    COALESCE(v_fe.phase_due_at::text, 'NULL'), COALESCE(v_ec.phase_due_at::text, 'NULL');
  IF v_fe.phase_due_at IS NOT NULL THEN
    RAISE NOTICE '[fix1358] the lock was already engaged: fe armed on its floor Mon 10-26 and on the locked slot Tue 10-27 (cc-252 read 7)';
  END IF;
END $$;
