-- =============================================================================
-- FIX-1378 (1 of 4) — the shared run_rule_taggers hold row CONVERTS to
-- cadence_hours 24, gated in SQL on FIX-1338's verdict. cc-259, 2026-11-04.
--
-- NEEDS 20261104000000_fix1338_rate_regression_work_done_denominator.sql (the
-- same push, first). `db push` applies per file in order, so the verdict this
-- file reads is the work-done body that file just installed.
--
-- WHY IT WAITED. The canary's TS side (canary-rate.ts, FIX-1315) demotes a
-- HELD pipeline's rate regression to `report`. The day the hold converts, it
-- escalates again, and under fix978's rows-written denominator the merge-mode
-- taggers read as a regression (FIX-1338). With work-done denomination they
-- rate on their scan: prod read 4 (cc-259, 2026-11-04 01:2xZ, the new CTE
-- inlined read-only) gave {verdict intermittent, denominator desired_rows,
-- baseline_runs 81, baseline_p90 1.0648, threshold 2.1296, recent_min 0.1417,
-- recent_max 5.9312 s/1k}. The max is the 11-02 daily that ran 5,179.7 s inside
-- cc-262's IO throttle; it leaves the recent window after two more dailies.
-- `intermittent` converts: only `sustained_regression` RAISEs (below).
--
-- THE RECEIPTS (cc-259 read 7, prod). Both cadences have dispatched runs
-- (FIX-1334's "a dispatched daily AND weekly have run"):
--   rule-taggers-daily  Tue 11-03: armed 06:31:00Z, complete 06:33:00 →
--     06:36:02Z, 182.6 s, desired_rows 873,305, scan 175.2 s.
--   rule-taggers-weekly Tue 11-03: armed 16:03:00Z (the 16:01Z tick armed an
--     overdue ec-crawl first), complete 16:05:00 → 16:15:32Z, 632.9 s,
--     93,688 tags written of desired_rows 4,466,294, scan 65.0 s.
--
-- WHAT, in one DO block (fix1355's shape, 20261027001000:121-147):
--   (1) the hold row is ASSERTED: FIX-1311's takeover hold (held_since set,
--       hold_reason 'parked for the dispatcher cutover…', cadence_hours NULL,
--       note LIKE 'FIX-1311 (cc-232)%'), or defensively the gated push's own
--       'prod session held: …' hold (rule 385; the claim skips a row that is
--       already held, so it cannot be the latter). Anything else RAISEs: a
--       human hold is resolved by a human. Already converted → NOTICE, 0 rows.
--   (2) the verdict guard: run_rule_taggers' element of
--       check_pipeline_rate_regression() → RAISE on sustained_regression;
--       ok | intermittent | insufficient_data | absent convert, and the
--       numbers go into the note.
--   (3) the UPDATE (1 row): held_since / hold_reason NULL, cadence_hours 24.
--       The row is SHARED with the weekly; 24 h mirrors the daily for the
--       canary until it reads job_registry (FIX-1317).
--   (4) the registry rows it mirrors are asserted, never written: exactly two
--       on the pipeline, rule-taggers-daily `by 30 6 * * *` anchor daily and
--       rule-taggers-weekly `by 0 16 * * 2` anchor weekly.
--   (5) a read-back that RAISEs on any miss (the converted row, the four
--       pins), then NOTICEs: the row list_scheduled_rollup_pipelines() now
--       returns and check_rollup_freshness(…, 24). Freshness is PRINTED, never
--       a RAISE: at a Saturday apply the daily's newest complete may be > 24 h
--       old if that morning's 06:30Z run has not landed. The canary judges
--       freshness; this file converts.
--
-- ROLLBACK (data): scripts/fix1378-revert-convert-cutover-holds.sql puts the
-- row back to FIX-1311's hold_reason and note byte-for-byte, only while it
-- carries this file's note.
--
-- No routine is defined or replaced here; no job_registry, pipeline_state or
-- cron write. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  c_pipeline CONSTANT text := 'run_rule_taggers';
  c_hours    CONSTANT int  := 24;
  v_n        int;
  v_row      public.rollup_watch_overrides%ROWTYPE;
  v_el       jsonb;
  v_verdict  text;
  v_missing  text[] := '{}';
  v_reg      text;
  v_list     jsonb;
  v_fresh    jsonb;
  v_md5_b    text;
  v_md5_d    text;
  v_md5_g    text;
  v_md5_p    text;
BEGIN
  SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = c_pipeline;
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1378] rollup_watch_overrides has no % row — expected FIX-1311''s takeover hold', c_pipeline;
  END IF;

  IF v_row.cadence_hours = c_hours AND v_row.note LIKE 'FIX-1378 (cc-259)%' AND v_row.retired_at IS NULL THEN
    RAISE NOTICE '[fix1378] rollup_watch_overrides % already a cadence row (% h) — 0 rows', c_pipeline, c_hours;
  ELSE
    -- ── (1) the hold row: FIX-1311's takeover hold, or the push's own ────────
    IF NOT ((v_row.held_since IS NOT NULL
             AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
             AND v_row.cadence_hours IS NULL
             AND v_row.note LIKE 'FIX-1311 (cc-232)%')
            OR v_row.hold_reason LIKE 'prod session held: %')
       OR v_row.retired_at IS NOT NULL THEN
      RAISE EXCEPTION '[fix1378] % override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
        c_pipeline, v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
    END IF;

    -- ── (2) the verdict guard: FIX-1338's work-done body, installed first ────
    SELECT e INTO v_el
      FROM jsonb_array_elements(public.check_pipeline_rate_regression()->'pipelines') e
     WHERE e->>'pipeline' = c_pipeline;
    IF v_el->>'verdict' = 'sustained_regression' THEN
      RAISE EXCEPTION '[fix1378] % reads sustained_regression (recent_min % / threshold % s/1k, denominator %) — the hold stays; the canary would escalate on conversion',
        c_pipeline, v_el->>'recent_min_s_per_1k', v_el->>'threshold_s_per_1k', v_el->>'denominator';
    END IF;
    v_verdict := CASE
                   WHEN v_el IS NULL THEN 'no rated rows'
                   ELSE format('%s: recent_min %s / threshold %s s/1k = %s, denominator %s',
                               v_el->>'verdict', v_el->>'recent_min_s_per_1k', v_el->>'threshold_s_per_1k',
                               round((v_el->>'recent_min_s_per_1k')::numeric / NULLIF((v_el->>'threshold_s_per_1k')::numeric, 0), 3),
                               v_el->>'denominator')
                 END;

    -- ── (3) the shared hold row → a cadence declaration (converted, not deleted)
    UPDATE public.rollup_watch_overrides
       SET held_since    = NULL,
           hold_reason   = NULL,
           cadence_hours = c_hours,
           note          = format('FIX-1378 (cc-259) — rule-taggers-daily cadence row (24 h mirrors `by 30 6 * * *` for the canary until it reads job_registry, FIX-1317); '
                                  'shared with rule-taggers-weekly (`by 0 16 * * 2`). Converted on the Tue 11-03 receipts '
                                  '(daily armed 06:31Z, complete 182.6 s; weekly armed 16:03Z, complete 632.9 s) and the canary''s verdict (%s). '
                                  'Revert: scripts/fix1378-revert-convert-cutover-holds.sql', v_verdict),
           updated_at    = now()
     WHERE pipeline = c_pipeline
       AND retired_at IS NULL
       AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%'
             AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%')
            OR hold_reason LIKE 'prod session held: %');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1378] % conversion touched % rows, expected 1', c_pipeline, v_n;
    END IF;
    RAISE NOTICE '[fix1378] rollup_watch_overrides %: cutover hold → cadence_hours % (1 row); verdict %', c_pipeline, c_hours, v_verdict;
  END IF;

  -- ── (4) the registry rows it mirrors: asserted, never written ─────────────
  SELECT string_agg(format('%s %s %s', job, deadline_rule, COALESCE(anchor_cadence, '-')), ' | ' ORDER BY job) INTO v_reg
    FROM public.job_registry WHERE pipeline = c_pipeline;
  IF v_reg IS DISTINCT FROM 'rule-taggers-daily by 30 6 * * * daily | rule-taggers-weekly by 0 16 * * 2 weekly' THEN
    v_missing := v_missing || format('the registry rows on %s read %L (expected rule-taggers-daily by 30 6 * * * daily | rule-taggers-weekly by 0 16 * * 2 weekly)',
                                     c_pipeline, v_reg);
  END IF;

  -- ── (5) read-back — RAISE on any miss ─────────────────────────────────────
  -- A re-apply under a LATER session's claim finds the converted row held by
  -- that session (the claim holds every unheld row); that is the push's own.
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = c_pipeline
                    AND ((held_since IS NULL AND hold_reason IS NULL) OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours = c_hours AND note LIKE 'FIX-1378 (cc-259)%') THEN
    v_missing := v_missing || format('%s hold row converted (cadence_hours %s, the FIX-1378 note)', c_pipeline, c_hours);
  END IF;

  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_p FROM pg_proc WHERE proname = 'prod_op_gate'          AND pronamespace = 'public'::regnamespace;
  IF v_md5_b IS DISTINCT FROM 'ac8dbcddf71978e73d28c999433156b7'
     OR v_md5_d IS DISTINCT FROM 'd6a9073bcc4d9084b9d7994324a89b18'
     OR v_md5_g IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6'
     OR v_md5_p IS DISTINCT FROM '1d3507cd4b71439f0cfff51cde49b9d8' THEN
    v_missing := v_missing || format('the pins: box_is_saturated %s / dispatch_one_unit %s / get_dispatcher_status %s / prod_op_gate %s',
                                     v_md5_b, v_md5_d, v_md5_g, v_md5_p);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1378] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  SELECT e INTO v_list
    FROM jsonb_array_elements(public.list_scheduled_rollup_pipelines()->'pipelines') e
   WHERE e->>'pipeline' = c_pipeline;
  v_fresh := public.check_rollup_freshness(c_pipeline, c_hours);
  RAISE NOTICE '[fix1378] read-back ok: % registry %; pins % / % / % / %',
    c_pipeline, v_reg, v_md5_d, v_md5_g, v_md5_b, v_md5_p;
  RAISE NOTICE '[fix1378] % now: list_scheduled_rollup_pipelines held % · cadence_hours % · driver %; check_rollup_freshness(%) status % · last_complete_at % · % h since (printed, never a RAISE)',
    c_pipeline, v_list->>'held', v_list->>'cadence_hours', v_list->>'driver',
    c_hours, v_fresh->>'status', v_fresh->>'last_complete_at', v_fresh->>'hours_since_complete';
END $$;
