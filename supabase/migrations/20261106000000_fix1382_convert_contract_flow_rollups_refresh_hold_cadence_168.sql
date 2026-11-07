-- =============================================================================
-- FIX-1382 — the contract_flow_rollups_rebuild hold row CONVERTS to
-- cadence_hours 168 on its first dispatched Thu slot receipt. cc-263,
-- 2026-11-07. Plan step s12b-10 (docs/cc/projects/dispatcher.md). The sixth
-- conversion, after cc-259's four (FIX-1378) and cc-255's group-donor
-- (FIX-1380); the NINTH file of cc-263's manifest, so it sorts after
-- 20261104006000.
--
-- NEEDS 20261104000000_fix1338_rate_regression_work_done_denominator.sql (the
-- same push, earlier): the verdict guard below reads the work-done body, and
-- contract-flow's rows carry no metadata source, so only that body rates them.
--
-- THE HOLD. FIX-1311's takeover hold (cc-232, 20261013230000), kept by
-- FIX-1371's RETURN with its note appended. The registry row has owned the job
-- since that RETURN (`by 0 14 * * 4`); the hold kept the canary quiet until the
-- first dispatched Thu slot landed.
--
-- THE RECEIPT (cc-263 read 4, prod):
--   contract-flow-rollups-refresh Thu 11-05 14:00Z: armed 14:01:00Z (tick
--     16682, by 0 14 * * 4 → -00:01:00; MemAvailable 351, swap 403), complete
--     14:03:00 → 14:52:55Z, 2,995.0 s (band 0–8839, ≤ 4,188), 500 recipients /
--     1,201 agency-sector rows, reaped 14:53:00Z succeeded: CALL unit_ms
--     2995068. cron jobid 28 has no run after 10-08 (the park held).
--
-- THE VERDICT AT THE READ (cc-263 read 4). Prod's OLD body 6ae0aaa2 returns no
-- element: the rows carry no metadata source. The NEW body rates them; by its
-- arithmetic over prod's 11 complete rows in 90 days, baseline 8 runs, P90
-- 1,698.0 s/1k, threshold 3,396.0, recent 1,156.50 / 1,641.16 / 1,760.74, so
-- `ok`. Its 1.57× wall against the 256MB era is a SEPARATE question
-- (FIX-1384) and does not hold this conversion (rule 419).
--
-- WHAT, in one DO block (fix1380's shape, 20261104006000):
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
--       which mirrors `by 0 14 * * 4` for the canary until it reads
--       job_registry (FIX-1317).
--   (4) the registry row it mirrors is asserted, never written: exactly one
--       row on the pipeline, contract-flow-rollups-refresh `by 0 14 * * 4`, anchor_cadence NULL.
--   (5) a read-back that RAISEs on any miss (the converted row, the four
--       pins), then NOTICEs: the row list_scheduled_rollup_pipelines() now
--       returns and check_rollup_freshness(…, 168). Freshness is PRINTED, never
--       a RAISE (at a Fri/Sat apply the Thursday receipt is ~1.5 days old,
--       inside 168 h). The canary judges freshness; this file converts.
--
-- ROLLBACK (data): scripts/fix1382-revert-convert-contract-flow-hold.sql puts
-- the row back to FIX-1311's hold_reason and note byte-for-byte, only while it
-- carries this file's note.
--
-- No routine is defined or replaced here; no job_registry, pipeline_state or
-- cron write. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  c_pipeline CONSTANT text := 'contract_flow_rollups_rebuild';
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
    RAISE EXCEPTION '[fix1382] rollup_watch_overrides has no % row — expected FIX-1311''s takeover hold', c_pipeline;
  END IF;

  IF v_row.cadence_hours = c_hours AND v_row.note LIKE 'FIX-1382 (cc-263)%' AND v_row.retired_at IS NULL THEN
    RAISE NOTICE '[fix1382] rollup_watch_overrides % already a cadence row (% h) — 0 rows', c_pipeline, c_hours;
  ELSE
    -- ── (1) the hold row: FIX-1311's takeover hold, or the push's own ────────
    IF NOT ((v_row.held_since IS NOT NULL
             AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
             AND v_row.cadence_hours IS NULL
             AND v_row.note LIKE 'FIX-1311 (cc-232)%')
            OR v_row.hold_reason LIKE 'prod session held: %')
       OR v_row.retired_at IS NOT NULL THEN
      RAISE EXCEPTION '[fix1382] % override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
        c_pipeline, v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
    END IF;

    -- ── (2) the verdict guard: FIX-1338's work-done body, installed first ────
    SELECT e INTO v_el
      FROM jsonb_array_elements(public.check_pipeline_rate_regression()->'pipelines') e
     WHERE e->>'pipeline' = c_pipeline;
    IF v_el->>'verdict' = 'sustained_regression' THEN
      RAISE EXCEPTION '[fix1382] % reads sustained_regression (recent_min % / threshold % s/1k, denominator %) — the hold stays; the canary would escalate on conversion',
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
           note          = format('FIX-1382 (cc-263) — contract-flow-rollups-refresh cadence row (168 h mirrors `by 0 14 * * 4` for the canary until it reads job_registry, FIX-1317). '
                                  'Converted on the Thu 11-05 receipt (armed 14:01Z, complete 2,995 s, 500 recipients / 1,201 agency-sector rows) and the rate verdict (%s). '
                                  'Revert: scripts/fix1382-revert-convert-contract-flow-hold.sql', v_verdict),
           updated_at    = now()
     WHERE pipeline = c_pipeline
       AND retired_at IS NULL
       AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%'
             AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%')
            OR hold_reason LIKE 'prod session held: %');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1382] % conversion touched % rows, expected 1', c_pipeline, v_n;
    END IF;
    RAISE NOTICE '[fix1382] rollup_watch_overrides %: cutover hold → cadence_hours % (1 row); verdict %', c_pipeline, c_hours, v_verdict;
  END IF;

  -- ── (4) the registry row it mirrors: asserted, never written ──────────────
  SELECT string_agg(format('%s %s %s', job, deadline_rule, COALESCE(anchor_cadence, '-')), ' | ' ORDER BY job) INTO v_reg
    FROM public.job_registry WHERE pipeline = c_pipeline;
  IF v_reg IS DISTINCT FROM 'contract-flow-rollups-refresh by 0 14 * * 4 -' THEN
    v_missing := v_missing || format('the registry rows on %s read %L (expected contract-flow-rollups-refresh by 0 14 * * 4 -)',
                                     c_pipeline, v_reg)::text;
  END IF;

  -- ── (5) read-back — RAISE on any miss ─────────────────────────────────────
  -- A re-apply under a LATER session's claim finds the converted row held by
  -- that session (the claim holds every unheld row); that is the push's own.
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = c_pipeline
                    AND ((held_since IS NULL AND hold_reason IS NULL) OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours = c_hours AND note LIKE 'FIX-1382 (cc-263)%') THEN
    v_missing := v_missing || format('%s hold row converted (cadence_hours %s, the FIX-1382 note)', c_pipeline, c_hours)::text;
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
    RAISE EXCEPTION '[fix1382] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  SELECT e INTO v_list
    FROM jsonb_array_elements(public.list_scheduled_rollup_pipelines()->'pipelines') e
   WHERE e->>'pipeline' = c_pipeline;
  v_fresh := public.check_rollup_freshness(c_pipeline, c_hours);
  RAISE NOTICE '[fix1382] read-back ok: % registry %; pins % / % / % / %',
    c_pipeline, v_reg, v_md5_d, v_md5_g, v_md5_b, v_md5_p;
  RAISE NOTICE '[fix1382] % now: list_scheduled_rollup_pipelines held % · cadence_hours % · driver %; check_rollup_freshness(%) status % · last_complete_at % · % h since (printed, never a RAISE)',
    c_pipeline, v_list->>'held', v_list->>'cadence_hours', v_list->>'driver',
    c_hours, v_fresh->>'status', v_fresh->>'last_complete_at', v_fresh->>'hours_since_complete';
END $$;
