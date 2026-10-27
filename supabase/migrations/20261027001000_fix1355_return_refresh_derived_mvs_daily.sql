-- =============================================================================
-- FIX-1355 — RETURN refresh-derived-mvs-daily through job_registry as
-- `by 0 6 * * *` (its cron slot), the last parked daily; and the shared
-- refresh_derived_mvs hold row → cadence_hours 24 on the canary's verdict.
-- cc-251, 2026-10-26.
--
-- NEEDS 20261027000000_fix1354_box_gate_memory_rules.sql (the same push,
-- first). This row's cap_mb 256 is the largest in the registry, so under the
-- headroom test it is the FIRST row the test excludes when the box is tight.
-- That is why it lands behind it: at headroom_target_mb 150 it arms only when
-- MemAvailable is ≥ 406 MB (10-26's median gate reading was 387, cc-251 M1), so
-- on a tight box the headroom test, not the 06:00 slot, decides its hour. The
-- read-back asserts the FIX-1354 bodies are in place.
--
-- WHY NOW. The daily was parked by cc-232 (FIX-1311, 20261013230000) for the
-- dispatcher cutover. cc-249 withdrew its RETURN after Sunday's incident
-- (cc-250 §6), and Craig moved it here, behind the memory rules (Cowork 10-25,
-- #2).
--
-- THE CLOCK AT THE PUSH (cc-251 read 3, prod 10-26 23:48Z):
-- refresh_derived_mvs last complete|partial = the 10-13 daily (06:00:00.10 →
-- 06:04:07.19Z). The weekly shares the pipeline and is parked; its last row is
-- the 10-13 00:47Z `reaped`. `by 0 6 * * *` prev slot = Mon 10-26 06:00Z >
-- last, so it is DUE at the push, priority 2, ttd ≈ −18 h. It arms on the first
-- tick where nothing excludes it: headroom (above), the census, the claim.
-- Budget 5400 (the one-shot's cron_job_budget row). In the cron era p50 /
-- max were 354.8 / 1,207.6 s, 13 units.
--
-- WHAT, in one DO block (the fix1334 shape, 20261020001000:124-143):
--   (1) refresh-derived-mvs-daily `at 0 6 * * *` → `by 0 6 * * *`, matched on
--       the old text; "already returned" NOTICE on `by 0 6 * * *`; anything
--       else RAISEs naming the rule it read. Every other column stays the seed
--       row's (asserted in the read-back): gates {prod_session}, priority 2,
--       cost_class mixed, cap_mb 256, exclusion_group mvs, budget_seconds
--       5400, unit_shape atomic, phase_lock false, by_window_minutes NULL,
--       yield_to '{}'.
--   (2) the rollup_watch_overrides row for refresh_derived_mvs CONVERTS (never
--       deleted, rule 289): held_since / hold_reason NULL, cadence_hours 24.
--       The fix1316 three-way guard applies (20261016230000:929-951). The row
--       is SHARED with the weekly (20261013230000:102-125): the weekly stays
--       parked, and the daily's cadence is the one the canary now watches.
--       The canary's verdict (cc-251 read 7, check_pipeline_rate_regression()
--       at 23:5xZ): {"verdict": "ok", "escalates": false, "recent_runs": 3,
--       "baseline_runs": 74, "worst_case_ratio": 0.09, "threshold_s_per_1k":
--       423932.7577, "recent_min_s_per_1k": 19006.2637}. recent_min / threshold
--       = 0.045 < 0.9, so it converts (rule 342's shape).
--   (3) one owner: cron refresh-derived-mvs-daily (jobid 9, parked by cc-232)
--       asserted inactive by NAME (FIX-946). The registry owns it. Two owners
--       is a RAISE. No cron un-park, ever.
--   (4) a read-back that RAISEs on any miss: the rule and the unchanged
--       columns; the cron inactive; the hold row converted; the FIX-1354 md5
--       pins (this file touches no routine; it asserts the pair the first file
--       just wrote); the pick's arithmetic as a NOTICE: cron_prev_slot /
--       cron_next_slot for 0 6 * * * at now(), the last complete|partial, the
--       ttd → DUE now, and today's headroom reading for a 256-cap row.
--
-- NON-ADVANCING EXITS (rule 302), refresh_derived_mvs('daily')
-- (20261004075000:469): peer_wait_gate(ec rebuild, fe totals, 600) waits ≤ 600 s
-- and then PROCEEDS (it writes no row; it lands in the running row's metadata
-- only when it shaped the run); the shared advisory lock
-- hashtext('refresh_derived_mvs') → `skipped`; prod_session_state().defer →
-- `skipped`; the predictive budget 3300 s → `partial` with the skipped units
-- named. `SET work_mem = '128MB'` (plain SET, :548) gives each of the 13 units
-- 128 MB × hash_mem_multiplier 2 of hash headroom, which is where the cap_mb 256
-- comes from. The running row carries 'cadence', 'daily'; the terminal UPDATE
-- writes complete | partial | failed. No job band (bands.json:34 is the
-- rebuild_entity_search_index unit band), so receipts §9 reads no-band.
--
-- NETS: platform_dials.pause; the box skip, now including the swap ceiling and
-- the headroom test (FIX-1354); the prod_session gate; the 5400 s one-shot
-- budget row + the */2 cron-job-budget-watchdog; the procedure's own 3300 s
-- predictive budget; the postgres role's 3 h statement ceiling; the I6 re-arm
-- cooldown; the data revert below.
--
-- ROLLBACK (data): scripts/fix1355-revert-return-refresh-derived-mvs-daily.sql
-- puts the row back to `at 0 6 * * *`, and the hold row back to the cutover
-- hold only if it carries this file's note. The cron stays parked.
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_n       int;
  v_rule    text;
  v_row     public.rollup_watch_overrides%ROWTYPE;
  v_jobid   bigint;
  v_active  boolean;
  v_missing text[] := '{}';
  v_dy      text;
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
  -- ── (1) refresh-derived-mvs-daily: RETURN on its cron slot ────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 0 6 * * *',
         note          = note || '; RETURNED 2026-10-26 (FIX-1355, cc-251): by 0 6 * * * = its cron slot',
         updated_at    = now()
   WHERE job = 'refresh-derived-mvs-daily'
     AND deadline_rule = 'at 0 6 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1355] job_registry refresh-derived-mvs-daily: at 0 6 * * * → by 0 6 * * * (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'refresh-derived-mvs-daily';
    IF v_rule = 'by 0 6 * * *' THEN
      RAISE NOTICE '[fix1355] job_registry refresh-derived-mvs-daily already returned (by 0 6 * * *) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1355] job_registry refresh-derived-mvs-daily reads %, expected at 0 6 * * * or by 0 6 * * *',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) the shared hold row → a cadence declaration (converted, not deleted)
  UPDATE public.rollup_watch_overrides
     SET held_since    = NULL,
         hold_reason   = NULL,
         cadence_hours = 24,
         note          = 'FIX-1355 (cc-251) — refresh-derived-mvs-daily RETURNED via job_registry (by 0 6 * * *); '
                         'cadence_hours 24 mirrors the daily for the canary until it reads job_registry (FIX-1317). '
                         'Shared with refresh-derived-mvs-weekly, still parked. Converted on the canary''s verdict '
                         '(recent_min 19006.26 / threshold 423932.76 s/1k = 0.045 < 0.9). '
                         'Revert: scripts/fix1355-revert-return-refresh-derived-mvs-daily.sql',
         updated_at    = now()
   WHERE pipeline = 'refresh_derived_mvs'
     AND hold_reason LIKE 'parked for the dispatcher cutover (cc-232%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1355] rollup_watch_overrides refresh_derived_mvs: cutover hold → cadence_hours 24 (1 row)';
  ELSE
    SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'refresh_derived_mvs';
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1355] rollup_watch_overrides has no refresh_derived_mvs row — expected the cc-232 cutover hold';
    ELSIF v_row.held_since IS NULL AND v_row.cadence_hours = 24 THEN
      RAISE NOTICE '[fix1355] rollup_watch_overrides refresh_derived_mvs already a cadence row (24 h) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1355] refresh_derived_mvs override is not the cutover hold (held_since %, hold_reason %, cadence_hours %) — a human hold is resolved by a human',
        v_row.held_since, v_row.hold_reason, v_row.cadence_hours;
    END IF;
  END IF;

  -- ── (3) one owner: the daily's cron stays parked, by NAME (FIX-946) ───────
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'refresh-derived-mvs-daily';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1355] % cron.job rows named refresh-derived-mvs-daily — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'refresh-derived-mvs-daily';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[fix1355] cron refresh-derived-mvs-daily (jobid %) is active = % — the registry owns it; two owners', v_jobid, v_active;
  END IF;
  RAISE NOTICE '[fix1355] cron refresh-derived-mvs-daily (jobid %) inactive — registry owns it', v_jobid;

  -- ── (4) read-back — RAISE on any miss ─────────────────────────────────────
  SELECT deadline_rule INTO v_dy FROM public.job_registry
   WHERE job = 'refresh-derived-mvs-daily' AND runner = 'pg_cron' AND pipeline = 'refresh_derived_mvs'
     AND unit_shape = 'atomic' AND unit_call = 'CALL public.refresh_derived_mvs(''daily'');'
     AND priority = 2 AND cost_class = 'mixed' AND cap_mb = 256 AND exclusion_group = 'mvs'
     AND budget_seconds = 5400 AND gates = '{prod_session}' AND NOT phase_lock
     AND by_window_minutes IS NULL AND yield_to = '{}' AND NOT idempotent_refire;
  IF v_dy IS DISTINCT FROM 'by 0 6 * * *' THEN
    v_missing := v_missing || format('refresh-derived-mvs-daily rule %L (the seed row''s other columns unchanged?)', v_dy);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'refresh_derived_mvs' AND held_since IS NULL AND hold_reason IS NULL
                    AND retired_at IS NULL AND cadence_hours = 24 AND note LIKE 'FIX-1355 (cc-251)%') THEN
    v_missing := v_missing || 'refresh_derived_mvs hold row converted (cadence_hours 24, the FIX-1355 note)';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-derived-mvs-weekly' AND active) THEN
    v_missing := v_missing || 'cron refresh-derived-mvs-weekly is active (it stays parked)';
  END IF;

  -- The FIX-1354 bodies must be in place: this row lands behind the headroom test.
  SELECT md5(prosrc) INTO v_md5_b FROM pg_proc WHERE proname = 'box_is_saturated'      AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc WHERE proname = 'dispatch_one_unit'     AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_md5_b IS DISTINCT FROM 'ac8dbcddf71978e73d28c999433156b7'
     OR v_md5_d IS DISTINCT FROM '64c8271e7601095d275c68eff5187931'
     OR v_md5_g IS DISTINCT FROM '4c30523742e280a4b48ea2ec390654d6' THEN
    v_missing := v_missing || format('the FIX-1354 pins (20261027000000 first): box_is_saturated %s / dispatch_one_unit %s / get_dispatcher_status %s',
                                     v_md5_b, v_md5_d, v_md5_g);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1355] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- The pick's arithmetic, read the way step 6 reads it.
  SELECT completed_at INTO v_last FROM public.data_sync_log
   WHERE pipeline = 'refresh_derived_mvs' AND status IN ('complete', 'partial') AND completed_at IS NOT NULL
   ORDER BY completed_at DESC LIMIT 1;
  v_prev := public.cron_prev_slot('0 6 * * *', now());
  v_next := public.cron_next_slot('0 6 * * *', now());
  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_head := (SELECT headroom_target_mb FROM public.platform_dials WHERE id);
  IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
    v_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
  END IF;
  RAISE NOTICE '[fix1355] read-back ok: refresh-derived-mvs-daily % (prev % / next %); refresh_derived_mvs last complete|partial %; %; hold row cadence_hours 24; md5 % / % / %',
    v_dy, v_prev, v_next, v_last,
    CASE WHEN v_last IS NULL OR v_last < v_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_prev - now()) || ')'
         ELSE 'next due ' || v_next END,
    v_md5_b, v_md5_d, v_md5_g;
  RAISE NOTICE '[fix1355] headroom now: %',
    CASE WHEN v_avail IS NULL THEN 'mirror stale or absent — the test is skipped (fail-open)'
         WHEN v_avail - 256 < v_head THEN format('%s MB avail − 256 MB cap = %s < %s MB → excluded (headroom) until MemAvailable ≥ %s',
                                                 v_avail, v_avail - 256, v_head, 256 + v_head)
         ELSE format('%s MB avail − 256 MB cap = %s ≥ %s MB → admitted', v_avail, v_avail - 256, v_head) END;
END $$;
