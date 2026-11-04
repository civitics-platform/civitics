-- =============================================================================
-- FIX-1378 (cc-259) ROLLBACK — the four converted cadence rows back to
-- FIX-1311's cutover hold (data only).
--
-- The mirror of the conversions in supabase/migrations/20261104001000_… →
-- 20261104004000_fix1378_convert_*.sql. NOT a migration: a payload for the
-- --call path, run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1378-revert-convert-cutover-holds.sql
--
-- What it does, per row, ONLY while the row still carries a FIX-1378 note (a
-- later hand on that row is a human's to resolve):
--   held_since    = now()  (the revert's instant; FIX-1311's 10-13 instant
--                           differs per environment, so it is not restored)
--   hold_reason   = FIX-1311's text, byte-for-byte
--   cadence_hours = NULL
--   note          = the note the row carried before the conversion,
--                   byte-for-byte (FIX-1311's text + its RETURN appendix,
--                   asserted by md5 below; prod = clone, cc-259 read)
--
-- What it does NOT do: touch job_registry (the rows stay RETURNed; the
-- dispatcher keeps owning the jobs), un-park a cron, or revert FIX-1338's body
-- (that is fix978's CREATE OR REPLACE, re-applied by hand).
--
-- Idempotent: a second run NOTICEs 0 rows ×4 and changes nothing.
-- =============================================================================

DO $$
DECLARE
  c_reason CONSTANT text := 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';
  c_base   CONSTANT text := ' parked (active = false) by migration 20261013230000 for the dispatcher cutover. '
                            'Returns only through a job_registry row with a deadline rule; that return deletes this row. '
                            'Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.';
  r        record;
  v_n      int;
  v_md5    text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('run_rule_taggers',
       'FIX-1311 (cc-232) — pg_cron rule-taggers-daily + rule-taggers-weekly' || c_base,
       'b5f50c7b92492ff4adc797a7b5501a5c'),
      ('donor_party_rollup_refresh',
       'FIX-1311 (cc-232) — pg_cron donor-party-rollup-refresh' || c_base
         || '; donor-party RETURNED 2026-10-30 (FIX-1365) — hold kept, conversion to cadence_hours 168 owed with the catch-up receipt',
       '52c9937f9a54df553b41e162be301d7d'),
      ('treemap_individuals_global_refresh',
       'FIX-1311 (cc-232) — pg_cron treemap-individuals-global-refresh' || c_base
         || '; treemap-individuals-global-refresh RETURNED 2026-10-31 (FIX-1368) — hold kept, conversion to cadence_hours 168 owed (cc-259)',
       'ba0b81de306033426a8d0bc20747a491'),
      ('agency_staffing_rollup_refresh',
       'FIX-1311 (cc-232) — pg_cron agency-staffing-rollup-refresh' || c_base
         || '; agency-staffing-rollup-refresh RETURNED 2026-10-31 (FIX-1369) — hold kept, conversion to cadence_hours 168 owed (cc-259)',
       '0986fa9600678ef0ebcf8e7aa5d7cb04')
    ) AS t(pipeline, note, note_md5)
  LOOP
    IF md5(r.note) IS DISTINCT FROM r.note_md5 THEN
      RAISE EXCEPTION '[fix1378-revert] % restore text md5 % ≠ the pre-conversion note''s %', r.pipeline, md5(r.note), r.note_md5;
    END IF;
    UPDATE public.rollup_watch_overrides
       SET held_since    = now(),
           hold_reason   = c_reason,
           cadence_hours = NULL,
           note          = r.note,
           updated_at    = now()
     WHERE pipeline = r.pipeline
       AND note LIKE 'FIX-1378 (cc-259)%';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[fix1378-revert] rollup_watch_overrides % → FIX-1311''s cutover hold: % row(s)', r.pipeline, v_n;
  END LOOP;
END $$;
