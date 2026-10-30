-- =============================================================================
-- FIX-1365 — RETURN donor-party-rollup-refresh through job_registry as
-- `by 0 15 * * 2` (its cron slot), crawl-first. The second of the five parked
-- weeklies to come back. cc-254, 2026-10-30. Plan step s12b-4
-- (docs/cc/projects/dispatcher.md).
--
-- ITS OWN PIPELINE. donor_party_rollup_refresh has exactly one registry row
-- (rule 378, read 3(a)), so a running row of it can only be this job's and
-- the row needs no anchor_cadence (OPERATIONS: only a row that shares its
-- pipeline does). The read-back asserts the count.
--
-- WHY THIS WEEKLY. jobid 17 (parked 10-13 23:32Z by FIX-1311) is the cheapest
-- of the four weeklies left in steady state: crawl-mode firings 67.9 s /
-- 78.8 s on 09-29 / 10-06 (bands.json 0–119 s). Its row is ready: resumable,
-- priority 3, memory, cap_mb 64 (FIX-1357), group rollups (exclusive with
-- donor-rollup and the sweeps), budget_seconds 1800, gates {prod_session}.
--
-- THE MODE, ON PROD (cc-254 read 3, 2026-10-30 00:22Z). The body
-- refresh_donor_party_rollup_incremental (md5 7bf24bc1…, last CREATEd at
-- 20261010010000:378; prod = clone) picks the windowed FULL rebuild when
--     lag = LEAST(max(financial_relationships.updated_at), fr_watermark_horizon())
--           − donor_party_rollup_watermark.last_indexed_at
-- exceeds pipeline_state.donor_party_crawl.full_rebuild_lag_days (14 when the
-- key is absent), and CRAWLS otherwise. On prod: FR max 2026-10-25 22:51:26Z,
-- horizon 10-29 23:22Z, watermark 2026-10-10 23:57:47Z (the 10-13 15:00Z crawl
-- ended `partial` at its 40-unit cap) → lag 14 d 22:53:39. The dial reads
-- {"full_rebuild_lag_days": 30}, written 2026-09-30 02:41:29Z by FIX-1249
-- (cc-174) → CRAWL. At the absent-key default of 14 it would be FULL.
--
--   The trap the dial keeps the row out of: under a `by` row a resumable gets
--   ONE CALL per slot (a `partial` advances the clock: the row is not due
--   again until the next Tuesday), the CALL stops at its 1500 s unit budget,
--   and a full-rebuild cursor is discarded at c_cycle_max_age 22 days, i.e.
--   after 3 CALLs. The windowed path has never run on prod (the 09-22
--   one-statement rebuild took 11,278 s; prod cold IO runs 10–60× the
--   clone's 311 s cycle), so a cycle that needs more than 3 Tuesdays never
--   completes and the watermark never moves: FIX-1216's trap in a new coat.
--   The crawl has no cursor and no expiry. Every slice COMMITs its rows AND
--   its watermark, and a budget-capped `partial` resumes next Tuesday from
--   the watermark.
--
--   The prompt (cc-254) took the key to be absent and moved the dial 14 → 35.
--   Read 3 found 30. Craig, 10-30: keep 30, no write. So this file ASSERTS the
--   dial and writes no pipeline_state. A park of up to 30 days crawls; a
--   longer one still rebuilds (FIX-1249 sized 30 above the 3-firing cycle).
--
-- THE BACKLOG (read 3(e), prod): 565,260 FR rows updated in
-- (watermark, target]. The slice bound counts EVERY FR row (LIMIT slice_rows
-- 50,000), so 12 slices, under max_units 40. 21,210 of those rows pass the
-- slice's dirty predicate (donation, financial_entity → official; 23,686 in
-- financial_relationships_donor_rollup_dirty_idx, which also holds ie_*):
-- 15,324 distinct donors of the rollup's 2,737,798 (0.56 %).
--
-- THE CLOCK AT THE PUSH: `0 15 * * 2` prev slot Tue 10-27 15:00Z, next Tue
-- 11-03 15:00Z; the pipeline's last complete|partial is 10-13 15:00:48Z, older
-- than prev → DUE at the push, ttd ≈ −2.4 d. It arms on the first tick that
-- nothing excludes it: headroom (MemAvailable − 64 < 150), units:,
-- group busy: rollups, gated: prod_session.
--
-- WHAT, in one DO block (fix1363's shape; no hold conversion):
--   (1) the row `at 0 15 * * 2` → `by 0 15 * * 2`, matched on the old text;
--       an "already returned" NOTICE on the `by` text; anything else RAISEs.
--   (2) the dial and the cursor, ASSERTED and not written: donor_party_crawl
--       reads full_rebuild_lag_days 30 (else RAISE: someone moved it, and the
--       mode arithmetic above no longer holds), and there is no
--       donor_party_full_rebuild cursor (else RAISE: a windowed cycle is
--       open, and under a `by` row it would get one CALL per Tuesday).
--   (3) the hold row is ASSERTED to be FIX-1311's takeover hold (held_since
--       set, hold_reason 'parked for the dispatcher cutover…', cadence_hours
--       NULL, note LIKE 'FIX-1311 (cc-232)%') or the gated push's own
--       'prod session held: …' hold. It cannot be the latter, because the
--       claim's setGuardedHolds() skips a row that is already held, but the
--       guard admits it rather than RAISE on it (cc-253). Only its note grows.
--       It stays a hold: a catch-up that spans Tuesdays would read stale to
--       the canary against a 168 h cadence (check_rollup_freshness at 168 h,
--       read 4: 561.4 h since the 10-06 complete). The conversion is owed
--       with the catch-up's receipt.
--   (4) one owner: cron donor-party-rollup-refresh (jobid 17 on prod)
--       inactive, by NAME, exactly one row (FIX-946). No un-park, ever.
--   (5) a read-back that RAISEs on any miss: the rule and every other column,
--       exactly one registry row on the pipeline, the hold row's shape and
--       note, the four pins. Printed as NOTICEs: the pick's arithmetic
--       (prev / next slot, the last complete|partial, DUE NOW + ttd), the
--       mode the body picks now with its inputs, the slice-bound and
--       dirty-index FR counts, and today's headroom for a 64-cap row.
--
-- NON-ADVANCING EXITS (rule 302): the advisory lock
-- hashtext('donor_party_rollup_refresh') held → `skipped`;
-- prod_session_state().defer → `skipped`. A budget- or unit-capped crawl is
-- `partial` with its watermark moved (advancing: the pick reads
-- complete|partial); a slice error is `failed`.
--
-- NETS: the swap ceiling 1018 / headroom 150 (a 64-cap row needs MemAvailable
-- ≥ 214); the 1800 s cron_job_budget row + the */2 watchdog; the body's
-- unit_budget_seconds 1500 / max_units 40 (every slice COMMITs; a cancel keeps
-- the watermark); max_concurrent_units 2; the I6 cooldown;
-- platform_dials.pause; the data revert below.
--
-- ROLLBACK (data): scripts/fix1365-revert-return-donor-party-rollup.sql puts
-- the row back to `at 0 15 * * 2`, matched on `by 0 15 * * 2`. Nothing else:
-- no dial was written (30 is FIX-1249's), the hold row's note stays, the cron
-- stays parked.
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  c_pin_d CONSTANT text := 'd6a9073bcc4d9084b9d7994324a89b18';
  v_n       int;
  v_rule    text;
  v_cfg     jsonb;
  v_cursor  jsonb;
  v_row     public.rollup_watch_overrides%ROWTYPE;
  v_jobid   bigint;
  v_active  boolean;
  v_missing text[] := '{}';
  v_got     text;
  v_last    timestamptz;
  v_prev    timestamptz;
  v_next    timestamptz;
  v_wm      timestamptz;
  v_target  timestamptz;
  v_lag     interval;
  v_full    interval;
  v_mode    text;
  v_fr_rows bigint;
  v_dirty   bigint;
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
  v_md5_i   text;
  v_avail   int;
  v_head    int;
  v_box     jsonb;
BEGIN
  -- ── (1) donor-party-rollup-refresh: RETURN on its cron slot ───────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 0 15 * * 2',
         note          = note || '; RETURNED 2026-10-30 (FIX-1365, cc-254): by 0 15 * * 2 = its cron slot; crawl-first (full_rebuild_lag_days 30, FIX-1249)',
         updated_at    = now()
   WHERE job = 'donor-party-rollup-refresh'
     AND deadline_rule = 'at 0 15 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1365] job_registry donor-party-rollup-refresh: at 0 15 * * 2 → by 0 15 * * 2 (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'donor-party-rollup-refresh';
    IF v_rule = 'by 0 15 * * 2' THEN
      RAISE NOTICE '[fix1365] job_registry donor-party-rollup-refresh already returned (by 0 15 * * 2) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1365] job_registry donor-party-rollup-refresh reads %, expected at 0 15 * * 2 or by 0 15 * * 2',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) the dial and the cursor: ASSERTED, not written ────────────────────
  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'donor_party_crawl';
  IF v_cfg IS NULL OR (v_cfg->>'full_rebuild_lag_days') IS DISTINCT FROM '30' THEN
    RAISE EXCEPTION '[fix1365] pipeline_state donor_party_crawl reads %, expected full_rebuild_lag_days 30 (FIX-1249; cc-254 read 3) — the mode arithmetic in this file no longer holds',
      COALESCE(v_cfg::text, '(no row: the body defaults to 14)');
  END IF;
  RAISE NOTICE '[fix1365] pipeline_state donor_party_crawl % — full_rebuild_lag_days 30 asserted, not written', v_cfg;

  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = 'donor_party_full_rebuild';
  IF FOUND THEN
    RAISE EXCEPTION '[fix1365] a donor_party_full_rebuild cursor is open (%): a windowed cycle under a by row gets one CALL per slot and is discarded at 22 days — resolve it before the RETURN',
      v_cursor;
  END IF;

  -- ── (3) the hold row: ASSERT FIX-1311's takeover hold; note only ──────────
  SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'donor_party_rollup_refresh';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1365] rollup_watch_overrides has no donor_party_rollup_refresh row — expected FIX-1311''s takeover hold';
  ELSIF NOT ((v_row.held_since IS NOT NULL
              AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
              AND v_row.cadence_hours IS NULL
              AND v_row.note LIKE 'FIX-1311 (cc-232)%')
             OR v_row.hold_reason LIKE 'prod session held: %')
        OR v_row.retired_at IS NOT NULL THEN
    RAISE EXCEPTION '[fix1365] donor_party_rollup_refresh override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
      v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
  END IF;
  UPDATE public.rollup_watch_overrides
     SET note       = note || '; donor-party RETURNED 2026-10-30 (FIX-1365) — hold kept, conversion to cadence_hours 168 owed with the catch-up receipt',
         updated_at = now()
   WHERE pipeline = 'donor_party_rollup_refresh'
     AND note LIKE 'FIX-1311 (cc-232)%'
     AND note NOT LIKE '%donor-party RETURNED 2026-10-30 (FIX-1365)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1365] rollup_watch_overrides donor_party_rollup_refresh: FIX-1311''s hold kept (hold_reason %); note % (% row)',
    v_row.hold_reason, CASE WHEN v_n = 1 THEN 'appended' ELSE 'already carries the RETURN' END, v_n;

  -- ── (4) one owner: the cron stays parked, by NAME (FIX-946) ───────────────
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'donor-party-rollup-refresh';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1365] % cron.job rows named donor-party-rollup-refresh — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'donor-party-rollup-refresh';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[fix1365] cron donor-party-rollup-refresh (jobid %) is active = % — the registry owns it; two owners', v_jobid, v_active;
  END IF;
  RAISE NOTICE '[fix1365] cron donor-party-rollup-refresh (jobid %) inactive — registry owns it', v_jobid;

  -- ── (5) read-back — RAISE on any miss ─────────────────────────────────────
  SELECT deadline_rule INTO v_got FROM public.job_registry
   WHERE job = 'donor-party-rollup-refresh' AND runner = 'pg_cron' AND pipeline = 'donor_party_rollup_refresh'
     AND unit_shape = 'resumable' AND unit_call = 'CALL public.refresh_donor_party_rollup_incremental();'
     AND priority = 3 AND cost_class = 'memory' AND cap_mb = 64 AND exclusion_group = 'rollups'
     AND budget_seconds = 1800 AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL
     AND by_window_minutes IS NULL AND yield_to = '{}' AND NOT idempotent_refire
     AND anchor_cadence IS NULL;
  IF v_got IS DISTINCT FROM 'by 0 15 * * 2' THEN
    v_missing := v_missing || format('donor-party-rollup-refresh rule %L (the row''s other columns unchanged?)', v_got);
  END IF;
  SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = 'donor_party_rollup_refresh';
  IF v_n <> 1 THEN
    v_missing := v_missing || format('%s registry rows on donor_party_rollup_refresh (rule 378: a second row needs anchor_cadence)', v_n);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'donor_party_rollup_refresh'
                    AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%')
                         OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%'
                    AND note LIKE '%donor-party RETURNED 2026-10-30 (FIX-1365)%') THEN
    v_missing := v_missing || 'donor_party_rollup_refresh hold row (FIX-1311''s hold + the FIX-1365 note)';
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
    RAISE EXCEPTION '[fix1365] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- The pick's arithmetic, read the way step 6 reads it (anchor_cadence NULL).
  SELECT completed_at INTO v_last FROM public.data_sync_log
   WHERE pipeline = 'donor_party_rollup_refresh' AND status IN ('complete', 'partial') AND completed_at IS NOT NULL
   ORDER BY completed_at DESC LIMIT 1;
  v_prev := public.cron_prev_slot('0 15 * * 2', now());
  v_next := public.cron_next_slot('0 15 * * 2', now());
  RAISE NOTICE '[fix1365] read-back ok: donor-party-rollup-refresh % (prev % / next %); its last complete|partial %; %; md5 % / % / % / %',
    v_got, v_prev, v_next, v_last,
    CASE WHEN v_last IS NULL OR v_last < v_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_prev - now()) || ')'
         ELSE 'next due ' || v_next END,
    v_md5_d, v_md5_g, v_md5_b, v_md5_p;

  -- The mode the body will pick, with the body's own inputs (20261010010000:477-528).
  SELECT md5(prosrc) INTO v_md5_i FROM pg_proc
   WHERE proname = 'refresh_donor_party_rollup_incremental' AND pronamespace = 'public'::regnamespace;
  SELECT (value->>'last_indexed_at')::timestamptz INTO v_wm FROM public.pipeline_state WHERE key = 'donor_party_rollup_watermark';
  SELECT max(updated_at) INTO v_target FROM public.financial_relationships;
  v_target := LEAST(v_target, public.fr_watermark_horizon());
  v_lag    := v_target - v_wm;
  v_full := make_interval(days => GREATEST(COALESCE((v_cfg->>'full_rebuild_lag_days')::int, 14), 1));
  v_mode := CASE WHEN v_wm IS NULL THEN 'bootstrap'
                 WHEN v_lag > v_full THEN 'full'
                 ELSE 'crawl' END;
  IF v_wm IS NOT NULL THEN
    SELECT count(*) INTO v_fr_rows FROM public.financial_relationships
     WHERE updated_at > v_wm AND updated_at <= v_target;
    SELECT count(*) INTO v_dirty FROM public.financial_relationships
     WHERE to_type = 'official' AND from_type = 'financial_entity'
       AND relationship_type IN ('donation', 'ie_support', 'ie_oppose')
       AND updated_at > v_wm AND updated_at <= v_target;
  END IF;
  RAISE NOTICE '[fix1365] mode now: % (watermark %, target %, lag % vs full_rebuild_lag %; body md5 % %); FR rows in range % → % slice(s) of 50,000 (max_units 40); dirty-index rows %',
    v_mode, v_wm, v_target, v_lag, v_full, v_md5_i,
    CASE WHEN v_md5_i = '7bf24bc1476db8e0e82b7cf4afb6a280' THEN '(the body this arithmetic copies)'
         ELSE '(NOT 7bf24bc1… — read the body before trusting this line)' END,
    v_fr_rows, ceil(v_fr_rows / 50000.0), v_dirty;

  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_head := (SELECT headroom_target_mb FROM public.platform_dials WHERE id);
  IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
    v_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
  END IF;
  RAISE NOTICE '[fix1365] headroom now: %',
    CASE WHEN v_avail IS NULL THEN 'mirror stale or absent — the test is skipped (fail-open)'
         WHEN v_avail - 64 < v_head THEN format('%s MB avail − 64 MB cap = %s < %s MB → excluded (headroom) until MemAvailable ≥ %s',
                                                v_avail, v_avail - 64, v_head, 64 + v_head)
         ELSE format('%s MB avail − 64 MB cap = %s ≥ %s MB → admitted', v_avail, v_avail - 64, v_head) END;
END $$;
