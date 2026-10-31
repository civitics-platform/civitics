-- =============================================================================
-- FIX-1370 — RETURN group-donor-rollup-refresh through job_registry as
-- `by 10 3 * * 3` (its cron slot). The third file of the rollups-group chain
-- (cc-256, 2026-10-31; with FIX-1368 treemap and FIX-1369 agency-staffing in
-- one class-P push). Plan step s12b-9 (docs/cc/projects/dispatcher.md).
--
-- ITS OWN PIPELINE. group_donor_rollup_refresh has exactly one registry row
-- (rule 378, cc-256 read 3), so the row needs no anchor_cadence. The
-- read-back asserts the count.
--
-- THE BODY, ON PROD (cc-256 read 4(c), 2026-10-31 00:0xZ):
-- run_group_donor_rollup_refresh (md5 a656fca8…, 2,760 B, last CREATEd at
-- 20260911000100) takes an xact advisory lock, defers to a held prod session,
-- then CALLs refresh_group_donor_rollup() (md5 362d0579…, 5,561 B, last
-- CREATEd at 20261013010000, FIX-1296) and writes ONE terminal `complete` row
-- (cohorts, donor_rows, source pg_cron). The inner function is ATOMIC: one
-- transaction that DELETEs and re-INSERTs group_donor_rollup (top 200 donors
-- per cohort, FIX-501) and group_donor_rollup_summary, so readers keep the
-- prior snapshot until COMMIT and a cancel rolls back whole. work_mem 64MB is
-- an in-body `SET LOCAL` (FIX-1296), not a proconfig entry: proconfig carries
-- only search_path, and the read-back NOTICE reads the SET from prosrc. It
-- keeps no watermark and no dial (no group_donor% pipeline_state key on prod),
-- so one run is the whole catch-up.
--
--   THE BODY WRITES NO RUNNING ROW (cc-256 read 5). dispatch_one_unit
--   (20261029000000) still counts the dispatched one-shot live: step 5's
--   census takes every `armed` dispatch_log row with no reaped/missed row as
--   a unit (:541-548, :562-563), and also a client backend whose query CALLs
--   public.run_group_donor_rollup_refresh( (:570-577). Every job of a live
--   unit puts its exclusion_group in v_busy_groups (:603-606), so `group
--   busy: rollups` holds for the whole run. No body change is needed.
--
-- THE LAST RUNS: 10-07 03:10Z complete, 101 s, 581 cohorts, 47,208
-- donor_rows (the first run after FIX-501's top-200 cut; 09-30 stored
-- 543,815). 30-d p50/max 101.5 / 294.2 s; bands.json 0–442 s.
--
-- THE CLOCK AT THE PUSH: `10 3 * * 3` prev slot Wed 10-28 03:10Z, next Wed
-- 11-04 03:10Z. The last complete (10-07 03:11:41Z) is older than prev, so
-- the row is DUE at the push, ttd ≈ −2.9 d: the chain's latest slot, so it
-- arms third.
--
-- WHAT, in one DO block (fix1365's shape minus the dial):
--   (1) the row `at 10 3 * * 3` → `by 10 3 * * 3`, matched on the old text;
--       an "already returned" NOTICE on the `by` text; anything else RAISEs.
--   (2) the hold row is ASSERTED to be FIX-1311's takeover hold or the gated
--       push's own 'prod session held: …' hold (rule 385); only its note
--       grows. Conversion to cadence_hours 168 is batched into cc-259.
--   (3) one owner: cron group-donor-rollup-refresh (jobid 49 on prod)
--       inactive, by NAME, exactly one row (FIX-946). No un-park, ever.
--   (4) a read-back that RAISEs on any miss (the rule and every other column,
--       one registry row on the pipeline, the hold row, the cron row, the
--       four pins), then NOTICEs: the pick's arithmetic, the body's premise
--       (both md5s, the in-body work_mem, no running row), the last run's
--       counts, today's headroom for a 64-cap row.
--   No pipeline_state write.
--
-- NON-ADVANCING EXITS (rule 302): the xact advisory lock
-- hashtext('group_donor_rollup_refresh') held → a bare RETURN, NO row;
-- prod_session_state().defer → `skipped`. An error or a cancel rolls the
-- refresh back whole and writes no row (the reap reads `failed: …`).
--
-- NETS: the swap ceiling 1018 / headroom 150 (a 64-cap row needs MemAvailable
-- ≥ 214); the one-shot's 1800 s cron_job_budget row + the */2 watchdog (a
-- cancel is SAFE: DELETE, not TRUNCATE, in one transaction); group rollups;
-- max_concurrent_units 2; the I6 cooldown; platform_dials.pause; the data
-- revert below.
--
-- ROLLBACK (data):
-- scripts/fix1370-revert-return-group-donor-rollup-refresh.sql puts the row
-- back to `at 10 3 * * 3`, matched on `by 10 3 * * 3`. Nothing else: the hold
-- row's note stays, the cron stays parked.
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
  v_meta    jsonb;
  v_keys    text;
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
  v_md5_w   text;
  v_md5_r   text;
  v_src_w   text;
  v_src_r   text;
  v_cfg_r   text[];
  v_avail   int;
  v_head    int;
  v_box     jsonb;
BEGIN
  -- ── (1) group-donor-rollup-refresh: RETURN on its cron slot ───────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 10 3 * * 3',
         note          = note || '; RETURNED 2026-10-31 (FIX-1370, cc-256): by 10 3 * * 3 = its cron slot',
         updated_at    = now()
   WHERE job = 'group-donor-rollup-refresh'
     AND deadline_rule = 'at 10 3 * * 3';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1370] job_registry group-donor-rollup-refresh: at 10 3 * * 3 → by 10 3 * * 3 (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'group-donor-rollup-refresh';
    IF v_rule = 'by 10 3 * * 3' THEN
      RAISE NOTICE '[fix1370] job_registry group-donor-rollup-refresh already returned (by 10 3 * * 3) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1370] job_registry group-donor-rollup-refresh reads %, expected at 10 3 * * 3 or by 10 3 * * 3',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) the hold row: ASSERT FIX-1311's takeover hold; note only ──────────
  SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'group_donor_rollup_refresh';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1370] rollup_watch_overrides has no group_donor_rollup_refresh row — expected FIX-1311''s takeover hold';
  ELSIF NOT ((v_row.held_since IS NOT NULL
              AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
              AND v_row.cadence_hours IS NULL
              AND v_row.note LIKE 'FIX-1311 (cc-232)%')
             OR v_row.hold_reason LIKE 'prod session held: %')
        OR v_row.retired_at IS NOT NULL THEN
    RAISE EXCEPTION '[fix1370] group_donor_rollup_refresh override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
      v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
  END IF;
  UPDATE public.rollup_watch_overrides
     SET note       = note || '; group-donor-rollup-refresh RETURNED 2026-10-31 (FIX-1370) — hold kept, conversion to cadence_hours 168 owed (cc-259)',
         updated_at = now()
   WHERE pipeline = 'group_donor_rollup_refresh'
     AND note LIKE 'FIX-1311 (cc-232)%'
     AND note NOT LIKE '%group-donor-rollup-refresh RETURNED 2026-10-31 (FIX-1370)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1370] rollup_watch_overrides group_donor_rollup_refresh: FIX-1311''s hold kept (hold_reason %); note % (% row)',
    v_row.hold_reason, CASE WHEN v_n = 1 THEN 'appended' ELSE 'already carries the RETURN' END, v_n;

  -- ── (3) one owner: the cron stays parked, by NAME (FIX-946) ───────────────
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'group-donor-rollup-refresh';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1370] % cron.job rows named group-donor-rollup-refresh — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'group-donor-rollup-refresh';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[fix1370] cron group-donor-rollup-refresh (jobid %) is active = % — the registry owns it; two owners', v_jobid, v_active;
  END IF;
  RAISE NOTICE '[fix1370] cron group-donor-rollup-refresh (jobid %) inactive — registry owns it', v_jobid;

  -- ── (4) read-back — RAISE on any miss ─────────────────────────────────────
  SELECT deadline_rule INTO v_got FROM public.job_registry
   WHERE job = 'group-donor-rollup-refresh' AND runner = 'pg_cron' AND pipeline = 'group_donor_rollup_refresh'
     AND unit_shape = 'atomic' AND unit_call = 'CALL public.run_group_donor_rollup_refresh();'
     AND priority = 3 AND cost_class = 'memory' AND cap_mb = 64 AND exclusion_group = 'rollups'
     AND budget_seconds = 1800 AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL
     AND by_window_minutes IS NULL AND yield_to = '{}' AND yield_lead_seconds = 0 AND NOT idempotent_refire
     AND anchor_cadence IS NULL;
  IF v_got IS DISTINCT FROM 'by 10 3 * * 3' THEN
    v_missing := v_missing || format('group-donor-rollup-refresh rule %L (the row''s other columns unchanged?)', v_got);
  END IF;
  SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = 'group_donor_rollup_refresh';
  IF v_n <> 1 THEN
    v_missing := v_missing || format('%s registry rows on group_donor_rollup_refresh (rule 378: a second row needs anchor_cadence)', v_n);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'group_donor_rollup_refresh'
                    AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%')
                         OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%'
                    AND note LIKE '%group-donor-rollup-refresh RETURNED 2026-10-31 (FIX-1370)%') THEN
    v_missing := v_missing || 'group_donor_rollup_refresh hold row (FIX-1311''s hold + the FIX-1370 note)';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'group-donor-rollup-refresh' AND active) THEN
    v_missing := v_missing || 'cron group-donor-rollup-refresh active';
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
    RAISE EXCEPTION '[fix1370] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- The pick's arithmetic, read the way step 6 reads it (anchor_cadence NULL).
  SELECT completed_at, metadata INTO v_last, v_meta FROM public.data_sync_log
   WHERE pipeline = 'group_donor_rollup_refresh' AND status IN ('complete', 'partial') AND completed_at IS NOT NULL
   ORDER BY completed_at DESC LIMIT 1;
  v_prev := public.cron_prev_slot('10 3 * * 3', now());
  v_next := public.cron_next_slot('10 3 * * 3', now());
  RAISE NOTICE '[fix1370] read-back ok: group-donor-rollup-refresh % (prev % / next %); its last complete|partial % (cohorts %, donor_rows %); %; md5 % / % / % / %',
    v_got, v_prev, v_next, v_last, v_meta->>'cohorts', v_meta->>'donor_rows',
    CASE WHEN v_last IS NULL OR v_last < v_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_prev - now()) || ')'
         ELSE 'next due ' || v_next END,
    v_md5_d, v_md5_g, v_md5_b, v_md5_p;

  -- The body's premise: the wrapper and the refresh it CALLs, as read 4(c) read them.
  SELECT md5(prosrc), prosrc INTO v_md5_w, v_src_w FROM pg_proc
   WHERE proname = 'run_group_donor_rollup_refresh' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc), prosrc, proconfig INTO v_md5_r, v_src_r, v_cfg_r FROM pg_proc
   WHERE proname = 'refresh_group_donor_rollup' AND pronamespace = 'public'::regnamespace;
  SELECT string_agg(key, ', ' ORDER BY key) INTO v_keys FROM public.pipeline_state WHERE key LIKE 'group_donor%';
  RAISE NOTICE '[fix1370] body premise: wrapper md5 % %, refresh md5 % %; work_mem: in-body SET LOCAL 64MB %, proconfig %; the wrapper writes % running row; pipeline_state group_donor%% keys: %',
    v_md5_w, CASE WHEN v_md5_w = 'a656fca845af1414348c282ed2f29ccd' THEN '(as read)' ELSE '(NOT a656fca8… — read it)' END,
    v_md5_r, CASE WHEN v_md5_r = '362d05796d1c04d144aee259e3569590' THEN '(as read)' ELSE '(NOT 362d0579… — read it)' END,
    CASE WHEN position('SET LOCAL work_mem = ''64MB''' IN v_src_r) > 0 THEN 'present' ELSE 'ABSENT' END,
    COALESCE(v_cfg_r::text, '(none)'),
    CASE WHEN position('''running''' IN v_src_w) > 0 THEN 'a' ELSE 'no' END,
    COALESCE(v_keys, 'none');

  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_head := (SELECT headroom_target_mb FROM public.platform_dials WHERE id);
  IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
    v_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
  END IF;
  RAISE NOTICE '[fix1370] headroom now: %',
    CASE WHEN v_avail IS NULL THEN 'mirror stale or absent — the test is skipped (fail-open)'
         WHEN v_avail - 64 < v_head THEN format('%s MB avail − 64 MB cap = %s < %s MB → excluded (headroom) until MemAvailable ≥ %s',
                                                v_avail, v_avail - 64, v_head, 64 + v_head)
         ELSE format('%s MB avail − 64 MB cap = %s ≥ %s MB → admitted', v_avail, v_avail - 64, v_head) END;
END $$;
