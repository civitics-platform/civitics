-- =============================================================================
-- FIX-1424 (cc-292) ROLLBACK — irs990, audit and crs-summaries back to their
-- GitHub-schedule registry rows (data only).
--
-- The mirror of
-- supabase/migrations/20261119002000_fix1424_three_gha_starts_by_vercel_dispatch.sql.
-- NOT a migration: a payload for --call (or the gated class-P path):
--
--   node scripts/db-query.mjs --prod --call --yes-i-mean-prod \
--     --file scripts/fix1424-revert-gha-dispatch-starts.sql
--
-- WORKING ORDER: revert the app half FIRST in one deploy — the three allowlist
-- entries in apps/civitics/src/lib/gha-dispatch.ts, the three crons in
-- apps/civitics/vercel.json, and each workflow's `schedule:` block restored
-- (irs990 0 15 * * 1, audit 0 4 * * 1, crs-summaries 0 10 * * 6) — then this
-- file. The rows are the catalog; the dispatcher never loops an `at` row, so
-- the order between the two halves moves no run.
--
-- Matched on the NEW text, so a row already back is left alone; each note's
-- cc-292 clause is taken off.
--
-- Idempotent: a second run NOTICEs and changes nothing.
-- =============================================================================

DO $$
DECLARE
  v     record;
  v_n   int;
  v_cur record;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('irs990',        'at 0 15 * * 2', 'gha-dispatch:irs990',        'at 0 15 * * 1', 'gha:irs990.yml',
       '; cc-292 (FIX-1424): START by Vercel dispatch (/api/cron/gha-dispatch/irs990, 0 15 * * 2) — GitHub''s schedule: started it 8–9 h late (11-16 23:38Z, inside the post-landing pass); Tuesday still follows Sunday''s fec_bulk'),
      ('audit',         'at 0 17 * * 2', 'gha-dispatch:audit',         'at 0 4 * * 1',  'gha:audit.yml',
       '; cc-292 (FIX-1424): START by Vercel dispatch (/api/cron/gha-dispatch/audit, 0 17 * * 2) — Monday 04:00Z ran 6–8 h late into the post-landing stall (11-16 cancelled, no report); Tuesday 17:00Z is after the pass'),
      ('crs-summaries', 'at 0 10 * * 6', 'gha-dispatch:crs-summaries', 'at 0 10 * * 6', 'gha:crs-summaries.yml',
       '; cc-292 (FIX-1424): START by Vercel dispatch (/api/cron/gha-dispatch/crs-summaries, 0 10 * * 6, the slot kept) — GitHub started it 3.7–6.2 h late; on time a 350-min run ends by 15:50Z')
    ) AS v(job, now_rule, now_call, was_rule, was_call, note_add)
  LOOP
    UPDATE public.job_registry
       SET deadline_rule = v.was_rule,
           unit_call     = v.was_call,
           note          = replace(note, v.note_add, ''),
           updated_at    = now()
     WHERE job = v.job AND deadline_rule = v.now_rule AND unit_call = v.now_call;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
      RAISE NOTICE '[fix1424-revert] %: % / % → % / % (1 row)', v.job, v.now_rule, v.now_call, v.was_rule, v.was_call;
    ELSE
      SELECT deadline_rule, unit_call INTO v_cur FROM public.job_registry WHERE job = v.job;
      IF v_cur.deadline_rule = v.was_rule AND v_cur.unit_call = v.was_call THEN
        RAISE NOTICE '[fix1424-revert] % already % / % — 0 rows', v.job, v.was_rule, v.was_call;
      ELSE
        RAISE EXCEPTION '[fix1424-revert] % reads % / %, expected % / %', v.job, v_cur.deadline_rule, v_cur.unit_call, v.now_rule, v.now_call;
      END IF;
    END IF;
  END LOOP;
END $$;
