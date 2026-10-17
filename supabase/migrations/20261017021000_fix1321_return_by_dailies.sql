-- =============================================================================
-- FIX-1321 — RETURN the first two `by` dailies through job_registry (v1.3
-- note §2 RETURN; §8's compressed calendar puts them on V1's day):
--   fe-inbound-rollup-refresh  `at 13 2 * * *` → `by 13 2 * * *`
--   vote-stats-refresh         `at 30 3 * * *` → `by 30 3 * * *`
-- The `by` form's first prod exercise. cc-235, 2026-10-17.
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (1)(2) the two row UPDATEs, each matched on its `at …` literal (a second
--       run NOTICEs "already returned"; anything else RAISEs). unit_call,
--       gates {prod_session}, budget_seconds (fe-inbound 1800 / vote-stats
--       NULL), exclusion groups (fe-totals / votes) UNCHANGED.
--   (3) the two cutover hold rows CONVERTED, not deleted (M1 D-c: deleting
--       makes list_scheduled_rollup_pipelines() flag orphan:<pipeline> every
--       canary run), each matched on pipeline AND its exact hold_reason
--       literal (cc-235 read 4), into a cadence_hours = 24 declaration that
--       mirrors the registry rule for the canary until FIX-1317.
--   (4) both cron rows asserted inactive by NAME (FIX-946). They were parked
--       by FIX-1311 (fe-inbound, jobid 55 on prod) and FIX-1312 (vote-stats,
--       jobid 27). Active here = two owners = a RAISE, never a fix-up.
--   (5) a read-back that RAISEs on any miss, including cron_next_daily() on
--       each rule's schedule — a NULL there is what the tick would log as
--       `unsupported_deadline`; this fails the push instead.
-- No routine is defined or replaced here (D-h).
--
-- WHY `by`, not `stale_after`. I3: a `by M H * * *` row is DUE when nothing
-- completed (data_sync_log complete|partial for its pipeline) since the most
-- recent slot <= now. A late run does not move the next slot, so the form has
-- no drift by construction (contrast FIX-1323). A `partial` (fe-inbound capped
-- at 10 × 200) advances the clock — the same daily throughput the cron had.
-- At landing both are DUE (fe-inbound last completed 2026-10-13 02:13Z,
-- vote-stats 2026-10-14 03:30Z — both before the park), so both fire at the
-- first ticks after the push.
--
-- The claim: the push's own FIX-950 claim runs setGuardedHolds() first. Both
-- rows are already held by the cutover reason, so the claim leaves them alone,
-- and the release clears only SESSION_HOLD_NOTE rows — the converted rows have
-- cadence_hours 24 and are kept by clearGuardedHolds()'s `cadence_hours IS
-- NULL` guard either way.
--
-- NETS: platform_dials.pause; the prod_session gate on both rows; fe-inbound's
-- 1800 s cron_job_budget row (the */2 watchdog cancels an over-budget CALL);
-- vote-stats has no budget row (budget_seconds NULL — p50/max 22.2/45.3 s,
-- 30 d) and runs under the postgres role's 3 h ceiling; the re-arm cooldown
-- (I6) absorbs every non-advancing exit (fe-inbound's lock / prod_session /
-- FEC-interlock `skipped`/`deferred`; vote-stats' prod_session `skipped` and
-- its silent advisory-lock exit); the data revert below.
--
-- ROLLBACK (data): scripts/fix1321-revert-by-dailies.sql — both rules back to
-- `at …`, both hold rows back to their cutover literals. The crons stay
-- parked (the pre-state). Working order in its header.
--
-- IDEMPOTENT: a second run NOTICEs and changes nothing (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_n    int;
  v_rule text;
BEGIN
  -- ── (1) fe-inbound-rollup-refresh ───────────────────────────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 13 2 * * *',
         note          = note || '; RETURNED 2026-10-17 (FIX-1321, cc-235): by 13 2 * * *',
         updated_at    = now()
   WHERE job = 'fe-inbound-rollup-refresh'
     AND deadline_rule = 'at 13 2 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1321] job_registry fe-inbound-rollup-refresh: at 13 2 * * * → by 13 2 * * * (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'fe-inbound-rollup-refresh';
    IF v_rule = 'by 13 2 * * *' THEN
      RAISE NOTICE '[fix1321] job_registry fe-inbound-rollup-refresh already returned (by 13 2 * * *) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1321] job_registry fe-inbound-rollup-refresh reads %, expected at 13 2 * * * or by 13 2 * * *',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) vote-stats-refresh ──────────────────────────────────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 30 3 * * *',
         note          = note || '; RETURNED 2026-10-17 (FIX-1321, cc-235): by 30 3 * * *',
         updated_at    = now()
   WHERE job = 'vote-stats-refresh'
     AND deadline_rule = 'at 30 3 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1321] job_registry vote-stats-refresh: at 30 3 * * * → by 30 3 * * * (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'vote-stats-refresh';
    IF v_rule = 'by 30 3 * * *' THEN
      RAISE NOTICE '[fix1321] job_registry vote-stats-refresh already returned (by 30 3 * * *) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1321] job_registry vote-stats-refresh reads %, expected at 30 3 * * * or by 30 3 * * *',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) the two cutover hold rows → cadence declarations (converted, not deleted)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_n   int;
  v_row public.rollup_watch_overrides%ROWTYPE;
BEGIN
  -- financial_entity_inbound_rollup (cc-232, FIX-1311)
  UPDATE public.rollup_watch_overrides
     SET held_since    = NULL,
         hold_reason   = NULL,
         cadence_hours = 24,
         note          = 'FIX-1321 (cc-235) — fe-inbound-rollup-refresh RETURNED via job_registry (by 13 2 * * *); '
                         'cadence_hours mirrors the registry rule for the canary until FIX-1317. '
                         'Revert: scripts/fix1321-revert-by-dailies.sql',
         updated_at    = now()
   WHERE pipeline = 'financial_entity_inbound_rollup'
     AND hold_reason = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1321] rollup_watch_overrides financial_entity_inbound_rollup: cutover hold → cadence_hours 24 (1 row)';
  ELSE
    SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'financial_entity_inbound_rollup';
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1321] rollup_watch_overrides has no financial_entity_inbound_rollup row — expected the cc-232 cutover hold';
    ELSIF v_row.held_since IS NULL AND v_row.cadence_hours = 24 THEN
      RAISE NOTICE '[fix1321] rollup_watch_overrides financial_entity_inbound_rollup already a cadence row (24 h) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1321] financial_entity_inbound_rollup override is not the cutover hold (held_since %, hold_reason %, cadence_hours %) — a human hold is resolved by a human',
        v_row.held_since, v_row.hold_reason, v_row.cadence_hours;
    END IF;
  END IF;

  -- official_vote_stats_rebuild (cc-226, FIX-1312)
  UPDATE public.rollup_watch_overrides
     SET held_since    = NULL,
         hold_reason   = NULL,
         cadence_hours = 24,
         note          = 'FIX-1321 (cc-235) — vote-stats-refresh RETURNED via job_registry (by 30 3 * * *); '
                         'cadence_hours mirrors the registry rule for the canary until FIX-1317. '
                         'Revert: scripts/fix1321-revert-by-dailies.sql',
         updated_at    = now()
   WHERE pipeline = 'official_vote_stats_rebuild'
     AND hold_reason = 'parked for the dispatcher cutover (cc-226, FIX-1312); returns via job_registry';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1321] rollup_watch_overrides official_vote_stats_rebuild: cutover hold → cadence_hours 24 (1 row)';
  ELSE
    SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'official_vote_stats_rebuild';
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1321] rollup_watch_overrides has no official_vote_stats_rebuild row — expected the cc-226 cutover hold';
    ELSIF v_row.held_since IS NULL AND v_row.cadence_hours = 24 THEN
      RAISE NOTICE '[fix1321] rollup_watch_overrides official_vote_stats_rebuild already a cadence row (24 h) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1321] official_vote_stats_rebuild override is not the cutover hold (held_since %, hold_reason %, cadence_hours %) — a human hold is resolved by a human',
        v_row.held_since, v_row.hold_reason, v_row.cadence_hours;
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (4) one owner each: the parked cron rows stay parked (by NAME — FIX-946)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_name   text;
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['fe-inbound-rollup-refresh', 'vote-stats-refresh'] LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1321] % cron.job rows named % — expected exactly 1', v_n, v_name;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_name;
    IF v_active IS DISTINCT FROM false THEN
      RAISE EXCEPTION '[fix1321] cron % (jobid %) is active = % — the registry owns it; two owners', v_name, v_jobid, v_active;
    END IF;
    RAISE NOTICE '[fix1321] cron % (jobid %) inactive — registry owns it', v_name, v_jobid;
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (5) read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_fe      text;
  v_vs      text;
  v_fe_next timestamptz;
  v_vs_next timestamptz;
  v_md5_d   text;
  v_md5_g   text;
BEGIN
  SELECT deadline_rule INTO v_fe FROM public.job_registry
   WHERE job = 'fe-inbound-rollup-refresh'
     AND unit_call = 'CALL public.run_fe_inbound_rollup(p_max_units := 10)'
     AND gates = '{prod_session}' AND budget_seconds = 1800;
  SELECT deadline_rule INTO v_vs FROM public.job_registry
   WHERE job = 'vote-stats-refresh'
     AND unit_call = 'CALL public.rebuild_official_vote_stats();'
     AND gates = '{prod_session}' AND budget_seconds IS NULL;
  IF v_fe IS DISTINCT FROM 'by 13 2 * * *' THEN
    v_missing := v_missing || format('fe-inbound-rollup-refresh rule %L (unit_call/gates/budget unchanged?)', v_fe);
  END IF;
  IF v_vs IS DISTINCT FROM 'by 30 3 * * *' THEN
    v_missing := v_missing || format('vote-stats-refresh rule %L (unit_call/gates/budget unchanged?)', v_vs);
  END IF;

  -- The tick's own reading (20261016230000, step 6): NULL = unsupported_deadline.
  v_fe_next := public.cron_next_daily(substring(v_fe FROM '^by\s+(.+)$'), now());
  v_vs_next := public.cron_next_daily(substring(v_vs FROM '^by\s+(.+)$'), now());
  IF v_fe_next IS NULL THEN
    v_missing := v_missing || 'cron_next_daily(fe-inbound by schedule) is NULL';
  END IF;
  IF v_vs_next IS NULL THEN
    v_missing := v_missing || 'cron_next_daily(vote-stats by schedule) is NULL';
  END IF;

  IF (SELECT count(*) FROM public.rollup_watch_overrides
       WHERE pipeline IN ('financial_entity_inbound_rollup', 'official_vote_stats_rebuild')
         AND cadence_hours = 24 AND held_since IS NULL AND retired_at IS NULL) <> 2 THEN
    v_missing := v_missing || 'both overrides cadence_hours 24 / held_since NULL / retired_at NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job
              WHERE jobname IN ('fe-inbound-rollup-refresh', 'vote-stats-refresh') AND active) THEN
    v_missing := v_missing || 'both cron rows inactive';
  END IF;

  -- D-h: no dispatcher body moved (cc-235 read 3).
  SELECT md5(prosrc) INTO v_md5_d FROM pg_proc
   WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc
   WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_md5_d IS DISTINCT FROM '98660b34c17c5c537fc3d2e03d021440' THEN
    v_missing := v_missing || format('dispatch_one_unit md5 %s, expected the M1 body', v_md5_d);
  END IF;
  IF v_md5_g IS DISTINCT FROM '4c9d0eb0cd85f9f46b38a9947cc94785' THEN
    v_missing := v_missing || format('get_dispatcher_status md5 %s, expected the M1 body', v_md5_g);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1321] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1321] read-back ok: fe-inbound-rollup-refresh % (next slot %), vote-stats-refresh % (next slot %); both overrides cadence 24; both crons inactive; dispatch_one_unit % / get_dispatcher_status %',
    v_fe, v_fe_next, v_vs, v_vs_next, v_md5_d, v_md5_g;
END $$;
