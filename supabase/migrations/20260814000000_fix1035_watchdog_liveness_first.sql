-- FIX-1035 — enforce_derived_mvs_unit_budget(): probe backend liveness BEFORE
-- the budget comparison, and close a dead run's row instead of refusing forever.
--
-- ── The blind spot FIX-1030 shipped with ────────────────────────────────────
-- The FIX-1030 ordering was:
--
--     1. is the in-flight unit over budget?   → if NOT, return 'within budget'
--     2. is the published pid still alive?    → if NOT, return 'none'
--
-- Both branches return 'none', so a run whose backend has *died* is never
-- closed by the watchdog at any point in its life:
--
--   * While the frozen `current_unit_started_at` is still inside the budget,
--     step 1 short-circuits and step 2 never runs. The watchdog reports
--     "within budget" about a process that does not exist.
--   * Once arithmetic carries that frozen timestamp past the budget, step 2
--     finally runs, finds no live backend, and refuses — correctly, for a
--     *cancel*, but there is nothing left to cancel and the row still sits
--     'running'.
--
-- The 2026-08-13 supervised firing produced exactly this: attempt 1's watchdog
-- tick reported `within budget, unit_age_seconds 702.5` for a backend that had
-- been gone for eleven minutes. A timestamp that ages by arithmetic looks
-- identical to a unit making progress — liveness is the only signal that
-- distinguishes them, and it was being consulted second.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- Hoist liveness above the budget comparison. A published pid that is gone is
-- terminal information: no budget can make it recoverable and no later tick can
-- learn anything new. So the watchdog closes the row itself, on the next 2-minute
-- tick rather than waiting out reap_stale_sync_log()'s 60-minute threshold.
--
-- ── Two probes, deliberately different strictness ───────────────────────────
-- This is the load-bearing detail. FIX-1030's single probe was written for the
-- CANCEL decision, where the dangerous direction is acting when you should not,
-- so it is narrow on purpose:
--
--     pid = r.pid AND datname = current_database()
--            AND state <> 'idle' AND query ILIKE '%refresh_derived_mvs%'
--
-- Reusing that probe for the CLOSE decision would invert its safety. A live
-- backend that is briefly `idle` between statements, or whose current query text
-- does not mention refresh_derived_mvs (a COMMIT, a nested helper), fails that
-- predicate — harmless when it means "don't cancel", destructive when it means
-- "mark this live run reaped". So the close path gets its own, strictly weaker
-- test: is the pid present in pg_stat_activity AT ALL?
--
--   * absent   → the backend is definitively gone. Close.
--   * present  → could be ours mid-COMMIT, could be a recycled pid. Refuse to
--                close, fall through to the budget/cancel path. If it really is
--                a recycled pid, reap_stale_sync_log() still catches the row at
--                60 minutes — a slower correct answer, not a wrong one.
--
-- Both probes therefore keep the FIX-1030 invariant: every check that cannot be
-- satisfied resolves to the inert outcome.
--
-- ── Close shape follows the FIX-944 / FIX-979 reap convention ───────────────
-- status='reaped', metadata.reaped=true, error_message LIKE 'reaped_orphan%',
-- and completed_at is LEFT ALONE. All three tells matter: they are what
-- pipeline_runtime_stats_mv (FIX-979) matches on to exclude the row from runtime
-- percentiles. Stamping completed_at=NOW() here is precisely the mistake FIX-944
-- removed — it would turn "watchdog latency" into a reported duration.
--
-- The `already_acted` guard stays ABOVE the new probe. After a watchdog cancel,
-- the procedure's FIX-1021 handler runs its own bookkeeping; during that window
-- the backend may transiently not match. Closing the row there would race the
-- handler and clobber a clean 'partial' — the exact failure FIX-1030's
-- cancel-at-most-once rule exists to prevent.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.enforce_derived_mvs_unit_budget(
  p_budget_seconds int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  r             record;
  c_budget      int;
  v_age         numeric;
  v_signaled    boolean;
  v_pid_present boolean;
  v_closed      int;
BEGIN
  SELECT l.id,
         l.metadata->>'cadence'                            AS cadence,
         l.metadata->>'current_unit'                       AS unit,
         (l.metadata->>'current_unit_started_at')::timestamptz AS unit_started,
         (l.metadata->>'backend_pid')::int                 AS pid,
         (l.metadata->>'unit_budget_seconds')::int         AS row_budget,
         (l.metadata ? 'watchdog_canceled_at')             AS already_acted
    INTO r
  FROM public.data_sync_log l
  WHERE l.pipeline = 'refresh_derived_mvs'
    AND l.status   = 'running'
  ORDER BY l.started_at DESC
  LIMIT 1;

  IF r.id IS NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'no running refresh_derived_mvs');
  END IF;

  -- Cancel at most once per run. Without this the watchdog would fire again two
  -- minutes later and cancel the procedure's own bookkeeping UPDATE — turning a
  -- clean 'partial' close back into the stranded 'running' row this whole line
  -- of work exists to eliminate. Also gates the FIX-1035 close path below, so a
  -- post-cancel cleanup window is never mistaken for a dead backend.
  IF r.already_acted THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'already cancelled this run', 'log_id', r.id);
  END IF;

  -- A run that has not published a unit yet (or was written by a pre-FIX-1030
  -- procedure) is not something this function can reason about.
  IF r.unit IS NULL OR r.unit_started IS NULL OR r.pid IS NULL THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'no in-flight unit published', 'log_id', r.id);
  END IF;

  v_age := EXTRACT(epoch FROM (clock_timestamp() - r.unit_started));

  -- ── FIX-1035: LIVENESS FIRST ─────────────────────────────────────────────
  -- Weaker than the cancel probe below on purpose (see header). Presence alone,
  -- no datname/state/query predicates: absence is the only unambiguous signal.
  SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.pid = r.pid)
    INTO v_pid_present;

  IF NOT v_pid_present THEN
    -- Terminal. Close the row on the FIX-944 reap shape rather than leaving it
    -- for the 60-minute reaper.
    UPDATE public.data_sync_log
    SET status        = 'reaped',
        error_message = format(
          'reaped_orphan — derived-mvs watchdog found published backend pid %s '
          'gone while unit %L was in flight. started_at..reap time is NOT a '
          'runtime (FIX-944/FIX-1035).', r.pid, r.unit),
        -- Explicit no-op, matching reap_stale_sync_log(): the gap between the
        -- backend's death and this tick is watchdog latency, never duration.
        completed_at  = completed_at,
        metadata      = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'reaped',                       true,
          'reaped_at',                    clock_timestamp(),
          'reaped_by',                    'enforce_derived_mvs_unit_budget',
          'watchdog_closed_dead_backend', true,
          'watchdog_dead_pid',            r.pid,
          'watchdog_dead_unit',           r.unit,
          'watchdog_unit_age_seconds',    round(v_age, 1),
          'reap_note',
            'The published backend was absent from pg_stat_activity. Elapsed '
            'since current_unit_started_at is an UPPER BOUND on how long the '
            'unit ran, not a measurement — the timestamp froze when the backend '
            'died and kept ageing by arithmetic (FIX-1035).')
    WHERE id = r.id
      -- Guards the window between the SELECT above and this UPDATE: if the
      -- procedure closed its own row in between, leave its verdict alone.
      AND status = 'running';

    GET DIAGNOSTICS v_closed = ROW_COUNT;

    IF v_closed = 0 THEN
      RETURN jsonb_build_object('action', 'none',
                                'reason', 'row closed itself before the watchdog could',
                                'log_id', r.id);
    END IF;

    RAISE WARNING '[derived-mvs watchdog] closed dead run: pid % gone, unit % (age %s, cadence %)',
      r.pid, r.unit, round(v_age)::int, r.cadence;

    RETURN jsonb_build_object('action', 'closed_dead_backend',
                              'unit', r.unit, 'cadence', r.cadence, 'pid', r.pid,
                              'unit_age_seconds', round(v_age, 1),
                              'log_id', r.id);
  END IF;

  c_budget := COALESCE(
    p_budget_seconds,
    r.row_budget,
    NULLIF(current_setting('civitics.derived_mvs_unit_budget_seconds', true), '')::int,
    900);

  IF v_age <= c_budget THEN
    RETURN jsonb_build_object('action', 'none', 'reason', 'within budget',
                              'unit', r.unit, 'unit_age_seconds', round(v_age, 1),
                              'budget_seconds', c_budget);
  END IF;

  -- The CANCEL probe. Narrow on purpose — see the header. Reaching here already
  -- means the pid exists; this additionally requires that it is OUR backend,
  -- actively running, so a recycled pid can never be signalled.
  PERFORM 1
  FROM pg_stat_activity a
  WHERE a.pid     = r.pid
    AND a.datname = current_database()
    AND a.state  <> 'idle'
    AND a.query ILIKE '%refresh_derived_mvs%';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'none',
                              'reason', 'published pid is live but is not a refresh_derived_mvs backend',
                              'unit', r.unit, 'pid', r.pid, 'unit_age_seconds', round(v_age, 1));
  END IF;

  -- The cancel lands in the procedure's FIX-1021 `WHEN query_canceled` handler,
  -- which names the unit, EXITs the loop and closes the row 'partial'.
  v_signaled := pg_cancel_backend(r.pid);

  UPDATE public.data_sync_log
  SET metadata = metadata || jsonb_build_object(
                   'watchdog_canceled_at',   clock_timestamp(),
                   'watchdog_canceled_unit', r.unit,
                   'watchdog_unit_age_seconds', round(v_age, 1),
                   'watchdog_budget_seconds', c_budget)
  WHERE id = r.id;

  RAISE WARNING '[derived-mvs watchdog] cancelled unit % after %s (budget %s, cadence %, pid %)',
    r.unit, round(v_age)::int, c_budget, r.cadence, r.pid;

  RETURN jsonb_build_object('action', 'canceled', 'signaled', v_signaled,
                            'unit', r.unit, 'cadence', r.cadence, 'pid', r.pid,
                            'unit_age_seconds', round(v_age, 1),
                            'budget_seconds', c_budget, 'log_id', r.id);
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_derived_mvs_unit_budget(int) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_derived_mvs_unit_budget(int) IS
  'FIX-1030/FIX-1035 — bounds a SINGLE refresh_derived_mvs unit from outside '
  'the backend running it. Order matters: liveness is probed FIRST (FIX-1035), '
  'because a published pid that has vanished is terminal and no budget '
  'comparison can learn anything from it — that run is closed status=''reaped'' '
  'on the FIX-944 shape (completed_at untouched). Only a run whose backend is '
  'still present reaches the budget comparison, and an over-budget one is '
  'cancelled once; the cancel lands in the procedure''s FIX-1021 query_canceled '
  'handler, which closes the row partial. The close probe (pid present at all) '
  'is deliberately weaker than the cancel probe (pid is a live, non-idle '
  'refresh_derived_mvs backend): every unsatisfied check must resolve to the '
  'inert outcome, and inert means opposite things for the two decisions.';
