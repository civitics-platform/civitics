-- =============================================================================
-- FIX-1327 — RETURN the two crawls through job_registry (v1.3 note §2 RETURN;
-- §8's calendar step E1):
--   ec-crawl  `at */15 * * * *` → `stale_after 10 minutes`
--   fe-crawl  `at */30 * * * *` → `stale_after 25 minutes`
-- The first crawl units through the ARM path. cc-237, 2026-10-18.
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (1)(2) the two row UPDATEs, each matched on its `at …` literal (a second
--       run NOTICEs "already returned"; anything else RAISEs). unit_call,
--       priority 2, cost_class (ec mixed / fe io), cap_mb 128, exclusion_group
--       (ec / fe-totals), budget_seconds 1800, gates {prod_session,blackout}
--       and idempotent_refire are UNCHANGED (the seed, 20261014230000).
--   (3) the two cutover hold rows CONVERTED, not deleted (M1 D-c), each
--       matched on pipeline AND its exact hold_reason literal (cc-237 read 4),
--       into a cadence_hours = 24 declaration for the canary until FIX-1317.
--   (4) both cron rows asserted inactive by NAME (FIX-946). Parked by FIX-1311
--       (ec-crawl jobid 45 / fe-crawl jobid 46 on prod). Active here = two
--       owners = a RAISE, never a fix-up.
--   (5) a read-back that RAISEs on any miss, including the tick's own cast of
--       each interval — a typo fails the PUSH, not the first tick.
-- No routine is defined or replaced here (D-h). No pipeline_state config is
-- written (D-d): the crawls' own guards stay exactly as they are.
--
-- WHY `stale_after`. The pick (20261016230000) reads a `stale_after <iv>` row
-- as due at max(completed_at) of its pipeline's complete|partial rows + <iv>.
-- Every crawl unit writes one: ec `partial` when unit-capped / next-arm /
-- budget / canceled / parked and `complete` when the cycle closes
-- (run_entity_connections_rebuild, newest in 20261009030000); fe `partial`
-- when canceled / capped, else `complete` — a CAUGHT-UP firing is a ~0.1 s
-- `complete` (run_fe_totals_crawl, newest in 20260911000200). Inside a cycle
-- ec is due ~10 min after each unit's end → armed on the next odd tick → run
-- +2 min ≈ the cron's */15; fe ≈ 29 min ≈ the cron's */30.
--
-- THE NON-ADVANCING EXITS (rule 302), all left as they are. A unit that exits
-- without a complete|partial row is a non-advancing reap; I6 backs the row
-- off LEAST(1800 × 2^(n−1), 86400) s from the last one and resets on the next
-- advancing completion. In crawl_gate's order (20261004075000):
--   backoff (and fe's peer_backoff on ec_crawl.backoff_until) → WRITES
--     `skipped`; yield_to peer_running / peer_due, the crawl's own blackout
--     read, and ec's cycle_cooldown (cursor NULL AND the last `complete` <
--     min_cycle_interval_minutes ago) → NO row (FIX-1111's logging asymmetry,
--     a pipeline_state.<key>.skips bump only). After the gate: the advisory
--     lock and prod_session_state().defer → `skipped`; the FIX-1101 FEC
--     interlock → `deferred`. The `running` row is written only AFTER every
--     one of these, so a silent exit leaves the armed one-shot as the only
--     trace. peer_due cannot fire while both peers' crons are parked
--     (`CONTINUE WHEN NOT active`) — FIX-1331. ec's cycle_cooldown will be
--     the first ladder on a quiet weekend — FIX-1330.
--
-- THE MEASUREMENT (cc-237 read 5, prod 2026-10-17 23:57:56Z):
--   ec: last complete|partial = last complete = 2026-10-13 21:30:30.44Z (a
--     30 s cycle, all 11 arms gated skipped_unchanged); no
--     entity_connections_rebuild_cursor row → no cycle in flight, and the
--     last complete is > 360 min old → the first dispatched unit opens a NEW
--     cycle. ttd at landing ≈ −4 d 3 h.
--   fe: last = 2026-10-13 23:30:00.21Z `complete`, caught up (slice →
--     2026-10-11 22:38:53Z, 0 rows); no fe_crawl_bootstrap_progress row.
--     ttd at landing ≈ −4 d 1 h. Both priority 2 → ec (more negative) first.
--   rows since the park (2026-10-13 23:32:42Z): 0 for both pipelines.
--   ec_crawl: blackout [{05:45, 09:00}], min_cycle_interval_minutes 360,
--     backoff_until 2026-10-11 11:01Z (past), unit_budget_seconds 1800,
--     yield_to refresh-derived-mvs-daily / rule-taggers-daily (lead 1800).
--   fe_crawl: blackout [] , backoff_until 2026-10-11 04:02Z (past), the same
--     yield_to. The dispatcher's `blackout` gate reads in_blackout('ec_crawl')
--     for BOTH rows, so fe-crawl is gated 05:45–09:00Z by the dispatcher
--     although its own key has no window (D-c — a rider for FIX-1124 part 2).
--   pre-park cron bands (30 d to the park): ec jobid 45 2,854 runs p50 0.2 s
--     max 6,952.2 s; fe jobid 46 1,427 runs p50 0.2 s max 1,953.0 s.
--
-- The claim: the push's FIX-950 claim runs setGuardedHolds() first, which
-- holds only rows with held_since NULL. Both rows here are still held by the
-- cutover reason at claim time, so the claim leaves them alone; the release
-- clears only rows whose hold_reason carries its own prefix.
--
-- NETS: platform_dials.pause; the box-saturation skip; the prod_session and
-- blackout gates on both rows; the 1800 s cron_job_budget row I7 inserts for
-- each one-shot and the */2 budget watchdog (these ARE CALLs — the watchdog
-- cancels them); the postgres role's 3 h ceiling; the I6 re-arm ladder; the
-- data revert below.
--
-- ROLLBACK (data): scripts/fix1327-revert-crawls-return.sql — both rules back
-- to `at …`, both hold rows back to the cutover literal. The crons stay
-- parked: a RETURN's revert never re-activates a cron. Working order in its
-- header.
--
-- IDEMPOTENT: a second run NOTICEs and changes nothing (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_n    int;
  v_rule text;
BEGIN
  -- ── (1) ec-crawl ────────────────────────────────────────────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'stale_after 10 minutes',
         note          = note || '; RETURNED 2026-10-18 (FIX-1327, cc-237): stale_after 10 minutes under the */15 floor; '
                                 'its own gates (backoff / yield_to / blackout / 360-min cycle gap) are non-advancing reaps the I6 ladder absorbs',
         updated_at    = now()
   WHERE job = 'ec-crawl'
     AND deadline_rule = 'at */15 * * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1327] job_registry ec-crawl: at */15 * * * * → stale_after 10 minutes (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'ec-crawl';
    IF v_rule = 'stale_after 10 minutes' THEN
      RAISE NOTICE '[fix1327] job_registry ec-crawl already returned (stale_after 10 minutes) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1327] job_registry ec-crawl reads %, expected at */15 * * * * or stale_after 10 minutes',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) fe-crawl ────────────────────────────────────────────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'stale_after 25 minutes',
         note          = note || '; RETURNED 2026-10-18 (FIX-1327, cc-237): stale_after 25 minutes under the */30 floor',
         updated_at    = now()
   WHERE job = 'fe-crawl'
     AND deadline_rule = 'at */30 * * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1327] job_registry fe-crawl: at */30 * * * * → stale_after 25 minutes (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'fe-crawl';
    IF v_rule = 'stale_after 25 minutes' THEN
      RAISE NOTICE '[fix1327] job_registry fe-crawl already returned (stale_after 25 minutes) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1327] job_registry fe-crawl reads %, expected at */30 * * * * or stale_after 25 minutes',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) the two cutover hold rows → cadence declarations (converted, not deleted)
-- ═══════════════════════════════════════════════════════════════════════════
-- Why 24: check_rollup_freshness (20261004010000) clocks on the newest
-- `complete` row. For ec that is a CYCLE CLOSE (units are `partial`), which
-- comes every ~6–8 h on a quiet week (the 360-min gap + the ladder) and
-- within ~10 h inside a landing week's cycle. 24 → report 36 h / escalate
-- 60 h, the thresholds the two dailies got (FIX-1321).

DO $$
DECLARE
  v_n   int;
  v_row public.rollup_watch_overrides%ROWTYPE;
BEGIN
  -- entity_connections_rebuild (cc-232, FIX-1311)
  UPDATE public.rollup_watch_overrides
     SET held_since    = NULL,
         hold_reason   = NULL,
         cadence_hours = 24,
         note          = 'FIX-1327 (cc-237) — ec-crawl RETURNED via job_registry (stale_after 10 minutes); '
                         'cadence_hours mirrors the canary until FIX-1317 (it clocks on complete rows = ec cycle closes). '
                         'Revert: scripts/fix1327-revert-crawls-return.sql',
         updated_at    = now()
   WHERE pipeline = 'entity_connections_rebuild'
     AND hold_reason = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1327] rollup_watch_overrides entity_connections_rebuild: cutover hold → cadence_hours 24 (1 row)';
  ELSE
    SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'entity_connections_rebuild';
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1327] rollup_watch_overrides has no entity_connections_rebuild row — expected the cc-232 cutover hold';
    ELSIF v_row.held_since IS NULL AND v_row.cadence_hours = 24 THEN
      RAISE NOTICE '[fix1327] rollup_watch_overrides entity_connections_rebuild already a cadence row (24 h) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1327] entity_connections_rebuild override is not the cutover hold (held_since %, hold_reason %, cadence_hours %) — a human hold is resolved by a human',
        v_row.held_since, v_row.hold_reason, v_row.cadence_hours;
    END IF;
  END IF;

  -- financial_entity_totals_refresh (cc-232, FIX-1311)
  UPDATE public.rollup_watch_overrides
     SET held_since    = NULL,
         hold_reason   = NULL,
         cadence_hours = 24,
         note          = 'FIX-1327 (cc-237) — fe-crawl RETURNED via job_registry (stale_after 25 minutes); '
                         'cadence_hours mirrors the canary until FIX-1317. '
                         'Revert: scripts/fix1327-revert-crawls-return.sql',
         updated_at    = now()
   WHERE pipeline = 'financial_entity_totals_refresh'
     AND hold_reason = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1327] rollup_watch_overrides financial_entity_totals_refresh: cutover hold → cadence_hours 24 (1 row)';
  ELSE
    SELECT * INTO v_row FROM public.rollup_watch_overrides WHERE pipeline = 'financial_entity_totals_refresh';
    IF NOT FOUND THEN
      RAISE EXCEPTION '[fix1327] rollup_watch_overrides has no financial_entity_totals_refresh row — expected the cc-232 cutover hold';
    ELSIF v_row.held_since IS NULL AND v_row.cadence_hours = 24 THEN
      RAISE NOTICE '[fix1327] rollup_watch_overrides financial_entity_totals_refresh already a cadence row (24 h) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1327] financial_entity_totals_refresh override is not the cutover hold (held_since %, hold_reason %, cadence_hours %) — a human hold is resolved by a human',
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
  FOREACH v_name IN ARRAY ARRAY['ec-crawl', 'fe-crawl'] LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1327] % cron.job rows named % — expected exactly 1', v_n, v_name;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_name;
    IF v_active IS DISTINCT FROM false THEN
      RAISE EXCEPTION '[fix1327] cron % (jobid %) is active = % — the registry owns it; two owners', v_name, v_jobid, v_active;
    END IF;
    RAISE NOTICE '[fix1327] cron % (jobid %) inactive — registry owns it', v_name, v_jobid;
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (5) read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_ec      text;
  v_fe      text;
  v_ec_iv   interval;
  v_fe_iv   interval;
  v_md5_d   text;
  v_md5_g   text;
BEGIN
  SELECT deadline_rule INTO v_ec FROM public.job_registry
   WHERE job = 'ec-crawl'
     AND unit_call = 'CALL public.run_entity_connections_rebuild(''incremental'', p_max_units := 1);'
     AND gates = '{prod_session,blackout}' AND exclusion_group = 'ec' AND budget_seconds = 1800
     AND priority = 2 AND cap_mb = 128 AND idempotent_refire;
  SELECT deadline_rule INTO v_fe FROM public.job_registry
   WHERE job = 'fe-crawl'
     AND unit_call = 'CALL public.run_fe_totals_crawl(p_max_units := 1);'
     AND gates = '{prod_session,blackout}' AND exclusion_group = 'fe-totals' AND budget_seconds = 1800
     AND priority = 2 AND cap_mb = 128 AND idempotent_refire;
  IF v_ec IS DISTINCT FROM 'stale_after 10 minutes' THEN
    v_missing := v_missing || format('ec-crawl rule %L (unit_call/gates/group/budget unchanged?)', v_ec);
  END IF;
  IF v_fe IS DISTINCT FROM 'stale_after 25 minutes' THEN
    v_missing := v_missing || format('fe-crawl rule %L (unit_call/gates/group/budget unchanged?)', v_fe);
  END IF;

  -- The tick's own reading (20261016230000): the same substring, the same cast.
  v_ec_iv := (substring(v_ec FROM '^stale_after\s+(.+)$'))::interval;
  v_fe_iv := (substring(v_fe FROM '^stale_after\s+(.+)$'))::interval;
  IF v_ec_iv IS DISTINCT FROM interval '10 minutes' THEN
    v_missing := v_missing || format('ec-crawl interval %s, expected 00:10:00', v_ec_iv);
  END IF;
  IF v_fe_iv IS DISTINCT FROM interval '25 minutes' THEN
    v_missing := v_missing || format('fe-crawl interval %s, expected 00:25:00', v_fe_iv);
  END IF;

  IF (SELECT count(*) FROM public.rollup_watch_overrides
       WHERE pipeline IN ('entity_connections_rebuild', 'financial_entity_totals_refresh')
         AND cadence_hours = 24 AND held_since IS NULL AND retired_at IS NULL) <> 2 THEN
    v_missing := v_missing || 'both overrides cadence_hours 24 / held_since NULL / retired_at NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname IN ('ec-crawl', 'fe-crawl') AND active) THEN
    v_missing := v_missing || 'both cron rows inactive';
  END IF;

  -- FIX-1328's half is not this file's: run_rule_taggers stays held (D-e).
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'run_rule_taggers' AND held_since IS NOT NULL
                    AND hold_reason = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry') THEN
    v_missing := v_missing || 'run_rule_taggers still held with the cutover literal';
  END IF;

  -- D-h: no dispatcher body moved (cc-237 read 3).
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
    RAISE EXCEPTION '[fix1327] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1327] read-back ok: ec-crawl % (%), fe-crawl % (%); gates {prod_session,blackout}, groups ec / fe-totals, budget 1800 both; both overrides cadence 24; both crons inactive; run_rule_taggers still held; dispatch_one_unit % / get_dispatcher_status %',
    v_ec, v_ec_iv, v_fe, v_fe_iv, v_md5_d, v_md5_g;
END $$;
