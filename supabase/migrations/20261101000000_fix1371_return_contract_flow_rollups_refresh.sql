-- =============================================================================
-- FIX-1371 — RETURN contract-flow-rollups-refresh through job_registry as
-- `by 0 14 * * 4` (its cron slot). The last parked weekly (cc-257, plan step
-- s12b-10 in docs/cc/projects/dispatcher.md). One class-P push of this one
-- file; no routine, no dial.
--
-- WHAT, in one DO block (fix1368's shape):
--   (1) the row `at 0 14 * * 4` → `by 0 14 * * 4`, matched on the old text;
--       an "already returned" NOTICE on the `by` text; anything else RAISEs.
--       The note carries the UTC date of the apply, not a literal.
--   (2) the hold row is ASSERTED to be FIX-1311's takeover hold (held_since
--       set, hold_reason 'parked for the dispatcher cutover…', cadence_hours
--       NULL, note LIKE 'FIX-1311 (cc-232)%') or the gated push's own 'prod
--       session held: …' hold (rule 385). Only its note grows. It stays a
--       hold: the conversion to cadence_hours 168 is owed after the Thu 11-05
--       14:00Z slot.
--   (3) one owner: cron contract-flow-rollups-refresh (jobid 28 on prod, 40
--       on the clone) inactive, by NAME, exactly one row (FIX-946). No
--       un-park, ever.
--   (4) a read-back that RAISEs on any miss: the rule and every other column,
--       exactly one registry row on the pipeline, the hold row's shape and
--       note, the cron row, the four pins. Printed as NOTICEs: this body's
--       md5, the pick's arithmetic (prev / next slot, the last
--       complete|partial, DUE NOW + ttd), the premise (the state key, the last
--       complete wall, the FR heap pages, the FIX-1118 index's reltuples, the
--       budget against the max wall, the I6 ladder), and today's headroom for
--       a 64-cap row.
--   No pipeline_state write: there is no dial and no cursor.
--
-- ITS OWN PIPELINE. contract_flow_rollups_rebuild has exactly one registry row
-- (rule 378, cc-257 read 3), so a running row of it can only be this job's and
-- the row needs no anchor_cadence. The read-back asserts the count.
--
-- WHY. THE BODY, ON PROD (cc-257 reads 4–6, 2026-10-31 23:59Z):
-- refresh_contract_flow_rollups() is a PROCEDURE, md5 c699dc7d…, 12,329 B,
-- last CREATEd at 20261010020000 (FIX-1295 M3), proconfig NULL; prod = clone.
--   - The START gate box_backoff_gate('contract-flow-rollups-refresh', 1800)
--     runs BEFORE the advisory lock. Under a dispatched unit the tick has
--     already admitted the box, so the gate is redundant; a wait, if any,
--     writes gate.waited_s on the running row and sits inside the 9,000 s
--     budget (1,800 + 5,891 = 7,691). Not clear → a `skipped` row and RETURN.
--   - pg_try_advisory_lock(hashtext('contract_flow_rollups_rebuild')) (a
--     session lock); prod_session_state()->>'defer' → `skipped`.
--   - SET work_mem = '64MB'; SET max_parallel_workers_per_gather = 0
--     (FIX-1295 M3). This body has NEVER run on prod: M3 landed 10-10, the
--     last firing was Thu 10-08 (the P1-A body, 20261003030000), the park was
--     Tue 10-13 23:32Z. The first dispatched run is M3's contract-flow
--     receipt.
--   - A `running` row COMMITted first (FIX-1194 P1-A), then ONE sub-block:
--     DELETE + INSERT contract_recipient_rollup (top-500: a GROUP BY to_id,
--     naics_code over every relationship_type = 'contract' FR row, then a
--     second aggregate) → DELETE + INSERT contract_agency_sector_rollup
--     (agency × sector over the same rows) → the
--     contract_flow_rollups_state flip. EXCEPTION WHEN query_canceled → the
--     running row closes `failed`, canceled true, stage_in_flight,
--     elapsed_seconds, and BOTH TABLES ARE AS THEY WERE (the sub-block rolled
--     back) — and the procedure RETURNS normally, so the one-shot's cron run
--     and its reap read `succeeded`. Any other error → `failed` and a RAISE
--     (the reap reads `failed: …`). `complete` closes the running row in the
--     writes' transaction (recipients 500, agency_sectors, rows_inserted).
--   - Walls on prod (data_sync_log): seven firings 08-20 … 10-08 at
--     1,847.7–1,949.2 s (10-01 1,904.2 s / 10-08 1,903.6 s; 10-08 the last
--     complete, 500 / 1,146), and the 09-17 firing 5,891.2 s — `complete`
--     (500 / 1,492), on a saturated box before FIX-1194's gate, NOT a budget
--     cancel. budget_seconds 9000 = 4.7× the typical, 1.5× the max.
--   - The cost shape (read 6): financial_relationships heap 672,581 pages
--     (5,255 MB of 13 GB total) at 15.66 M reltuples; the FIX-1118 partial
--     index (contract + grant) reads 4,986,493 reltuples. The clone: 442,655
--     pages at 10.45 M, 3,810,261 on the index.
--
-- THE CLOCK AT THE PUSH: `0 14 * * 4` prev slot Thu 10-29 14:00Z, next Thu
-- 11-05 14:00Z. The pipeline's last complete|partial (10-08 14:31:43Z) is
-- older than prev, so the row is DUE at the push, ttd ≈ −2 d 11 h. Group mvs
-- holds refresh-derived-mvs-daily (`by 0 6 * * *`, priority 2) and -weekly
-- (`by 47 0 * * 2`); Thursday 14:00Z meets neither slot, and a daily that
-- comes due mid-run reads `group busy: mvs` and runs after (an unwindowed
-- `by`, rule 391).
--
-- NON-ADVANCING EXITS (rule 302): the START gate timed out → `skipped`; the
-- advisory lock held → no row; prod_session_state().defer → `skipped`; a
-- budget cancel → `failed` (canceled true); an error → `failed`. None is
-- complete|partial, so each leaves the row DUE.
--
-- NETS: the one-shot's 9000 s cron_job_budget row + the */2 watchdog (and the
-- Vercel cron-watchdog route) → the body's query_canceled path → `failed`
-- with both tables intact; the START gate (redundant under the tick, bounded
-- inside the budget); the tick's memory rungs (the swap ceiling 1018, the
-- headroom 150: a 64-cap row needs MemAvailable ≥ 214); group mvs;
-- max_concurrent_units 2; the I6 re-arm cooldown — a reap after the last
-- complete|partial counts, whatever its text, so a DUE `by` row that failed
-- re-arms at reap + 1800 s, + 3600 s, + 7200 s … capped at 24 h, each attempt
-- a full FR scan (by_window_minutes is the dial that bounds the retries to a
-- window; NOT written here); platform_dials.pause; the data revert below.
--
-- ROLLBACK (data):
-- scripts/fix1371-revert-return-contract-flow-rollups-refresh.sql puts the
-- row back to `at 0 14 * * 4`, matched on `by 0 14 * * 4`. Nothing else: the
-- hold row's note stays, the cron stays parked.
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  c_pin_d CONSTANT text := 'd6a9073bcc4d9084b9d7994324a89b18';
  c_body  CONSTANT text := 'c699dc7d6acf1cf35a3164b71ec0a3aa';
  v_day     text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  v_n       int;
  v_rule    text;
  v_row     public.rollup_watch_overrides%ROWTYPE;
  v_jobid   bigint;
  v_active  boolean;
  v_missing text[] := '{}';
  v_got     text;
  v_last    timestamptz;
  v_wall    numeric;
  v_prev    timestamptz;
  v_next    timestamptz;
  v_state   jsonb;
  v_src     text;
  v_pages   bigint;
  v_idx     bigint;
  v_cool    int;
  v_md5_b   text;
  v_md5_d   text;
  v_md5_g   text;
  v_md5_p   text;
  v_md5_c   text;
  v_avail   int;
  v_head    int;
  v_box     jsonb;
BEGIN
  -- ── (1) contract-flow-rollups-refresh: RETURN on its cron slot ────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 0 14 * * 4',
         note          = note || '; RETURNED ' || v_day || ' (FIX-1371, cc-257): by 0 14 * * 4 = its cron slot',
         updated_at    = now()
   WHERE job = 'contract-flow-rollups-refresh'
     AND deadline_rule = 'at 0 14 * * 4';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1371] job_registry contract-flow-rollups-refresh: at 0 14 * * 4 → by 0 14 * * 4 (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'contract-flow-rollups-refresh';
    IF v_rule = 'by 0 14 * * 4' THEN
      RAISE NOTICE '[fix1371] job_registry contract-flow-rollups-refresh already returned (by 0 14 * * 4) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1371] job_registry contract-flow-rollups-refresh reads %, expected at 0 14 * * 4 or by 0 14 * * 4',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) the hold row: ASSERT FIX-1311's takeover hold; note only ──────────
  SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'contract_flow_rollups_rebuild';
  IF NOT FOUND THEN
    RAISE EXCEPTION '[fix1371] rollup_watch_overrides has no contract_flow_rollups_rebuild row — expected FIX-1311''s takeover hold';
  ELSIF NOT ((v_row.held_since IS NOT NULL
              AND v_row.hold_reason LIKE 'parked for the dispatcher cutover%'
              AND v_row.cadence_hours IS NULL
              AND v_row.note LIKE 'FIX-1311 (cc-232)%')
             OR v_row.hold_reason LIKE 'prod session held: %')
        OR v_row.retired_at IS NOT NULL THEN
    RAISE EXCEPTION '[fix1371] contract_flow_rollups_rebuild override is not FIX-1311''s takeover hold (held_since %, hold_reason %, cadence_hours %, note %) — a human hold is resolved by a human',
      v_row.held_since, v_row.hold_reason, v_row.cadence_hours, left(v_row.note, 40);
  END IF;
  UPDATE public.rollup_watch_overrides
     SET note       = note || '; contract-flow-rollups-refresh RETURNED ' || v_day || ' (FIX-1371) — hold kept, conversion to cadence_hours 168 owed after the Thu 11-05 slot',
         updated_at = now()
   WHERE pipeline = 'contract_flow_rollups_rebuild'
     AND note LIKE 'FIX-1311 (cc-232)%'
     AND note NOT LIKE '%contract-flow-rollups-refresh RETURNED % (FIX-1371)%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '[fix1371] rollup_watch_overrides contract_flow_rollups_rebuild: FIX-1311''s hold kept (hold_reason %); note % (% row)',
    v_row.hold_reason, CASE WHEN v_n = 1 THEN 'appended' ELSE 'already carries the RETURN' END, v_n;

  -- ── (3) one owner: the cron stays parked, by NAME (FIX-946) ───────────────
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'contract-flow-rollups-refresh';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[fix1371] % cron.job rows named contract-flow-rollups-refresh — expected exactly 1', v_n;
  END IF;
  SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = 'contract-flow-rollups-refresh';
  IF v_active IS DISTINCT FROM false THEN
    RAISE EXCEPTION '[fix1371] cron contract-flow-rollups-refresh (jobid %) is active = % — the registry owns it; two owners', v_jobid, v_active;
  END IF;
  RAISE NOTICE '[fix1371] cron contract-flow-rollups-refresh (jobid %) inactive — registry owns it', v_jobid;

  -- ── (4) read-back — RAISE on any miss ─────────────────────────────────────
  SELECT deadline_rule INTO v_got FROM public.job_registry
   WHERE job = 'contract-flow-rollups-refresh' AND runner = 'pg_cron' AND pipeline = 'contract_flow_rollups_rebuild'
     AND unit_shape = 'atomic' AND unit_call = 'CALL public.refresh_contract_flow_rollups();'
     AND priority = 3 AND cost_class = 'memory' AND cap_mb = 64 AND exclusion_group = 'mvs'
     AND budget_seconds = 9000 AND gates = '{prod_session}' AND NOT phase_lock AND phase_due_at IS NULL
     AND by_window_minutes IS NULL AND yield_to = '{}' AND yield_lead_seconds = 0 AND NOT idempotent_refire
     AND anchor_cadence IS NULL
     AND note LIKE '%; RETURNED % (FIX-1371, cc-257): by 0 14 * * 4 = its cron slot%';
  IF v_got IS DISTINCT FROM 'by 0 14 * * 4' THEN
    v_missing := v_missing || format('contract-flow-rollups-refresh rule %L (the row''s other columns unchanged? the RETURN note?)', v_got);
  END IF;
  SELECT count(*) INTO v_n FROM public.job_registry WHERE pipeline = 'contract_flow_rollups_rebuild';
  IF v_n <> 1 THEN
    v_missing := v_missing || format('%s registry rows on contract_flow_rollups_rebuild (rule 378: a second row needs anchor_cadence)', v_n);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'contract_flow_rollups_rebuild'
                    AND ((held_since IS NOT NULL AND hold_reason LIKE 'parked for the dispatcher cutover%')
                         OR hold_reason LIKE 'prod session held: %')
                    AND retired_at IS NULL AND cadence_hours IS NULL AND note LIKE 'FIX-1311 (cc-232)%'
                    AND note LIKE '%contract-flow-rollups-refresh RETURNED % (FIX-1371)%') THEN
    v_missing := v_missing || 'contract_flow_rollups_rebuild hold row (FIX-1311''s hold + the FIX-1371 note)';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'contract-flow-rollups-refresh' AND active) THEN
    v_missing := v_missing || 'cron contract-flow-rollups-refresh active';
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
    RAISE EXCEPTION '[fix1371] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;

  -- The body this premise reads (cc-257 read 4). A NOTICE, not a RAISE.
  SELECT md5(prosrc), prosrc INTO v_md5_c, v_src FROM pg_proc
   WHERE proname = 'refresh_contract_flow_rollups' AND pronamespace = 'public'::regnamespace;
  RAISE NOTICE '[fix1371] body: refresh_contract_flow_rollups md5 % % — START gate %, work_mem 64MB %, query_canceled sub-block %',
    v_md5_c,
    CASE WHEN v_md5_c = c_body THEN '(the body this premise reads)'
         ELSE '(DIFFERENT from the clone — re-read the shape)' END,
    CASE WHEN position('box_backoff_gate(''contract-flow-rollups-refresh'', 1800)' IN v_src) > 0 THEN '1800 s' ELSE 'NOT FOUND' END,
    CASE WHEN position('SET work_mem = ''64MB'';' IN v_src) > 0 THEN 'in-body' ELSE 'NOT FOUND' END,
    CASE WHEN position('WHEN query_canceled THEN' IN v_src) > 0 THEN 'present' ELSE 'NOT FOUND' END;

  -- The pick's arithmetic, read the way step 6 reads it (anchor_cadence NULL).
  SELECT completed_at, round(EXTRACT(epoch FROM completed_at - started_at)::numeric, 1)
    INTO v_last, v_wall
    FROM public.data_sync_log
   WHERE pipeline = 'contract_flow_rollups_rebuild' AND status IN ('complete', 'partial') AND completed_at IS NOT NULL
   ORDER BY completed_at DESC LIMIT 1;
  v_prev := public.cron_prev_slot('0 14 * * 4', now());
  v_next := public.cron_next_slot('0 14 * * 4', now());
  RAISE NOTICE '[fix1371] read-back ok: contract-flow-rollups-refresh % (prev % / next %); its last complete|partial %; %; md5 % / % / % / %',
    v_got, v_prev, v_next, v_last,
    CASE WHEN v_last IS NULL OR v_last < v_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_prev - now()) || ')'
         ELSE 'next due ' || v_next END,
    v_md5_d, v_md5_g, v_md5_b, v_md5_p;

  -- The premise: the state, the last wall, the scan's size, the budget, the ladder.
  SELECT value INTO v_state FROM public.pipeline_state WHERE key = 'contract_flow_rollups_state';
  SELECT relpages INTO v_pages FROM pg_class WHERE oid = to_regclass('public.financial_relationships');
  SELECT reltuples::bigint INTO v_idx FROM pg_class
   WHERE oid = to_regclass('public.financial_relationships_contract_grant_updated_at');
  v_cool := (SELECT rearm_cooldown_seconds FROM public.platform_dials WHERE id);
  RAISE NOTICE '[fix1371] premise: contract_flow_rollups_state rebuilt_at % (recipients %, agency_sectors %); the last complete wall % s; FR heap % pages; the FIX-1118 index % reltuples (contract + grant); budget 9000 s vs the 5,891 s max (09-17); rearm_cooldown_seconds % → re-arm at reap + % s / + % s / + % s',
    v_state->>'rebuilt_at', v_state->>'recipients', v_state->>'agency_sectors', v_wall,
    v_pages, v_idx, v_cool, v_cool, v_cool * 2, v_cool * 4;

  v_box  := public.box_is_saturated(p_include_watchdog_wall := false);
  v_head := (SELECT headroom_target_mb FROM public.platform_dials WHERE id);
  IF NOT COALESCE((v_box->'readings'->'thresholds'->'memory'->>'mem_stale')::boolean, true) THEN
    v_avail := (v_box->'readings'->'memory'->>'mem_available_mb')::int;
  END IF;
  RAISE NOTICE '[fix1371] headroom now: %',
    CASE WHEN v_avail IS NULL THEN 'mirror stale or absent — the test is skipped (fail-open)'
         WHEN v_avail - 64 < v_head THEN format('%s MB avail − 64 MB cap = %s < %s MB → excluded (headroom) until MemAvailable ≥ %s',
                                                v_avail, v_avail - 64, v_head, 64 + v_head)
         ELSE format('%s MB avail − 64 MB cap = %s ≥ %s MB → admitted', v_avail, v_avail - 64, v_head) END;
END $$;
