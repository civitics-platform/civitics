-- =============================================================================
-- FIX-1069 — the incremental donations arm is ONE unwindowed statement, so
--            FIX-1056's budget, banking and resume have never once run on prod.
--
-- ═══ WHAT HAPPENED, MEASURED ════════════════════════════════════════════════
-- prod 2026-08-19, jobid 2 (rebuild-ec-incremental), data_sync_log row
-- 3777eabf-eba7-40ce-beff-062aa31b91cc, 08:00:00 -> 14:04:28 UTC, verbatim:
--
--     status            partial
--     rows_inserted     0
--     elapsed_seconds   21868
--     arm_timings       {"rebuild_entity_connections_donations": 21677}
--     arms_banked       []
--     next_arm          rebuild_entity_connections_donations
--     budget_exhausted  false
--     error_message     canceled — rebuild_entity_connections_donations:
--                       canceling statement due to statement timeout
--
-- 21,677 s of a 21,868 s run — 99.1% — inside ONE arm. Zero edges written, zero
-- arms banked, and `pipeline_state.entity_connections_rebuild_cursor` DOES NOT
-- EXIST on prod: the cursor row was never created, because the code that
-- creates it only runs after an arm completes and no arm ever did.
--
-- ═══ WHY FIX-1056 DID NOT PREVENT IT ════════════════════════════════════════
-- FIX-1056 built exactly the right machine and wired it to the wrong branch.
-- Its windowed, per-window-COMMIT, budget-checked, banked donations path is
-- gated on `IF v_full`. Both pg_cron jobs that exist —
--
--     jobid  2  rebuild-ec-incremental      0 8 * * 3  CALL …('incremental')
--     jobid 22  rebuild-ec-incremental-mon  0 8 * * 1  CALL …('incremental')
--
-- — pass mode='incremental'. So the windowed path is, on prod, dead code: it
-- has never executed and cannot execute on any scheduled firing. The
-- incremental branch instead lists `rebuild_entity_connections_donations` in
-- `v_fns` and runs it through the generic loop, whose body is
--
--     EXECUTE format('SELECT COALESCE(SUM(edges_upserted), 0) FROM public.%I()', v_fn)
--
-- — a SINGLE top-level statement. Everything FIX-1056 added operates BETWEEN
-- arms, and there is no "between" inside one statement:
--
--   * the budget is checked before an arm starts, so it cannot stop an arm
--     already running (hence `budget_exhausted false` on a 6-hour overrun);
--   * banking happens after an arm returns, and it never returned;
--   * the per-window COMMIT that makes progress durable is in the other branch;
--   * the 6 h cluster statement_timeout is what finally landed, mid-statement,
--     and rolled the entire arm back — which is why 21,677 s of work produced
--     0 rows.
--
-- This is the general rule FIX-1071 states from the other side: an in-procedure
-- budget bounds the NUMBER of units, never a single unit. FIX-1071 adds the
-- outside bound; THIS migration makes the units small enough that the inside
-- bound can see between them. Both are needed and neither replaces the other.
--
-- ═══ WHY IT IS NOT SELF-CORRECTING ══════════════════════════════════════════
-- The overrun PREDATES the FEC backfill: Monday 08-17 (jobid 22) also ran the
-- full 6 h and died on the CONTRACTS arm, having spent 11,824 s in donations
-- first. The backfill did not create the problem; it relocated which arm the
-- axe hits, grew the donations dirty set ~30x, and turned the output to zero.
--
-- The dirty set is a function of how much upstream bulk-rewriting has happened
-- since the last SUCCESSFUL run, so a run that writes nothing makes the next
-- run strictly harder. Measured on prod at the time of writing, against the
-- live watermark of 2026-08-17 04:01:23:
--
--     dirty rows      3,357,701
--     dirty from_ids  1,961,194     (of 2,820,984 donation-ish from_ids total)
--
-- 70% of all donors, growing every night. Unfixed, jobid 22's firing on Monday
-- 2026-08-24 08:00 UTC repeats 08-19 verbatim, only worse.
--
-- ═══ WHAT THIS MIGRATION DOES ═══════════════════════════════════════════════
-- Gives the incremental arm the same 16-window from_id-range treatment the full
-- path has had since FIX-588/FIX-703, plus three things the full path does not
-- need and this one does:
--
--   1. A DURABLE PER-WINDOW WATERMARK, advanced by the window itself as its
--      last act inside its own transaction. This is the ratchet: a window that
--      is cancelled or rolled back does not advance, so it is simply redone.
--      Structurally guaranteed rather than dependent on procedure control flow
--      — there is no code path that can advance a watermark for work that did
--      not commit. The scalar `last_indexed_at` is maintained as the MIN across
--      the 16 windows, so every existing reader keeps seeing an honest,
--      conservative "everything before this is fully indexed".
--
--   2. A CYCLE-SCOPED DIRTY-SET STAGING TABLE. The dirty set is computed ONCE
--      per cycle into `ec_donations_incr_dirty` and reused by every window and
--      by every subsequent firing until the cycle closes. A budget exit at
--      window 9 costs nothing on re-entry: the staging table is still there,
--      windows 1-9 short-circuit on their watermarks, and window 10 resumes.
--
--   3. BUDGET CHECKED BETWEEN WINDOWS, so a budget exit BANKS the windows that
--      finished instead of losing the whole arm. Combined with (1) and (2),
--      the arm now converges across firings instead of restarting from zero.
--
-- ═══ THE RESIDUAL COST, STATED HONESTLY (FIX-1018 class) ════════════════════
-- Building the dirty set is a single un-interruptible statement — the same
-- pre-loop shape FIX-1018 found in the donor rollup, where 9,292 s of a 9,367 s
-- run happened before iteration 1 existed. It is bounded here in a way it was
-- not there:
--
--   * it is ONE pass over the `updated_at` index plus a heap fetch of the dirty
--     rows, not a per-window cost, and NOT repeated on resume;
--   * it is paid once per CYCLE, not once per firing;
--   * FIX-1071's outside bound now covers it, which the internal budget cannot.
--
-- It is deliberately NOT optimised with a new index in this migration. Adding a
-- ~300 MB partial index on (from_id, updated_at) to a 10.4M-row table three
-- days before the deadline is a bigger risk than the cost it saves, and the
-- correct sizing input — how long the populate actually takes on the saturated
-- prod box — is precisely what the supervised drain measures. If the populate
-- turns out to dominate, that measurement is the sizing evidence for the index,
-- and it gets its own FIX. Playbook: measure, then tune.
--
-- ═══ THE INERT `SET statement_timeout` GUARDS ARE REMOVED ═══════════════════
-- `rebuild_entity_connections_donations()` carried `SET statement_timeout =
-- '45min'` and `rebuild_entity_connections_donations_full()` carried '90min'.
-- Neither has ever bounded anything. Re-measured for this migration on local
-- (PG 17), session statement_timeout deliberately varied:
--
--     CREATE FUNCTION _probe() … AS $$ PERFORM pg_sleep(5) $$;
--     ALTER FUNCTION _probe() SET statement_timeout = '2s';
--
--     session timeout = 0    ->  SELECT _probe()  =>  slept 5s, NO timeout
--     session timeout = 30s  ->  SELECT _probe()  =>  slept 5s, NO timeout
--     current_setting() INSIDE the body           =>  '2s'
--     current_setting() outside                   =>  '0'
--
-- The third and fourth lines are the mechanism, and they are worth stating
-- precisely because the value being visibly correct is exactly what makes the
-- guard so convincing: proconfig DOES change the GUC inside the body. It does
-- not RE-ARM the timer, which was armed once in start_xact_command() before the
-- function was entered. So the guard reads as a 45-minute bound, reports itself
-- as a 45-minute bound, and enforces nothing.
--
-- FIX-1063 measured this for the CALL path and FIX-1056 for the procedure; this
-- generalises it to the plain SELECT path, i.e. all of them. A guard that
-- announces a bound it does not enforce is worse than no guard: the 08-17 run
-- was allowed to sit for six hours partly because the arm "had" a 45-minute
-- timeout. Both are RESET here, and the new functions deliberately carry none.
--
-- Checked before removing: the only callers of these functions are
-- packages/data/src/scripts/rebuild-entity-connections.ts and
-- run-rebuild-chunks-prod.ts, and BOTH connect with a direct pg.Client rather
-- than PostgREST — so no caller was relying on proconfig to widen a role-level
-- REST timeout, and the RESET cannot regress a request path.
--
-- Cross-ref FIX-1056 (budget/banking/resume, and the branch this fixes),
-- FIX-1071 (the outside bound), FIX-703/FIX-588 (the full path this mirrors),
-- FIX-747 (the opposition class), FIX-1028 (query_canceled handlers),
-- FIX-1018 (the pre-loop blind spot), FIX-833 (orphan sweep is separate),
-- FIX-834 (grant posture).
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The cycle-scoped dirty-set staging table.
--
--    UNLOGGED: it is transient derived state, rebuilt from financial_relation-
--    ships whenever it is missing, so paying WAL for it buys nothing. A crash
--    truncates it, which is handled — prepare() rebuilds when it finds it empty.
--
--    PK is (from_id, from_type), from_id FIRST, because every read of this
--    table is a from_id RANGE scan for one of the 16 windows.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNLOGGED TABLE IF NOT EXISTS public.ec_donations_incr_dirty (
  from_id   uuid NOT NULL,
  from_type text NOT NULL,
  PRIMARY KEY (from_id, from_type)
);

COMMENT ON TABLE public.ec_donations_incr_dirty IS
  'FIX-1069 — donors whose donation/ie_support/ie_oppose rows changed since the '
  'current incremental cycle''s start watermark. Built ONCE per cycle by '
  'rebuild_ec_donations_incr_prepare() and consumed by the 16 window calls, so '
  'a budget exit mid-cycle does not re-pay the dirty-set build on resume. '
  'UNLOGGED and safe to truncate: prepare() rebuilds it whenever it is empty.';

ALTER TABLE public.ec_donations_incr_dirty ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ec_donations_incr_dirty FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ec_donations_incr_dirty TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. prepare — open (or resume) a cycle. Returns the cycle target timestamp,
--    or NULL to mean "no watermark exists, caller must bootstrap via the full
--    windowed path".
--
--    Idempotent and cheap on re-entry: if a cycle is already open and its
--    staging table is populated, it returns the SAME target without rebuilding
--    anything. That is what makes resume free.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_incr_prepare()
RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE
  c_key           CONSTANT text     := 'entity_connections_donations';
  c_cycle_max_age CONSTANT interval := interval '7 days';
  v_state    jsonb;
  v_scalar   timestamptz;
  v_windows  jsonb;
  v_target   timestamptz;
  v_staged   timestamptz;
  v_since    timestamptz;
  v_rows     bigint;
  i          int;
BEGIN
  SELECT value INTO v_state FROM public.pipeline_state WHERE key = c_key;

  v_scalar := (v_state->>'last_indexed_at')::timestamptz;

  -- No watermark at all => never bootstrapped. The incremental path cannot
  -- clean up EC rows whose donor has vanished from FR (it only touches donors
  -- present in the dirty set), so a true bootstrap must go through the full
  -- windowed path, which range-DELETEs. Signal that to the caller.
  IF v_scalar IS NULL THEN
    RETURN NULL;
  END IF;

  v_windows := v_state->'windows';

  -- First run after this migration: seed all 16 windows from the existing
  -- scalar. Every window therefore starts level, which is what lets a window's
  -- watermark double as its own "already done this cycle" flag.
  IF v_windows IS NULL OR jsonb_typeof(v_windows) <> 'object' THEN
    v_windows := '{}'::jsonb;
    FOR i IN 0..15 LOOP
      v_windows := jsonb_set(v_windows, ARRAY[i::text], to_jsonb(v_scalar::text));
    END LOOP;
  END IF;

  v_staged := (v_state->'cycle'->>'staged_at')::timestamptz;
  v_target := (v_state->'cycle'->>'target_at')::timestamptz;

  -- ── Resume an open cycle ───────────────────────────────────────────────────
  -- Reuse iff the cycle is young AND the staging table still holds its rows.
  -- The EXISTS check is what makes an UNLOGGED table safe here: a crash-
  -- truncated staging table falls through and is rebuilt rather than silently
  -- producing a no-op cycle that advances watermarks over unprocessed donors.
  IF v_staged IS NOT NULL
     AND v_target IS NOT NULL
     AND v_staged > now() - c_cycle_max_age
     AND EXISTS (SELECT 1 FROM public.ec_donations_incr_dirty)
  THEN
    -- Persist the (possibly newly seeded) windows without disturbing the cycle.
    UPDATE public.pipeline_state
       SET value      = value || jsonb_build_object('windows', v_windows),
           updated_at = now()
     WHERE key = c_key;
    RAISE NOTICE '[donations/incr] resuming cycle target=% staged=% (% dirty donors already staged)',
      v_target, v_staged, (SELECT count(*) FROM public.ec_donations_incr_dirty);
    RETURN v_target;
  END IF;

  -- ── Open a fresh cycle ─────────────────────────────────────────────────────
  -- Start from the OLDEST window, so no window can be handed a dirty set that
  -- begins after its own watermark (which would leave a gap for that window).
  SELECT min((e.value)::timestamptz) INTO v_since
    FROM jsonb_each_text(v_windows) AS e(key, value);
  v_since := COALESCE(v_since, v_scalar);

  SELECT MAX(fr.updated_at) INTO v_target
    FROM public.financial_relationships fr
   WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose');
  v_target := COALESCE(v_target, now());

  -- A target at or before the oldest window is a genuine no-op cycle; still
  -- open it so the windows can level up and the arm can bank.
  IF v_target < v_since THEN
    v_target := v_since;
  END IF;

  TRUNCATE public.ec_donations_incr_dirty;

  INSERT INTO public.ec_donations_incr_dirty (from_id, from_type)
  SELECT DISTINCT fr.from_id, fr.from_type
    FROM public.financial_relationships fr
   WHERE fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
     AND fr.updated_at > v_since
     AND fr.updated_at <= v_target;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.pipeline_state (key, value)
  VALUES (c_key, COALESCE(v_state, '{}'::jsonb)
                 || jsonb_build_object(
                      'windows', v_windows,
                      'cycle', jsonb_build_object(
                        'since_at',  v_since,
                        'target_at', v_target,
                        'staged_at', now(),
                        'dirty_donors', v_rows)))
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  RAISE NOTICE '[donations/incr] opened cycle since=% target=% — % dirty donors staged',
    v_since, v_target, v_rows;

  RETURN v_target;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_ec_donations_incr_prepare() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_incr_prepare() TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_incr_prepare() IS
  'FIX-1069 — open or resume an incremental donations cycle. Stages the dirty '
  'donor set ONCE per cycle into ec_donations_incr_dirty and returns the cycle '
  'target timestamp; returns NULL when no watermark exists, meaning the caller '
  'must bootstrap through the full windowed path instead. Free on resume.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. window — the unit the budget can now see between.
--
--    Self-contained and idempotent, exactly like rebuild_ec_donations_full_-
--    window(): range-scoped DELETE of both derived classes for the dirty donors
--    in [p_lo, p_hi), then the two aggregations, then its own watermark
--    advance. Safe for the caller to COMMIT after.
--
--    THE RATCHET. The watermark advance is the LAST statement, in the same
--    transaction as the edges. There is no ordering in which a window's
--    watermark moves without its edges committing: a cancel, a timeout or an
--    error rolls back both together and the window is simply redone.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_incr_window(
  p_idx    int,
  p_lo     uuid,
  p_hi     uuid,
  p_target timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  c_key   CONSTANT text := 'entity_connections_donations';
  v_count bigint := 0;
  v_opp   bigint := 0;
  v_since timestamptz;
  v_wins  jsonb;
  v_min   timestamptz;
BEGIN
  SELECT (value->'windows'->>p_idx::text)::timestamptz
    INTO v_since
    FROM public.pipeline_state
   WHERE key = c_key;

  -- Already level with this cycle's target => banked by an earlier firing.
  -- This is the intra-arm resume: re-entering the arm after a budget exit
  -- costs one cheap read per completed window, not a redo.
  IF v_since IS NOT NULL AND v_since >= p_target THEN
    RAISE NOTICE '    [donations/incr] window %/16 — SKIPPED (already at target)', p_idx + 1;
    RETURN 0;
  END IF;

  -- ── Clear both derived classes for this window's dirty donors ──────────────
  -- Scoped by the dirty set AND by the from_id range: the range predicate is
  -- redundant given the join but lets the planner use
  -- entity_connections_from_id_connection_type (from_id, connection_type).
  DELETE FROM public.entity_connections ec
   USING public.ec_donations_incr_dirty d
   WHERE ec.connection_type IN ('donation', 'opposition')
     AND ec.from_type = d.from_type
     AND ec.from_id   = d.from_id
     AND d.from_id   >= p_lo
     AND (p_hi IS NULL OR d.from_id < p_hi);

  -- ── donation + ie_support -> 'donation' ────────────────────────────────────
  -- NOTE the aggregation is NOT filtered by updated_at: a dirty donor's edge is
  -- re-derived from their FULL history, which is what makes the window
  -- idempotent and the result identical to a single-pass run.
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN public.ec_donations_incr_dirty d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
    WHERE fr.relationship_type IN ('donation', 'ie_support')
      AND d.from_id >= p_lo
      AND (p_hi IS NULL OR d.from_id < p_hi)
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'donation'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  -- ── ie_oppose -> 'opposition' (same dirty set, same window) ────────────────
  WITH agg AS (
    SELECT
      fr.from_type, fr.from_id, fr.to_type, fr.to_id,
      COUNT(*)                                        AS evidence_count,
      SUM(COALESCE(fr.amount_cents, 0))               AS total_cents,
      MIN(fr.occurred_at)                             AS first_at,
      MAX(fr.occurred_at)                             AS last_at,
      (ARRAY_AGG(fr.id ORDER BY fr.occurred_at DESC NULLS LAST))[1:100] AS evidence_ids
    FROM public.financial_relationships fr
    INNER JOIN public.ec_donations_incr_dirty d
      ON d.from_type = fr.from_type AND d.from_id = fr.from_id
    WHERE fr.relationship_type = 'ie_oppose'
      AND d.from_id >= p_lo
      AND (p_hi IS NULL OR d.from_id < p_hi)
    GROUP BY fr.from_type, fr.from_id, fr.to_type, fr.to_id
  ), inserted AS (
    INSERT INTO public.entity_connections (
      from_type, from_id, to_type, to_id, connection_type,
      strength, amount_cents, occurred_at, ended_at,
      evidence_count, evidence_source, evidence_ids
    )
    SELECT
      a.from_type, a.from_id, a.to_type, a.to_id, 'opposition'::public.connection_type,
      LEAST(0.999, GREATEST(0.001,
        LOG(10, GREATEST(a.total_cents / 100.0, 1.0)) / 8.0
      ))::numeric(4,3),
      a.total_cents, a.first_at, a.last_at,
      a.evidence_count, 'financial_relationships', a.evidence_ids
    FROM agg a
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_opp FROM inserted;

  -- ── The ratchet: advance THIS window only, and recompute the scalar ────────
  -- `last_indexed_at` is kept as the MIN across the 16 windows so every existing
  -- reader keeps seeing a conservative, true "everything before this is fully
  -- indexed" — it does not move until the slowest window has caught up.
  UPDATE public.pipeline_state
     SET value = jsonb_set(value, ARRAY['windows', p_idx::text],
                           to_jsonb(p_target::text)),
         updated_at = now()
   WHERE key = c_key;

  SELECT min((e.value)::timestamptz) INTO v_min
    FROM public.pipeline_state ps,
         jsonb_each_text(ps.value->'windows') AS e(key, value)
   WHERE ps.key = c_key;

  UPDATE public.pipeline_state
     SET value = jsonb_set(value, ARRAY['last_indexed_at'], to_jsonb(v_min::text)),
         updated_at = now()
   WHERE key = c_key AND v_min IS NOT NULL;

  RETURN v_count + v_opp;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_incr_window(int, uuid, uuid, timestamptz) IS
  'FIX-1069 — rebuild donation + opposition edges for the DIRTY donors in '
  '[p_lo, p_hi), then advance window p_idx''s watermark to p_target as the last '
  'act of the same transaction. Self-contained and idempotent so the caller can '
  'COMMIT after each window; a cancelled window rolls back its watermark with '
  'its edges and is simply redone. Skips instantly when already at target.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. close — end a cycle once every window is level.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rebuild_ec_donations_incr_close(p_target timestamptz)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  c_key CONSTANT text := 'entity_connections_donations';
  v_lag int;
BEGIN
  SELECT count(*) INTO v_lag
    FROM public.pipeline_state ps,
         jsonb_each_text(ps.value->'windows') AS e(key, value)
   WHERE ps.key = c_key
     AND (e.value)::timestamptz < p_target;

  IF v_lag > 0 THEN
    RETURN false;
  END IF;

  TRUNCATE public.ec_donations_incr_dirty;

  UPDATE public.pipeline_state
     SET value      = (value - 'cycle')
                      || jsonb_build_object('last_indexed_at', p_target::text),
         updated_at = now()
   WHERE key = c_key;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_ec_donations_incr_close(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_ec_donations_incr_close(timestamptz) TO service_role;

COMMENT ON FUNCTION public.rebuild_ec_donations_incr_close(timestamptz) IS
  'FIX-1069 — close an incremental donations cycle once all 16 window '
  'watermarks are level with p_target: drop the staging rows and the cycle '
  'block, and set the scalar last_indexed_at. Returns false (and changes '
  'nothing) while any window still lags.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Drop the inert proconfig guards. See the header for the measurement.
--    These announce a bound they have never enforced; the announcement is the
--    harm.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER FUNCTION public.rebuild_entity_connections_donations()      RESET statement_timeout;
ALTER FUNCTION public.rebuild_entity_connections_donations_full() RESET statement_timeout;
ALTER FUNCTION public.rebuild_ec_donations_full_window(uuid, uuid) RESET statement_timeout;

COMMENT ON FUNCTION public.rebuild_entity_connections_donations() IS
  'Dirty-set incremental donation + opposition rebuild, single statement. '
  'FIX-1069: NO LONGER the scheduled path — run_entity_connections_rebuild() '
  'now drives rebuild_ec_donations_incr_window() across 16 committed windows, '
  'because as one statement this function could not be budgeted, banked or '
  'resumed (prod 2026-08-19: 21,677s, 0 edges, everything rolled back). Kept '
  'as a break-glass single-shot for small dirty sets. Its former '
  'SET statement_timeout=45min was removed: proconfig changes the GUC inside '
  'the body but never re-arms the timer, so it bounded nothing.';
