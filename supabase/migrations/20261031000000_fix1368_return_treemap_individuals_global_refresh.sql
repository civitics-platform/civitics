-- =============================================================================
-- FIX-1368 — RETURN treemap-individuals-global-refresh through job_registry as
-- `by 0 14 * * 2` (its cron slot). The first file of the rollups-group chain
-- (cc-256, 2026-10-31): one class-P push carries this, FIX-1369
-- (agency-staffing) and FIX-1370 (group-donor). Plan step s12b-7
-- (docs/cc/projects/dispatcher.md).
--
-- ITS OWN PIPELINE. treemap_individuals_global_refresh has exactly one
-- registry row (rule 378, cc-256 read 3), so a running row of it can only be
-- this job's and the row needs no anchor_cadence. The read-back asserts the
-- count.
--
-- THE BODY, ON PROD (cc-256 read 4(a), 2026-10-31 00:0xZ):
-- refresh_treemap_individuals_global (md5 227e9995…, 14,401 B, last CREATEd
-- at 20261010010000; prod = clone) runs a FULL 64-chunk sweep every time. It
-- keeps no watermark, so there is no catch-up: one complete run is fresh.
-- Each chunk MERGEs into the UNLOGGED staging table _tin_state_name and
-- advances pipeline_state.treemap_global_refresh.chunk_cursor INSIDE its own
-- transaction, so a cancel keeps every committed chunk. c_budget is 5400 s,
-- the registry's budget_seconds. The GUC civitics.treemap_global_budget_seconds
-- would override it and is unset on prod. A predictive guard (elapsed + 1.25
-- × the slowest chunk > c_budget) ends the run `partial`, resumable.
-- c_max_sweep is 240 hours: a resumed sweep older than 10 days is DISCARDED
-- and restarted.
--
--   Rule 390 / D12, read: under a `by` row a resumable gets ONE CALL per
--   slot, because a `partial` advances the clock. A partial resumes the next
--   Tuesday (7 d < 240 h), so a sweep finishes on its second CALL. Only a
--   sweep that cannot finish in two Tuesdays is discarded, and that is the
--   body's own design, not the trap. The last five walls were 872–994 s, 18 %
--   of the budget (bands.json 0–1492 s). No trap, no dial.
--
-- THE STATE AT THE READ: treemap_global_refresh = {"last_completed_at":
-- "2026-10-13 14:15:31.618572+00"}: no cursor, no in-flight sweep.
-- _tin_state_name is absent. The 10-13 14:00Z run was complete in 932 s
-- (slowest chunk 35 s, resumed false). The first dispatched CALL is a fresh
-- sweep.
--
-- THE CLOCK AT THE PUSH: `0 14 * * 2` prev slot Tue 10-27 14:00Z, next Tue
-- 11-03 14:00Z. The pipeline's last complete|partial (10-13 14:15:31Z) is
-- older than prev, so the row is DUE at the push, ttd ≈ −3.5 d. Group
-- rollups serializes it with the chain's other two rows by ttd, so it arms
-- second, after agency-staffing (prev Tue 00:05Z) reaps.
--
-- WHAT, in one DO block (fix1365's shape minus the dial):
--   (1) the row `at 0 14 * * 2` → `by 0 14 * * 2`, matched on the old text;
--       an "already returned" NOTICE on the `by` text; anything else RAISEs.
--   (2) the hold row is ASSERTED to be FIX-1311's takeover hold (held_since
--       set, hold_reason 'parked for the dispatcher cutover…', cadence_hours
--       NULL, note LIKE 'FIX-1311 (cc-232)%') or the gated push's own 'prod
--       session held: …' hold (rule 385). Only its note grows. It stays a
--       hold: the conversion to cadence_hours 168 is batched into cc-259.
--   (3) one owner: cron treemap-individuals-global-refresh (jobid 26 on prod)
--       inactive, by NAME, exactly one row (FIX-946). No un-park, ever.
--   (4) a read-back that RAISEs on any miss: the rule and every other column,
--       exactly one registry row on the pipeline, the hold row's shape and
--       note, the cron row, the four pins. Printed as NOTICEs: the pick's
--       arithmetic (prev / next slot, the last complete|partial, DUE NOW +
--       ttd), the body's premise (the state key, the budget GUC, the body
--       md5), and today's headroom for a 64-cap row.
--   No pipeline_state write: there is no dial, and the cursor is the body's.
--
-- NON-ADVANCING EXITS (rule 302): the advisory lock
-- hashtext('treemap_individuals_global_refresh') held → `skipped`;
-- prod_session_state().defer → `skipped`. A guard-stopped or cancelled sweep
-- is `partial` (advancing: the pick reads complete|partial, so the row waits
-- for next Tuesday and resumes there); a chunk error is `failed`.
--
-- NETS: the swap ceiling 1018 / headroom 150 (a 64-cap row needs MemAvailable
-- ≥ 214); the one-shot's 5400 s cron_job_budget row + the */2 watchdog; the
-- body's own predictive guard at c_budget and its per-chunk COMMIT (a cancel
-- keeps the cursor); group rollups (never beside donor-rollup-refresh, which
-- rewrites the per-official scopes of treemap_individuals_rollup);
-- max_concurrent_units 2; the I6 cooldown; platform_dials.pause; the data
-- revert below.
--
-- ROLLBACK (data):
-- scripts/fix1368-revert-return-treemap-individuals-global-refresh.sql puts
-- the row back to `at 0 14 * * 2`, matched on `by 0 14 * * 2`. Nothing else:
-- the hold row's note stays, the cron stays parked.
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  c_pin_d CONSTANT text := 'd6a9073bcc4d9084b9d7994324a89b18';
  v_n       int;
  v_rule    text;
  v_row     public.rollup_watch_overrides%ROWTYPE;
  v_jobid   bigint;
  v_active  boolean;
  v_missing text[] := '{}';
  v_got     text;
  v_last    timestamptz;
  v_prev    timestamptz;
  v_next    timestamptz;
  v_state   jsonb;
  v_guc     text;
  v_cursor  int;
  v_begun   timestamptz;
  v_plan    text;
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
  v_md5_t   text;
  v_avail   int;
  v_head    int;
  v_box     jsonb;
BEGIN
  -- ── (1) treemap-individuals-global-refresh: RETURN on its cron slot ───────
  UPDATE public.job_registry
     SET deadline_rule = 'by 0 14 * * 2',
         note          = note || '; RETURNED 2026-10-31 (FIX-1368, cc-256): by 0 14 * * 2 = its cron slot',
         updated_at    = now()
   WHERE job = 'treemap-individuals-global-refresh'
     AND deadline_rule = 'at 0 14 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1368] job_registry treemap-individuals-global-refresh: at 0 14 * * 2 → by 0 14 * * 2 (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'treemap-individuals-global-refresh';
    IF v_rule = 'by 0 14 * * 2' THEN
      RAISE NOTICE '[fix1368] job_registry treemap-individuals-global-refresh already returned (by 0 14 * * 2) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1368] job_registry treemap-individuals-global-refresh reads %, expected at 0 14 * * 2 or by 0 14 * * 2',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) the hold row: ASSERT FIX-1311's takeover hold; note only ──────────
  SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'treemap_individuals_global_refresh';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1368] rollup_watch_overrides has no treemap_individuals_global_refresh row — expected FIX-1311''s takeover hold';
  ELSIF NOT ((v_row.held_since IS NOT NULL
              AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
              AND v_row.cadence_hours IS NULL
              AND v_row.note LIKE 'FIX-1311 (cc-232)%')
             OR v_row.hold_reason LIKE 'prod session held: %')
        OR v_row.retired_at IS NOT NULL THEN
    RAISE EXCEPTION '[fix1368] treemap_individuals_global_refresh override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
      v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
  END IF;
  UPDATE public.rollup_watch_overrides
     SET note       = note || '; treemap-individuals-global-refresh RETURNED 2026-10-31 (FIX-1368) — hold kept, conversion to cadence_hours 168 owed (cc-259)',
         updated_at = now()
   WHERE pipeline = 'treemap_individuals_global_refresh'
     AND note LIKE 'FIX-1311 (cc-232)%'
     AND note NOT LIKE '%treemap-individuals-global-refresh RETURNED 2026-10-31 (FIX-1368)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1368] rollup_watch_overrides treemap_individuals_global_refresh: FIX-1311''s hold kept (hold_reason %); note % (% row)',
    v_row.hold_reason, CASE WHEN v_n = 1 THEN 'appended' ELSE 'already carries the RETURN' END, v_n;

  -- ── (3) one owner: the cron stays parked, by NAME (FIX-946) ───────────────
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'treemap-individuals-global-refresh';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1368] % cron.job rows named treemap-individuals-global-refresh — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'treemap-individuals-global-refresh';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[fix1368] cron treemap-individuals-global-refresh (jobid %) is active = % — the registry owns it; two owners', v_jobid, v_active;
  END IF;
  RAISE NOTICE '[fix1368] cron treemap-individuals-global-refresh (jobid %) inactive — registry owns it', v_jobid;

  -- ── (4) read-back — RAISE on any miss ─────────────────────────────────────
  SELECT deadline_rule INTO v_got FROM public.job_registry
   WHERE job = 'treemap-individuals-global-refresh' AND runner = 'pg_cron' AND pipeline = 'treemap_individuals_global_refresh'
     AND unit_shape = 'resumable' AND unit_call = 'CALL public.refresh_treemap_individuals_global();'
     AND priority = 3 AND cost_class = 'cpu' AND cap_mb = 64 AND exclusion_group = 'rollups'
     AND budget_seconds = 5400 AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL
     AND by_window_minutes IS NULL AND yield_to = '{}' AND yield_lead_seconds = 0 AND NOT idempotent_refire
     AND anchor_cadence IS NULL;
  IF v_got IS DISTINCT FROM 'by 0 14 * * 2' THEN
    v_missing := v_missing || format('treemap-individuals-global-refresh rule %L (the row''s other columns unchanged?)', v_got);
  END IF;
  SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = 'treemap_individuals_global_refresh';
  IF v_n <> 1 THEN
    v_missing := v_missing || format('%s registry rows on treemap_individuals_global_refresh (rule 378: a second row needs anchor_cadence)', v_n);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'treemap_individuals_global_refresh'
                    AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%')
                         OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%'
                    AND note LIKE '%treemap-individuals-global-refresh RETURNED 2026-10-31 (FIX-1368)%') THEN
    v_missing := v_missing || 'treemap_individuals_global_refresh hold row (FIX-1311''s hold + the FIX-1368 note)';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'treemap-individuals-global-refresh' AND active) THEN
    v_missing := v_missing || 'cron treemap-individuals-global-refresh active';
  END IF;

  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_p FROM pg_proc WHERE proname = 'prod_op_gate'          AND pronamespace = 'public'::regnamespace;
  IF v_md5_b IS DISTINCT FROM 'ac8dbcddf71978e73d28c999433156b7'
     OR v_md5_d IS DISTINCT FROM c_pin_d
     OR v_md5_g IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6'
     OR v_md5_p IS DISTINCT FROM '1d3507cd4b71439f0cfff51cde49b9d8' THEN
    v_missing := v_missing || format('the pins: box_is_saturated %s / dispatch_one_unit %s / get_dispatcher_status %s / prod_op_gate %s',
                                     v_md5_b, v_md5_d, v_md5_g, v_md5_p);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1368] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- The pick's arithmetic, read the way step 6 reads it (anchor_cadence NULL).
  SELECT completed_at INTO v_last FROM public.data_sync_log
   WHERE pipeline = 'treemap_individuals_global_refresh' AND status IN ('complete', 'partial') AND completed_at IS NOT NULL
   ORDER BY completed_at DESC LIMIT 1;
  v_prev := public.cron_prev_slot('0 14 * * 2', now());
  v_next := public.cron_next_slot('0 14 * * 2', now());
  RAISE NOTICE '[fix1368] read-back ok: treemap-individuals-global-refresh % (prev % / next %); its last complete|partial %; %; md5 % / % / % / %',
    v_got, v_prev, v_next, v_last,
    CASE WHEN v_last IS NULL OR v_last < v_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_prev - now()) || ')'
         ELSE 'next due ' || v_next END,
    v_md5_d, v_md5_g, v_md5_b, v_md5_p;

  -- The body's premise: what the first CALL does with the state it finds
  -- (20261010010000's body: the resume / discard test, then the budget).
  SELECT md5(prosrc) INTO v_md5_t FROM pg_proc
   WHERE proname = 'refresh_treemap_individuals_global' AND pronamespace = 'public'::regnamespace;
  SELECT value INTO v_state FROM public.pipeline_state WHERE key = 'treemap_global_refresh';
  v_guc    := NULLIF(current_setting('civitics.treemap_global_budget_seconds', true), '');
  v_cursor := COALESCE((v_state->>'chunk_cursor')::int, -1);
  v_begun  := (v_state->>'sweep_started_at')::timestamptz;
  v_plan := CASE
              WHEN v_cursor < 0 THEN 'a fresh sweep (no cursor)'
              WHEN v_begun IS NULL OR clock_timestamp() - v_begun > interval '240 hours'
                THEN format('discard + a fresh sweep (the in-flight sweep began %s, past c_max_sweep 240 h)', v_begun)
              WHEN to_regclass('public._tin_state_name') IS NULL
                THEN 'discard + a fresh sweep (staging missing)'
              ELSE format('resume at chunk %s of 64 (the sweep began %s)', v_cursor + 1, v_begun) END;
  RAISE NOTICE '[fix1368] body premise: treemap_global_refresh %; staging %; budget GUC % → c_budget % s; the first CALL runs %; body md5 % %',
    COALESCE(v_state::text, '(no row)'),
    COALESCE(to_regclass('public._tin_state_name')::text, 'absent'),
    COALESCE(v_guc, 'unset'),
    CASE WHEN COALESCE(v_guc::int, 0) > 0 THEN v_guc ELSE '5400' END,
    v_plan, v_md5_t,
    CASE WHEN v_md5_t = '227e99957d5f2db9b8e9b3b2bd8c984c' THEN '(the body this premise reads)'
         ELSE '(NOT 227e9995… — read the body before trusting this line)' END;

  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_head := (SELECT headroom_target_mb FROM public.platform_dials WHERE id);
  IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
    v_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
  END IF;
  RAISE NOTICE '[fix1368] headroom now: %',
    CASE WHEN v_avail IS NULL THEN 'mirror stale or absent — the test is skipped (fail-open)'
         WHEN v_avail - 64 < v_head THEN format('%s MB avail − 64 MB cap = %s < %s MB → excluded (headroom) until MemAvailable ≥ %s',
                                                v_avail, v_avail - 64, v_head, 64 + v_head)
         ELSE format('%s MB avail − 64 MB cap = %s ≥ %s MB → admitted', v_avail, v_avail - 64, v_head) END;
END $$;
