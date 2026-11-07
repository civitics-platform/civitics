-- =============================================================================
-- FIX-1383 (cc-263) ROLLBACK — the converted sweep cadence rows back to
-- FIX-1311's cutover hold (data only).
--
-- The mirror of supabase/migrations/20261107000000_fix1383_convert_five_monthly_
-- sweeps_hold_cadence_744.sql. NOT a migration: a payload for the --call path,
-- run under a FIX-950 claim:
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod --file scripts/fix1383-revert-convert-five-sweeps-holds.sql
--
-- What it does, per row, ONLY while the row still carries a FIX-1383 note (a
-- later hand on that row is a human's to resolve):
--   held_since    = now()  (the revert's instant; FIX-1311's 10-13 instant
--                           differs per environment, so it is not restored)
--   hold_reason   = FIX-1311's text, byte-for-byte
--   cadence_hours = NULL
--   note          = the note the row carried before the conversion,
--                   byte-for-byte on PROD (FIX-1311's text + FIX-1374's RETURN
--                   appendix, asserted by md5 below, read after push 1's
--                   read-back). The appendix carries the UTC date of the apply:
--                   2026-11-07 on prod, 2026-11-02 on the clone.
--
-- What it does NOT do: touch job_registry (the rows stay RETURNed; the
-- dispatcher keeps owning the jobs) or un-park a cron.
--
-- Idempotent: a second run NOTICEs 0 rows and changes nothing.
-- =============================================================================

DO $$
DECLARE
  c_reason CONSTANT text := 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';
  r        record;
  v_n      int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('donation_edge_orphan_sweep',
       'FIX-1311 (cc-232) — pg_cron donation-edge-orphan-sweep parked (active = false) by migration 20261013230000 for the dispatcher cutover. Returns only through a job_registry row with a deadline rule; that return deletes this row. Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.; donation-edge-orphan-sweep RETURNED 2026-11-07 (FIX-1374) — hold kept, conversion to cadence_hours 744 owed (cc-259)',
       '3a15dbd19f239e2227bd15c8f8b077c1'),
      ('financial_entity_totals_reconcile',
       'FIX-1311 (cc-232) — pg_cron financial-entity-totals-reconcile parked (active = false) by migration 20261013230000 for the dispatcher cutover. Returns only through a job_registry row with a deadline rule; that return deletes this row. Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.; financial-entity-totals-reconcile RETURNED 2026-11-07 (FIX-1374) — hold kept, conversion to cadence_hours 744 owed (cc-259)',
       'c42acc47de09a7193acd23a6113bf176'),
      ('donor_rollup_orphan_sweep',
       'FIX-1311 (cc-232) — pg_cron donor-rollup-orphan-sweep parked (active = false) by migration 20261013230000 for the dispatcher cutover. Returns only through a job_registry row with a deadline rule; that return deletes this row. Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.; donor-rollup-orphan-sweep RETURNED 2026-11-07 (FIX-1374) — hold kept, conversion to cadence_hours 744 owed (cc-259)',
       'db7d506a714da4d5e580db8f4aebffad'),
      ('donor_party_rollup_orphan_sweep',
       'FIX-1311 (cc-232) — pg_cron donor-party-rollup-orphan-sweep parked (active = false) by migration 20261013230000 for the dispatcher cutover. Returns only through a job_registry row with a deadline rule; that return deletes this row. Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.; donor-party-rollup-orphan-sweep RETURNED 2026-11-07 (FIX-1374) — hold kept, conversion to cadence_hours 744 owed (cc-259)',
       '0b7f31ed835e71e27fdf8cea6fcc266a'),
      ('entity_connection_stats_orphan_sweep',
       'FIX-1311 (cc-232) — pg_cron entity-connection-stats-orphan-sweep parked (active = false) by migration 20261013230000 for the dispatcher cutover. Returns only through a job_registry row with a deadline rule; that return deletes this row. Rollback: scripts/fix1311-unpark-derived-layer-crons.sql.; entity-connection-stats-orphan-sweep RETURNED 2026-11-07 (FIX-1374) — hold kept, conversion to cadence_hours 744 owed (cc-259)',
       'eb7847f437b9511cb8fe917b3c0d4c78')
    ) AS t(pipeline, note, note_md5)
  LOOP
    IF md5(r.note) IS DISTINCT FROM r.note_md5 THEN
      RAISE EXCEPTION '[fix1383-revert] % restore text md5 % ≠ the pre-conversion note''s %', r.pipeline, md5(r.note), r.note_md5;
    END IF;
    UPDATE public.rollup_watch_overrides
       SET held_since    = now(),
           hold_reason   = c_reason,
           cadence_hours = NULL,
           note          = r.note,
           updated_at    = now()
     WHERE pipeline = r.pipeline
       AND note LIKE 'FIX-1383 (cc-263)%';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[fix1383-revert] rollup_watch_overrides % → FIX-1311''s cutover hold: % row(s)', r.pipeline, v_n;
  END LOOP;
END $$;
