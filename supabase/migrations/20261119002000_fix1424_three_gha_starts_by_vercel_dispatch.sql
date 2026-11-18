-- =============================================================================
-- FIX-1424 — irs990, the weekly audit and crs-summaries START by a Vercel-fired
-- dispatch, not GitHub's `schedule:` (cc-292, file C of three; A = FIX-1421's
-- reap close, B = FIX-1423's ec-crawl cadence). The registry half: three rows.
-- The other half rides the same commit: the allowlist in
-- apps/civitics/src/lib/gha-dispatch.ts, three crons in apps/civitics/vercel.json,
-- and the `schedule:` block removed from each workflow (no late fallback: a
-- second start hours later is what this fixes). FIX-1218's shape, as
-- nightly.yml / sync-canary-check.yml / platform-snapshot.yml already run.
--
-- WHY (cc-292 read 6, gh run list). GitHub started each one hours late:
--   irs990        0 15 * * 1 → 11-02 23:02Z, 11-09 23:44Z, 11-16 23:38Z — the
--                 last inside the post-landing pass's ecs windows; it died on
--                 its first read (officials load: statement timeout).
--   audit         0 4 * * 1  → 10-26 09:44Z, 11-02 11:59Z, 11-09 12:32Z,
--                 11-16 12:26Z — the last inside the stall, cancelled at its
--                 30 min timeout: there is no 11-16 report in docs/audits/.
--   crs-summaries 0 10 * * 6 → 10-24 13:44Z … 11-14 16:14Z; a 350-min run
--                 started at 16:14Z ends 22:04Z, past the 21:00Z nightly.
--
-- THE SLOTS:
--   irs990        at 0 15 * * 1 → at 0 15 * * 2 (Tuesday 15:00Z: after
--                 Sunday's fec_bulk, the ordering irs990.yml calls
--                 load-bearing, and after the pass — 11-16's closed Tue 01:37Z)
--   audit         at 0 4 * * 1  → at 0 17 * * 2 (Tuesday 17:00Z, two hours
--                 behind irs990; the housekeep bot is Monday 10:00Z)
--   crs-summaries at 0 10 * * 6 kept — on time, a 350-min run ends by 15:50Z
-- unit_call gha:<file> → gha-dispatch:<stem> for all three (the stem is the
-- FILE's: the audit's workflow NAME is weekly-integrity-audit). Each START is a
-- plain Vercel dispatch, like sync-canary-check's — NOT a dispatcher request
-- stamp: the rows stay `at …`, so the pick never loops them and step 3b never
-- reaps them (a one-row pipeline would read `failed: GHA (no phase)`). Gating
-- them through the tick is a later plan step (docs/cc/projects/dispatcher.md).
--
-- ROLLBACK: scripts/fix1424-revert-gha-dispatch-starts.sql (the rows back,
-- matched on the new text) — with the app half reverted in the same breath
-- (the allowlist entries, the three crons, the `schedule:` blocks), or the
-- workflows have no start at all.
--
-- IDEMPOTENT: each row matched on its exact old rule AND unit_call; one already
-- on its new text NOTICEs, 0 rows; anything else RAISEs.
-- =============================================================================

DO $$
DECLARE
  v     record;
  v_n   int;
  v_cur record;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('irs990',        'at 0 15 * * 1', 'gha:irs990.yml',        'at 0 15 * * 2', 'gha-dispatch:irs990',
       '; cc-292 (FIX-1424): START by Vercel dispatch (/api/cron/gha-dispatch/irs990, 0 15 * * 2) — GitHub''s schedule: started it 8–9 h late (11-16 23:38Z, inside the post-landing pass); Tuesday still follows Sunday''s fec_bulk'),
      ('audit',         'at 0 4 * * 1',  'gha:audit.yml',         'at 0 17 * * 2', 'gha-dispatch:audit',
       '; cc-292 (FIX-1424): START by Vercel dispatch (/api/cron/gha-dispatch/audit, 0 17 * * 2) — Monday 04:00Z ran 6–8 h late into the post-landing stall (11-16 cancelled, no report); Tuesday 17:00Z is after the pass'),
      ('crs-summaries', 'at 0 10 * * 6', 'gha:crs-summaries.yml', 'at 0 10 * * 6', 'gha-dispatch:crs-summaries',
       '; cc-292 (FIX-1424): START by Vercel dispatch (/api/cron/gha-dispatch/crs-summaries, 0 10 * * 6, the slot kept) — GitHub started it 3.7–6.2 h late; on time a 350-min run ends by 15:50Z')
    ) AS v(job, was_rule, was_call, now_rule, now_call, note_add)
  LOOP
    UPDATE public.job_registry
       SET deadline_rule = v.now_rule,
           unit_call     = v.now_call,
           note          = note || v.note_add,
           updated_at    = now()
     WHERE job = v.job AND deadline_rule = v.was_rule AND unit_call = v.was_call;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
      RAISE NOTICE '[fix1424] %: % / % → % / % (1 row)', v.job, v.was_rule, v.was_call, v.now_rule, v.now_call;
    ELSE
      SELECT deadline_rule, unit_call INTO v_cur FROM public.job_registry WHERE job = v.job;
      IF NOT FOUND THEN
        RAISE EXCEPTION '[fix1424] job_registry has no row %', v.job;
      ELSIF v_cur.deadline_rule = v.now_rule AND v_cur.unit_call = v.now_call THEN
        RAISE NOTICE '[fix1424] % already % / % — 0 rows', v.job, v.now_rule, v.now_call;
      ELSE
        RAISE EXCEPTION '[fix1424] % reads % / %, expected % / % (or % / %)',
          v.job, v_cur.deadline_rule, v_cur.unit_call, v.was_rule, v.was_call, v.now_rule, v.now_call;
      END IF;
    END IF;
  END LOOP;
END $$;

-- read-back — RAISE on any miss
DO $$
DECLARE
  v_missing text[] := '{}';
  v_got     text;
BEGIN
  SELECT string_agg(job || ' ' || runner || ' ' || deadline_rule || ' ' || unit_call, ' | ' ORDER BY job) INTO v_got
    FROM public.job_registry WHERE job IN ('irs990', 'audit', 'crs-summaries');
  IF v_got IS DISTINCT FROM
     'audit github_actions at 0 17 * * 2 gha-dispatch:audit | crs-summaries github_actions at 0 10 * * 6 gha-dispatch:crs-summaries | irs990 github_actions at 0 15 * * 2 gha-dispatch:irs990' THEN
    v_missing := v_missing || format('the three rows read %L', v_got)::text;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_registry WHERE job IN ('irs990', 'audit', 'crs-summaries')
                AND (note NOT LIKE '%; cc-292 (FIX-1424): START by Vercel dispatch%'
                     OR note LIKE '%; cc-292 (FIX-1424): %; cc-292 (FIX-1424): %')) THEN
    v_missing := v_missing || 'a note does not carry the cc-292 clause exactly once'::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1424] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1424] read-back ok: %', v_got;
END $$;
