-- =============================================================================
-- FIX-1334 — RETURN rule-taggers-daily through job_registry as `by 30 6 * * *`,
-- switch rule-taggers-weekly from its `stale_after 7 days` bridge (FIX-1328) to
-- `by 0 16 * * 2` BEFORE the bridge's first firing, and opt donor-rollup-refresh
-- + fr-vacuum-analyze into the phase lock (FIX-1323). cc-239, 2026-10-20.
--
-- NEEDS 20261020000000_fix1329_dispatcher_b1.sql (the same push, first): the M1
-- body reads `by` as daily-only, so `by 0 16 * * 2` under it is
-- unsupported_deadline every tick; phase_lock is B1's column. The read-back
-- asserts the B1 body is in place.
--
-- WHY `by` FOR BOTH. The daily and the weekly share the pipeline
-- run_rule_taggers AND the `tags` exclusion group, so their clock
-- (run_rule_taggers complete|partial) is shared. That is exactly why `by` is
-- right for both: a slot is due iff nothing completed since it. The weekly's
-- Tue 16:00Z slot is not satisfied by the daily's 06:31Z run, and the daily's
-- Wed 06:30Z slot is not satisfied by the weekly's Tue run. The bridge would
-- have broken the moment the daily returned (each daily run resets a
-- stale_after clock), which is why the two move in one file.
--
-- THE CLOCK AT THE PUSH (cc-239 read 5, prod 2026-10-19 23:19Z):
-- run_rule_taggers last complete|partial = the 10-13 weekly, 16:00:00.11 →
-- 16:15:02.71Z. So:
--   daily  `by 30 6 * * *`  prev slot = Mon 10-19 06:30Z > last → DUE at the
--          push, priority 2, ttd ≈ −18 h: it arms on the first tick after the
--          claim releases (unless two units are live) — the FIRST dispatched
--          run_rule_taggers. Budget 7200 (the one-shot's cron_job_budget row);
--          box_backoff_gate is weekly-only; the advisory lock is free.
--   weekly `by 0 16 * * 2`  prev slot = Tue 10-13 16:00Z < last 16:15Z → NOT
--          due until Tue 10-20 16:00Z (armed ~16:01Z). The bridge
--          (stale_after 7 days → 16:15:02Z) never fires; FIX-1328's receipt is
--          re-pointed to that dispatched weekly.
--
-- WHAT, in one DO block (cc-237's shape):
--   (1) rule-taggers-weekly  `stale_after 7 days` → `by 0 16 * * 2` (the
--       bridge's literal; "already" on `by 0 16 * * 2`; anything else RAISEs).
--   (2) rule-taggers-daily   `at 30 6 * * *` → `by 30 6 * * *` = its cron slot
--       (20260703000100:170-174). Every other column = the seed row
--       (20261014230000:210): pipeline run_rule_taggers, atomic,
--       CALL public.run_rule_taggers('daily');, priority 2, io, 128, tags,
--       7200, {prod_session}, idempotent_refire false.
--   (3) phase_lock = true for donor-rollup-refresh (`stale_after 12 hours`) and
--       fr-vacuum-analyze (`dead_tuples > 60% of trigger + floor 24 hours`),
--       each matched on its current rule literal; phase_due_at left NULL — the
--       first arm under B1 writes it (fixed-delay that once), the phase holds
--       from the second.
--   (4) cron rule-taggers-daily and rule-taggers-weekly asserted inactive by
--       NAME (FIX-946). The registry owns both; two owners is a RAISE.
--   (5) THE run_rule_taggers HOLD ROW STAYS HELD (held_since 2026-10-13
--       23:32:42Z, the cutover literal): converting it tonight would re-arm the
--       canary's rate_regression:run_rule_taggers escalation against pre-park
--       runs (FIX-1315's demotion keys on `held`). It converts to a
--       cadence_hours 24 row once a dispatched daily AND weekly have run (the
--       next prompt) or when FIX-1317 lands. Asserted in the read-back; this
--       file never writes rollup_watch_overrides.
--   (6) a read-back that RAISEs on any miss: both rules byte-exact and the
--       daily's unchanged columns; both slot pairs from now() printed; RAISE if
--       cron_next_slot('0 16 * * 2', now()) is not 2026-10-20 16:00:00+00, or
--       the weekly reads due, while a live dispatcher-tick is active (the
--       clone-safe conditional shape, cc-237); the daily's due state printed;
--       both phase_lock rows true; the hold row held; the B1 body present and
--       its md5 pair printed again.
--
-- NON-ADVANCING EXITS (rule 302), run_rule_taggers (20261009030000:2595): the
-- shared advisory lock → skipped; prod_session_state().defer → skipped;
-- box_backoff_gate('rule-taggers-weekly', 600) → skipped (weekly only);
-- interior COMMITs are fine for a CALL from a one-shot. Each is a ladder row.
--
-- NETS: platform_dials.pause; the box skip; the prod_session gate; the 7200 s
-- budget rows + the */2 budget watchdog; the postgres role's 3 h ceiling; the
-- I6 ladder; the data revert below.
--
-- ROLLBACK (data): scripts/fix1334-revert-rule-taggers-by.sql — the weekly back
-- to `stale_after 7 days`, the daily back to `at 30 6 * * *`, phase_lock false
-- on the two. The crons stay parked.
--
-- No routine is defined or replaced here. IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_n        int;
  v_rule     text;
  v_lock     boolean;
  v_name     text;
  v_jobid    bigint;
  v_active   boolean;
  v_missing  text[] := '{}';
  v_wk       text;
  v_dy       text;
  v_last     timestamptz;
  v_wk_prev  timestamptz;
  v_wk_next  timestamptz;
  v_dy_prev  timestamptz;
  v_dy_next  timestamptz;
  v_live     boolean;
  v_md5_d    text;
  v_md5_g    text;
  v_src      text;
BEGIN
  -- ── (1) rule-taggers-weekly: the bridge → by 0 16 * * 2 ────────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 0 16 * * 2',
         note          = note || '; cc-239: the stale_after 7 days bridge (FIX-1328) replaced by the by-weekly form '
                                 '(FIX-1329) BEFORE its first firing; first slot Tue 2026-10-20 16:00Z; FIX-1328''s receipt '
                                 '= that dispatched weekly (FIX-1334)',
         updated_at    = now()
   WHERE job = 'rule-taggers-weekly'
     AND deadline_rule = 'stale_after 7 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1334] job_registry rule-taggers-weekly: stale_after 7 days → by 0 16 * * 2 (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'rule-taggers-weekly';
    IF v_rule = 'by 0 16 * * 2' THEN
      RAISE NOTICE '[fix1334] job_registry rule-taggers-weekly already on by 0 16 * * 2 — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1334] job_registry rule-taggers-weekly reads %, expected stale_after 7 days or by 0 16 * * 2',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (2) rule-taggers-daily: RETURN on its cron slot ───────────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'by 30 6 * * *',
         note          = note || '; RETURNED 2026-10-20 (FIX-1334, cc-239): by 30 6 * * * = its cron slot '
                                 '(20260703000100:170-174); its own guards (the shared run_rule_taggers advisory lock → '
                                 'skipped; prod_session → skipped; interior COMMITs) are non-advancing reaps for the ladder',
         updated_at    = now()
   WHERE job = 'rule-taggers-daily'
     AND deadline_rule = 'at 30 6 * * *';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1334] job_registry rule-taggers-daily: at 30 6 * * * → by 30 6 * * * (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'rule-taggers-daily';
    IF v_rule = 'by 30 6 * * *' THEN
      RAISE NOTICE '[fix1334] job_registry rule-taggers-daily already returned (by 30 6 * * *) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1334] job_registry rule-taggers-daily reads %, expected at 30 6 * * * or by 30 6 * * *',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;

  -- ── (3) phase_lock on the two slot-like rows (FIX-1323) ────────────────────
  UPDATE public.job_registry
     SET phase_lock = true
   WHERE job = 'donor-rollup-refresh'
     AND deadline_rule = 'stale_after 12 hours'
     AND NOT phase_lock;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  SELECT deadline_rule, phase_lock INTO v_rule, v_lock FROM public.job_registry WHERE job = 'donor-rollup-refresh';
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1334] job_registry donor-rollup-refresh: phase_lock false → true (1 row)';
  ELSIF v_lock AND v_rule = 'stale_after 12 hours' THEN
    RAISE NOTICE '[fix1334] job_registry donor-rollup-refresh already phase-locked — 0 rows';
  ELSE
    RAISE EXCEPTION '[fix1334] job_registry donor-rollup-refresh reads rule % / phase_lock %, expected stale_after 12 hours',
      COALESCE(v_rule, '(no row)'), v_lock;
  END IF;

  UPDATE public.job_registry
     SET phase_lock = true
   WHERE job = 'fr-vacuum-analyze'
     AND deadline_rule = 'dead_tuples > 60% of trigger + floor 24 hours'
     AND NOT phase_lock;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  SELECT deadline_rule, phase_lock INTO v_rule, v_lock FROM public.job_registry WHERE job = 'fr-vacuum-analyze';
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1334] job_registry fr-vacuum-analyze: phase_lock false → true (1 row)';
  ELSIF v_lock AND v_rule = 'dead_tuples > 60% of trigger + floor 24 hours' THEN
    RAISE NOTICE '[fix1334] job_registry fr-vacuum-analyze already phase-locked — 0 rows';
  ELSE
    RAISE EXCEPTION '[fix1334] job_registry fr-vacuum-analyze reads rule % / phase_lock %, expected dead_tuples > 60%% of trigger + floor 24 hours',
      COALESCE(v_rule, '(no row)'), v_lock;
  END IF;

  -- ── (4) one owner: both rule-tagger crons parked, by NAME (FIX-946) ────────
  FOREACH v_name IN ARRAY ARRAY['rule-taggers-daily', 'rule-taggers-weekly'] LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1334] % cron.job rows named % — expected exactly 1', v_n, v_name;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_name;
    IF v_active IS DISTINCT FROM false THEN
      RAISE EXCEPTION '[fix1334] cron % (jobid %) is active = % — the registry owns it; two owners', v_name, v_jobid, v_active;
    END IF;
    RAISE NOTICE '[fix1334] cron % (jobid %) inactive — registry owns it', v_name, v_jobid;
  END LOOP;

  -- ── (6) read-back — RAISE on any miss ─────────────────────────────────────
  SELECT deadline_rule INTO v_wk FROM public.job_registry
   WHERE job = 'rule-taggers-weekly'
     AND unit_call = 'CALL public.run_rule_taggers(''weekly'');'
     AND gates = '{prod_session}' AND exclusion_group = 'tags' AND budget_seconds = 7200
     AND priority = 3 AND cap_mb = 128 AND pipeline = 'run_rule_taggers';
  IF v_wk IS DISTINCT FROM 'by 0 16 * * 2' THEN
    v_missing := v_missing || format('rule-taggers-weekly rule %L (unit_call/gates/group/budget unchanged?)', v_wk);
  END IF;
  SELECT deadline_rule INTO v_dy FROM public.job_registry
   WHERE job = 'rule-taggers-daily' AND runner = 'pg_cron' AND pipeline = 'run_rule_taggers'
     AND unit_shape = 'atomic' AND unit_call = 'CALL public.run_rule_taggers(''daily'');'
     AND priority = 2 AND cost_class = 'io' AND cap_mb = 128 AND exclusion_group = 'tags'
     AND budget_seconds = 7200 AND gates = '{prod_session}' AND NOT idempotent_refire;
  IF v_dy IS DISTINCT FROM 'by 30 6 * * *' THEN
    v_missing := v_missing || format('rule-taggers-daily rule %L (the seed row''s other columns unchanged?)', v_dy);
  END IF;
  IF (SELECT count(*) FROM public.job_registry
       WHERE phase_lock AND phase_due_at IS NULL
         AND job IN ('donor-rollup-refresh', 'fr-vacuum-analyze')) <> 2 THEN
    v_missing := v_missing || 'donor-rollup-refresh + fr-vacuum-analyze phase_lock true, phase_due_at NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_registry
              WHERE phase_lock AND job NOT IN ('donor-rollup-refresh', 'fr-vacuum-analyze')) THEN
    v_missing := v_missing || 'phase_lock on a row other than the two';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'run_rule_taggers' AND held_since IS NOT NULL AND retired_at IS NULL
                    AND cadence_hours IS NULL
                    AND hold_reason = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry') THEN
    v_missing := v_missing || 'run_rule_taggers still held with the cutover literal';
  END IF;

  -- The B1 body must be in place: the M1 body reads `by` as daily-only.
  SELECT md5(prosrc), prosrc INTO v_md5_d, v_src FROM pg_proc
   WHERE proname = 'dispatch_one_unit' AND pronamespace = 'public'::regnamespace;
  SELECT md5(prosrc) INTO v_md5_g FROM pg_proc
   WHERE proname = 'get_dispatcher_status' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL OR v_src NOT LIKE '%public.cron_prev_slot(%' OR v_md5_d = '98660b34c17c5c537fc3d2e03d021440' THEN
    v_missing := v_missing || 'dispatch_one_unit is the B1 body (20261020000000 first)';
  END IF;

  -- The slots, read the way the pick reads them.
  SELECT max(completed_at) INTO v_last FROM public.data_sync_log
   WHERE pipeline = 'run_rule_taggers' AND status IN ('complete', 'partial');
  v_wk_prev := public.cron_prev_slot('0 16 * * 2', now());
  v_wk_next := public.cron_next_slot('0 16 * * 2', now());
  v_dy_prev := public.cron_prev_slot('30 6 * * *', now());
  v_dy_next := public.cron_next_slot('30 6 * * *', now());
  v_live := EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatcher-tick' AND active);
  IF v_live AND v_wk_next IS DISTINCT FROM '2026-10-20 16:00:00+00'::timestamptz THEN
    v_missing := v_missing || format('cron_next_slot(0 16 * * 2, now()) = %s, expected 2026-10-20 16:00:00+00 with dispatcher-tick active', v_wk_next);
  END IF;
  IF v_live AND (v_last IS NULL OR v_last < v_wk_prev) THEN
    v_missing := v_missing || format('rule-taggers-weekly reads DUE (last %s < prev slot %s) with dispatcher-tick active — it would fire tonight', v_last, v_wk_prev);
  END IF;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '[fix1334] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1334] read-back ok: rule-taggers-weekly % (prev % / next %), rule-taggers-daily % (prev % / next %); run_rule_taggers last complete|partial %; daily %; weekly %; % ; phase_lock t on donor-rollup-refresh + fr-vacuum-analyze (phase_due_at NULL); run_rule_taggers still held',
    v_wk, v_wk_prev, v_wk_next, v_dy, v_dy_prev, v_dy_next, v_last,
    CASE WHEN v_last IS NULL OR v_last < v_dy_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_dy_prev - now()) || ')'
         ELSE 'next due ' || v_dy_next END,
    CASE WHEN v_last IS NULL OR v_last < v_wk_prev THEN 'DUE NOW (ttd ' || date_trunc('second', v_wk_prev - now()) || ')'
         ELSE 'next due ' || v_wk_next END,
    CASE WHEN v_live THEN '(dispatcher-tick active)' ELSE '(no active dispatcher-tick here — not a live hazard)' END;
  RAISE NOTICE '[fix1334] md5 dispatch_one_unit % / get_dispatcher_status %', v_md5_d, v_md5_g;
END $$;
