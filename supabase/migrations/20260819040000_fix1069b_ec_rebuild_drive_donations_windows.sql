-- =============================================================================
-- FIX-1069 (part b) — drive the donations arm through 16 committed windows in
--                     BOTH modes.
--
-- Part (a) — 20260819030000 — added the staging table and the incremental
-- prepare/window/close functions. This file rewires the procedure to use them.
-- Split into two files only so the procedure diff is reviewable on its own;
-- both apply in the same push, and the harmless failure direction is this one
-- (new functions with no caller do nothing).
--
-- Based on the FIX-1056 body, verified byte-identical on local and prod
-- (md5(prosrc) = 81cfb1d05cb838ad053ce6d3bfdf2c5e, 23,237 bytes) before this
-- replacement was written, so nothing lands on top of an intervening edit.
--
-- FOUR CHANGES, all confined to the donations arm and the next_arm bookkeeping:
--
--   (a) the donations block is no longer gated on `IF v_full`. It picks the
--       window function by mode — rebuild_ec_donations_full_window() for 'full'
--       (and for a bootstrap, which must range-DELETE to clear orphans) and
--       rebuild_ec_donations_incr_window() for 'incremental'. The loop, the
--       per-window COMMIT, the budget check and the banking are shared.
--
--   (b) 'rebuild_entity_connections_donations' is REMOVED from the incremental
--       v_fns array. That entry is what routed the arm through the generic
--       single-statement EXECUTE, which is the whole bug.
--
--   (c) a budget exit inside the donations loop now names the arm AND the
--       window index, instead of being silently overwritten by the
--       first-unbanked-v_fns-arm lookup at the end of the run.
--
--   (d) v_next_arm now accounts for the donations arm. Previously it was
--       computed only over v_fns, which contains the donations WINDOW arm in
--       neither mode — so a run whose donations windows failed while every
--       v_fns arm succeeded computed v_next_arm = NULL, and was kept from
--       reporting 'complete' only by the separate v_failures gate. The unbanked
--       donations arm is now named directly. This is a latent FIX-1056 bug that
--       only became reachable once the incremental branch had a window arm.
-- =============================================================================

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
  'the outside bound this internal budget cannot provide for a single arm.';
