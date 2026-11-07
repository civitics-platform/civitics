-- =============================================================================
-- FIX-1382 (cc-263) ROLLBACK — contract_flow_rollups_rebuild's converted cadence
-- row back to FIX-1311's cutover hold (data only).
--
-- The mirror of supabase/migrations/20261106000000_fix1382_convert_contract_flow_
-- rollups_refresh_hold_cadence_168.sql. NOT a migration: a payload for the
-- --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod --file scripts/fix1382-revert-convert-contract-flow-hold.sql
--
-- What it does, ONLY while the row still carries a FIX-1382 note (a later hand
-- on that row is a human's to resolve):
--   held_since    = now()  (the revert's instant; FIX-1311's 10-13 instant
--                           differs per environment — prod 23:32:42Z, the clone
--                           23:22:10Z — so it is not restored)
--   hold_reason   = FIX-1311's text, byte-for-byte
--   cadence_hours = NULL
--   note          = the note the row carried before the conversion,
--                   byte-for-byte (FIX-1311's text + FIX-1371's RETURN
--                   appendix, asserted by md5 below; prod = clone, cc-263 read 4:
--                   e244409743016116d42147d29c4d9744)
--
-- What it does NOT do: touch job_registry (the row stays RETURNed; the
-- dispatcher keeps owning the job), un-park cron jobid 28, or revert FIX-1338's
-- body (that is fix978's CREATE OR REPLACE, re-applied by hand).
--
-- Idempotent: a second run NOTICEs 0 rows and changes nothing.
-- =============================================================================

DO $$
DECLARE
  c_pipeline CONSTANT text := 'contract_flow_rollups_rebuild';
  c_reason   CONSTANT text := 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';
  c_note     CONSTANT text := 'FIX-1311 (cc-232) — pg_cron contract-flow-rollups-refresh parked (active = false) by migration 20261013230000 for the dispatcher cutover. '
                              'Returns only through a job_registry row with a deadline rule; that return deletes this row. '
                              'Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.'
                              '; contract-flow-rollups-refresh RETURNED 2026-11-01 (FIX-1371) — hold kept, conversion to cadence_hours 168 owed after the Thu 11-05 slot';
  c_note_md5 CONSTANT text := 'e244409743016116d42147d29c4d9744';
  v_n        int;
BEGIN
  IF md5(c_note) IS DISTINCT FROM c_note_md5 THEN
    RAISE EXCEPTION '[fix1382-revert] % restore text md5 % ≠ the pre-conversion note''s %', c_pipeline, md5(c_note), c_note_md5;
  END IF;
  UPDATE public.rollup_watch_overrides
     SET held_since    = now(),
         hold_reason   = c_reason,
         cadence_hours = NULL,
         note          = c_note,
         updated_at    = now()
   WHERE pipeline = c_pipeline
     AND note LIKE 'FIX-1382 (cc-263)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1382-revert] rollup_watch_overrides % → FIX-1311''s cutover hold: % row(s)', c_pipeline, v_n;
END $$;
