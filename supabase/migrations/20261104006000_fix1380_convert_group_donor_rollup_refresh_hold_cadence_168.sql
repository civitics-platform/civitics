-- =============================================================================
-- FIX-1380 — the group_donor_rollup_refresh hold row CONVERTS to
-- cadence_hours 168 on its first Wed slot receipt. cc-255, 2026-11-05. Plan
-- step s12b-10 (docs/cc/projects/dispatcher.md). The fifth conversion, after
-- cc-259's four (FIX-1378, 20261104001000 … 004000); the EIGHTH file of
-- cc-263's Sat 11-07 manifest, so it sorts after 20261104005000.
--
-- NEEDS 20261104000000_fix1338_rate_regression_work_done_denominator.sql (the
-- same push, first): the verdict guard below reads the work-done body.
--
-- THE HOLD. FIX-1311's takeover hold (cc-232, 20261013230000), kept by
-- FIX-1370's RETURN with its note appended. The registry row has owned the job
-- since that RETURN (`by 10 3 * * 3`); the hold kept the canary quiet until the
-- first dispatched Wed slot landed.
--
-- THE RECEIPT (cc-255 read 3(i), prod):
--   group-donor-rollup-refresh Wed 11-04 03:10Z: armed 03:11:00Z (by 10 3 * * 3
--     → -00:01:00; MemAvailable 443, swap 500; excluded none), complete
--     03:13:00 → 03:15:03Z, 123.9 s (band 0–442), 581 cohorts / 47,208 donor
--     rows, reaped 03:17:00Z succeeded: CALL unit_ms 123897. cron jobid 49 has
--     no run after 10-30 (the park held).
--
-- THE VERDICT AT THE READ (cc-255 read 7, prod's OLD body 6ae0aaa2, no
-- denominator key): {verdict insufficient_data, baseline_runs 4, recent_runs 3,
-- threshold 0.8803, recent_min 2.1496 s/1k}. The recent window sits above the
-- threshold because rows written fell 542k → 47,208 on 10-07 while the wall
-- held ~100 s (a denominator change, not a slowdown); 4 baseline runs < 5 keeps
-- it insufficient_data under either body until the 11-11 slot. It converts.
--
-- WHAT, in one DO block (fix1378's shape, 20261104002000):
--   (1) the hold row is ASSERTED: FIX-1311's takeover hold (held_since set,
--       hold_reason 'parked for the dispatcher cutover…', cadence_hours NULL,
--       note LIKE 'FIX-1311 (cc-232)%'), or defensively the gated push's own
--       'prod session held: …' hold (rule 385). Anything else RAISEs: a human
--       hold is resolved by a human. Already converted → NOTICE, 0 rows.
--   (2) the verdict guard: the pipeline's element of
--       check_pipeline_rate_regression() → RAISE on sustained_regression;
--       ok | intermittent | insufficient_data | absent convert, and the
--       numbers (or 'no rated rows') go into the note.
--   (3) the UPDATE (1 row): held_since / hold_reason NULL, cadence_hours 168,
--       which mirrors `by 10 3 * * 3` for the canary until it reads
--       job_registry (FIX-1317).
--   (4) the registry row it mirrors is asserted, never written: exactly one
--       row on the pipeline, group-donor-rollup-refresh `by 10 3 * * 3`, anchor_cadence NULL.
--   (5) a read-back that RAISEs on any miss (the converted row, the four
--       pins), then NOTICEs: the row list_scheduled_rollup_pipelines() now
--       returns and check_rollup_freshness(…, 168). Freshness is PRINTED, never
--       a RAISE (at a Saturday apply the Wednesday receipt is ~3.5 days old,
--       inside 168 h). The canary judges freshness; this file converts.
--
-- ROLLBACK (data): scripts/fix1380-revert-convert-group-donor-hold.sql puts the
-- row back to FIX-1311's hold_reason and note byte-for-byte, only while it
-- carries this file's note.
--
-- No routine is defined or replaced here; no job_registry, pipeline_state or
-- cron write. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  c_pipeline CONSTANT text := 'group_donor_rollup_refresh';
  c_hours    CONSTANT int  := 168;
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
    RAISE EXCEPTION '[fix1380] rollup_watch_overrides has no % row — expected FIX-1311''s takeover hold', c_pipeline;
  END IF;

  IF v_row.cadence_hours = c_hours AND v_row.note LIKE 'FIX-1380 (cc-255)%' AND v_row.retired_at IS NULL THEN
    RAISE NOTICE '[fix1380] rollup_watch_overrides % already a cadence row (% h) — 0 rows', c_pipeline, c_hours;
  ELSE
    -- ── (1) the hold row: FIX-1311's takeover hold, or the push's own ────────
    IF NOT ((v_row.held_since IS NOT NULL
             AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
             AND v_row.cadence_hours IS NULL
             AND v_row.note LIKE 'FIX-1311 (cc-232)%')
            OR v_row.hold_reason LIKE 'prod session held: %')
       OR v_row.retired_at IS NOT NULL THEN
      RAISE EXCEPTION '[fix1380] % override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
        c_pipeline, v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
    END IF;

    -- ── (2) the verdict guard: FIX-1338's work-done body, installed first ────
    SELECT e INTO v_el
      FROM jsonb_array_elements(public.check_pipeline_rate_regression()->'pipelines') e
     WHERE e->>'pipeline' = c_pipeline;
    IF v_el->>'verdict' = 'sustained_regression' THEN
      RAISE EXCEPTION '[fix1380] % reads sustained_regression (recent_min % / threshold % s/1k, denominator %) — the hold stays; the canary would escalate on conversion',
        c_pipeline, v_el->>'recent_min_s_per_1k', v_el->>'threshold_s_per_1k', v_el->>'denominator';
    END IF;
    v_verdict := CASE
                   WHEN v_el IS NULL THEN 'no rated rows'
                   ELSE format('%s: recent_min %s / threshold %s s/1k = %s, denominator %s',
                               v_el->>'verdict', v_el->>'recent_min_s_per_1k', v_el->>'threshold_s_per_1k',
                               round((v_el->>'recent_min_s_per_1k')::numeric / NULLIF((v_el->>'threshold_s_per_1k')::numeric, 0), 3),
                               COALESCE(v_el->>'denominator', 'none (the pre-FIX-1338 body)'))
                 END;

    -- ── (3) the hold row → a cadence declaration (converted, not deleted) ────
    UPDATE public.rollup_watch_overrides
       SET held_since    = NULL,
           hold_reason   = NULL,
           cadence_hours = c_hours,
           note          = format('FIX-1380 (cc-255) — group-donor-rollup-refresh cadence row (168 h mirrors `by 10 3 * * 3` for the canary until it reads job_registry, FIX-1317). '
                                  'Converted on the Wed 11-04 receipt (armed 03:11Z, complete 123.9 s, 581 cohorts / 47,208 donor rows) and the rate verdict (%s). '
                                  'Revert: scripts/fix1380-revert-convert-group-donor-hold.sql', v_verdict),
           updated_at    = now()
     WHERE pipeline = c_pipeline
       AND retired_at IS NULL
       AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%'
             AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%')
            OR hold_reason LIKE 'prod session held: %');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1380] % conversion touched % rows, expected 1', c_pipeline, v_n;
    END IF;
    RAISE NOTICE '[fix1380] rollup_watch_overrides %: cutover hold → cadence_hours % (1 row); verdict %', c_pipeline, c_hours, v_verdict;
  END IF;

  -- ── (4) the registry row it mirrors: asserted, never written ──────────────
  SELECT string_agg(format('%s %s %s', job, deadline_rule, COALESCE(anchor_cadence, '-')), ' | ' ORDER BY job) INTO v_reg
    FROM public.job_registry WHERE pipeline = c_pipeline;
  IF v_reg IS DISTINCT FROM 'group-donor-rollup-refresh by 10 3 * * 3 -' THEN
    v_missing := v_missing || format('the registry rows on %s read %L (expected group-donor-rollup-refresh by 10 3 * * 3 -)',
                                     c_pipeline, v_reg)::text;
  END IF;

  -- ── (5) read-back — RAISE on any miss ─────────────────────────────────────
  -- A re-apply under a LATER session's claim finds the converted row held by
  -- that session (the claim holds every unheld row); that is the push's own.
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = c_pipeline
                    AND ((held_since IS NULL AND hold_reason IS NULL) OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours = c_hours AND note LIKE 'FIX-1380 (cc-255)%') THEN
    v_missing := v_missing || format('%s hold row converted (cadence_hours %s, the FIX-1380 note)', c_pipeline, c_hours)::text;
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
                                     v_md5_b, v_md5_d, v_md5_g, v_md5_p)::text;
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1380] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  SELECT e INTO v_list
    FROM jsonb_array_elements(public.list_scheduled_rollup_pipelines()->'pipelines') e
   WHERE e->>'pipeline' = c_pipeline;
  v_fresh := public.check_rollup_freshness(c_pipeline, c_hours);
  RAISE NOTICE '[fix1380] read-back ok: % registry %; pins % / % / % / %',
    c_pipeline, v_reg, v_md5_d, v_md5_g, v_md5_b, v_md5_p;
  RAISE NOTICE '[fix1380] % now: list_scheduled_rollup_pipelines held % · cadence_hours % · driver %; check_rollup_freshness(%) status % · last_complete_at % · % h since (printed, never a RAISE)',
    c_pipeline, v_list->>'held', v_list->>'cadence_hours', v_list->>'driver',
    c_hours, v_fresh->>'status', v_fresh->>'last_complete_at', v_fresh->>'hours_since_complete';
END $$;
