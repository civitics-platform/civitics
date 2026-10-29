-- =============================================================================
-- FIX-1363 — RETURN refresh-derived-mvs-weekly through job_registry as
-- `by 47 0 * * 2` (its cron slot), behind the memory gate. It is the first of
-- the five parked weeklies to come back. cc-253, 2026-10-28. Plan step s12b-3
-- (docs/cc/projects/dispatcher.md).
--
-- NEEDS 20261029000000_fix1361_dispatcher_anchor_cadence_and_headroom_rung_after_live.sql
-- (the same push, first). The weekly shares refresh_derived_mvs with the
-- daily. Under the old anchor, the daily's 06:0xZ completion satisfies the
-- weekly's Tuesday slot, so a weekly the gate holds past 06:00Z lapses to the
-- next week and writes no row. FIX-1361 keys the weekly on its own
-- metadata.cadence rows (anchor_cadence 'weekly'). The read-back asserts that
-- body's pin and the column.
--
-- WHY THIS WEEKLY. jobid 10 is one of the two Tuesday weeklies that wedged
-- the box: the 10-13 00:47Z run is a reaped_orphan, its backend gone while
-- unit 1 chord_industry_flows_mv was in flight, on a box already at the swap
-- ceiling. The other, rule-taggers-weekly, has run clean under the dispatcher
-- since 10-20. Its two heavy units (chord_industry_flows_mv,
-- chord_donor_type_party_flows_mv) each hash the whole of financial_entities
-- under the body's `SET work_mem = '128MB'`. That was 256 MB per hash node
-- under hash_mem_multiplier 2 and is 128 MB since FIX-1356; a hash that no
-- longer fits spills to batches, which costs IO, not swap. Its cap_mb has been
-- 128 since FIX-1357, so the headroom test admits it at MemAvailable ≥ 278.
--
-- THE NETS that did not exist on 10-13: the swap ceiling 1018 and headroom 150
-- (FIX-1354); the halved hash peak (FIX-1356); the 5400 s cron_job_budget row
-- (FIX-1129) + the */2 cron-job-budget-watchdog; the procedure's own 4200 s
-- predictive budget and 900 s per-unit budget (enforce_derived_mvs_unit_budget);
-- max_concurrent_units 2; the I6 cooldown; platform_dials.pause; the data
-- revert below. The shared hold row is ALREADY a cadence row (cadence_hours
-- 24, FIX-1355): nothing to convert, and the weekly's cadence is not what the
-- canary watches (FIX-1317 later).
--
-- THE CLOCK AT THE PUSH (cc-253 read 3, prod 10-28 23:50Z): `47 0 * * 2` prev
-- slot Tue 10-27 00:47Z, next Tue 11-03 00:47Z. The weekly's own last
-- complete|partial is 10-06 01:10:27Z (6 units, 1,407.4 s; the 10-13 row is
-- the wedge), so it is DUE at the push, priority 3, ttd ≈ −2 d. It arms on the
-- first tick nothing excludes it: headroom (MemAvailable − 128 < 150), the
-- census (units: 2 live), group busy: mvs, the claim. Cron-era walls: July's
-- 07:00Z slot 1,053–2,781 s; 09-08 → 10-06 at 00:47Z 1,046–1,621 s.
--
-- WHAT, in one DO block (the fix1355 shape minus the hold conversion):
--   (1) refresh-derived-mvs-weekly `at 47 0 * * 2` → `by 47 0 * * 2`, matched
--       on the old text; an "already returned" NOTICE on the `by` text;
--       anything else RAISEs naming the rule it read.
--   (2) the shared rollup_watch_overrides row is ASSERTED to be FIX-1355's
--       cadence row (held_since / hold_reason NULL, or the gated push's own
--       'prod session held: …' hold; retired_at NULL, cadence_hours 24, note
--       LIKE 'FIX-1355 (cc-251)%'), and only its note gains
--       '; weekly RETURNED 2026-10-28 (FIX-1363)', so
--       list_scheduled_rollup_pipelines() readers see that both rows are
--       registry-owned. The prefix FIX-1355's revert keys on is kept.
--   (3) one owner: cron refresh-derived-mvs-weekly (jobid 10) inactive by
--       NAME, exactly one row (FIX-946); the daily's jobid 9 inactive. No cron
--       un-park, ever.
--   (4) a read-back that RAISEs on any miss: the rule and every other column
--       unchanged (cap_mb 128, anchor_cadence 'weekly' — the first file set
--       it); the cron rows; the three pins (dispatch_one_unit = FIX-1361's new
--       d6a9073b…, get_dispatcher_status and box_is_saturated unchanged). The
--       pick's arithmetic as a NOTICE: cron_prev_slot / cron_next_slot for
--       47 0 * * 2, the weekly's own last complete|partial (cadence-filtered,
--       the way step 6 now reads it), DUE NOW + ttd, and today's headroom
--       reading for a 128-cap row.
--
-- NON-ADVANCING EXITS (rule 302), refresh_derived_mvs('weekly'): the shared
-- advisory lock hashtext('refresh_derived_mvs') → `skipped` (the daily's run
-- holds it); prod_session_state().defer → `skipped`; the predictive budget
-- 4200 s → `partial` with the skipped units named (advancing: the pick reads
-- complete|partial). The running row carries 'cadence', 'weekly'. Six units:
-- chord_industry_flows_mv, chord_donor_type_party_flows_mv,
-- chord_donor_state_party_flows_mv, chord_subject_party_flows_mv,
-- official_sector_dollars_mv, refresh_spending_totals (10-06's unit_seconds
-- 414.3 / 379.7 / 369.8 / 6.2 / 97.3 / 139.9).
--
-- ROLLBACK (data): scripts/fix1363-revert-return-refresh-derived-mvs-weekly.sql
-- puts the row back to `at 47 0 * * 2`, matched on `by 47 0 * * 2`. The cron
-- stays parked, and the hold row is not touched: it is the daily's cadence
-- row.
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
  v_wk      text;
  v_last    timestamptz;
  v_prev    timestamptz;
  v_next    timestamptz;
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_avail   int;
  v_head    int;
  v_box     jsonb;
BEGIN
  -- ── (1) refresh-derived-mvs-weekly: RETURN on its cron slot ───────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 47 0 * * 2',
         note          = note || '; RETURNED 2026-10-28 (FIX-1363, cc-253): by 47 0 * * 2 = its cron slot',
         updated_at    = now()
   WHERE job = 'refresh-derived-mvs-weekly'
     AND deadline_rule = 'at 47 0 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1363] job_registry refresh-derived-mvs-weekly: at 47 0 * * 2 → by 47 0 * * 2 (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'refresh-derived-mvs-weekly';
    IF v_rule = 'by 47 0 * * 2' THEN
      RAISE NOTICE '[fix1363] job_registry refresh-derived-mvs-weekly already returned (by 47 0 * * 2) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1363] job_registry refresh-derived-mvs-weekly reads %, expected at 47 0 * * 2 or by 47 0 * * 2',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) the shared hold row: ASSERT FIX-1355's cadence row; note only ─────
  -- A gated push holds every guarded pipeline for its claim
  -- (packages/data/src/lib/prod-session.ts setGuardedHolds: held_since now(),
  -- hold_reason 'prod session held: <reason>'; the release clears exactly
  -- those). So inside the push this row carries the session's OWN hold, which
  -- is not a human's. The first push of this file (cc-253, 00:18:16Z) refused
  -- on it and rolled back.
  SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'refresh_derived_mvs';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1363] rollup_watch_overrides has no refresh_derived_mvs row — expected FIX-1355''s cadence row';
  ELSIF NOT ((v_row.held_since IS NULL AND v_row.hold_reason IS NULL)
             OR v_row.hold_reason LIKE 'prod session held: %')
        OR v_row.retired_at IS NOT NULL
        OR v_row.cadence_hours IS DISTINCT FROM 24 OR v_row.note NOT LIKE 'FIX-1355 (cc-251)%' THEN
    RAISE EXCEPTION '[fix1363] refresh_derived_mvs override is not FIX-1355''s cadence row (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
      v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
  END IF;
  UPDATE public.rollup_watch_overrides
     SET note       = note || '; weekly RETURNED 2026-10-28 (FIX-1363)',
         updated_at = now()
   WHERE pipeline = 'refresh_derived_mvs'
     AND note LIKE 'FIX-1355 (cc-251)%'
     AND note NOT LIKE '%weekly RETURNED 2026-10-28 (FIX-1363)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1363] rollup_watch_overrides refresh_derived_mvs: FIX-1355''s cadence row (24 h) kept; note % (% row)',
    CASE WHEN v_n = 1 THEN 'appended' ELSE 'already carries the weekly' END, v_n;

  -- ── (3) one owner: both crons stay parked, by NAME (FIX-946) ──────────────
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'refresh-derived-mvs-weekly';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1363] % cron.job rows named refresh-derived-mvs-weekly — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'refresh-derived-mvs-weekly';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[fix1363] cron refresh-derived-mvs-weekly (jobid %) is active = % — the registry owns it; two owners', v_jobid, v_active;
  END IF;
  RAISE NOTICE '[fix1363] cron refresh-derived-mvs-weekly (jobid %) inactive — registry owns it', v_jobid;

  -- ── (4) read-back — RAISE on any miss ─────────────────────────────────────
  SELECT deadline_rule INTO v_wk FROM public.job_registry
   WHERE job = 'refresh-derived-mvs-weekly' AND runner = 'pg_cron' AND pipeline = 'refresh_derived_mvs'
     AND unit_shape = 'atomic' AND unit_call = 'CALL public.refresh_derived_mvs(''weekly'');'
     AND priority = 3 AND cost_class = 'mixed' AND cap_mb = 128 AND exclusion_group = 'mvs'
     AND budget_seconds = 5400 AND gates = '{prod_session}' AND NOT phase_lock
     AND by_window_minutes IS NULL AND yield_to = '{}' AND NOT idempotent_refire
     AND anchor_cadence = 'weekly';
  IF v_wk IS DISTINCT FROM 'by 47 0 * * 2' THEN
    v_missing := v_missing || format('refresh-derived-mvs-weekly rule %L (the row''s other columns unchanged, anchor_cadence weekly?)', v_wk);
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-derived-mvs-daily' AND active) THEN
    v_missing := v_missing || 'cron refresh-derived-mvs-daily is active (it stays parked)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'refresh_derived_mvs'
                    AND ((held_since IS NULL AND hold_reason IS NULL) OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours = 24 AND note LIKE 'FIX-1355 (cc-251)%'
                    AND note LIKE '%weekly RETURNED 2026-10-28 (FIX-1363)%') THEN
    v_missing := v_missing || 'refresh_derived_mvs hold row (FIX-1355''s cadence row + the FIX-1363 note)';
  END IF;

  -- FIX-1361's body must be in place: the weekly needs its own anchor.
  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_md5_b IS DISTINCT FROM 'ac8dbcddf71978e73d28c999433156b7'
     OR v_md5_d IS DISTINCT FROM c_pin_d
     OR v_md5_g IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6' THEN
    v_missing := v_missing || format('the pins (20261029000000 first): box_is_saturated %s / dispatch_one_unit %s (expected %s) / get_dispatcher_status %s',
                                     v_md5_b, v_md5_d, c_pin_d, v_md5_g);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1363] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- The pick's arithmetic, read the way step 6 now reads it (FIX-1361).
  SELECT completed_at INTO v_last FROM public.data_sync_log
   WHERE pipeline = 'refresh_derived_mvs' AND status IN ('complete', 'partial') AND completed_at IS NOT NULL
     AND metadata->>'cadence' = 'weekly'
   ORDER BY completed_at DESC LIMIT 1;
  v_prev := public.cron_prev_slot('47 0 * * 2', now());
  v_next := public.cron_next_slot('47 0 * * 2', now());
  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_head := (SELECT headroom_target_mb FROM public.platform_dials WHERE id);
  IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
    v_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
  END IF;
  RAISE NOTICE '[fix1363] read-back ok: refresh-derived-mvs-weekly % (prev % / next %); its own last complete|partial %; %; md5 % / % / %',
    v_wk, v_prev, v_next, v_last,
    CASE WHEN v_last IS NULL OR v_last < v_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_prev - now()) || ')'
         ELSE 'next due ' || v_next END,
    v_md5_b, v_md5_d, v_md5_g;
  RAISE NOTICE '[fix1363] headroom now: %',
    CASE WHEN v_avail IS NULL THEN 'mirror stale or absent — the test is skipped (fail-open)'
         WHEN v_avail - 128 < v_head THEN format('%s MB avail − 128 MB cap = %s < %s MB → excluded (headroom) until MemAvailable ≥ %s',
                                                 v_avail, v_avail - 128, v_head, 128 + v_head)
         ELSE format('%s MB avail − 128 MB cap = %s ≥ %s MB → admitted', v_avail, v_avail - 128, v_head) END;
END $$;
