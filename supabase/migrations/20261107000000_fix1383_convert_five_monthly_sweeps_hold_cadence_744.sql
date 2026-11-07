-- =============================================================================
-- FIX-1383 — the five monthly sweeps' hold rows CONVERT to cadence_hours 744 on
-- their first dispatched walls: five of five, the rows whose terminal row reads
-- complete. cc-263, 2026-11-07. Plan step s12b-12 (docs/cc/projects/dispatcher.md).
-- The TENTH file of cc-263: written after the chain that file 1 armed, and
-- pushed alone in a second gated class-P push.
--
-- THE HOLDS. FIX-1311's takeover holds (cc-232, 20261013230000), kept by
-- FIX-1374's RETURN with each note appended (20261102000000, on prod since
-- 01:05:5xZ on 11-07). The registry rows own the jobs since that RETURN.
--
-- THE RECEIPTS (cc-263's chain, prod):
--   donation-edge-orphan-sweep        armed 01:07:00Z, 01:09:00 → 01:10:40Z, complete  99.6 s (band 0–204), 0 deleted
--   financial-entity-totals-reconcile armed 01:09:00Z, 01:11:00 → 01:20:44Z, complete 583.5 s (band 0–234, ABOVE: FIX-1385), 0 zeroed
--   donor-rollup-orphan-sweep         armed 01:11:01Z, 01:13:00 → 01:15:26Z, complete 146.0 s (band 0–156), 0 deleted
--   donor-party-rollup-orphan-sweep   armed 01:17:11Z, 01:19:01 → 01:22:22Z, complete 200.6 s (band 0–436), 0 deleted
--   entity-connection-stats-orphan-sweep armed 01:23:01Z, 01:25:00 → 01:26:07Z, complete 67.4 s (band 0–140), 0 deleted
--   Each reaped succeeded: CALL; crons 23 / 14 / 15 / 18 / 19 have no run after 10-01 (the parks held).
--   fe-totals' wall is a SEPARATE question from its conversion (rule 419): the gate is a complete terminal row and the verdict, so it converts here.
--
-- LEFT OUT (each stays held; its conversion is owed to the Dec 1 slot):
--   none: all five closed complete.
--
-- THE VERDICT. check_pipeline_rate_regression() returned no element for any of the five at
-- the 01:36Z read: a sweep's rows written are its deletes, 0 tonight, and zero-work
-- rows are filtered out. So each note is expected to read 'no rated rows'.
--
-- WHAT, in one DO block over a VALUES list (fix1380's steps, per row):
--   (1) the hold row is ASSERTED: FIX-1311's takeover hold WITH FIX-1374's
--       appendix (held_since set, hold_reason 'parked for the dispatcher
--       cutover…', cadence_hours NULL, note LIKE 'FIX-1311 (cc-232)%' and LIKE
--       '%RETURNED%(FIX-1374)%'), or defensively the gated push's own 'prod
--       session held: …' hold (rule 385). Anything else RAISEs: a human hold
--       is resolved by a human. Already converted → NOTICE, 0 rows.
--   (2) the verdict guard: the pipeline's element of
--       check_pipeline_rate_regression() → RAISE on sustained_regression;
--       anything else, absent included, converts, and the numbers (or 'no
--       rated rows') go into the note.
--   (3) the UPDATE (1 row each): held_since / hold_reason NULL, cadence_hours
--       744, which mirrors the row's `by … 1 * *` for the canary until it
--       reads job_registry (FIX-1317).
--   (4) the registry row it mirrors is asserted, never written: exactly one
--       row on the pipeline, the job's `by` text, anchor_cadence NULL.
--   (5) a read-back that RAISEs on any miss (each converted row, the four
--       pins), then NOTICEs: each row list_scheduled_rollup_pipelines() now
--       returns and check_rollup_freshness(…, 744). Freshness is PRINTED,
--       never a RAISE. The canary judges freshness; this file converts.
--
-- ROLLBACK (data): scripts/fix1383-revert-convert-five-sweeps-holds.sql puts
-- each row back to FIX-1311's hold_reason and the FIX-1374-appended note
-- byte-for-byte, only while it carries this file's note.
--
-- No routine is defined or replaced here; no job_registry, pipeline_state or
-- cron write. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  c_hours CONSTANT int := 744;
  r          record;
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
  FOR r IN
    SELECT * FROM (VALUES
      ('donation_edge_orphan_sweep', 'donation-edge-orphan-sweep', 'by 30 11 1 * *',
       'the 11-01 slot, armed 11-07 01:07Z, complete 99.6 s, rows 0'),
      ('financial_entity_totals_reconcile', 'financial-entity-totals-reconcile', 'by 0 12 1 * *',
       'the 11-01 slot, armed 11-07 01:09Z, complete 583.5 s, rows 0'),
      ('donor_rollup_orphan_sweep', 'donor-rollup-orphan-sweep', 'by 30 12 1 * *',
       'the 11-01 slot, armed 11-07 01:11Z, complete 146.0 s, rows 0'),
      ('donor_party_rollup_orphan_sweep', 'donor-party-rollup-orphan-sweep', 'by 0 13 1 * *',
       'the 11-01 slot, armed 11-07 01:17Z, complete 200.6 s, rows 0'),
      ('entity_connection_stats_orphan_sweep', 'entity-connection-stats-orphan-sweep', 'by 30 13 1 * *',
       'the 11-01 slot, armed 11-07 01:23Z, complete 67.4 s, rows 0')
    ) AS t(pipeline, job, rule, receipt)
  LOOP
    SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = r.pipeline;
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1383] rollup_watch_overrides has no % row — expected FIX-1311''s takeover hold', r.pipeline;
    END IF;

    IF v_row.cadence_hours = c_hours AND v_row.note LIKE 'FIX-1383 (cc-263)%' AND v_row.retired_at IS NULL THEN
      RAISE NOTICE '[fix1383] rollup_watch_overrides % already a cadence row (% h) — 0 rows', r.pipeline, c_hours;
    ELSE
      -- ── (1) the hold row: FIX-1311's takeover hold + FIX-1374's appendix, or the push's own ──
      IF NOT ((v_row.held_since IS NOT NULL
               AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
               AND v_row.cadence_hours IS NULL
               AND v_row.note LIKE 'FIX-1311 (cc-232)%'
               AND v_row.note LIKE '%RETURNED%(FIX-1374)%')
              OR v_row.hold_reason LIKE 'prod session held: %')
         OR v_row.retired_at IS NOT NULL THEN
        RAISE EXCEPTION '[fix1383] % override is not FIX-1311''s takeover hold with FIX-1374''s appendix (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
          r.pipeline, v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
      END IF;

      -- ── (2) the verdict guard ────────────────────────────────────────────────
      v_el := NULL;
      SELECT e INTO v_el
        FROM jsonb_array_elements(public.check_pipeline_rate_regression()->'pipelines') e
       WHERE e->>'pipeline' = r.pipeline;
      IF v_el->>'verdict' = 'sustained_regression' THEN
        RAISE EXCEPTION '[fix1383] % reads sustained_regression (recent_min % / threshold % s/1k, denominator %) — the hold stays; the canary would escalate on conversion',
          r.pipeline, v_el->>'recent_min_s_per_1k', v_el->>'threshold_s_per_1k', v_el->>'denominator';
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
             note          = format('FIX-1383 (cc-263) — %s cadence row (744 h mirrors `%s` for the canary until it reads job_registry, FIX-1317). '
                                    'Converted on the first dispatched run (%s) and the rate verdict (%s). '
                                    'Revert: scripts/fix1383-revert-convert-five-sweeps-holds.sql', r.job, r.rule, r.receipt, v_verdict),
             updated_at    = now()
       WHERE pipeline = r.pipeline
         AND retired_at IS NULL
         AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%'
               AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%' AND note LIKE '%RETURNED%(FIX-1374)%')
              OR hold_reason LIKE 'prod session held: %');
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN
        RAISE EXCEPTION '[fix1383] % conversion touched % rows, expected 1', r.pipeline, v_n;
      END IF;
      RAISE NOTICE '[fix1383] rollup_watch_overrides %: cutover hold → cadence_hours % (1 row); verdict %', r.pipeline, c_hours, v_verdict;
    END IF;

    -- ── (4) the registry row it mirrors: asserted, never written ────────────
    SELECT string_agg(format('%s %s %s', job, deadline_rule, COALESCE(anchor_cadence, '-')), ' | ' ORDER BY job) INTO v_reg
      FROM public.job_registry WHERE pipeline = r.pipeline;
    IF v_reg IS DISTINCT FROM format('%s %s -', r.job, r.rule) THEN
      v_missing := v_missing || format('the registry rows on %s read %L (expected %s %s -)',
                                       r.pipeline, v_reg, r.job, r.rule)::text;
    END IF;

    -- ── (5) read-back of the row — RAISE below on any miss ──────────────────
    -- A re-apply under a LATER session's claim finds the converted row held by
    -- that session (the claim holds every unheld row); that is the push's own.
    IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                    WHERE pipeline = r.pipeline
                      AND ((held_since IS NULL AND hold_reason IS NULL) OR hold_reason LIKE 'prod session held: %')
                      AND retired_at IS NULL AND cadence_hours = c_hours AND note LIKE 'FIX-1383 (cc-263)%') THEN
      v_missing := v_missing || format('%s hold row converted (cadence_hours %s, the FIX-1383 note)', r.pipeline, c_hours)::text;
    END IF;
  END LOOP;

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
    RAISE EXCEPTION '[fix1383] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  RAISE NOTICE '[fix1383] read-back ok: 5 row(s); pins % / % / % / %', v_md5_d, v_md5_g, v_md5_b, v_md5_p;
  FOR r IN
    SELECT o.pipeline FROM public.rollup_watch_overrides o WHERE o.note LIKE 'FIX-1383 (cc-263)%' ORDER BY o.pipeline
  LOOP
    SELECT e INTO v_list
      FROM jsonb_array_elements(public.list_scheduled_rollup_pipelines()->'pipelines') e
     WHERE e->>'pipeline' = r.pipeline;
    v_fresh := public.check_rollup_freshness(r.pipeline, c_hours);
    RAISE NOTICE '[fix1383] % now: list_scheduled_rollup_pipelines held % · cadence_hours % · driver %; check_rollup_freshness(%) status % · last_complete_at % · % h since (printed, never a RAISE)',
      r.pipeline, v_list->>'held', v_list->>'cadence_hours', v_list->>'driver',
      c_hours, v_fresh->>'status', v_fresh->>'last_complete_at', v_fresh->>'hours_since_complete';
  END LOOP;
END $$;
