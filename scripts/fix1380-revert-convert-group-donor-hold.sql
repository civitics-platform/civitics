-- =============================================================================
-- FIX-1380 (cc-255) ROLLBACK — group_donor_rollup_refresh's converted cadence
-- row back to FIX-1311's cutover hold (data only).
--
-- The mirror of supabase/migrations/20261104006000_fix1380_convert_group_donor_
-- rollup_refresh_hold_cadence_168.sql. NOT a migration: a payload for the
-- --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod --file scripts/fix1380-revert-convert-group-donor-hold.sql
--
-- What it does, ONLY while the row still carries a FIX-1380 note (a later hand
-- on that row is a human's to resolve):
--   held_since    = now()  (the revert's instant; FIX-1311's 10-13 instant
--                           differs per environment — prod 23:32:42Z, the clone
--                           23:22:10Z — so it is not restored)
--   hold_reason   = FIX-1311's text, byte-for-byte
--   cadence_hours = NULL
--   note          = the note the row carried before the conversion,
--                   byte-for-byte (FIX-1311's text + FIX-1370's RETURN
--                   appendix, asserted by md5 below; prod = clone, cc-255 read 7:
--                   e67f34916a2e78870b90b4528f2ed7a9)
--
-- What it does NOT do: touch job_registry (the row stays RETURNed; the
-- dispatcher keeps owning the job), un-park cron jobid 49, or revert FIX-1338's
-- body (that is fix978's CREATE OR REPLACE, re-applied by hand).
--
-- Idempotent: a second run NOTICEs 0 rows and changes nothing.
-- =============================================================================

DO $$
DECLARE
  c_pipeline CONSTANT text := 'group_donor_rollup_refresh';
  c_reason   CONSTANT text := 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';
  c_note     CONSTANT text := 'FIX-1311 (cc-232) — pg_cron group-donor-rollup-refresh parked (active = false) by migration 20261013230000 for the dispatcher cutover. '
                              'Returns only through a job_registry row with a deadline rule; that return deletes this row. '
                              'Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.'
                              '; group-donor-rollup-refresh RETURNED 2026-10-31 (FIX-1370) — hold kept, conversion to cadence_hours 168 owed (cc-259)';
  c_note_md5 CONSTANT text := 'e67f34916a2e78870b90b4528f2ed7a9';
  v_n        int;
BEGIN
  IF md5(c_note) IS DISTINCT FROM c_note_md5 THEN
    RAISE EXCEPTION '[fix1380-revert] % restore text md5 % ≠ the pre-conversion note''s %', c_pipeline, md5(c_note), c_note_md5;
  END IF;
  UPDATE public.rollup_watch_overrides
     SET held_since    = now(),
         hold_reason   = c_reason,
         cadence_hours = NULL,
         note          = c_note,
         updated_at    = now()
   WHERE pipeline = c_pipeline
     AND note LIKE 'FIX-1380 (cc-255)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1380-revert] rollup_watch_overrides % → FIX-1311''s cutover hold: % row(s)', c_pipeline, v_n;
END $$;
