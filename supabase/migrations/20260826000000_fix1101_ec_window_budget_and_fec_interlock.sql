-- =============================================================================
-- FIX-1101 (REVISED TWICE) — bound a SINGLE donations window from outside, and
--                            defer the arm while a FEC bulk run is live or
--                            pending resume.
--
-- ═══ TWO PREMISES REFUTED BEFORE THIS SHIPPED ══════════════════════════════
-- FIX-1101 was filed proposing cost-weighted window bounds and bisect-on-cancel,
-- on the premise that window 5 of the 2026-08-24 run was an EXPENSIVE window.
-- The cost census (audit §11) refuted that: the 16 windows are uniform in
-- donors to ±1.1% and in cost to 1.5×, and window 5 was the CHEAPEST of the
-- sixteen by evidence rows (93,699) while taking ≥10.5× the wall clock.
--
-- The census then proposed a second mechanism — that the windows degrade
-- `entity_connections`' visibility map in flight, FIX-884/FIX-943 one level in
-- — and prescribed an inter-window VACUUM. **This migration does not ship that
-- vacuum, because the A/B measured it and it is also wrong.** Audit §12:
--
--   Arm A′ (prod-faithful control: autovacuum DISABLED on entity_connections,
--   so it is entitled to do nothing exactly as prod's arithmetic entitled it;
--   565,593 staged dirty donors, matching prod's recorded 565,810):
--
--     window 1   155,066 edges   69.5 s     0 dead tuples entering
--     window 2   148,767 edges   62.8 s   155,066
--     window 3   151,605 edges   42.4 s   303,833
--     window 4   148,344 edges   56.0 s   455,438   ← prod's 08-24 level
--     window 5   146,456 edges   46.7 s   603,782
--
--   Dead tuples driven to 750,238 — 1.65× the 455,182 prod accumulated and
--   well past prod's ~498,786 trigger — and the window time RATIO from 1 to 5
--   is 0.67×. The curve does not rise. There is nothing for a vacuum to fix.
--
-- ═══ WHY IT COULD NEVER HAVE BEEN THE MECHANISM ════════════════════════════
-- The structural reason, which is the durable lesson: **VM decay can only cost
-- an INDEX-ONLY scan, and this arm does not contain one.** Measured plans, at
-- the real dirty-set size:
--
--   * the aggregation reads `financial_relationships` through
--     `Index Scan using financial_relationships_from` — a PLAIN index scan,
--     which fetches the heap tuple unconditionally and never consults the
--     visibility map. This also disposes of the sibling hypothesis that FR's
--     80.66% all-visible (left by the killed FEC replay) was the cause: for
--     this query FR's VM state is not an input.
--   * the DELETE must touch the heap by definition — a tuple cannot be marked
--     dead without visiting it — so no DELETE plan can be index-only.
--
-- And the VM damage that DOES occur is real but LOCAL, so it cannot accumulate
-- across windows that each read a different range. Probed mid-run at 455k dead
-- tuples with an index-only scan over a fixed range:
--
--     range rewritten by window 1  [00000000..04000000)   108,534 heap fetches
--     range no window has touched  [d0000000..d4000000)         139 heap fetches
--
-- Each window damages its own from_id neighbourhood — `entity_connections` is
-- physically clustered by from_id because the full rebuild inserts window by
-- window — and the next window reads somewhere else. FIX-884's mechanism is
-- real; it simply does not reach this workload.
--
-- ═══ SO WHAT DID MOVE WINDOW 5 — THE BOX, NOT THE ARM ══════════════════════
-- Independent evidence measured 2026-08-25 for this migration, with BOTH EC
-- cron jobs `active = f` and no EC rebuild running anywhere:
--
--     prod stalled box-wide 11:00–18:00 UTC.
--
--   * jobs 40 and 44, the */2 watchdogs, fired 30 times an hour every hour and
--     FAILED 17/30, 22/30, 25/30, **29/30**, 16/30, 12/30, 14/30 across the
--     11:00–17:00 hours, returning to 0/30 by 19:00;
--   * all five of FIX-1066's moved Tuesday weeklies died on `job startup
--     timeout` (jobids 25, 26, 17 at 13:00/14:00/15:00) or were cancelled at
--     their budget (13, 12);
--   * six GitHub Actions `platform-snapshot` runs were cancelled between 11:36
--     and 17:28.
--
-- **The box enters this state without the EC rebuild.** That is the fact the
-- 08-24 reading could not have: FIX-1101's own bullet records jobid 44 failing
-- 24 of 30 firings in the 12:00 hour on 08-24, which was read as the six-hour
-- window starving the watchdog — but the same starvation occurred on 08-25 with
-- the arm paused. Window 5 ran 09:27→13:16 on 08-24, straight through that
-- band. The most defensible reading of the ≥10.5× is that window 5 was a
-- VICTIM of a recurring afternoon pathology, not its cause, and that the
-- pathology is unattributed (filed separately — it is not an EC defect and this
-- migration does not pretend to fix it).
--
-- ═══ WHAT THEREFORE SHIPS ══════════════════════════════════════════════════
-- Exactly the two things the evidence still supports:
--
--   1. A per-window OUTSIDE budget (default 30 min). This survives every
--      refutation above **because it does not depend on knowing the cause.**
--      Window 5 ate 13,740 s of an 18,000 s whole-run bound on 5.4% of the
--      run's work and nothing below the run level could see it; a per-window
--      bound catches that in 30 minutes whatever the reason. FIX-1030's
--      unit-watchdog pattern, FIX-1035's liveness-first ordering, FIX-1028's
--      existing cancel handling on the receiving end. No bisect-on-cancel: the
--      census showed the unit is not too big, so both halves would behave
--      identically.
--
--   2. The FEC interlock, widened to cover a pending
--      `pipeline_state.fec_bulk_run_state` and not just the advisory lock.
--      NOTE THE JUSTIFICATION HAS CHANGED: the census argued this on FR's
--      degraded visibility map, which the plan above shows is not an input to
--      this query. It is kept on two grounds that do hold — a live or pending
--      FEC replay means `financial_relationships` is actively being
--      bulk-rewritten, so (a) the EC dirty set is being computed against a
--      moving target and the cycle will be immediately stale, and (b) the two
--      heaviest writers on the box would be contending for the same starved
--      I/O. Deferring is right; the reason is contention and consistency, not
--      the visibility map.
--
-- DELIBERATELY NOT SHIPPED: the inter-window vacuum job and its driver toggle.
-- Writing them was cheap; shipping an unfalsified mechanism is not. A */5
-- VACUUM job toggled by a flag would have added the FIX-885 stranded-flag
-- failure mode to this procedure to buy an improvement measured at zero.
--
-- Cross-ref FIX-1069 (the windows), FIX-1071 (the whole-run outside bound),
-- FIX-1056 (budget/banking/resume), FIX-1063 (the watchdog this extends),
-- FIX-1030/FIX-1035 (unit watchdog + liveness-first), FIX-1028 (query_canceled
-- handlers), FIX-884/FIX-943 (the VM mechanism, and its limits), FIX-885 (the
-- stranded-flag precedent that argued against the toggle), FIX-1100 (the FEC
-- compensating vacuum), FIX-1072, FIX-1103.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The per-window action log.
--
--    Sibling of cron_job_budget_action (FIX-1063) rather than a reuse of it:
--    that table is keyed on (runid, jobid) from cron.job_run_details, and a
--    window cancel is not a job cancel — the job keeps running and banks its
--    completed windows. Conflating them would make "how many JOBS did the
--    watchdog kill" unanswerable.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ec_window_budget_action (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acted_at        timestamptz NOT NULL DEFAULT now(),
  window_idx      int         NOT NULL,
  window_started  timestamptz NOT NULL,
  backend_pid     int,
  age_seconds     numeric,
  budget_seconds  int,
  signaled        boolean,
  outcome         text        NOT NULL
);

CREATE INDEX IF NOT EXISTS ec_window_budget_action_acted_at_idx
  ON public.ec_window_budget_action (acted_at DESC);

COMMENT ON TABLE public.ec_window_budget_action IS
  'FIX-1101 — append-only record of every action enforce_ec_window_budget() '
  'takes: a cancel of an overrunning donations window, or a reap of a published '
  'window whose backend was already gone. Deliberately separate from '
  'cron_job_budget_action (FIX-1063), which counts whole-JOB cancellations.';

ALTER TABLE public.ec_window_budget_action ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ec_window_budget_action FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.ec_window_budget_action TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The per-window watchdog.
--
--    Reads what the driver published in
--    pipeline_state.entity_connections_window_inflight:
--      {"window_idx": n, "started_at": ts, "backend_pid": pid, "mode": "...",
--       "log_id": uuid}
--
--    ORDER (FIX-1035): liveness FIRST, then age, then the narrow cancel probe.
--    A published pid that is GONE is indistinguishable from a slow window by
--    arithmetic alone — the published timestamp keeps ageing after the backend
--    dies — so absence is established before anything is inferred from elapsed
--    time.
--
--    NO in-procedure statement_timeout anywhere in this design: it is
--    decorative inside a CALL, measured three times now (FIX-1056, FIX-1063,
--    FIX-1069 §5). statement_timeout is armed once in start_xact_command() and
--    neither proconfig, nor SET in the body, nor the transaction a procedure's
--    COMMIT starts, re-arms it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_ec_window_budget()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_state_key  CONSTANT text := 'entity_connections_window_inflight';
  c_budget_key CONSTANT text := 'entity_connections_window_budget';
  c_default    CONSTANT int  := 1800;   -- 30 minutes
  v_state      jsonb;
  v_idx        int;
  v_started    timestamptz;
  v_pid        int;
  v_budget     int;
  v_age        numeric;
  v_present    boolean;
  v_signaled   boolean;
BEGIN
  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_state_key;

  IF v_state IS NULL OR v_state->>'started_at' IS NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'no window in flight');
  END IF;

  v_idx     := (v_state->>'window_idx')::int;
  v_started := (v_state->>'started_at')::timestamptz;
  v_pid     := (v_state->>'backend_pid')::int;

  -- Floor of 5 s, not a comfortable 60: FIX-1056's precedent is that this
  -- override exists partly so the repro paths exercise the SHIPPED code rather
  -- than a test variant of it, and a 60 s floor would force the forced-budget
  -- proof to run against a copy of this function instead of this function.
  SELECT GREATEST(5, (value->>'seconds')::int) INTO v_budget
    FROM public.pipeline_state
   WHERE key = c_budget_key AND (value->>'seconds') IS NOT NULL;
  v_budget := COALESCE(v_budget, c_default);

  v_age := EXTRACT(epoch FROM (clock_timestamp() - v_started));

  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'no backend_pid published',
                              'window_idx', v_idx);
  END IF;

  -- ── FIX-1035: LIVENESS FIRST ───────────────────────────────────────────────
  -- Presence alone, deliberately weaker than the cancel probe below: absence is
  -- the only unambiguous signal, and any extra predicate could turn "alive but
  -- momentarily not matching" into a false reap.
  SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.pid = v_pid)
    INTO v_present;

  IF NOT v_present THEN
    -- The driver died without clearing its published window. Clear it here so a
    -- later firing is not handed a phantom, and record that we did. The window
    -- itself rolled back with its backend; nothing is lost and nothing needs
    -- undoing — FIX-1069's ratchet advances a watermark only inside the
    -- window's own committed transaction.
    DELETE FROM public.pipeline_state WHERE key = c_state_key;

    INSERT INTO public.ec_window_budget_action
      (window_idx, window_started, backend_pid, age_seconds, budget_seconds, signaled, outcome)
    VALUES
      (v_idx, v_started, v_pid, round(v_age, 1), v_budget, false, 'reaped_dead_backend');

    RAISE WARNING '[ec-window watchdog] published backend pid % gone while window % was in flight — cleared (age %s is an UPPER BOUND on how long it ran, not a measurement)',
      v_pid, v_idx, round(v_age)::int;

    RETURN jsonb_build_object('action', 'reaped', 'window_idx', v_idx,
                              'pid', v_pid, 'age_seconds', round(v_age, 1));
  END IF;

  IF v_age <= v_budget THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'within budget',
                              'window_idx', v_idx, 'age_seconds', round(v_age, 1),
                              'budget_seconds', v_budget);
  END IF;

  -- Cancel at most once per published window. Without this the watchdog would
  -- fire again two minutes later and cancel the driver's own bookkeeping, which
  -- is precisely the stranded-'running'-row failure FIX-1030 exists to prevent.
  IF EXISTS (
    SELECT 1 FROM public.ec_window_budget_action a
     WHERE a.window_started = v_started
       AND a.window_idx     = v_idx
       AND a.outcome        = 'canceled'
  ) THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'already cancelled this window',
                              'window_idx', v_idx);
  END IF;

  -- Narrow cancel probe: same database, not idle, and started BEFORE the window
  -- it claims to be running — a recycled pid necessarily started later.
  PERFORM 1
  FROM pg_stat_activity a
  WHERE a.pid            = v_pid
    AND a.datname        = current_database()
    AND a.state         <> 'idle'
    AND a.backend_start  < v_started;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'cancel probe unsatisfied',
                              'window_idx', v_idx, 'pid', v_pid);
  END IF;

  -- Lands in the driver's FIX-1028 `WHEN query_canceled` handler for the window
  -- loop: the cancelled window rolls back whole (edges AND watermark together),
  -- previously banked windows survive, the loop EXITs, next_arm names the
  -- window, and the run closes 'partial' and resumable.
  v_signaled := pg_cancel_backend(v_pid);

  INSERT INTO public.ec_window_budget_action
    (window_idx, window_started, backend_pid, age_seconds, budget_seconds, signaled, outcome)
  VALUES
    (v_idx, v_started, v_pid, round(v_age, 1), v_budget, v_signaled, 'canceled');

  RAISE WARNING '[ec-window watchdog] cancelled window % (pid %) after %s — budget %s',
    v_idx, v_pid, round(v_age)::int, v_budget;

  RETURN jsonb_build_object('action', 'canceled', 'window_idx', v_idx, 'pid', v_pid,
                            'age_seconds', round(v_age, 1), 'budget_seconds', v_budget,
                            'signaled', v_signaled);
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_ec_window_budget() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_ec_window_budget() IS
  'FIX-1101 — bounds a SINGLE entity_connections donations window from outside '
  'the backend running it, because FIX-1071''s whole-run bound cannot see '
  'inside one window (prod 2026-08-24: window 5 spent 13,740s of an 18,000s '
  'budget on 5.4% of the run''s work). FIX-1030''s unit-watchdog shape with '
  'FIX-1035''s liveness-first ordering. Default 30 min, overridable at '
  'pipeline_state.entity_connections_window_budget = {"seconds": N}. Survives '
  'not knowing WHY a window is slow, which is the point — the cause of the '
  '08-24 outlier was never established and looks box-wide (FIX-1103).';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Run it on the FIX-1063 watchdog's cadence.
--
--    Called from INSIDE enforce_cron_job_budgets() rather than given its own
--    pg_cron job, deliberately. jobid 44 already fires */2, and under the
--    connection-accept pressure this watchdog has to work through it is the
--    firing whose success and failure rates are already characterised. A
--    sibling job would be a second thing that has to win the same race, and
--    on 2026-08-25 that race was lost 29 times in 30. One firing, two checks.
--    The call is wrapped so a failure in the new check cannot stop the
--    established one.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_cron_job_budgets()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  r          record;
  v_target   text;
  v_signaled boolean;
  v_acted    jsonb := '[]'::jsonb;
  v_checked  int   := 0;
  v_window   jsonb := jsonb_build_object('action', 'none', 'reason', 'not evaluated');
BEGIN
  FOR r IN
    SELECT d.runid,
           d.jobid,
           j.jobname,
           j.command,
           d.job_pid,
           d.start_time,
           b.budget_seconds,
           EXTRACT(epoch FROM (clock_timestamp() - d.start_time)) AS age
    FROM cron.job_run_details d
    JOIN cron.job              j ON j.jobid   = d.jobid
    JOIN public.cron_job_budget b ON b.jobname = j.jobname
    WHERE d.status = 'running'
    ORDER BY d.start_time
  LOOP
    v_checked := v_checked + 1;

    -- within budget: nothing to do
    CONTINUE WHEN r.age <= r.budget_seconds;

    -- already cancelled this firing
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.cron_job_budget_action a WHERE a.runid = r.runid
    );

    -- pg_cron did not record a pid for this run
    CONTINUE WHEN r.job_pid IS NULL;

    -- The procedure this job CALLs, e.g. 'public.refresh_treemap_individuals_global'.
    v_target := substring(r.command from 'CALL\s+([a-zA-Z0-9_."]+)');
    CONTINUE WHEN v_target IS NULL;

    PERFORM 1
    FROM pg_stat_activity a
    WHERE a.pid           = r.job_pid
      AND a.datname       = current_database()
      AND a.state        <> 'idle'
      AND a.backend_start <= r.start_time + interval '2 minutes'
      AND a.query ILIKE '%' || v_target || '%';

    CONTINUE WHEN NOT FOUND;

    -- The cancel lands in the target procedure's FIX-1028 / FIX-1021
    -- `WHEN query_canceled` handler, which closes its data_sync_log row
    -- 'partial' rather than leaving it stranded 'running'.
    v_signaled := pg_cancel_backend(r.job_pid);

    INSERT INTO public.cron_job_budget_action
      (runid, jobid, jobname, job_pid, age_seconds, budget_seconds, signaled)
    VALUES
      (r.runid, r.jobid, r.jobname, r.job_pid, round(r.age, 1), r.budget_seconds, v_signaled);

    RAISE WARNING '[cron-budget watchdog] cancelled % (jobid %, runid %, pid %) after %s — budget %s',
      r.jobname, r.jobid, r.runid, r.job_pid, round(r.age)::int, r.budget_seconds;

    v_acted := v_acted || jsonb_build_object(
      'jobname',        r.jobname,
      'jobid',          r.jobid,
      'runid',          r.runid,
      'pid',            r.job_pid,
      'age_seconds',    round(r.age, 1),
      'budget_seconds', r.budget_seconds,
      'signaled',       v_signaled);
  END LOOP;

  -- ── FIX-1101 — the per-window check, on the same firing ────────────────────
  BEGIN
    v_window := public.enforce_ec_window_budget();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[cron-budget watchdog] ec-window check failed: %', SQLERRM;
    v_window := jsonb_build_object('action', 'error', 'reason', SQLERRM);
  END;

  RETURN jsonb_build_object(
    'checked',   v_checked,
    'canceled',  jsonb_array_length(v_acted),
    'actions',   v_acted,
    'ec_window', v_window);
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_cron_job_budgets() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_cron_job_budgets() IS
  'FIX-1063 — bounds any pg_cron job listed in cron_job_budget from OUTSIDE '
  'the backend running it, because a CALL cannot bound itself: statement_timeout '
  'is armed once at CALL time and no SET, proconfig, or post-COMMIT transaction '
  'restart re-arms it (measured, FIX-1056). Generalises FIX-1030''s '
  'enforce_derived_mvs_unit_budget() by keying off cron.job_run_details.job_pid, '
  'so target jobs need no instrumentation. Cancels at most once per runid; '
  'every unsatisfied check refuses to cancel. FIX-1101: also runs '
  'enforce_ec_window_budget() on the same firing, so the per-window bound '
  'inherits this job''s */2 cadence instead of racing it from a sibling job.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The widened FEC interlock — a probe, never a hold.
--
--    Two conditions, either of which defers:
--
--      (a) the FEC bulk pipeline's SESSION advisory lock is held. Probed by
--          READING pg_locks, deliberately NOT by pg_try_advisory_lock followed
--          by an unlock: the rebuild procedure COMMITs between windows and a
--          session-level advisory lock survives COMMIT, so a try/unlock pair
--          that lost its unlock to an error would leave the EC rebuild holding
--          the FEC pipeline's own interlock for the rest of the session — a
--          worse failure than the one being prevented.
--
--          The key is hashtext('fec_bulk_pipeline')::bigint (see
--          packages/data/src/pipelines/fec-bulk/pipeline-lock.ts). A
--          single-argument advisory lock lands in pg_locks as
--          classid = key >> 32, objid = key & 0xFFFFFFFF, objsubid = 1.
--          VERIFIED on local: key -855273339 -> classid 4294967295,
--          objid 3439693957, objsubid 1, and the shift/mask expression below
--          reproduces both.
--
--          pg_locks shows only LIVE sessions, so this probe IS its own liveness
--          check. No data_sync_log row is consulted: a 'running' row routinely
--          outlives its writer — two were stranded on prod on 2026-08-25 alone
--          (jobids 13 and 12).
--
--      (b) pipeline_state.fec_bulk_run_state is present — a killed replay
--          pending resume. This is the case a lock probe CANNOT see, and the
--          one that actually obtained on 08-24: the FEC writer had been killed
--          at its budget 2.5 h before the EC run started, so nothing held the
--          lock.
--
--    STALENESS BOUND on (b). Deferring forever on a marker that never clears
--    converts one bad run into an indefinitely skipped arm, which is strictly
--    worse than the thing being avoided. A run_state older than 24 h is
--    reported STALE and does NOT defer; the driver RAISEs a WARNING naming its
--    age so the strand is loud rather than silent.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fec_bulk_interlock_state()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  c_lock_name  CONSTANT text     := 'fec_bulk_pipeline';
  c_max_age    CONSTANT interval := interval '24 hours';
  v_key        bigint;
  v_lock_held  boolean;
  v_state      jsonb;
  v_updated    timestamptz;
  v_age        interval;
  v_stale      boolean := false;
BEGIN
  v_key := hashtext(c_lock_name)::bigint;

  SELECT EXISTS (
    SELECT 1 FROM pg_locks l
     WHERE l.locktype = 'advisory'
       AND l.granted
       AND l.objsubid = 1
       AND l.classid  = ((v_key >> 32) & 4294967295)::bigint::oid
       AND l.objid    = (v_key & 4294967295)::bigint::oid
  ) INTO v_lock_held;

  SELECT value, updated_at INTO v_state, v_updated
    FROM public.pipeline_state WHERE key = 'fec_bulk_run_state';

  IF v_state IS NOT NULL THEN
    -- Prefer the state's own updated_at (run-state.ts writes it on every
    -- checkpoint); fall back to the row's.
    v_age := clock_timestamp()
             - COALESCE((v_state->>'updated_at')::timestamptz, v_updated, clock_timestamp());
    v_stale := v_age > c_max_age;
  END IF;

  RETURN jsonb_build_object(
    'lock_held',       v_lock_held,
    'run_state',       v_state IS NOT NULL,
    'run_state_age',   CASE WHEN v_state IS NOT NULL THEN round(EXTRACT(epoch FROM v_age))::int END,
    'run_state_stale', v_stale,
    'defer',           v_lock_held OR (v_state IS NOT NULL AND NOT v_stale),
    'reason',          CASE
                         WHEN v_lock_held THEN 'fec bulk advisory lock held by a live session'
                         WHEN v_state IS NOT NULL AND NOT v_stale
                           THEN 'pipeline_state.fec_bulk_run_state present — a killed FEC replay is pending resume'
                         WHEN v_state IS NOT NULL AND v_stale
                           THEN 'fec_bulk_run_state present but STALE — proceeding'
                         ELSE 'clear'
                       END);
END;
$$;

REVOKE ALL ON FUNCTION public.fec_bulk_interlock_state() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fec_bulk_interlock_state() IS
  'FIX-1101 — is a FEC bulk run live OR pending resume? Probes pg_locks for the '
  'hashtext(''fec_bulk_pipeline'') session advisory lock (reads it, never takes '
  'it) and checks for pipeline_state.fec_bulk_run_state. Widened from a '
  'lock-only probe because on 2026-08-24 the FEC writer was already dead and '
  'the lock showed nothing. Deferring is justified by write contention and by '
  'the EC dirty set being computed against a moving target — NOT by '
  'financial_relationships'' visibility map, which the donations aggregation '
  'reads through a plain Index Scan and therefore never consults. A run_state '
  'older than 24 h is reported STALE and does not defer.';


-- ---------------------------------------------------------------------------
-- 5. The driver.
--
--    Reproduced in full from FIX-1069b with the FIX-1101 changes marked. Every
--    line not marked FIX-1101 is byte-identical to the shipped body.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(IN p_mode text DEFAULT 'incremental'::text)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key   bigint := hashtext('entity_connections_rebuild')::bigint;
  v_full       boolean := (p_mode = 'full');
  v_log_id     uuid;
  v_fns        text[];
  v_fn         text;
  v_total      bigint := 0;
  v_n          bigint;
  v_failures   text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  -- EXCEPTION WHEN OTHERS does not match query_canceled, so before this the 6h
  -- statement_timeout blew straight through both handlers below and out of the
  -- procedure, skipping the terminal UPDATE and stranding the row 'running'.
  v_canceled   text := NULL;
  -- ── FIX-1056 — budget + durable per-arm resume checkpoint ─────────────────
  -- 5h, deliberately 1h under the 6h `postgres` role statement_timeout so the
  -- terminal bookkeeping below is never the thing that gets cancelled. Do NOT
  -- raise this to 6h: the margin IS the feature. FIX-1071 mirrors this value in
  -- cron_job_budget as an OUTSIDE bound, because this one is checked at arm
  -- boundaries and therefore cannot bound a single arm.
  c_budget_default interval := interval '5 hours';
  c_budget        interval;
  c_cursor_key    text     := 'entity_connections_rebuild_cursor';
  c_budget_key    text     := 'entity_connections_rebuild_budget';
  c_cycle_max_age interval := interval '7 days';
  v_cursor        jsonb;
  v_done_arms     text[]   := ARRAY[]::text[];
  v_cycle_started timestamptz;
  v_budget_out    boolean  := false;
  v_arm_started   timestamptz;
  v_arm_failed    boolean;
  v_arm_timings   jsonb    := '{}'::jsonb;
  v_next_arm      text     := NULL;
  v_resumed       boolean  := false;
  -- ── FIX-1069 — the donations arm is windowed in BOTH modes ────────────────
  v_don_arm       text;
  v_incr_target   timestamptz := NULL;
  v_bootstrap     boolean  := false;
  v_closed        boolean;
  -- ── FIX-1101 ──────────────────────────────────────────────────────────────
  c_inflight_key  text     := 'entity_connections_window_inflight';
  v_interlock     jsonb;
  c_bounds     uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000',
    '50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000',
    '70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000',
    '90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000',
    'f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_lo         uuid;
  v_hi         uuid;
  v_win        bigint;
  v_donations_total bigint;
  i            int;
  -- FIX-1028 — real entry time so a cancelled run reports a true span.
  v_started    timestamptz := clock_timestamp();
BEGIN
  IF p_mode NOT IN ('full', 'incremental') THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: invalid p_mode %, expected ''full'' or ''incremental''', p_mode;
  END IF;

  -- ── Concurrency guard (session advisory lock; survives the COMMITs below) ───
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'skipped', now(), now(),
      jsonb_build_object(
        'mode', p_mode,
        'skip_reason', 'advisory lock held by a concurrent entity_connections rebuild',
        'source', 'pg_cron'
      )
    );
    RAISE NOTICE '[rebuild] advisory lock held — skipping (mode=%)', p_mode;
    RETURN;
  END IF;

  -- ── FIX-1101 — the widened FEC interlock ──────────────────────────────────
  -- Defers BEFORE the log row goes 'running', before the cursor read and before
  -- any cycle is opened, so a deferred firing leaves no state behind and the
  -- next firing is indistinguishable from a first one.
  --
  -- The status is its own value, 'deferred', not 'skipped': a skip means a peer
  -- rebuild is already doing this work, a defer means the work is deliberately
  -- postponed. Conflating them would make the two indistinguishable in exactly
  -- the log this line of work is diagnosed from.
  --
  -- Placed AFTER the advisory-lock guard, so at this point we HOLD the rebuild
  -- lock and the unlock below is both required and unconditional.
  v_interlock := public.fec_bulk_interlock_state();

  IF (v_interlock->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES (
      'entity_connections_rebuild', 'deferred', v_started, clock_timestamp(),
      jsonb_build_object(
        'mode',          p_mode,
        'source',        'pg_cron',
        'defer_reason',  v_interlock->>'reason',
        'fec_interlock', v_interlock)
    );
    RAISE WARNING '[rebuild] DEFERRED — %', v_interlock->>'reason';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- A stale marker does NOT defer, but it must not be silent either: a
  -- run_state that never clears would otherwise convert one bad run into an
  -- indefinitely skipped arm.
  IF (v_interlock->>'run_state_stale')::boolean THEN
    RAISE WARNING '[rebuild] fec_bulk_run_state present but STALE (%s old) — proceeding; the marker is stranded and wants investigating',
      v_interlock->>'run_state_age';
  END IF;

  -- work_mem is re-read per query (keeps the donation HashAggregate off disk on
  -- Micro; FIX-588). NOTE: the CALL's statement_timeout is fixed at CALL start
  -- and cannot be changed here — the total-runtime budget is the `postgres` role
  -- default (6h, FIX-703). A `SET statement_timeout` here would be a no-op on
  -- the already-armed timer. FIX-1069 re-measured the same for a FUNCTION's
  -- proconfig on the plain SELECT path (the GUC does change inside the body; the
  -- timer does not re-arm) and REMOVED the decorative 45min/90min guards from
  -- the donations arm functions rather than leave them to mislead.
  SET work_mem = '256MB';

  -- ── FIX-1056 — budget, overridable without a migration ────────────────────
  -- pipeline_state.entity_connections_rebuild_budget = {"seconds": N}. Exists so
  -- an operator can shrink or widen the budget in one UPDATE, and so the repro
  -- paths exercise the SHIPPED code path rather than a test variant of it.
  SELECT GREATEST(interval '1 second', make_interval(secs => (value->>'seconds')::numeric))
    INTO c_budget
    FROM public.pipeline_state
   WHERE key = c_budget_key AND (value->>'seconds') IS NOT NULL;
  c_budget := COALESCE(c_budget, c_budget_default);

  -- ── FIX-1056 — read the resume cursor BEFORE opening the log row ───────────
  SELECT value INTO v_cursor FROM public.pipeline_state WHERE key = c_cursor_key;

  IF v_cursor IS NOT NULL
     AND v_cursor->>'mode' = p_mode
     AND (v_cursor->>'cycle_started_at')::timestamptz > now() - c_cycle_max_age
  THEN
    v_cycle_started := (v_cursor->>'cycle_started_at')::timestamptz;
    SELECT COALESCE(array_agg(x), ARRAY[]::text[])
      INTO v_done_arms
      FROM jsonb_array_elements_text(COALESCE(v_cursor->'completed_arms', '[]'::jsonb)) x;
    v_resumed := COALESCE(array_length(v_done_arms, 1), 0) > 0;
    IF v_resumed THEN
      RAISE NOTICE '[rebuild] resuming cycle started % — % arm(s) already banked: %',
        v_cycle_started, array_length(v_done_arms, 1), array_to_string(v_done_arms, ', ');
    END IF;
  ELSE
    -- No cursor, wrong mode, or a cycle too old to trust: start fresh.
    v_cycle_started := v_started;
    v_done_arms     := ARRAY[]::text[];
  END IF;

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES (
    'entity_connections_rebuild', 'running', now(),
    jsonb_build_object(
      'mode', p_mode,
      'source', 'pg_cron',
      'resumed', v_resumed,
      'cycle_started_at', v_cycle_started,
      'budget_seconds', round(EXTRACT(epoch FROM c_budget))::int,
      'arms_banked_on_entry', to_jsonb(v_done_arms)
    )
  )
  RETURNING id INTO v_log_id;

  -- ── Startup reconcile: heal a stranded autovacuum flag (FIX-885) ──────────
  -- Runs on EVERY invocation, both modes, before the mode-gated pause below.
  -- Placed AFTER the advisory-lock guard on purpose: if a rebuild is genuinely
  -- in flight we return early above, so we can never un-pause a peer's
  -- deliberate pause. Conditional on the observed state so a healthy run does
  -- no catalog churn, and RAISEs a WARNING when it actually heals something.
  IF NOT COALESCE(
       (SELECT (split_part(opt, '=', 2))::boolean
          FROM pg_catalog.pg_class c, unnest(c.reloptions) AS opt
         WHERE c.oid = 'public.entity_connections'::regclass
           AND opt LIKE 'autovacuum_enabled=%'),
       true
     ) THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE WARNING '[rebuild] startup reconcile: autovacuum was stranded OFF on entity_connections — re-enabled (FIX-885)';
  END IF;

  -- ── Pause autovacuum on entity_connections for the full rebuild (FIX-590) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = false);
    RAISE NOTICE '[rebuild] autovacuum paused on entity_connections (full rebuild)';
  END IF;
  COMMIT;

  -- ═══ DONATIONS ARM — 16 COMMITTED WINDOWS, BOTH MODES (FIX-703/FIX-1069) ═══
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint, so the
  -- CALL-level budget never becomes an atomic multi-hour txn.
  --
  -- FIX-1069 — this is the change that matters. Before it this whole block was
  -- gated on `IF v_full`, and BOTH scheduled jobs run mode='incremental', so on
  -- prod the windowed path was unreachable code while the incremental arm ran
  -- as one 6-hour statement that banked nothing and wrote nothing.
  --
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band. reconcile_recipient_count() survives as a break-glass full
  -- recompute with NO caller and NO cron job (FIX-736 unscheduled it; the
  -- FIX-1056 comment correction records why that mattered).
  v_don_arm := CASE WHEN v_full THEN 'donations_full_windows' ELSE 'donations_incr_windows' END;

  IF NOT (v_don_arm = ANY(v_done_arms)) THEN
    v_arm_started := clock_timestamp();

    -- ── prepare ──────────────────────────────────────────────────────────────
    IF v_full THEN
      BEGIN
        PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
      EXCEPTION WHEN OTHERS THEN
        v_failures := v_failures || format('donations prepare: %s', SQLERRM);
        RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;
    ELSE
      -- FIX-1069 — stages the dirty set ONCE per cycle and returns the cycle
      -- target. Free on resume: an open cycle whose staging table is still
      -- populated returns immediately without rebuilding anything.
      BEGIN
        v_incr_target := public.rebuild_ec_donations_incr_prepare();
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare CANCELED: %', SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('donations incr prepare: %s', SQLERRM);
        RAISE WARNING '  [donations/incr] prepare FAILED: %', SQLERRM;
      END;
      COMMIT;

      -- A NULL target means no watermark has ever been set. The incremental
      -- path only touches donors present in its dirty set, so it cannot clear
      -- an edge whose donor has vanished from financial_relationships; a true
      -- bootstrap must go through the full windowed path, which range-DELETEs.
      IF v_canceled IS NULL
         AND v_incr_target IS NULL
         AND COALESCE(array_length(v_failures, 1), 0) = 0
      THEN
        v_bootstrap := true;
        v_don_arm   := 'donations_full_windows';
        RAISE WARNING '  [donations/incr] no watermark — bootstrapping via the FULL windowed path';
        BEGIN
          PERFORM public.rebuild_ec_donations_full_prepare();
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations prepare: %s', SQLERRM);
          RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
        END;
        COMMIT;
      END IF;
    END IF;

    -- ── the 16 windows ───────────────────────────────────────────────────────
    v_donations_total := 0;
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      FOR i IN 1..16 LOOP
        -- FIX-1056 — stop at a window boundary rather than being axed mid-window.
        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          -- FIX-1069 — name the arm AND the window. The end-of-run lookup below
          -- only covers v_fns, which never contains the donations window arm.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        -- ── FIX-1101 — publish the in-flight window ────────────────────────
        -- Must be COMMITted before the window starts, or the watchdog — which
        -- runs in a different backend — cannot see it. FIX-1030's shape.
        -- clock_timestamp(), not now(): now() is transaction_timestamp() and
        -- would date the window to whenever this transaction began.
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_inflight_key, jsonb_build_object(
                  'window_idx',  i,
                  'started_at',  clock_timestamp(),
                  'backend_pid', pg_backend_pid(),
                  'mode',        p_mode,
                  'log_id',      v_log_id))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = now();
        COMMIT;

        BEGIN
          IF v_full OR v_bootstrap THEN
            v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
          ELSE
            -- p_idx is 0-based, to match the window watermark keys "0".."15".
            v_win := public.rebuild_ec_donations_incr_window(i - 1, v_lo, v_hi, v_incr_target);
          END IF;
          v_donations_total := v_donations_total + v_win;
          RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
        EXCEPTION
        -- FIX-1028 — by name, FIRST. PL/pgSQL's OTHERS matches every error
        -- EXCEPT query_canceled and assert_failure.
        WHEN query_canceled THEN
          v_canceled := format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          -- FIX-1101 — name the arm AND the window, matching what the BUDGET
          -- exit above already does. Before this, a cancelled window closed the
          -- row with next_arm = 'donations_incr_windows' and the window index
          -- only in cancel_detail, so the two exit paths described the same
          -- situation differently and next_arm alone could not tell an operator
          -- where to resume. Now that FIX-1101's watchdog makes a per-window
          -- cancel a ROUTINE outcome rather than an incident, that asymmetry
          -- would be read every week.
          v_next_arm := format('%s (window %s/16)', v_don_arm, i);
          RAISE WARNING '  [donations] window %/16 — CANCELED (statement_timeout or operator cancel): %', i, SQLERRM;
        WHEN OTHERS THEN
          -- Per-window catch: one bad window must not abort the rest; the run is
          -- reported `failed`.
          v_failures := v_failures || format('donations window %s [%s..%s): %s',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), SQLERRM);
          RAISE WARNING '  [donations] window %/16 FAILED: %', i, SQLERRM;
        END;
        -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction —
        -- PL/pgSQL forbids COMMIT inside one). This is the point at which the
        -- window's edges AND, in incremental mode, its watermark become durable
        -- together. Neither can land without the other.
        COMMIT;

        -- ── FIX-1101 — clear the in-flight window ──────────────────────────
        -- Its own transaction, deliberately NOT folded into the window's: a
        -- cancelled window rolls back, and a clear that rolled back with it
        -- would leave the watchdog looking at a window that is no longer
        -- running and cancelling the driver's own bookkeeping two minutes
        -- later. Clearing here means the only way to leave stale published
        -- state is a hard terminate, which the watchdog's liveness-first check
        -- reaps within one */2 tick.
        DELETE FROM public.pipeline_state WHERE key = c_inflight_key;
        COMMIT;

        -- FIX-1028 — stop the sweep. The box has just proven it cannot finish
        -- one window; the remaining ones would each re-arm the same axe.
        IF v_canceled IS NOT NULL THEN
          EXIT;
        END IF;
      END LOOP;
    END IF;

    v_total := v_total + v_donations_total;
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_don_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- ── bank only a clean, complete pass over all 16 windows ─────────────────
    IF v_canceled IS NULL AND NOT v_budget_out AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      -- FIX-1069 — close the incremental cycle: drop the staging rows and set
      -- the scalar watermark. Returns false if any window still lags, which
      -- cannot happen on this branch but is checked rather than assumed.
      IF NOT v_full AND NOT v_bootstrap THEN
        BEGIN
          v_closed := public.rebuild_ec_donations_incr_close(v_incr_target);
          IF NOT v_closed THEN
            RAISE WARNING '  [donations/incr] cycle NOT closed — a window still lags the target';
          END IF;
        EXCEPTION WHEN OTHERS THEN
          v_failures := v_failures || format('donations incr close: %s', SQLERRM);
          RAISE WARNING '  [donations/incr] close FAILED: %', SQLERRM;
        END;
      END IF;

      IF COALESCE(array_length(v_failures, 1), 0) = 0 THEN
        v_done_arms := v_done_arms || v_don_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
      END IF;
      COMMIT;
    END IF;

    RAISE NOTICE '  [chunk] donations (windowed, %) — % (% edges)',
      CASE WHEN v_full THEN 'full' WHEN v_bootstrap THEN 'bootstrap' ELSE 'incremental' END,
      CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
           WHEN v_canceled IS NOT NULL THEN 'CANCELED'
           ELSE 'complete' END,
      v_donations_total;
  ELSE
    RAISE NOTICE '  [chunk] donations (windowed) — SKIPPED (already banked this cycle)';
  END IF;

  -- ── Remaining chunks (external + investigation MUST stay last) ─────────────
  IF v_full THEN
    v_fns := ARRAY[
      'rebuild_entity_connections_votes_full',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  ELSE
    -- FIX-1069 — 'rebuild_entity_connections_donations' REMOVED. That entry is
    -- what routed the incremental donations arm through the generic
    -- single-statement EXECUTE below; it is now driven as 16 committed windows
    -- above. The function still exists as a break-glass single-shot.
    v_fns := ARRAY[
      'rebuild_entity_connections_votes',
      'rebuild_entity_connections_cosponsors',
      'rebuild_entity_connections_appointments',
      'rebuild_entity_connections_oversight',
      'rebuild_entity_connections_holds',
      'rebuild_entity_connections_gifts',
      'rebuild_entity_connections_contracts',
      'rebuild_entity_connections_lobbying',
      'rebuild_entity_connections_external',
      'rebuild_entity_connections_investigation'
    ];
  END IF;

  FOREACH v_fn IN ARRAY v_fns LOOP
    -- FIX-1028 — a cancel in the donations windows above skips the chunks too.
    EXIT WHEN v_canceled IS NOT NULL;
    -- FIX-1056 — and so does a budget exhaustion in those windows.
    EXIT WHEN v_budget_out;

    -- FIX-1056 — resume: an arm banked earlier in this cycle is already built.
    -- Its edges are stale by at most one cadence, never missing.
    IF v_fn = ANY(v_done_arms) THEN
      RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', v_fn;
      CONTINUE;
    END IF;

    -- FIX-1056 — stop BEFORE starting an arm the budget cannot cover, so the
    -- exit lands on an arm boundary with the cursor and the log row intact
    -- rather than being cancelled mid-statement by the 6h axe.
    IF clock_timestamp() - v_started >= c_budget THEN
      v_budget_out := true;
      v_next_arm   := v_fn;
      RAISE WARNING '  [chunk] % — BUDGET EXHAUSTED (%s elapsed); banking % arm(s) and exiting',
        v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
        COALESCE(array_length(v_done_arms, 1), 0);
      EXIT;
    END IF;

    v_arm_started := clock_timestamp();
    v_arm_failed  := false;
    BEGIN
      EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
        INTO v_n;
      v_total := v_total + v_n;
      RAISE NOTICE '  [chunk] % — complete (% edges)', v_fn, v_n;
    EXCEPTION
    -- FIX-1028 — by name; see the donations handler above.
    WHEN query_canceled THEN
      v_canceled := format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — CANCELED (statement_timeout or operator cancel): %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      v_arm_failed := true;
      v_failures := v_failures || format('%s: %s', v_fn, SQLERRM);
      RAISE WARNING '  [chunk] % — FAILED: %', v_fn, SQLERRM;
    END;

    -- FIX-1056 — per-arm elapsed, recorded for EVERY outcome. This is the
    -- observability gap that let the 08-17 overrun be attributed to the arm the
    -- axe hit rather than the arm that spent the hours.
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_fn, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- FIX-1056 — bank the arm only if it neither cancelled nor raised. A
    -- cancelled arm rolled back, so re-running it next firing is exactly right.
    IF v_canceled IS NULL AND NOT v_arm_failed THEN
      v_done_arms := v_done_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
    END IF;

    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    -- Also the point at which the arm AND its cursor become durable together.
    COMMIT;

    IF v_canceled IS NOT NULL THEN
      EXIT;
    END IF;
  END LOOP;

  -- ── Re-enable autovacuum (always reached — budget is 6h, not a 90min wall) ──
  IF v_full THEN
    ALTER TABLE public.entity_connections SET (autovacuum_enabled = true);
    RAISE NOTICE '[rebuild] autovacuum re-enabled on entity_connections';
  END IF;

  -- ── FIX-1056 — cycle bookkeeping ───────────────────────────────────────────
  -- FIX-1069 — the donations WINDOW arm is in v_fns in neither mode, so it has
  -- to be named explicitly here. Without this, a run whose donations windows
  -- never banked could compute v_next_arm = NULL and sit one gate away from
  -- reporting 'complete'. Only computed when nothing already claimed it — a
  -- budget exit sets it with the window index attached.
  IF v_next_arm IS NULL THEN
    IF NOT (v_don_arm = ANY(v_done_arms)) THEN
      v_next_arm := v_don_arm;
    ELSE
      -- WITH ORDINALITY because unnest() ordering is not contractually
      -- guaranteed and "first outstanding arm" has to mean first in ARM ORDER,
      -- not first returned.
      SELECT f INTO v_next_arm
        FROM unnest(v_fns) WITH ORDINALITY AS u(f, ord)
       WHERE NOT (u.f = ANY(v_done_arms))
       ORDER BY u.ord
       LIMIT 1;
    END IF;
  END IF;

  IF v_next_arm IS NULL
     AND v_canceled IS NULL
     AND NOT v_budget_out
     AND COALESCE(array_length(v_failures, 1), 0) = 0
  THEN
    -- Every arm banked AND the pass was clean: the cycle is closed, so the
    -- cursor must not survive to make the NEXT firing skip everything.
    -- Deliberately also gated on v_failures: the donations windows can fail
    -- without being banked while every v_fns arm succeeds, which would
    -- otherwise clear the cursor on a run that still owes work. Leaving the
    -- cursor is safe either way — each arm is an idempotent DELETE-then-INSERT
    -- over its own connection_type — but clearing it on a failed pass would
    -- throw away the record of what still needs redoing.
    DELETE FROM public.pipeline_state WHERE key = c_cursor_key;
  END IF;
  COMMIT;

  -- FIX-704: the donor-rollup MV refresh that used to run here is GONE — the
  -- rollup is an incrementally-maintained table with its own watermark and its
  -- own pg_cron job (donor-rollup-refresh). Nothing after the edges remains.

  -- ── FIX-1101 — the belt-and-braces clear (playbook C3) ────────────────────
  -- Unconditional, and NOT gated on this run having published anything: this is
  -- the "put it where it can FIRE" backstop, and it must be able to clean up
  -- state this run did not create. Reached on every software exit from the
  -- procedure — convergence, budget exit, a caught cancel, per-arm failures.
  -- Only a hard terminate or a crash skips it, and that case is the watchdog's.
  DELETE FROM public.pipeline_state WHERE key = c_inflight_key;
  COMMIT;

  -- ── Terminal row ───────────────────────────────────────────────────────────
  UPDATE public.data_sync_log
  SET status        = CASE
                        -- FIX-1028 — a cancelled run is PARTIAL: the edges it did
                        -- commit are real, but the sweep did not cover everything.
                        WHEN v_canceled IS NOT NULL THEN 'partial'
                        -- FIX-1056 — a budget exit is also PARTIAL, and unlike a
                        -- cancel it is an ORDERLY stop with a resumable cursor.
                        WHEN v_budget_out THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        -- FIX-1056 — arms left unrun without a cancel or a budget
                        -- exit can only mean a failure skipped them; never claim
                        -- 'complete' while v_next_arm is non-NULL.
                        WHEN v_next_arm IS NOT NULL THEN 'partial'
                        ELSE 'complete'
                      END,
      -- clock_timestamp(), not now(): now() is transaction_timestamp() and this
      -- transaction began after the last chunk's COMMIT (FIX-979 / FIX-972).
      completed_at  = clock_timestamp(),
      rows_inserted = v_total,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s%s', v_canceled,
                                 CASE WHEN v_next_arm IS NOT NULL
                                      THEN format('; resumable at arm %s', v_next_arm)
                                      ELSE '' END,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN v_budget_out
                          -- +1 on the arm count: the donations window arm is
                          -- bankable but is not a member of v_fns.
                          THEN left(format('budget exhausted — resumable at arm %s (%s of %s arms banked)',
                                 COALESCE(v_next_arm, '?'),
                                 COALESCE(array_length(v_done_arms, 1), 0),
                                 COALESCE(array_length(v_fns, 1), 0) + 1), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'mode', p_mode,
                        'edges_total', v_total,
                        'chunk_failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        -- FIX-1056
                        'budget_exhausted', v_budget_out,
                        'arm_timings', v_arm_timings,
                        'arms_banked', to_jsonb(v_done_arms),
                        'next_arm', v_next_arm,
                        'cycle_started_at', v_cycle_started,
                        -- FIX-1069 — the donations cycle target this run drove
                        -- its windows toward, so a partial run's remaining work
                        -- is readable from the log row alone.
                        'donations_target_at', v_incr_target,
                        'donations_bootstrap', v_bootstrap
                      )
  WHERE id = v_log_id;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures), % arm(s) banked, next=%',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0),
    COALESCE(array_length(v_done_arms, 1), 0), COALESCE(v_next_arm, '(none)');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;
COMMENT ON PROCEDURE public.run_entity_connections_rebuild(text) IS
  'Rebuilds entity_connections arm by arm. FIX-1056: 5h wall-clock budget '
  'checked at arm boundaries, per-arm banking into '
  'pipeline_state.entity_connections_rebuild_cursor, per-arm timings. '
  'FIX-1069: the donations arm is driven as 16 COMMITted windows in BOTH modes '
  '— previously only under mode=full, while both scheduled jobs run '
  'incremental, so the arm ran as one unbudgetable, unbankable statement (prod '
  '2026-08-19: 21,677s, 0 edges, 0 arms banked, cursor never created). '
  'Incremental windows carry their own durable watermark, so a budget exit '
  'banks completed windows and the next firing resumes mid-arm. FIX-1071 adds '
  'the outside bound this internal budget cannot provide for a single arm. '
  'FIX-1101: publishes the in-flight window to '
  'pipeline_state.entity_connections_window_inflight so '
  'enforce_ec_window_budget() can bound ONE window (prod 2026-08-24: window 5 '
  'spent 13,740s of an 18,000s run budget on 5.4% of the work), and DEFERS the '
  'whole run with status ''deferred'' when a FEC bulk run is live or pending '
  'resume. FIX-1101 deliberately does NOT vacuum between windows: the A/B '
  'measured that mechanism at zero, because no plan in this arm is an '
  'index-only scan and visibility-map decay cannot cost anything else.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Un-pause the two EC rebuild jobs.
--
--    Both were set active = false by hand on 2026-08-25 after the 08-24 run
--    blew its 18,000 s bound, and were deliberately held there until a
--    per-window bound existed. It now does, so they come back on.
--
--    Done HERE, in the migration, rather than as an ad-hoc prod write: the
--    un-pause is then recorded in the repo with the reasoning beside it and
--    lands atomically with the machinery that justifies it. There is no state
--    in which prod carries the un-pause without the watchdog.
--
--    alter_job by NAME (playbook D3), never unschedule+schedule: these jobs'
--    entire diagnosis rests on their cron.job_run_details history and
--    rescheduling would mint new jobids and orphan it.
--
--    Guarded on the CURRENT state so this is honest about what it did, and so
--    it cannot silently override a future deliberate pause if the file is ever
--    replayed against a database where someone has paused them again.
--
--    WHAT THE NEXT FIRING WILL FIND: jobid 2 (0 8 * * 3) fires Wednesday
--    2026-08-26 08:00 UTC. prod's open cycle block survives from 08-24 but its
--    UNLOGGED staging table was truncated by the 08-24 16:26 restart, so
--    prepare()'s EXISTS check falls through and opens a FRESH cycle rather than
--    advancing watermarks over unprocessed donors (FIX-1069 handles this; the
--    16:26 restart is why it matters). The dirty set as of this migration is
--    935,417 rows / 649,024 donors. Whatever the supervised drain does not
--    take, that firing banks per window under a 30-minute per-window bound and
--    an 18,000 s whole-run bound, and exits resumable.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r      record;
  v_seen int := 0;
BEGIN
  FOR r IN
    SELECT jobid, jobname, active
      FROM cron.job
     WHERE jobname IN ('rebuild-ec-incremental', 'rebuild-ec-incremental-mon')
     ORDER BY jobid
  LOOP
    v_seen := v_seen + 1;
    IF r.active THEN
      RAISE NOTICE '[FIX-1101] % (jobid %) already active — left alone', r.jobname, r.jobid;
    ELSE
      PERFORM cron.alter_job(r.jobid, active := true);
      RAISE NOTICE '[FIX-1101] % (jobid %) UN-PAUSED (was active=false since 2026-08-25)', r.jobname, r.jobid;
    END IF;
  END LOOP;

  IF v_seen <> 2 THEN
    RAISE WARNING '[FIX-1101] expected 2 EC rebuild jobs by name, found % — check cron.job', v_seen;
  END IF;
END;
$$;
