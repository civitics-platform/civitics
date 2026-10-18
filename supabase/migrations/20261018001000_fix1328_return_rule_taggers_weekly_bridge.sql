-- =============================================================================
-- FIX-1328 — RETURN rule-taggers-weekly through job_registry on a BRIDGE:
--   rule-taggers-weekly  `at 0 16 * * 2` → `stale_after 7 days`
-- cc-237, 2026-10-18.
--
-- WHY A BRIDGE. The v1.3 calendar asked for `by 0 16 * * 2`. That cannot be
-- used: the pick's `by` branch (20261016230000) calls
-- public.cron_next_daily(<sched>, now()), which reads `M H * * *` only and
-- returns NULL for a weekly schedule → `unsupported_deadline` EVERY tick and
-- the job never runs. A weekly form is a body change (the md5s move), so it
-- rides the dispatcher-body prompt B1 (FIX-1329). The bridge keeps the Tue
-- 10-20 receipts (FIX-1284's 2nd reading, FIX-1248's close → FIX-1258).
--
-- THE CLOCK. `stale_after 7 days` is due at max(completed_at) of
-- run_rule_taggers complete|partial + 7 days. cc-237 read 5 (prod
-- 2026-10-17 23:57:56Z): the newest is the 10-13 16:00Z weekly (size_tags,
-- complete 16:00:00.11 → 16:15:02.71Z, 903 s, 135,725 tags); the daily's
-- last was 10-13 06:33:42Z; 0 rows since the park. → first due
-- 2026-10-20 16:15:02Z (09:15 PDT), armed on the next odd tick, priority 3.
--
-- THE ORDERING CONSTRAINT — the bridge BREAKS the moment rule-taggers-daily
-- returns: the daily writes run_rule_taggers rows too, and each one resets
-- this clock, so the weekly would slide forever. The daily therefore returns
-- only AFTER the Tue 10-20 firing, in the same push that switches this row to
-- `by 0 16 * * 2` (B1).
--
-- WHAT, in this file's order (one transaction under `supabase db push`):
--   (1) the row UPDATE, matched on its `at` literal (a second run NOTICEs
--       "already returned"; anything else RAISEs). unit_call, priority 3,
--       cost_class memory, cap_mb 128, exclusion_group tags, budget_seconds
--       7200 (I7 inserts the one-shot's cron_job_budget row) and gates
--       {prod_session} are UNCHANGED.
--   (2) cron rule-taggers-weekly AND rule-taggers-daily asserted inactive by
--       NAME (FIX-946) — the bridge's premise is that the daily stays parked.
--   (3) a read-back that RAISEs on any miss: the rule, the tick's own cast,
--       the unchanged columns, the run_rule_taggers hold row STILL HELD, the
--       md5s, and the first due instant — RAISE if it is < now + 24 h while a
--       live dispatcher-tick is active (then the clock premise is wrong and
--       the weekly would fire tonight). Where no tick is active (the clone)
--       it is printed, not raised.
--
-- THE HOLD ROW IS NOT CONVERTED. rollup_watch_overrides keys on the
-- PIPELINE, which the still-parked rule-taggers-daily shares: a half-returned
-- pipeline is honestly `held`, the canary keeps pushing no rollup: for it,
-- and FIX-1315's demotion of rate_regression:run_rule_taggers keeps applying.
-- The weekly's receipt is the dispatched reap (unit_ms vs the 10-13 reading
-- 902.6 s) + FIX-1318's dispatched[] line, not the canary.
--
-- NON-ADVANCING EXITS (rule 302), run_rule_taggers (20261009030000):
-- box_backoff_gate('rule-taggers-weekly', 600) waits up to 10 min on a
-- saturated box, then WRITES `skipped`; the advisory lock and
-- prod_session_state().defer WRITE `skipped`. Each is a ladder row. Interior
-- COMMITs are fine for a CALL from a one-shot.
--
-- NETS: platform_dials.pause; the box skip; the prod_session gate; the 7200 s
-- budget row + the */2 budget watchdog; the postgres role's 3 h ceiling; the
-- I6 ladder; the data revert below.
--
-- ROLLBACK (data): scripts/fix1328-revert-weekly-bridge.sql — the rule back to
-- `at 0 16 * * 2`. The cron stays parked.
--
-- No routine is defined or replaced here (D-h). IDEMPOTENT (rule 241).
-- =============================================================================

DO $$
DECLARE
  v_n    int;
  v_rule text;
BEGIN
  -- ── (1) rule-taggers-weekly ─────────────────────────────────────────────
  UPDATE public.job_registry
     SET deadline_rule = 'stale_after 7 days',
         note          = note || '; RETURNED 2026-10-18 (FIX-1328, cc-237) on a BRIDGE stale_after 7 days — '
                                 'the by-weekly form (FIX-1329) replaces it in B1; BREAKS once rule-taggers-daily returns '
                                 '(shared pipeline run_rule_taggers resets this clock), so the daily returns only after the '
                                 'Tue 10-20 firing and in the same push that switches this row to by 0 16 * * 2',
         updated_at    = now()
   WHERE job = 'rule-taggers-weekly'
     AND deadline_rule = 'at 0 16 * * 2';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RAISE NOTICE '[fix1328] job_registry rule-taggers-weekly: at 0 16 * * 2 → stale_after 7 days (1 row)';
  ELSE
    SELECT deadline_rule INTO v_rule FROM public.job_registry WHERE job = 'rule-taggers-weekly';
    IF v_rule = 'stale_after 7 days' THEN
      RAISE NOTICE '[fix1328] job_registry rule-taggers-weekly already returned (stale_after 7 days) — 0 rows';
    ELSE
      RAISE EXCEPTION '[fix1328] job_registry rule-taggers-weekly reads %, expected at 0 16 * * 2 or stale_after 7 days',
        COALESCE(v_rule, '(no row)');
    END IF;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (2) one owner, and the daily still parked (by NAME — FIX-946)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_name   text;
  v_n      int;
  v_jobid  bigint;
  v_active boolean;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['rule-taggers-weekly', 'rule-taggers-daily'] LOOP
    SELECT count(*) INTO v_n FROM cron.job WHERE jobname = v_name;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '[fix1328] % cron.job rows named % — expected exactly 1', v_n, v_name;
    END IF;
    SELECT jobid, active INTO v_jobid, v_active FROM cron.job WHERE jobname = v_name;
    IF v_active IS DISTINCT FROM false THEN
      RAISE EXCEPTION '[fix1328] cron % (jobid %) is active = % — the bridge needs both rule-tagger crons parked', v_name, v_jobid, v_active;
    END IF;
    RAISE NOTICE '[fix1328] cron % (jobid %) inactive', v_name, v_jobid;
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (3) read-back — RAISE on any miss
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_missing text[] := '{}';
  v_wk      text;
  v_iv      interval;
  v_last    timestamptz;
  v_due     timestamptz;
  v_live    boolean;
  v_md5_d   text;
  v_md5_g   text;
BEGIN
  SELECT deadline_rule INTO v_wk FROM public.job_registry
   WHERE job = 'rule-taggers-weekly'
     AND unit_call = 'CALL public.run_rule_taggers(''weekly'');'
     AND gates = '{prod_session}' AND exclusion_group = 'tags' AND budget_seconds = 7200
     AND priority = 3 AND cap_mb = 128;
  IF v_wk IS DISTINCT FROM 'stale_after 7 days' THEN
    v_missing := v_missing || format('rule-taggers-weekly rule %L (unit_call/gates/group/budget unchanged?)', v_wk);
  END IF;

  -- The tick's own reading (20261016230000): the same substring, the same cast.
  v_iv := (substring(v_wk FROM '^stale_after\s+(.+)$'))::interval;
  IF v_iv IS DISTINCT FROM interval '7 days' THEN
    v_missing := v_missing || format('rule-taggers-weekly interval %s, expected 7 days', v_iv);
  END IF;

  -- D-e: the hold row stays HELD — this file must not convert it.
  IF NOT EXISTS (SELECT 1 FROM public.rollup_watch_overrides
                  WHERE pipeline = 'run_rule_taggers' AND held_since IS NOT NULL AND retired_at IS NULL
                    AND hold_reason = 'parked for the dispatcher cutover (cc-232, FIX-1311); returns via job_registry') THEN
    v_missing := v_missing || 'run_rule_taggers still held with the cutover literal';
  END IF;

  -- The bridge's first due, read the way the pick reads it.
  SELECT max(completed_at) INTO v_last FROM public.data_sync_log
   WHERE pipeline = 'run_rule_taggers' AND status IN ('complete', 'partial');
  v_due  := v_last + v_iv;
  v_live := EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatcher-tick' AND active);
  IF v_live AND (v_due IS NULL OR v_due < now() + interval '24 hours') THEN
    v_missing := v_missing || format('first due %s (last %s) is < now + 24 h with dispatcher-tick active — the weekly would fire tonight', v_due, v_last);
  END IF;

  -- D-h: no dispatcher body moved.
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
    RAISE EXCEPTION '[fix1328] read-back failed: %', array_to_string(v_missing, '; ');
  END IF;
  RAISE NOTICE '[fix1328] read-back ok: rule-taggers-weekly % (%), budget 7200, gates {prod_session}; run_rule_taggers still held; last complete|partial %, first due % %; dispatch_one_unit % / get_dispatcher_status %',
    v_wk, v_iv, v_last, v_due,
    CASE WHEN v_live THEN '(dispatcher-tick active)' ELSE '(no active dispatcher-tick here — not a live hazard)' END,
    v_md5_d, v_md5_g;
END $$;
