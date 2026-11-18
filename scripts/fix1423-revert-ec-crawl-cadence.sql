-- =============================================================================
-- FIX-1423 (cc-292) ROLLBACK — ec-crawl back to `stale_after 10 minutes`.
--
-- The mirror of
-- supabase/migrations/20261119001000_fix1423_ec_crawl_stale_after_25_minutes.sql.
-- NOT a migration: a payload for --call (or the gated class-P path):
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1423-revert-ec-crawl-cadence.sql
--
-- No pause needed: the tick reads the row each time it runs, and an armed or
-- running unit is unaffected. Matched on the NEW text, so a row already back on
-- 10 is left alone; the note's cc-292 clause is taken off.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v_n    int;
  v_rule text;
BEGIN
  UPDATE public.job_registry
     SET deadline_rule = 'stale_after 10 minutes',
         note          = replace(note, '; cc-292 (FIX-1423): 25 minutes from 10 — the post-landing pass', ''),
         updated_at    = now()
   WHERE job = 'ec-crawl'
     AND deadline_rule = 'stale_after 25 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1423-revert] ec-crawl: stale_after 25 minutes → 10 minutes (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'ec-crawl';
    IF v_rule = 'stale_after 10 minutes' THEN
      RAISE NOTICE '[fix1423-revert] ec-crawl already stale_after 10 minutes — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1423-revert] ec-crawl deadline_rule = %, expected stale_after 25 minutes (or 10)', v_rule;
    END IF;
  END IF;
END $$;
