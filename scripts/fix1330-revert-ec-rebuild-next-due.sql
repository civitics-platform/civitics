-- =============================================================================
-- scripts/fix1330-revert-ec-rebuild-next-due.sql — REVERT of N2's FIX-1330
-- hunk in run_entity_connections_rebuild (cc-243): the 20261009030000 body
-- VERBATIM — the cycle-closing unit stops writing metadata.next_due_at. The
-- pick's read of it is harmless without a writer (GREATEST ignores NULL).
-- prosrc md5 38227eeb0969ca825db74e4dcc4cd2e0 (prod at cc-243 read 3), asserted.
-- A FILE, never run by a prompt unless its STOP table says so.
-- =============================================================================

BEGIN;

CREATE OR REPLACE PROCEDURE public.run_entity_connections_rebuild(IN p_mode text DEFAULT 'incremental'::text, IN p_max_units integer DEFAULT NULL::integer)
 LANGUAGE plpgsql
AS $procedure$DECLARE
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
  -- ── FIX-1111 — the crawl ──────────────────────────────────────────────────
  v_crawl        boolean := (p_max_units IS NOT NULL);
  v_units_run    int     := 0;
  v_unit_capped  boolean := false;
  v_gate         jsonb;
  v_unit_t0      timestamptz;
  v_unit_secs    numeric;
  v_rec          jsonb;
  v_backoff_set  boolean := false;
  v_win_since    timestamptz;
  v_unit_log     jsonb   := '[]'::jsonb;
  -- ── FIX-1115 — entity_connection_stats as 16 bounded windows ──────────────
  c_stats_arm    text    := 'entity_connection_stats_windows';
  c_stats_key    text    := 'entity_connection_stats_progress';
  v_stats_prog   jsonb;
  v_stats_done   int[]   := ARRAY[]::int[];
  v_stats_fp     text;
  v_stats_res    jsonb;
  v_stats_ups    bigint  := 0;
  v_stats_del    bigint  := 0;
  -- ── FIX-1117 — the per-arm source-change gate ─────────────────────────────
  c_fp_key       text    := 'ec_arm_source_fingerprints';
  v_fp           text;
  v_fp_prev      text;
  v_fp_t0        timestamptz;
  v_fp_secs      numeric := 0;
  v_gated_arms   text[]  := ARRAY[]::text[];
  -- ── FIX-1270 — park a generic arm after two consecutive cancels (cc-188) ───
  c_park_key      text    := 'ec_arm_parked';
  v_park          jsonb;
  v_last_two      text[];
  v_parked_now    text    := NULL;
  v_parked_detail text    := NULL;
  v_parked_arms   text[]  := ARRAY[]::text[];
  v_unparked_arms text[]  := ARRAY[]::text[];
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

  -- FIX-1111 — a unit cap of 0 or less is meaningless; treat it as a caller bug
  -- rather than silently doing nothing forever on a */15 schedule.
  IF v_crawl AND p_max_units < 1 THEN
    RAISE EXCEPTION 'run_entity_connections_rebuild: p_max_units must be >= 1 (got %)', p_max_units;
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
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connections_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[rebuild] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- ── FIX-1111 — the crawl gate ─────────────────────────────────────────────
  -- Crawl mode only: p_max_units IS NULL is byte-for-byte today's behaviour, so
  -- an operator's unbounded manual run is never blocked by a policy written for
  -- a */15 background job.
  --
  -- Placed AFTER the advisory-lock guard (so the unlock below is unconditional)
  -- and BEFORE the FEC interlock, because it is strictly cheaper: two
  -- pipeline_state reads and one indexed data_sync_log aggregate, against the
  -- interlock's pg_locks scan.
  --
  -- LOGGING ASYMMETRY, deliberate. Only `backoff` writes a data_sync_log row.
  -- At */15 a blackout or cooldown skip would write up to 96 rows a day saying
  -- "I did nothing, on purpose", drowning the very log that FIX-1107-class
  -- diagnosis is read from. Backoff is rare, means the box is throttled, and is
  -- exactly what you want to find in that log. The other two are counted in
  -- ec_crawl.skips and RAISEd, which is greppable without being noise.
  IF v_crawl THEN
    v_gate := public.ec_crawl_gate();
    IF NOT (v_gate->>'run')::boolean THEN
      IF v_gate->>'reason' = 'backoff' THEN
        INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
        VALUES (
          'entity_connections_rebuild', 'skipped', v_started, clock_timestamp(),
          jsonb_build_object(
            'mode',        p_mode,
            'source',      'pg_cron',
            'skip_reason', v_gate->>'detail',
            'crawl',       true,
            'max_units',   p_max_units,
            'gate',        v_gate));
      END IF;

      UPDATE public.pipeline_state
         SET value = value
                   || jsonb_build_object(
                        'skips',
                        COALESCE(value->'skips', '{}'::jsonb)
                        || jsonb_build_object(
                             v_gate->>'reason',
                             COALESCE((value->'skips'->>(v_gate->>'reason'))::int, 0) + 1,
                             'last_skip_at',     clock_timestamp(),
                             'last_skip_reason', v_gate->>'reason')),
             updated_at = now()
       WHERE key = 'ec_crawl';

      RAISE NOTICE '[rebuild/crawl] SKIPPED (%) — %', v_gate->>'reason', v_gate->>'detail';
      PERFORM pg_advisory_unlock(c_lock_key);
      RETURN;
    END IF;
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
  --
  -- FIX-1111 — this is also the whole Monday fix. jobid 22 is retired by the
  -- crawl, and the weekly FIX-903 FEC replay now simply defers crawl firings
  -- while it holds the lock or leaves a run_state. When it clears, the crawl's
  -- next unit runs — and if the replay spent the day's I/O budget, that unit's
  -- DURATION says so and the sensor above backs off 2 h. No schedule arithmetic.
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
  SET work_mem = '64MB';
  SET max_parallel_workers_per_gather = 0;

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
      'arms_banked_on_entry', to_jsonb(v_done_arms),
      -- FIX-1111
      'crawl', v_crawl,
      'max_units', p_max_units
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
        -- ── FIX-1111 — skip a banked window BEFORE spending a unit on it ─────
        -- rebuild_ec_donations_incr_window() already returns 0 immediately for a
        -- window level with the cycle target; this hoists that same check into
        -- the driver so an already-banked window does not consume the crawl's
        -- one unit. Without it, a crawl firing that met 15 banked windows would
        -- "run" window 1 in ~0 s, count it, and exit — livelock at one useless
        -- firing every 15 minutes forever.
        --
        -- Read-only and exactly the function's own predicate, so NULL-mode
        -- behaviour is unchanged: the call it replaces returned 0 anyway.
        IF NOT v_full AND NOT v_bootstrap THEN
          SELECT (value->'windows'->>(i - 1)::text)::timestamptz
            INTO v_win_since
            FROM public.pipeline_state
           WHERE key = 'entity_connections_donations';

          IF v_win_since IS NOT NULL AND v_win_since >= v_incr_target THEN
            RAISE NOTICE '    [donations/incr] window %/16 — SKIPPED (already at target)', i;
            CONTINUE;
          END IF;
        END IF;

        -- ── FIX-1111 — the unit cap ─────────────────────────────────────────
        -- Checked AFTER the skip above, so the cap is only ever spent on a
        -- window that will do real work.
        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, i);
          RAISE NOTICE '  [donations] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

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

        v_unit_t0 := clock_timestamp();   -- FIX-1111
        v_win     := 0;                   -- FIX-1111 — so a cancel records 0 rows, not NULL

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

        -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────
        -- A CANCELLED window is still counted and still recorded. It spent the
        -- I/O either way, and a 1,800 s cancel against a ~346 s median is
        -- precisely the reading that should trip the backoff — that is the
        -- sensor working, not an edge case to exclude.
        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     CASE WHEN v_full OR v_bootstrap THEN 'donations_full_window'
                          ELSE 'donations_incr_window' END,
                     format('%s window %s/16', v_don_arm, i),
                     v_unit_secs, v_win,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled' ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          -- The sensor must never be able to fail the run it is measuring.
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        -- FIX-1028 — stop the sweep. The box has just proven it cannot finish
        -- one window; the remaining ones would each re-arm the same axe.
        IF v_canceled IS NOT NULL THEN
          EXIT;
        END IF;

        -- FIX-1111 — the sensor tripped. In crawl mode stop here and let the
        -- gate hold the next firings off; in NULL mode the backoff is RECORDED
        -- for the crawl to obey but does NOT change this run's behaviour, which
        -- is what "NULL = today's behaviour" has to mean.
        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', v_don_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;
    END IF;

    v_total := v_total + v_donations_total;
    v_arm_timings := v_arm_timings || jsonb_build_object(
      v_don_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- ── bank only a clean, complete pass over all 16 windows ─────────────────
    -- FIX-1111 — `AND NOT v_unit_capped` is load-bearing. Without it a crawl
    -- firing that ran ONE window would fall into this branch, and although
    -- rebuild_ec_donations_incr_close() correctly refuses to close a cycle
    -- whose windows still lag (FIX-1069c), the arm would still be appended to
    -- v_done_arms below — so the NEXT firing would skip the entire donations
    -- arm with 15 windows unbuilt. The cap exit is an incomplete pass and must
    -- be treated exactly like a budget exit.
    IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
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
           WHEN v_unit_capped THEN 'UNIT CAP'
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
    -- FIX-1111 — and so does a unit-cap or backoff exit. Placed BEFORE the
    -- banked-arm CONTINUE so v_next_arm keeps the window index the donations
    -- exit already wrote into it, rather than being overwritten with the first
    -- outstanding chunk arm.
    EXIT WHEN v_unit_capped;

    -- FIX-1056 — resume: an arm banked earlier in this cycle is already built.
    -- Its edges are stale by at most one cadence, never missing.
    IF v_fn = ANY(v_done_arms) THEN
      RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', v_fn;
      CONTINUE;
    END IF;

    -- ── FIX-1117 — the source-change gate ───────────────────────────────────
    -- Placed AFTER the banked-arm skip and BEFORE the unit cap, for exactly the
    -- reason the banked-window skip sits before the window cap: a gated arm did
    -- no work, so it must not consume the firing's one unit. A cycle whose ten
    -- arms are all unchanged therefore finishes in ONE firing rather than ten,
    -- and that is most of the saving — the ring measured _external and
    -- _contracts rebuilding byte-identical row counts (2 x 574,209 and
    -- 3 x 189,949) for ~1,244 s of writer per cycle.
    --
    -- ⚠ FAIL OPEN. A NULL fingerprint — unknown arm, probe error, or no stored
    -- previous value — RUNS the arm. The only path that skips is "I measured
    -- this source before the last successful build, I measured it now, and the
    -- two are equal". A gate that can silently freeze an arm is the FIX-885
    -- stranded-flag class and is strictly worse than the waste it removes.
    v_fp      := NULL;
    v_fp_prev := NULL;
    v_fp_t0   := clock_timestamp();
    BEGIN
      v_fp := public.ec_arm_source_fingerprint(v_fn);
    EXCEPTION
    -- FIX-1028 — by name, and it earns its place here: the probe is a statement
    -- like any other, so the FIX-1063 watchdog can land on it, and OTHERS does
    -- not match query_canceled. Without this a cancelled probe would escape the
    -- procedure entirely and strand the log row 'running'.
    WHEN query_canceled THEN
      v_canceled := format('%s source fingerprint: %s', v_fn, SQLERRM);
      v_next_arm := v_fn;
      RAISE WARNING '  [gate] % — fingerprint probe CANCELED: %', v_fn, SQLERRM;
    WHEN OTHERS THEN
      RAISE WARNING '  [gate] % — fingerprint probe FAILED (%) — running the arm', v_fn, SQLERRM;
      v_fp := NULL;
    END;
    EXIT WHEN v_canceled IS NOT NULL;
    v_fp_secs := EXTRACT(epoch FROM (clock_timestamp() - v_fp_t0));

    -- ── FIX-1270 — a parked arm is skipped until its source moves ───────────
    -- Parked by the block after the unit record below, after two consecutive
    -- cancels. Skipped WITHOUT spending a unit and banked for the cycle — the
    -- gated-arm shape — so the cycle can close and the stats fingerprint can
    -- advance behind it. It stays parked until its fingerprint differs from the
    -- one it was parked on (cleared here, automatically) or an operator deletes
    -- pipeline_state.ec_arm_parked->'<arm>'. A NULL fingerprint on either side
    -- proves nothing, so it does not unpark: running it is what livelocked.
    v_park := NULL;
    SELECT value->v_fn INTO v_park FROM public.pipeline_state WHERE key = c_park_key;
    IF v_park IS NOT NULL THEN
      IF v_fp IS NOT NULL AND (v_park->>'fp') IS NOT NULL AND v_fp <> (v_park->>'fp') THEN
        UPDATE public.pipeline_state
           SET value = value - v_fn, updated_at = now()
         WHERE key = c_park_key;
        COMMIT;
        v_unparked_arms := v_unparked_arms || v_fn;
        RAISE WARNING '  [park] % — source changed since it was parked (% -> %); unparked, running it',
          v_fn, v_park->>'fp', v_fp;
      ELSE
        v_done_arms   := v_done_arms   || v_fn;
        v_parked_arms := v_parked_arms || v_fn;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
        COMMIT;

        v_arm_timings := v_arm_timings || jsonb_build_object(v_fn, round(v_fp_secs)::int);
        -- rows = 0 and seconds = the probe: unratable and far under the
        -- absolute trip, so the mark can never feed the backoff sensor.
        BEGIN
          v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (parked)',
                                               v_fp_secs, 0, 'skipped_parked');
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        RAISE WARNING '  [chunk] % — SKIPPED (parked since %: %); delete pipeline_state.ec_arm_parked->''%'' to retry it',
          v_fn, v_park->>'since', v_park->>'last_detail', v_fn;
        CONTINUE;
      END IF;
    END IF;

    IF v_fp IS NOT NULL THEN
      SELECT value->'arms'->v_fn->>'fp' INTO v_fp_prev
        FROM public.pipeline_state WHERE key = c_fp_key;
    END IF;

    IF v_fp IS NOT NULL AND v_fp_prev IS NOT NULL AND v_fp_prev = v_fp THEN
      -- Unchanged. Bank it for this cycle — an arm whose source did not move IS
      -- built, and refusing to bank it would stop the cycle ever closing — then
      -- carry straight on to the next arm without spending a unit.
      v_done_arms  := v_done_arms  || v_fn;
      v_gated_arms := v_gated_arms || v_fn;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      COMMIT;

      v_arm_timings := v_arm_timings || jsonb_build_object(v_fn, round(v_fp_secs)::int);

      -- The ring gets a "skipped_unchanged" mark so the lag metric can tell an
      -- IDLE arm from a GATED one. rows = 0 makes the entry unratable under
      -- FIX-1111b (rate is NULL below backoff_min_rows), so it is excluded from
      -- the median rate by construction and cannot drag down the baseline the
      -- next REAL run of this class is judged against. That property is why the
      -- mark can live in the same ring rather than needing a second one.
      BEGIN
        v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (gated)',
                                             v_fp_secs, 0, 'skipped_unchanged');
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;

      RAISE NOTICE '  [chunk] % — SKIPPED (source unchanged since last build: %)', v_fn, v_fp;
      CONTINUE;
    END IF;

    -- FIX-1111 — the unit cap, after the banked-arm skip for the same reason
    -- the window cap sits after the banked-window skip: a cap must only ever be
    -- spent on work that will actually run.
    IF v_crawl AND v_units_run >= p_max_units THEN
      v_unit_capped := true;
      v_next_arm    := v_fn;
      RAISE NOTICE '  [chunk] % — UNIT CAP reached (% unit(s)); banking and exiting', v_fn, v_units_run;
      EXIT;
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
    v_n           := 0;   -- FIX-1111 — so a cancelled arm records 0 rows, not NULL
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

      -- ── FIX-1117 — store the fingerprint this build CONSUMED ──────────────
      -- v_fp was captured BEFORE the arm ran. Re-reading the source here would
      -- mark any write that landed DURING the run as already consumed and gate
      -- it away forever; storing the pre-run value means such a write is seen
      -- next cycle and the arm runs again. Conservative in the only safe
      -- direction. Merged key-wise rather than jsonb_set()-ed, so a registry row
      -- that somehow lacks the 'arms' object still gets written correctly.
      IF v_fp IS NOT NULL THEN
        INSERT INTO public.pipeline_state AS ps (key, value)
        VALUES (c_fp_key, jsonb_build_object('arms',
                  jsonb_build_object(v_fn,
                    jsonb_build_object('fp', v_fp, 'at', clock_timestamp()))))
        ON CONFLICT (key) DO UPDATE
          SET value = COALESCE(ps.value, '{}'::jsonb)
                      || jsonb_build_object('arms',
                           COALESCE(ps.value->'arms', '{}'::jsonb)
                           || jsonb_build_object(v_fn,
                                jsonb_build_object('fp', v_fp, 'at', clock_timestamp()))),
              updated_at = now();
      END IF;
    END IF;

    -- Per-chunk COMMIT (advances xmin; mirrors the TS autocommit-per-chunk).
    -- Also the point at which the arm AND its cursor become durable together.
    COMMIT;

    -- ── FIX-1111 — the unit ran; count it and feed the sensor ───────────────
    v_units_run := v_units_run + 1;
    v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_arm_started));
    BEGIN
      v_rec := public.ec_crawl_record_unit(
                 v_fn, v_fn, v_unit_secs, v_n,
                 CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                      WHEN v_arm_failed          THEN 'failed'
                      ELSE 'ok' END);
      IF (v_rec->>'backoff_set')::boolean THEN
        v_backoff_set := true;
      END IF;
      v_unit_log := v_unit_log || jsonb_build_array(v_rec);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
    END;
    COMMIT;

    -- ── FIX-1270 — the second consecutive cancel parks the arm ─────────────
    -- A generic arm is ONE statement: a cancel rolls it back whole and banks
    -- nothing, the unit record above trips the 2 h backoff (seconds >= 1500),
    -- and before this the next firing retried the SAME arm into the same wall —
    -- every 2 h, forever, with the cycle never closing (census 2026-10-04
    -- §2.6 item 6; _contracts 2026-08-31, 1,878 s, 0 rows). Read the ring: if
    -- this arm's last two entries — real runs plus its '(parked)' marks, which
    -- break the chain so an unparked arm gets two fresh tries — are both
    -- 'canceled', park it, bank it for the cycle, clear the cancel and carry on
    -- to the next arm instead of EXITing. The first cancel still EXITs exactly
    -- as before. If the record above failed there is no ring entry, no park,
    -- and the old behaviour.
    IF v_canceled IS NOT NULL THEN
      SELECT array_agg(t.outcome ORDER BY t.ord DESC) INTO v_last_two
        FROM (SELECT u.value->>'outcome' AS outcome, u.ord
                FROM public.pipeline_state ps,
                     jsonb_array_elements(COALESCE(ps.value->'recent_units', '[]'::jsonb))
                       WITH ORDINALITY AS u(value, ord)
               WHERE ps.key = 'ec_crawl'
                 AND u.value->>'unit' IN (v_fn, v_fn || ' (parked)')
               ORDER BY u.ord DESC
               LIMIT 2) t;

      IF COALESCE(array_length(v_last_two, 1), 0) = 2
         AND v_last_two[1] = 'canceled' AND v_last_two[2] = 'canceled' THEN
        v_parked_now    := v_fn;
        v_parked_detail := v_canceled;
        INSERT INTO public.pipeline_state AS ps (key, value)
        VALUES (c_park_key, jsonb_build_object(v_fn, jsonb_build_object(
                  'since',       clock_timestamp(),
                  'cancels',     2,
                  'last_detail', v_canceled,
                  'fp',          v_fp,
                  'log_id',      v_log_id)))
        ON CONFLICT (key) DO UPDATE
          SET value = COALESCE(ps.value, '{}'::jsonb) || EXCLUDED.value,
              updated_at = now();

        v_done_arms := v_done_arms || v_fn;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
        COMMIT;

        BEGIN
          v_rec := public.ec_crawl_record_unit(v_fn, v_fn || ' (parked)', 0, 0, 'parked');
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        v_parked_arms := v_parked_arms || v_fn;
        v_canceled    := NULL;
        RAISE WARNING '  [park] % — PARKED after 2 consecutive cancels; the cycle carries on without it: %',
          v_fn, v_parked_detail;
      END IF;
    END IF;

    IF v_canceled IS NOT NULL THEN
      EXIT;
    END IF;

    -- FIX-1111 — sensor tripped; crawl mode stops, NULL mode carries on.
    IF v_crawl AND v_backoff_set THEN
      v_unit_capped := true;
      EXIT;
    END IF;
  END LOOP;

  -- ═══ EC STATS ARM — 16 BOUNDED, GATED WINDOWS (FIX-1115) ═══════════════════
  -- LAST in the cycle by construction: it aggregates entity_connections, so it
  -- has to run after every arm that writes edges — including _external and
  -- _investigation, which are themselves pinned last.
  --
  -- Shaped exactly like the donations windows above, and for the same reasons:
  -- one window is one unit, each window COMMITs, an already-banked window is
  -- skipped WITHOUT spending a unit (or a firing that met 15 banked windows
  -- would "run" window 1 in ~0 s and livelock at one useless firing every 15
  -- minutes), and per-window progress is durable so a cancel loses at most one
  -- window.
  --
  -- THE STALENESS THIS CLEARS: entity_connection_stats_mv last rebuilt
  -- successfully 2026-08-05 while the crawl writes edges continuously, so the
  -- first gated pass is a full 16-window backfill of three weeks of drift. At
  -- one unit per */15 firing that is ~4 h of wall clock, paced under the same
  -- sensor and blackout as everything else — which is the entire point of doing
  -- it here rather than in a 6-hour cron job.
  IF c_stats_arm = ANY(v_done_arms) THEN
    RAISE NOTICE '  [chunk] % — SKIPPED (already banked this cycle)', c_stats_arm;
  ELSIF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped THEN
    v_arm_started := clock_timestamp();

    -- ── the FIX-1117 gate, over entity_connections itself ───────────────────
    v_fp_t0    := clock_timestamp();
    v_stats_fp := NULL;
    BEGIN
      v_stats_fp := public.ec_arm_source_fingerprint(c_stats_arm);
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('%s source fingerprint: %s', c_stats_arm, SQLERRM);
      v_next_arm := c_stats_arm;
      RAISE WARNING '  [ec-stats] fingerprint probe CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      RAISE WARNING '  [ec-stats] fingerprint probe FAILED (%) — running the arm', SQLERRM;
      v_stats_fp := NULL;
    END;
    v_fp_secs := EXTRACT(epoch FROM (clock_timestamp() - v_fp_t0));

    v_fp_prev := NULL;
    IF v_canceled IS NULL AND v_stats_fp IS NOT NULL THEN
      SELECT value->'arms'->c_stats_arm->>'fp' INTO v_fp_prev
        FROM public.pipeline_state WHERE key = c_fp_key;
    END IF;

    IF v_canceled IS NOT NULL THEN
      NULL;   -- fall through to the terminal bookkeeping below

    ELSIF v_stats_fp IS NOT NULL AND v_fp_prev IS NOT NULL AND v_fp_prev = v_stats_fp THEN
      -- No edge has been written since the last successful stats build. Bank the
      -- arm and move on without spending a unit. On a day where the gate above
      -- also silenced the ten source arms, this is the whole cycle costing
      -- nothing but probes.
      v_done_arms  := v_done_arms  || c_stats_arm;
      v_gated_arms := v_gated_arms || c_stats_arm;
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      DELETE FROM public.pipeline_state WHERE key = c_stats_key;
      COMMIT;

      v_arm_timings := v_arm_timings || jsonb_build_object(c_stats_arm, round(v_fp_secs)::int);
      BEGIN
        v_rec := public.ec_crawl_record_unit(c_stats_arm, c_stats_arm || ' (gated)',
                                             v_fp_secs, 0, 'skipped_unchanged');
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;
      RAISE NOTICE '  [chunk] % — SKIPPED (entity_connections unchanged since last build: %)',
        c_stats_arm, v_stats_fp;

    ELSE
      -- ── resume this cycle's per-window progress ──────────────────────────
      SELECT value INTO v_stats_prog FROM public.pipeline_state WHERE key = c_stats_key;
      IF v_stats_prog IS NOT NULL
         AND (v_stats_prog->>'cycle_started_at')::timestamptz = v_cycle_started
      THEN
        SELECT COALESCE(array_agg(x::int), ARRAY[]::int[])
          INTO v_stats_done
          FROM jsonb_array_elements_text(COALESCE(v_stats_prog->'done', '[]'::jsonb)) x;
        -- Keep the fingerprint the FIRST firing of this arm captured. A pass
        -- that spans four hours of firings must record what it actually
        -- consumed, not a value re-read at the end with edges written between.
        v_stats_fp := COALESCE(v_stats_prog->>'fp', v_stats_fp);
        IF COALESCE(array_length(v_stats_done, 1), 0) > 0 THEN
          RAISE NOTICE '  [ec-stats] resuming — %/16 window(s) already banked this cycle',
            array_length(v_stats_done, 1);
        END IF;
      ELSE
        v_stats_done := ARRAY[]::int[];
      END IF;

      FOR i IN 1..16 LOOP
        -- Banked window: skip BEFORE the cap, never spending a unit on a no-op.
        IF (i - 1) = ANY(v_stats_done) THEN
          RAISE NOTICE '    [ec-stats] window %/16 — SKIPPED (already banked this cycle)', i;
          CONTINUE;
        END IF;

        IF v_crawl AND v_units_run >= p_max_units THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', c_stats_arm, i);
          RAISE NOTICE '  [ec-stats] window %/16 — UNIT CAP reached (% unit(s)); banking and exiting', i, v_units_run;
          EXIT;
        END IF;

        IF clock_timestamp() - v_started >= c_budget THEN
          v_budget_out := true;
          v_next_arm   := format('%s (window %s/16)', c_stats_arm, i);
          RAISE WARNING '  [ec-stats] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
          EXIT;
        END IF;

        v_lo := c_bounds[i];
        v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;

        v_unit_t0    := clock_timestamp();
        v_n          := 0;   -- so a cancelled window records 0 rows, not NULL
        v_arm_failed := false;
        BEGIN
          v_stats_res := public.rebuild_entity_connection_stats_window(v_lo, v_hi);
          v_n         := (v_stats_res->>'upserted')::bigint + (v_stats_res->>'deleted')::bigint;
          v_stats_ups := v_stats_ups + (v_stats_res->>'upserted')::bigint;
          v_stats_del := v_stats_del + (v_stats_res->>'deleted')::bigint;

          -- The window's rows and the window's progress become durable in the
          -- SAME transaction. FIX-1112's rule in its strongest form: there is no
          -- ratchet to lose, because the progress marker IS part of the chunk.
          INSERT INTO public.pipeline_state (key, value)
          VALUES (c_stats_key, jsonb_build_object(
                    'cycle_started_at', v_cycle_started,
                    'done',             to_jsonb(v_stats_done || (i - 1)),
                    'fp',               v_stats_fp))
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now();

          RAISE NOTICE '    [ec-stats] window %/16 [%..%) — % upserted, % deleted, % groups',
            i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'),
            v_stats_res->>'upserted', v_stats_res->>'deleted', v_stats_res->>'groups';
        EXCEPTION
        WHEN query_canceled THEN
          v_canceled := format('%s window %s/16: %s', c_stats_arm, i, SQLERRM);
          v_next_arm := format('%s (window %s/16)', c_stats_arm, i);
          RAISE WARNING '  [ec-stats] window %/16 — CANCELED: %', i, SQLERRM;
        WHEN OTHERS THEN
          v_arm_failed := true;
          v_failures := v_failures || format('%s window %s: %s', c_stats_arm, i, SQLERRM);
          RAISE WARNING '  [ec-stats] window %/16 FAILED: %', i, SQLERRM;
        END;
        COMMIT;

        -- Claim the window only once its transaction actually committed.
        -- PL/pgSQL variables are NOT rolled back by a subtransaction abort, so
        -- appending inside the block above would let a failed INSERT leave this
        -- array claiming a window that never banked.
        IF v_canceled IS NULL AND NOT v_arm_failed THEN
          v_stats_done := v_stats_done || (i - 1);
        END IF;

        v_units_run := v_units_run + 1;
        v_unit_secs := EXTRACT(epoch FROM (clock_timestamp() - v_unit_t0));
        BEGIN
          v_rec := public.ec_crawl_record_unit(
                     'entity_connection_stats_window',
                     format('%s window %s/16', c_stats_arm, i),
                     v_unit_secs, v_n,
                     CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                          WHEN v_arm_failed          THEN 'failed'
                          ELSE 'ok' END);
          IF (v_rec->>'backoff_set')::boolean THEN
            v_backoff_set := true;
          END IF;
          v_unit_log := v_unit_log || jsonb_build_array(v_rec);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '  [ec-crawl] unit record failed: %', SQLERRM;
        END;
        COMMIT;

        EXIT WHEN v_canceled IS NOT NULL;

        IF v_crawl AND v_backoff_set THEN
          v_unit_capped := true;
          v_next_arm    := format('%s (window %s/16)', c_stats_arm, LEAST(i + 1, 16));
          EXIT;
        END IF;
      END LOOP;

      v_total := v_total + v_stats_ups + v_stats_del;
      v_arm_timings := v_arm_timings || jsonb_build_object(
        c_stats_arm, round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

      -- Bank the ARM only on a clean, complete pass over all sixteen windows —
      -- the same "AND NOT v_unit_capped" discipline the donations arm needs, and
      -- for the same reason: a cap exit is an INCOMPLETE pass, and banking it
      -- would make the next firing skip the whole arm with windows unbuilt.
      IF v_canceled IS NULL AND NOT v_budget_out AND NOT v_unit_capped
         AND COALESCE(array_length(v_failures, 1), 0) = 0
         AND COALESCE(array_length(v_stats_done, 1), 0) = 16
      THEN
        v_done_arms := v_done_arms || c_stats_arm;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_cursor_key, jsonb_build_object(
          'mode', p_mode,
          'cycle_started_at', v_cycle_started,
          'completed_arms', to_jsonb(v_done_arms)))
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();

        IF v_stats_fp IS NOT NULL THEN
          INSERT INTO public.pipeline_state AS ps (key, value)
          VALUES (c_fp_key, jsonb_build_object('arms',
                    jsonb_build_object(c_stats_arm,
                      jsonb_build_object('fp', v_stats_fp, 'at', clock_timestamp()))))
          ON CONFLICT (key) DO UPDATE
            SET value = COALESCE(ps.value, '{}'::jsonb)
                        || jsonb_build_object('arms',
                             COALESCE(ps.value->'arms', '{}'::jsonb)
                             || jsonb_build_object(c_stats_arm,
                                  jsonb_build_object('fp', v_stats_fp, 'at', clock_timestamp()))),
                updated_at = now();
        END IF;

        DELETE FROM public.pipeline_state WHERE key = c_stats_key;
        COMMIT;
      END IF;

      RAISE NOTICE '  [chunk] % — % (% upserted, % deleted)', c_stats_arm,
        CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
             WHEN v_unit_capped THEN 'UNIT CAP'
             WHEN v_canceled IS NOT NULL THEN 'CANCELED'
             ELSE 'complete' END,
        v_stats_ups, v_stats_del;
    END IF;
  END IF;

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
    -- FIX-1115 — the stats arm is not a member of v_fns either, and it is LAST,
    -- so it is only the outstanding arm once every other one has banked.
    IF v_next_arm IS NULL AND NOT (c_stats_arm = ANY(v_done_arms)) THEN
      v_next_arm := c_stats_arm;
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
    -- FIX-1115 — belt-and-braces: the stats arm clears this itself when it
    -- banks, but a cycle can close having GATED the arm on a firing where the
    -- key was already gone, and a stale key carrying a dead cycle_started_at
    -- would otherwise sit here until the next stats pass ignored it.
    DELETE FROM public.pipeline_state WHERE key = c_stats_key;
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
                        -- FIX-1270 — so is the firing that PARKS an arm: its
                        -- edges are stale until the park clears. Only that
                        -- firing; a later one that skips the parked arm is
                        -- judged on its own outcome and lists it in parked_arms.
                        WHEN v_parked_now IS NOT NULL THEN 'partial'
                        -- FIX-1056 — a budget exit is also PARTIAL, and unlike a
                        -- cancel it is an ORDERLY stop with a resumable cursor.
                        WHEN v_budget_out THEN 'partial'
                        -- FIX-1111 — so is a unit-cap exit, and it is the crawl's
                        -- NORMAL outcome rather than an incident. It must still be
                        -- 'partial' (work remains), but `unit_capped` in metadata
                        -- is what distinguishes ~96 routine crawl exits a day from
                        -- the budget exhaustions FIX-969 counts.
                        WHEN v_unit_capped THEN 'partial'
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
      -- FIX-1270 — a park leads the message; whatever else ended the run
      -- follows it (concat_ws skips the NULL side).
      error_message = left(concat_ws('; ',
                        CASE WHEN v_parked_now IS NOT NULL
                             THEN format('arm parked after 2 consecutive cancels: %s (%s)',
                                         v_parked_now, v_parked_detail) END,
                      CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s%s', v_canceled,
                                 CASE WHEN v_next_arm IS NOT NULL
                                      THEN format('; resumable at arm %s', v_next_arm)
                                      ELSE '' END,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN v_budget_out
                          -- +2 on the arm count: the donations window arm and
                          -- (FIX-1115) the stats window arm are both bankable
                          -- but neither is a member of v_fns.
                          THEN left(format('budget exhausted — resumable at arm %s (%s of %s arms banked)',
                                 COALESCE(v_next_arm, '?'),
                                 COALESCE(array_length(v_done_arms, 1), 0),
                                 COALESCE(array_length(v_fns, 1), 0) + 2), 1000)
                        -- FIX-1111 — an ORDERLY, expected stop. Worded so it can
                        -- never be mistaken for a budget blowout in a grep.
                        WHEN v_unit_capped
                          THEN left(format('unit cap reached — %s unit(s) run%s; resumable at arm %s',
                                 v_units_run,
                                 CASE WHEN v_backoff_set THEN ' then BACKOFF tripped' ELSE '' END,
                                 COALESCE(v_next_arm, '?')), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END), 1000),
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
                        'donations_bootstrap', v_bootstrap,
                        -- FIX-1111
                        'crawl', v_crawl,
                        'max_units', p_max_units,
                        'units_run', v_units_run,
                        'unit_capped', v_unit_capped,
                        'backoff_tripped', v_backoff_set,
                        'units', v_unit_log,
                        -- FIX-1115
                        'stats_upserted', v_stats_ups,
                        'stats_deleted', v_stats_del,
                        -- FIX-1117 — which arms this firing skipped as unchanged.
                        -- Distinguishable from an idle arm, which simply never
                        -- appears, and from a banked one, which is in arms_banked
                        -- without being here.
                        'gated_arms', to_jsonb(v_gated_arms),
                        'gated_count', COALESCE(array_length(v_gated_arms, 1), 0),
                        -- FIX-1270 — parked_arms: parked by this firing or
                        -- skipped by it as parked; parked_now: the one this
                        -- firing parked; unparked_arms: cleared because their
                        -- source moved. Absent from the log = nothing parked.
                        'parked_arms', to_jsonb(v_parked_arms),
                        'parked_now', v_parked_now,
                        'parked_detail', v_parked_detail,
                        'unparked_arms', to_jsonb(v_unparked_arms)
                      )
  WHERE id = v_log_id;

  RAISE NOTICE '[rebuild] % in mode=% — % edges (% chunk failures), % arm(s) banked, % unit(s), next=%',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN v_budget_out THEN 'BUDGET EXHAUSTED'
         WHEN v_unit_capped THEN 'UNIT CAP'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_mode, v_total, COALESCE(array_length(v_failures, 1), 0),
    COALESCE(array_length(v_done_arms, 1), 0), v_units_run, COALESCE(v_next_arm, '(none)');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$;

REVOKE ALL ON PROCEDURE public.run_entity_connections_rebuild(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.run_entity_connections_rebuild(text, integer) TO service_role;

DO $revert$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE proname = 'run_entity_connections_rebuild' AND pronamespace = 'public'::regnamespace;
  IF v IS DISTINCT FROM '38227eeb0969ca825db74e4dcc4cd2e0' THEN
    RAISE EXCEPTION '[fix1330-revert] md5 % is not the 20261009030000 body', v;
  END IF;
  RAISE NOTICE '[fix1330-revert] run_entity_connections_rebuild back to 20261009030000 (md5 %)', v;
END $revert$;

COMMIT;
