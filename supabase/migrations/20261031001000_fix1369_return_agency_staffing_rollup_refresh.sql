-- =============================================================================
-- FIX-1369 — RETURN agency-staffing-rollup-refresh through job_registry as
-- `by 5 0 * * 2` (its cron slot). The second file of the rollups-group chain
-- (cc-256, 2026-10-31; with FIX-1368 treemap and FIX-1370 group-donor in one
-- class-P push). Plan step s12b-8 (docs/cc/projects/dispatcher.md).
--
-- ITS OWN PIPELINE. agency_staffing_rollup_refresh has exactly one registry
-- row (rule 378, cc-256 read 3), so the row needs no anchor_cadence. The
-- read-back asserts the count.
--
-- THE BODY, ON PROD (cc-256 read 4(b), 2026-10-31 00:0xZ):
-- refresh_agency_staffing_rollup (md5 c2802f12…, 11,211 B, last CREATEd at
-- 20261003030000; prod = clone). Its mode is decided O(1):
--     full        when fr_watermark_horizon() − agency_staffing_watermark
--                 .fr_last_indexed_at > c_full_lag (or either watermark NULL)
--     incremental otherwise.
-- c_full_lag is `interval '14 days'`, HARD-CODED: a body constant, not a
-- dial, and this file does not move it. On prod the watermark reads
-- 2026-10-12 23:05:00Z and the horizon 10-30 22:59Z, a lag of 17 d 23:54, so
-- the first dispatched CALL is FULL: all 136 agencies, in chunks of 50
-- (3 chunks, a COMMIT after each). There is no cursor. A full pass IS the
-- catch-up, and a `partial` (a cancel, or a box backoff at a chunk boundary)
-- leaves the watermark put so the next slot redoes the whole set. The body
-- sets work_mem 128MB in-body, = cap_mb 128 (FIX-1357). Its own
-- box_backoff_gate(…, 600) START gate runs before the lock; under the
-- dispatcher the tick has already admitted the box, so it returns clear at
-- once (the row carries a `gate` key only when it waited).
--
--   THE BODY WRITES NO RUNNING ROW: only the terminal complete|partial row,
--   at the end. The dispatcher still sees it live (cc-256 read 5): step 5's
--   census takes every `armed` dispatch_log row with no reaped/missed row
--   as a unit (20261029000000 :541-548, :562-563), and also a client
--   backend whose query CALLs the row's routine (:570-577). Every job of a
--   live unit puts its exclusion_group in v_busy_groups (:603-606), so group
--   rollups holds against the chain's other rows for the whole run.
--
-- THE LAST RUNS: 10-13 00:05Z incremental, 436 s, 75 agencies in 2 chunks
-- (dirty fr 72 / ec 19), the cron's last firing before the 10-13 park. The
-- four before it took 30–58 s.
--
-- THE CLOCK AT THE PUSH: `5 0 * * 2` prev slot Tue 10-27 00:05Z, next Tue
-- 11-03 00:05Z. The last complete|partial (10-13 00:12:16Z) is older than
-- prev, so the row is DUE at the push, ttd ≈ −4.0 d: the chain's earliest
-- slot, so it is the first pick.
--
-- WHAT, in one DO block (fix1365's shape minus the dial):
--   (1) the row `at 5 0 * * 2` → `by 5 0 * * 2`, matched on the old text;
--       an "already returned" NOTICE on the `by` text; anything else RAISEs.
--   (2) the hold row is ASSERTED to be FIX-1311's takeover hold or the gated
--       push's own 'prod session held: …' hold (rule 385); only its note
--       grows. Conversion to cadence_hours 168 is batched into cc-259.
--   (3) one owner: cron agency-staffing-rollup-refresh (jobid 25 on prod)
--       inactive, by NAME, exactly one row (FIX-946). No un-park, ever.
--   (4) a read-back that RAISEs on any miss (the rule and every other column,
--       one registry row on the pipeline, the hold row, the cron row, the
--       four pins), then NOTICEs: the pick's arithmetic, the mode the body
--       picks now with its inputs, today's headroom for a 128-cap row.
--   No pipeline_state write: the watermark is the body's.
--
-- NON-ADVANCING EXITS (rule 302): the START gate not clear after 600 s →
-- `skipped`; prod_session_state().defer → `skipped`. The advisory lock held →
-- a bare RETURN with NO row (the reap reads `succeeded: CALL`, the pick reads
-- no advance, and the I6 cooldown counts it). A cancel or a chunk-boundary
-- box backoff is `partial` (advancing for the pick; the watermark stays put).
--
-- NETS: the swap ceiling 1018 / headroom 150 (a 128-cap row needs
-- MemAvailable ≥ 278); the one-shot's 3600 s cron_job_budget row + the */2
-- watchdog; the body's chunk-boundary box_is_saturated backoff and per-chunk
-- COMMIT; group rollups; max_concurrent_units 2; the I6 cooldown;
-- platform_dials.pause; the data revert below.
--
-- ROLLBACK (data):
-- scripts/fix1369-revert-return-agency-staffing-rollup-refresh.sql puts the
-- row back to `at 5 0 * * 2`, matched on `by 5 0 * * 2`. Nothing else: the
-- hold row's note stays, the cron stays parked.
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
  v_w_fr    timestamptz;
  v_w_ec    timestamptz;
  v_h       timestamptz;
  v_mode    text;
  v_agencies int;
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
  v_md5_a   text;
  v_avail   int;
  v_head    int;
  v_box     jsonb;
BEGIN
  -- ── (1) agency-staffing-rollup-refresh: RETURN on its cron slot ───────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 5 0 * * 2',
         note          = note || '; RETURNED 2026-10-31 (FIX-1369, cc-256): by 5 0 * * 2 = its cron slot',
         updated_at    = now()
   WHERE job = 'agency-staffing-rollup-refresh'
     AND deadline_rule = 'at 5 0 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1369] job_registry agency-staffing-rollup-refresh: at 5 0 * * 2 → by 5 0 * * 2 (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'agency-staffing-rollup-refresh';
    IF v_rule = 'by 5 0 * * 2' THEN
      RAISE NOTICE '[fix1369] job_registry agency-staffing-rollup-refresh already returned (by 5 0 * * 2) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1369] job_registry agency-staffing-rollup-refresh reads %, expected at 5 0 * * 2 or by 5 0 * * 2',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) the hold row: ASSERT FIX-1311's takeover hold; note only ──────────
  SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'agency_staffing_rollup_refresh';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1369] rollup_watch_overrides has no agency_staffing_rollup_refresh row — expected FIX-1311''s takeover hold';
  ELSIF NOT ((v_row.held_since IS NOT NULL
              AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
              AND v_row.cadence_hours IS NULL
              AND v_row.note LIKE 'FIX-1311 (cc-232)%')
             OR v_row.hold_reason LIKE 'prod session held: %')
        OR v_row.retired_at IS NOT NULL THEN
    RAISE EXCEPTION '[fix1369] agency_staffing_rollup_refresh override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
      v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
  END IF;
  UPDATE public.rollup_watch_overrides
     SET note       = note || '; agency-staffing-rollup-refresh RETURNED 2026-10-31 (FIX-1369) — hold kept, conversion to cadence_hours 168 owed (cc-259)',
         updated_at = now()
   WHERE pipeline = 'agency_staffing_rollup_refresh'
     AND note LIKE 'FIX-1311 (cc-232)%'
     AND note NOT LIKE '%agency-staffing-rollup-refresh RETURNED 2026-10-31 (FIX-1369)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1369] rollup_watch_overrides agency_staffing_rollup_refresh: FIX-1311''s hold kept (hold_reason %); note % (% row)',
    v_row.hold_reason, CASE WHEN v_n = 1 THEN 'appended' ELSE 'already carries the RETURN' END, v_n;

  -- ── (3) one owner: the cron stays parked, by NAME (FIX-946) ───────────────
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'agency-staffing-rollup-refresh';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1369] % cron.job rows named agency-staffing-rollup-refresh — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'agency-staffing-rollup-refresh';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[fix1369] cron agency-staffing-rollup-refresh (jobid %) is active = % — the registry owns it; two owners', v_jobid, v_active;
  END IF;
  RAISE NOTICE '[fix1369] cron agency-staffing-rollup-refresh (jobid %) inactive — registry owns it', v_jobid;

  -- ── (4) read-back — RAISE on any miss ─────────────────────────────────────
  SELECT deadline_rule INTO v_got FROM public.job_registry
   WHERE job = 'agency-staffing-rollup-refresh' AND runner = 'pg_cron' AND pipeline = 'agency_staffing_rollup_refresh'
     AND unit_shape = 'atomic' AND unit_call = 'CALL public.refresh_agency_staffing_rollup();'
     AND priority = 3 AND cost_class = 'memory' AND cap_mb = 128 AND exclusion_group = 'rollups'
     AND budget_seconds = 3600 AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL
     AND by_window_minutes IS NULL AND yield_to = '{}' AND yield_lead_seconds = 0 AND NOT idempotent_refire
     AND anchor_cadence IS NULL;
  IF v_got IS DISTINCT FROM 'by 5 0 * * 2' THEN
    v_missing := v_missing || format('agency-staffing-rollup-refresh rule %L (the row''s other columns unchanged?)', v_got);
  END IF;
  SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = 'agency_staffing_rollup_refresh';
  IF v_n <> 1 THEN
    v_missing := v_missing || format('%s registry rows on agency_staffing_rollup_refresh (rule 378: a second row needs anchor_cadence)', v_n);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'agency_staffing_rollup_refresh'
                    AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%')
                         OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%'
                    AND note LIKE '%agency-staffing-rollup-refresh RETURNED 2026-10-31 (FIX-1369)%') THEN
    v_missing := v_missing || 'agency_staffing_rollup_refresh hold row (FIX-1311''s hold + the FIX-1369 note)';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agency-staffing-rollup-refresh' AND active) THEN
    v_missing := v_missing || 'cron agency-staffing-rollup-refresh active';
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
    RAISE EXCEPTION '[fix1369] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- The pick's arithmetic, read the way step 6 reads it (anchor_cadence NULL).
  SELECT completed_at INTO v_last FROM public.data_sync_log
   WHERE pipeline = 'agency_staffing_rollup_refresh' AND status IN ('complete', 'partial') AND completed_at IS NOT NULL
   ORDER BY completed_at DESC LIMIT 1;
  v_prev := public.cron_prev_slot('5 0 * * 2', now());
  v_next := public.cron_next_slot('5 0 * * 2', now());
  RAISE NOTICE '[fix1369] read-back ok: agency-staffing-rollup-refresh % (prev % / next %); its last complete|partial %; %; md5 % / % / % / %',
    v_got, v_prev, v_next, v_last,
    CASE WHEN v_last IS NULL OR v_last < v_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_prev - now()) || ')'
         ELSE 'next due ' || v_next END,
    v_md5_d, v_md5_g, v_md5_b, v_md5_p;

  -- The mode the body will pick, with the body's own inputs (20261003030000).
  SELECT md5(prosrc) INTO v_md5_a FROM pg_proc
   WHERE proname = 'refresh_agency_staffing_rollup' AND pronamespace = 'public'::regnamespace;
  SELECT value INTO v_state FROM public.pipeline_state WHERE key = 'agency_staffing_watermark';
  v_w_fr := (v_state->>'fr_last_indexed_at')::timestamptz;
  v_w_ec := (v_state->>'ec_last_indexed_at')::timestamptz;
  v_h    := public.fr_watermark_horizon();
  v_mode := CASE WHEN v_w_fr IS NULL OR v_w_ec IS NULL THEN 'full'
                 WHEN v_h - v_w_fr > interval '14 days' THEN 'full'
                 ELSE 'incremental' END;
  SELECT count(*) INTO v_agencies FROM public.agencies;
  RAISE NOTICE '[fix1369] mode now: % (watermark fr % / ec %, horizon %, lag % vs c_full_lag 14 days — a body constant); agencies % → % chunk(s) of 50 when full; body md5 % %',
    v_mode, v_w_fr, v_w_ec, v_h, v_h - v_w_fr, v_agencies, ceil(v_agencies / 50.0), v_md5_a,
    CASE WHEN v_md5_a = 'c2802f128d566bc068d8fab1175277b1' THEN '(the body this arithmetic copies)'
         ELSE '(NOT c2802f12… — read the body before trusting this line)' END;

  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_head := (SELECT headroom_target_mb FROM public.platform_dials WHERE id);
  IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
    v_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
  END IF;
  RAISE NOTICE '[fix1369] headroom now: %',
    CASE WHEN v_avail IS NULL THEN 'mirror stale or absent — the test is skipped (fail-open)'
         WHEN v_avail - 128 < v_head THEN format('%s MB avail − 128 MB cap = %s < %s MB → excluded (headroom) until MemAvailable ≥ %s',
                                                 v_avail, v_avail - 128, v_head, 128 + v_head)
         ELSE format('%s MB avail − 128 MB cap = %s ≥ %s MB → admitted', v_avail, v_avail - 128, v_head) END;
END $$;
