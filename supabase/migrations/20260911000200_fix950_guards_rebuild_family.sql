-- FIX-950 — the REBUILD / CRAWL / TAGGER / RECONCILE family stands down while
-- a supervised prod session is held.
--
-- HOW THIS FILE WAS BUILT, AND WHY IT LOOKS MACHINE-MADE
--
-- Each body below is the EXACT output of pg_get_functiondef() read from the
-- local prod-clone on 2026-09-11, md5-verified byte-identical to prod for all
-- twenty procedures before a character was changed, with ONE block inserted
-- immediately after the procedure's own advisory-lock acquisition. Nothing else
-- differs — not a SET clause, not whitespace, not a comment. That is the 885
-- model and rule 34's answer in one: an omitted `SET search_path` is silently
-- dropped by CREATE OR REPLACE, and the only reliable way to re-state twenty
-- bodies without losing one is not to retype them.
--
-- The guard: after the procedure has taken its own lock (so it is the legitimate
-- runner) and before it writes anything, it asks public.prod_session_state()
-- whether a human is holding the box. If so it writes the `skipped` row it
-- already knows how to write, releases the lock it just took, and returns —
-- in well under a second, which is the property the prod receipt measures.
--
-- `skipped` + `skip_reason` is deliberately the SAME vocabulary each of these
-- procedures already uses for its own lock contention, so nothing downstream
-- needs teaching: list_scheduled_rollup_pipelines() keeps listing the pipeline,
-- check_rollup_freshness() keeps counting only `complete` (so a held firing
-- correctly does NOT advance the freshness clock), and FIX-1137's future
-- re-fire can key on `skip_reason LIKE 'prod session held%'` — the same prefix
-- the nightly writes from TypeScript.
--
-- WHAT IS NOT GUARDED, and why: the twelve VACUUM jobs (a top-level VACUUM is
-- not a procedure and cannot branch), the two */2 watchdogs
-- (enforce_cron_job_budgets, enforce_derived_mvs_unit_budget — a session must
-- not disarm the thing that cancels runaway jobs), refresh_platform_counts and
-- purge_abuse_events (observational/retention, seconds). A session must not
-- blind the instruments.
--

-- ───────────────────────────────────────────────────────────────────────
-- run_entity_connections_rebuild
-- ───────────────────────────────────────────────────────────────────────
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
                        'gated_count', COALESCE(array_length(v_gated_arms, 1), 0)
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
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- run_fe_totals_crawl
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.run_fe_totals_crawl(IN p_max_units integer DEFAULT 1)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key  bigint := hashtext('financial_entity_totals_refresh')::bigint;
  c_boot_key  text   := 'fe_crawl_bootstrap_progress';
  c_bounds    uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id     uuid;
  v_started    timestamptz := clock_timestamp();
  v_gate       jsonb;
  v_interlock  jsonb;
  v_cfg        jsonb;
  v_budget     interval;
  v_units      int     := 0;
  v_capped     boolean := false;
  v_caught_up  boolean := false;
  v_canceled   text    := NULL;
  v_failures   text[]  := ARRAY[]::text[];
  v_rows       bigint  := 0;
  v_backoff    boolean := false;
  v_unit_log   jsonb   := '[]'::jsonb;
  v_res        jsonb;
  v_rec        jsonb;
  v_t0         timestamptz;
  v_secs       numeric;
  v_boot       jsonb;
  v_boot_done  int[]   := ARRAY[]::int[];
  v_lo         uuid;
  v_hi         uuid;
  v_n          bigint;
  i            int;
BEGIN
  IF p_max_units < 1 THEN
    RAISE EXCEPTION 'run_fe_totals_crawl: p_max_units must be >= 1 (got %)', p_max_units;
  END IF;

  -- Shares jobid 13's advisory lock key on purpose: the old procedure and this
  -- one must never run together against the same watermark.
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent financial-entity-totals refresh',
                               'source', 'pg_cron', 'crawl', true));
    RAISE NOTICE '[fe-crawl] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[fe-crawl] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- ── the gate, including the EC crawl's backoff ───────────────────────────
  v_gate := public.crawl_gate('fe_crawl', NULL, NULL, 'ec_crawl');
  IF NOT (v_gate->>'run')::boolean THEN
    IF v_gate->>'reason' IN ('backoff', 'peer_backoff') THEN
      INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
      VALUES ('financial_entity_totals_refresh', 'skipped', v_started, clock_timestamp(),
              jsonb_build_object('source', 'pg_cron', 'crawl', true,
                                 'skip_reason', v_gate->>'detail', 'gate', v_gate));
    END IF;
    UPDATE public.pipeline_state
       SET value = value || jsonb_build_object('skips',
                     COALESCE(value->'skips', '{}'::jsonb)
                     || jsonb_build_object(
                          v_gate->>'reason',
                          COALESCE((value->'skips'->>(v_gate->>'reason'))::int, 0) + 1,
                          'last_skip_at',     clock_timestamp(),
                          'last_skip_reason', v_gate->>'reason')),
           updated_at = now()
     WHERE key = 'fe_crawl';
    RAISE NOTICE '[fe-crawl] SKIPPED (%) — %', v_gate->>'reason', v_gate->>'detail';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;

  -- ── FIX-1101's FEC interlock ─────────────────────────────────────────────
  -- This crawl reads financial_relationships, which is exactly what the weekly
  -- FEC bulk replay rewrites. Deferring BEFORE the log row goes 'running' means
  -- a deferred firing leaves no state behind.
  v_interlock := public.fec_bulk_interlock_state();
  IF (v_interlock->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_refresh', 'deferred', v_started, clock_timestamp(),
            jsonb_build_object('source', 'pg_cron', 'crawl', true,
                               'defer_reason', v_interlock->>'reason',
                               'fec_interlock', v_interlock));
    RAISE WARNING '[fe-crawl] DEFERRED — %', v_interlock->>'reason';
    PERFORM pg_advisory_unlock(c_lock_key);
    RETURN;
  END IF;
  IF (v_interlock->>'run_state_stale')::boolean THEN
    RAISE WARNING '[fe-crawl] fec_bulk_run_state present but STALE (%) — proceeding; the marker is stranded',
      v_interlock->>'run_state_age';
  END IF;

  SELECT value INTO v_cfg FROM public.pipeline_state WHERE key = 'fe_crawl';
  v_budget := make_interval(secs => GREATEST(
                COALESCE((COALESCE(v_cfg, '{}'::jsonb)->>'unit_budget_seconds')::numeric, 1800), 60));

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_refresh', 'running', now(),
          jsonb_build_object('source', 'pg_cron', 'crawl', true,
                             'max_units', p_max_units,
                             'budget_seconds', round(EXTRACT(epoch FROM v_budget))::int))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- ═══ BOOTSTRAP PATH — only when the watermark is absent ═══════════════════
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_state
                  WHERE key = 'financial_entity_totals_watermark') THEN
    SELECT value INTO v_boot FROM public.pipeline_state WHERE key = c_boot_key;
    IF v_boot IS NOT NULL THEN
      SELECT COALESCE(array_agg(x::int), ARRAY[]::int[]) INTO v_boot_done
        FROM jsonb_array_elements_text(COALESCE(v_boot->'done', '[]'::jsonb)) x;
    END IF;

    FOR i IN 1..16 LOOP
      IF (i - 1) = ANY(v_boot_done) THEN CONTINUE; END IF;   -- no unit spent
      IF v_units >= p_max_units THEN v_capped := true; EXIT; END IF;
      IF clock_timestamp() - v_started >= v_budget THEN v_capped := true; EXIT; END IF;

      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      v_t0 := clock_timestamp();
      v_n  := 0;
      BEGIN
        v_n := public.financial_entity_donation_totals_window(v_lo, v_hi)
             + public.financial_entity_received_totals_window(v_lo, v_hi)
             + public.financial_entity_recipient_count_window(v_lo, v_hi);
        v_rows := v_rows + v_n;
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_boot_key, jsonb_build_object('done', to_jsonb(v_boot_done || (i - 1))))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
        RAISE NOTICE '  [fe-crawl] bootstrap window %/16 — % rows', i, v_n;
      EXCEPTION
      WHEN query_canceled THEN
        v_canceled := format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-crawl] bootstrap window %/16 CANCELED: %', i, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('bootstrap window %s: %s', i, SQLERRM);
        RAISE WARNING '  [fe-crawl] bootstrap window %/16 FAILED: %', i, SQLERRM;
      END;
      COMMIT;

      IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
        v_boot_done := v_boot_done || (i - 1);
      END IF;

      v_units := v_units + 1;
      v_secs  := EXTRACT(epoch FROM (clock_timestamp() - v_t0));
      BEGIN
        v_rec := public.crawl_record_unit('fe_crawl', 'fe_bootstrap_window',
                   format('bootstrap window %s/16', i), v_secs, v_n,
                   CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                        WHEN COALESCE(array_length(v_failures, 1), 0) > 0 THEN 'failed'
                        ELSE 'ok' END);
        IF (v_rec->>'backoff_set')::boolean THEN v_backoff := true; END IF;
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [fe-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;

      EXIT WHEN v_canceled IS NOT NULL;
      IF v_backoff THEN v_capped := true; EXIT; END IF;
    END LOOP;

    -- All sixteen bootstrap windows landed: seed the watermark so every later
    -- firing takes the slice path.
    IF v_canceled IS NULL AND COALESCE(array_length(v_failures, 1), 0) = 0
       AND COALESCE(array_length(v_boot_done, 1), 0) = 16 THEN
      INSERT INTO public.pipeline_state (key, value)
      VALUES ('financial_entity_totals_watermark',
              jsonb_build_object('last_indexed_at',
                -- FIX-983 — clamp the bootstrap seed to the head-lag horizon.
                LEAST(COALESCE((SELECT max(updated_at) FROM public.financial_relationships),
                               public.fr_watermark_horizon()),
                      public.fr_watermark_horizon())::text))
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
      DELETE FROM public.pipeline_state WHERE key = c_boot_key;
      v_caught_up := true;
      COMMIT;
    END IF;

  ELSE
    -- ═══ SLICE PATH — the normal one ═══════════════════════════════════════
    WHILE v_units < p_max_units LOOP
      IF clock_timestamp() - v_started >= v_budget THEN
        v_capped := true;
        RAISE WARNING '  [fe-crawl] BUDGET EXHAUSTED before slice %; stopping cleanly', v_units + 1;
        EXIT;
      END IF;

      v_t0  := clock_timestamp();
      v_res := NULL;
      BEGIN
        v_res  := public.refresh_fe_totals_slice();
        v_rows := v_rows + COALESCE((v_res->>'rows_written')::bigint, 0);
      EXCEPTION
      -- FIX-1028 — by name. The slice is atomic, so a cancel here has already
      -- rolled back BOTH its rows and its watermark advance. Nothing to repair,
      -- nothing stranded; the next firing retries the same slice.
      WHEN query_canceled THEN
        v_canceled := format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [fe-crawl] slice % CANCELED (rolled back whole — watermark unmoved): %',
          v_units + 1, SQLERRM;
      WHEN OTHERS THEN
        v_failures := v_failures || format('slice %s: %s', v_units + 1, SQLERRM);
        RAISE WARNING '  [fe-crawl] slice % FAILED: %', v_units + 1, SQLERRM;
      END;
      COMMIT;

      IF v_res IS NOT NULL AND COALESCE((v_res->>'bootstrap_required')::boolean, false) THEN
        RAISE WARNING '  [fe-crawl] watermark vanished mid-run — bootstrap required; stopping';
        EXIT;
      END IF;

      v_units := v_units + 1;
      v_secs  := EXTRACT(epoch FROM (clock_timestamp() - v_t0));
      BEGIN
        v_rec := public.crawl_record_unit('fe_crawl', 'fe_totals_slice',
                   format('slice -> %s', COALESCE(v_res->>'watermark', '(none)')),
                   v_secs, COALESCE((v_res->>'rows_written')::bigint, 0),
                   CASE WHEN v_canceled IS NOT NULL THEN 'canceled'
                        WHEN COALESCE(array_length(v_failures, 1), 0) > 0 THEN 'failed'
                        ELSE 'ok' END);
        IF (v_rec->>'backoff_set')::boolean THEN v_backoff := true; END IF;
        v_unit_log := v_unit_log || jsonb_build_array(v_rec);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '  [fe-crawl] unit record failed: %', SQLERRM;
      END;
      COMMIT;

      EXIT WHEN v_canceled IS NOT NULL;
      EXIT WHEN COALESCE(array_length(v_failures, 1), 0) > 0;

      IF v_res IS NOT NULL THEN
        RAISE NOTICE '  [fe-crawl] slice -> % — % donors, % recipients, % rows',
          v_res->>'watermark', v_res->>'donors', v_res->>'recipients', v_res->>'rows_written';
        IF COALESCE((v_res->>'caught_up')::boolean, false) THEN
          v_caught_up := true;
          RAISE NOTICE '  [fe-crawl] CAUGHT UP — watermark is at the newest FR write';
          EXIT;
        END IF;
      END IF;

      IF v_backoff THEN v_capped := true; EXIT; END IF;
    END LOOP;

    IF v_units >= p_max_units AND NOT v_caught_up AND v_canceled IS NULL
       AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      v_capped := true;
    END IF;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        WHEN v_capped                        THEN 'partial'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s; the slice rolled back whole, watermark unmoved, next firing retries it', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        WHEN v_capped
                          THEN left(format('unit cap reached — %s unit(s) run%s', v_units,
                                 CASE WHEN v_backoff THEN ' then BACKOFF tripped' ELSE '' END), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'units_run',       v_units,
                        'unit_capped',     v_capped,
                        'caught_up',       v_caught_up,
                        'canceled',        v_canceled IS NOT NULL,
                        'cancel_detail',   v_canceled,
                        'backoff_tripped', v_backoff,
                        'rows_written',    v_rows,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int,
                        'watermark_after', (SELECT value->>'last_indexed_at'
                                              FROM public.pipeline_state
                                             WHERE key = 'financial_entity_totals_watermark'),
                        'units',           v_unit_log)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-crawl] % — % unit(s), % rows, watermark now %',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'FAILED'
         WHEN v_caught_up THEN 'CAUGHT UP'
         WHEN v_capped THEN 'UNIT CAP' ELSE 'complete' END,
    v_units, v_rows,
    (SELECT value->>'last_indexed_at' FROM public.pipeline_state
      WHERE key = 'financial_entity_totals_watermark');

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- run_rule_taggers
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.run_rule_taggers(IN p_cadence text)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key    bigint := hashtext('run_rule_taggers')::bigint;  -- shared by both cadences
  c_wm_key      text   := 'size_tags:donation_watermark';
  v_log_id      uuid;
  v_rows        bigint := 0;
  v_action      text;
  v_current_sig text;
  v_stored_sig  text;
  v_failures    text[] := ARRAY[]::text[];
  v_canceled    text := NULL;                          -- FIX-1028
  v_started     timestamptz := clock_timestamp();      -- FIX-979
BEGIN
  IF p_cadence NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'run_rule_taggers: invalid p_cadence %, expected ''daily'' or ''weekly''', p_cadence;
  END IF;

  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('run_rule_taggers', 'skipped', v_started, clock_timestamp(),
            jsonb_build_object('cadence', p_cadence,
                               'skip_reason', 'advisory lock held by a concurrent run_rule_taggers',
                               'source', 'pg_cron'));
    RAISE NOTICE '[rule-taggers] advisory lock held — skipping (cadence=%)', p_cadence;
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('run_rule_taggers', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[rule-taggers] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Bounded memory for the aggregate rebuilds (they HashAggregate the donation /
  -- vote set). Plain SET survives COMMIT. Budget = 6h role default (FIX-703).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('run_rule_taggers', 'running', v_started,
          jsonb_build_object('cadence', p_cadence, 'source', 'pg_cron'))
  RETURNING id INTO v_log_id;
  COMMIT;

  IF p_cadence = 'weekly' THEN
    -- ── size-tags (donation-derived), gated ──────────────────────────────────
    BEGIN
      SELECT count(*)::text || '|'
             || COALESCE(max(created_at), 'epoch'::timestamptz)::text || '|'
             || COALESCE(max(updated_at), 'epoch'::timestamptz)::text
        INTO v_current_sig
        FROM public.financial_relationships
       WHERE from_type = 'financial_entity' AND relationship_type = 'donation';

      SELECT value->>'sig' INTO v_stored_sig
        FROM public.pipeline_state WHERE key = c_wm_key;

      IF v_stored_sig IS DISTINCT FROM v_current_sig THEN
        v_rows := public.rebuild_financial_entity_size_tags();
        INSERT INTO public.pipeline_state (key, value)
        VALUES (c_wm_key, jsonb_build_object('sig', v_current_sig))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
        v_action := 'rebuilt';
        RAISE NOTICE '  [rule-taggers] size-tags — rebuilt (% tags, sig=%)', v_rows, v_current_sig;
      ELSE
        v_action := 'skipped_unchanged';
        RAISE NOTICE '  [rule-taggers] size-tags — donation source unchanged (sig=%), skipping rebuild', v_current_sig;
      END IF;
    EXCEPTION
    -- FIX-1028 — by name, first. The rebuild and its signature advance share
    -- this subtransaction, so a cancel rolls BOTH back and the next run redoes
    -- the same work. Nothing to gate; just record it and close the row.
    WHEN query_canceled THEN
      v_action   := 'canceled';
      v_canceled := format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      -- Rebuild + watermark advance roll back together → next run retries.
      v_action := 'failed';
      v_failures := v_failures || format('size_tags: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] size-tags — FAILED: %', SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  ELSE
    -- ── pre-vote timing (vote-derived), ungated ──────────────────────────────
    BEGIN
      v_rows := public.rebuild_pre_vote_timing_tags();
      v_action := 'rebuilt';
      RAISE NOTICE '  [rule-taggers] pre-vote timing — rebuilt (% tags)', v_rows;
    EXCEPTION
    WHEN query_canceled THEN
      v_action   := 'canceled';
      v_canceled := format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — CANCELED (statement_timeout or operator cancel): %', SQLERRM;
    WHEN OTHERS THEN
      v_action := 'failed';
      v_failures := v_failures || format('pre_vote_timing: %s', SQLERRM);
      RAISE WARNING '  [rule-taggers] pre-vote timing — FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_rows,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'tagger', CASE WHEN p_cadence = 'weekly' THEN 'size_tags' ELSE 'pre_vote_timing' END,
                        'action', v_action,
                        'tags_written', v_rows,
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[rule-taggers] % (cadence=%) — action=%, % tags (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    p_cadence, v_action, v_rows, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- rebuild_entity_connection_stats
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.rebuild_entity_connection_stats()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('entity_connection_stats_rebuild')::bigint;
  c_bounds   uuid[] := ARRAY[
    '00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000000','30000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000000','50000000-0000-0000-0000-000000000000',
    '60000000-0000-0000-0000-000000000000','70000000-0000-0000-0000-000000000000',
    '80000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-000000000000',
    'a0000000-0000-0000-0000-000000000000','b0000000-0000-0000-0000-000000000000',
    'c0000000-0000-0000-0000-000000000000','d0000000-0000-0000-0000-000000000000',
    'e0000000-0000-0000-0000-000000000000','f0000000-0000-0000-0000-000000000000'
  ]::uuid[];
  v_log_id   uuid;
  v_lo       uuid;
  v_hi       uuid;
  v_res      jsonb;
  v_ups      bigint := 0;
  v_del      bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text   := NULL;
  i          int;
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connection_stats_rebuild', 'skipped', now(), now(),
            jsonb_build_object('skip_reason', 'advisory lock held by a concurrent stats rebuild',
                               'source', 'manual'));
    RAISE NOTICE '[ec-stats] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connection_stats_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[ec-stats] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('entity_connection_stats_rebuild', 'running', now(),
          jsonb_build_object('mode', 'bounded-windows', 'source', 'manual'))
  RETURNING id INTO v_log_id;
  COMMIT;

  FOR i IN 1..16 LOOP
    EXIT WHEN v_canceled IS NOT NULL;
    v_lo := c_bounds[i];
    v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
    BEGIN
      v_res := public.rebuild_entity_connection_stats_window(v_lo, v_hi);
      v_ups := v_ups + (v_res->>'upserted')::bigint;
      v_del := v_del + (v_res->>'deleted')::bigint;
      RAISE NOTICE '  [ec-stats] window %/16 — % upserted, % deleted, % groups',
        i, v_res->>'upserted', v_res->>'deleted', v_res->>'groups';
    EXCEPTION
    -- FIX-1028 — by name and FIRST; OTHERS does not match query_canceled.
    WHEN query_canceled THEN
      v_canceled := format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [ec-stats] window %/16 CANCELED: %', i, SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('window %s: %s', i, SQLERRM);
      RAISE WARNING '  [ec-stats] window %/16 FAILED: %', i, SQLERRM;
    END;
    COMMIT;  -- top level, outside the EXCEPTION subtransaction
  END LOOP;

  UPDATE public.data_sync_log
  SET status        = CASE WHEN v_canceled IS NOT NULL           THEN 'partial'
                           WHEN array_length(v_failures, 1) > 0  THEN 'failed'
                           ELSE 'complete' END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_ups + v_del,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE WHEN v_canceled IS NOT NULL THEN left('canceled — ' || v_canceled, 1000)
                           WHEN array_length(v_failures, 1) > 0
                             THEN left(array_to_string(v_failures, '; '), 1000) END,
      metadata      = metadata || jsonb_build_object(
                        'stats_upserted', v_ups,
                        'stats_deleted',  v_del,
                        'canceled',       v_canceled IS NOT NULL,
                        'failures',       COALESCE(array_length(v_failures, 1), 0))
  WHERE id = v_log_id;

  RAISE NOTICE '[ec-stats] % — % upserted, % deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_ups, v_del, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- rebuild_official_vote_stats
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.rebuild_official_vote_stats()
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $procedure$
DECLARE
  v_count   bigint;
  v_started timestamptz := clock_timestamp();  -- FIX-979
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('official_vote_stats_rebuild')::bigint) THEN
    RAISE NOTICE '[vote-stats rebuild] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('official_vote_stats_rebuild', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[vote-stats rebuild] prod session held — skipping (FIX-950)';
    -- xact-scoped lock: the RETURN ends the transaction, which releases it.
    RETURN;
  END IF;


  SET work_mem = '256MB';

  -- Atomic swap: readers are snapshot-isolated, so DELETE + INSERT in one txn is
  -- never observed as an empty set. Aggregation is byte-identical to _full().
  DELETE FROM public.official_vote_stats;

  WITH yes_party_votes AS (
    SELECT v.official_id, v.bill_proposal_id, o.party
    FROM public.votes v
    JOIN public.officials o ON o.id = v.official_id
    WHERE v.vote = 'yes' AND o.party IS NOT NULL
  ),
  proposal_party_counts AS (
    SELECT bill_proposal_id, COUNT(DISTINCT party) AS distinct_parties
    FROM yes_party_votes
    GROUP BY bill_proposal_id
  ),
  bipartisan AS (
    SELECT ypv.official_id,
           COUNT(*) FILTER (WHERE ppc.distinct_parties >= 2) AS bipartisan_yes
    FROM yes_party_votes ypv
    JOIN proposal_party_counts ppc ON ppc.bill_proposal_id = ypv.bill_proposal_id
    GROUP BY ypv.official_id
  ),
  totals AS (
    SELECT v.official_id,
           COUNT(*)                               AS total_votes,
           COUNT(*) FILTER (WHERE v.vote = 'yes') AS yes_votes
    FROM public.votes v
    GROUP BY v.official_id
  )
  INSERT INTO public.official_vote_stats (official_id, total_votes, yes_votes, bipartisan_yes)
  SELECT
    to2.official_id,
    to2.total_votes::BIGINT,
    to2.yes_votes::BIGINT,
    COALESCE(b.bipartisan_yes, 0)::BIGINT
  FROM totals to2
  LEFT JOIN bipartisan b ON b.official_id = to2.official_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Flip the bootstrap flag in the SAME txn as the full write, so the read fn only
  -- leaves the _full() fallback once the complete set is committed.
  INSERT INTO public.pipeline_state (key, value)
  VALUES ('official_vote_stats_state',
          jsonb_build_object('bootstrapped', true, 'rebuilt_at', now()::text, 'rows', v_count))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, rows_inserted, metadata)
  VALUES ('official_vote_stats_rebuild', 'complete', v_started, clock_timestamp(), v_count,
          jsonb_build_object('rows', v_count));

  RAISE NOTICE '[vote-stats rebuild] complete — % officials', v_count;
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- reconcile_donation_edge_orphans
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_donation_edge_orphans()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donation_edge_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  -- FIX-1028 — non-NULL once a query_canceled (57014) has been caught BY NAME.
  v_canceled text := NULL;
  -- FIX-979 — real entry time so a cancelled run reports a true span.
  v_started  timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donation-edge-orphans] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donation_edge_orphan_sweep', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donation-edge-orphans] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Keep the Merge Anti Join sorts as in-memory as Micro allows (they spill past
  -- ~256MB regardless at this cardinality — external merge sort, sequential IO).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donation_edge_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep the sweep its own short txn

  BEGIN
    DELETE FROM public.entity_connections ec
     WHERE ec.connection_type = 'donation'
       AND NOT EXISTS (
         SELECT 1 FROM public.financial_relationships fr
         WHERE fr.from_type = ec.from_type
           AND fr.from_id   = ec.from_id
           AND fr.to_type   = ec.to_type
           AND fr.to_id     = ec.to_id
           AND fr.relationship_type IN ('donation', 'ie_support')
       );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [donation-edge-orphans] orphan donation edges deleted: %', v_deleted;
  EXCEPTION
  -- FIX-1028 — by name, FIRST. WHEN OTHERS does not match query_canceled, so
  -- before this a watchdog cancel skipped the terminal UPDATE below entirely
  -- and stranded the row 'running' until the reaper.
  WHEN query_canceled THEN
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donation-edge-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donation-edge-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      -- FIX-981/979: clock_timestamp(), not now() — this transaction began
      -- after the sweep's COMMIT.
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_edges_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[donation-edge-orphans] % — % orphan donation edges deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- reconcile_donor_party_rollup_orphans
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_donor_party_rollup_orphans()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donor_party_rollup_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[dpr-orphans] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_party_rollup_orphan_sweep', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[dpr-orphans] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_party_rollup_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- DELETE rollup rows for any donor with NO surviving qualifying FR row —
  -- same predicate as donor_party_rollup_rebuild_donors. The FR.updated_at
  -- watermark cannot see hard deletes (FIX-705 blind spot); this is the
  -- catch-all. Single set-based anti-join.
  BEGIN
    DELETE FROM public.donor_party_rollup_mv r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.from_id = r.donor_id
        AND fr.relationship_type = 'donation'
        AND fr.from_type = 'financial_entity'
        AND fr.to_type   = 'official'
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [dpr-orphans] orphan rollup rows deleted: %', v_deleted;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [dpr-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [dpr-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[dpr-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- reconcile_donor_rollup_orphans
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_donor_rollup_orphans()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_donor_rollup_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[donor-rollup-orphans] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('donor_rollup_orphan_sweep', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[donor-rollup-orphans] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('donor_rollup_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- DELETE rollup rows for any recipient (official_id) with NO surviving
  -- qualifying FR to-side — same predicate as donor_rollup_rebuild_recipients
  -- (relationship_type IN donation/ie_support/ie_oppose, from_type=fe). Single
  -- Hash Anti Join: seq scan the rollup, anti-join against
  -- financial_relationships_donor_rollup_idx. Catches FIX-672-deleted junk
  -- committees + quarantined-IE officials whose FR rows are gone.
  BEGIN
    DELETE FROM public.official_donor_rollup_mv r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.financial_relationships fr
      WHERE fr.to_id = r.official_id
        AND fr.relationship_type IN ('donation', 'ie_support', 'ie_oppose')
        AND fr.from_type = 'financial_entity'
    );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [donor-rollup-orphans] orphan rollup rows deleted: %', v_deleted;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('rollup orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donor-rollup-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('rollup orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [donor-rollup-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[donor-rollup-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- reconcile_entity_connection_stats_orphans
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_entity_connection_stats_orphans()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_entity_connection_stats_orphans')::bigint;
  v_log_id   uuid;
  v_deleted  bigint := 0;
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[ec-stats-orphans] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('entity_connection_stats_orphan_sweep', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[ec-stats-orphans] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('entity_connection_stats_orphan_sweep', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;

  -- Belt-and-braces: the staged full rebuild removes orphans by construction
  -- (windowed DELETE covers the whole keyspace), so this normally deletes ~0
  -- rows. Kept per the FIX-705 discipline — it guards a future incremental
  -- conversion and any window that failed complete-if-stale.
  BEGIN
    DELETE FROM public.entity_connection_stats_mv s
    WHERE NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec WHERE ec.from_id = s.entity_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.entity_connections ec WHERE ec.to_id = s.entity_id
      );
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RAISE NOTICE '  [ec-stats-orphans] orphan stats rows deleted: %', v_deleted;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [ec-stats-orphans] DELETE CANCELED (statement_timeout or operator cancel): %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('orphan DELETE: %s', SQLERRM);
    RAISE WARNING '  [ec-stats-orphans] DELETE FAILED: %', SQLERRM;
  END;
  COMMIT;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_deleted,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s', v_canceled), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'orphan_rows_deleted', v_deleted,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[ec-stats-orphans] % — % orphan rows deleted (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_deleted, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;

-- ───────────────────────────────────────────────────────────────────────
-- reconcile_financial_entity_totals
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.reconcile_financial_entity_totals()
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_lock_key bigint := hashtext('reconcile_financial_entity_totals')::bigint;
  v_log_id   uuid;
  v_donated  bigint := 0;
  v_received bigint := 0;
  v_reccount bigint := 0;   -- FIX-736: recipient_count orphans zeroed
  v_failures text[] := ARRAY[]::text[];
  v_canceled text := NULL;                             -- FIX-1028
  v_started  timestamptz := clock_timestamp();         -- FIX-979
BEGIN
  IF NOT pg_try_advisory_lock(c_lock_key) THEN
    RAISE NOTICE '[fe-totals-reconcile] advisory lock held — skipping';
    RETURN;
  END IF;
  -- FIX-950 — a supervised prod session holds the box. Stand down and say so.
  -- This sits after our own advisory lock and before any write, so the skip is
  -- free and leaves nothing held. `skipped` + `skip_reason` is the vocabulary
  -- this procedure already uses for its own lock contention, so the FIX-1011
  -- census and check_rollup_freshness need no teaching.
  IF (public.prod_session_state()->>'defer')::boolean THEN
    INSERT INTO public.data_sync_log (pipeline, status, started_at, completed_at, metadata)
    VALUES ('financial_entity_totals_reconcile', 'skipped', now(), now(),
            jsonb_build_object(
              'skip_reason', 'prod session held: ' ||
                COALESCE(public.prod_session_state()->>'reason', '(no label)'),
              'source', 'pg_cron',
              'held_by', public.prod_session_state()->>'claimed_by'));
    RAISE NOTICE '[fe-totals-reconcile] prod session held — skipping (FIX-950)';
    PERFORM pg_advisory_unlock(c_lock_key);  -- release what we just took
    RETURN;
  END IF;


  -- Keep the anti-join hash builds in memory (single batch).
  SET work_mem = '256MB';

  INSERT INTO public.data_sync_log (pipeline, status, started_at, metadata)
  VALUES ('financial_entity_totals_reconcile', 'running', v_started,
          jsonb_build_object('source', 'pg_cron', 'kind', 'orphan-sweep'))
  RETURNING id INTO v_log_id;
  COMMIT;  -- publish the running row; keep each sweep its own short txn

  -- Sweep A — donated orphans: a donor carrying a positive total_donated_cents
  -- but with no surviving donation FR from-side (all rows hard-deleted).
  BEGIN
    UPDATE public.financial_entities fe
    SET total_donated_cents = 0
    WHERE fe.total_donated_cents > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.financial_relationships fr
        WHERE fr.from_type = 'financial_entity'
          AND fr.relationship_type = 'donation'
          AND fr.from_id = fe.id
      );
    GET DIAGNOSTICS v_donated = ROW_COUNT;
    RAISE NOTICE '  [fe-totals-reconcile] donated orphans zeroed: %', v_donated;
  EXCEPTION
  WHEN query_canceled THEN                             -- FIX-1028, by name, first
    v_canceled := format('donated sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] donated sweep CANCELED: %', SQLERRM;
  WHEN OTHERS THEN
    v_failures := v_failures || format('donated sweep: %s', SQLERRM);
    RAISE WARNING '  [fe-totals-reconcile] donated sweep FAILED: %', SQLERRM;
  END;
  COMMIT;

  -- Sweep B — received orphans: a recipient carrying a positive
  -- total_received_cents but no surviving inbound donation FR.
  IF v_canceled IS NULL THEN
    BEGIN
      UPDATE public.financial_entities fe
      SET total_received_cents = 0
      WHERE fe.total_received_cents > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.financial_relationships fr
          WHERE fr.to_type = 'financial_entity'
            AND fr.from_type = 'financial_entity'
            AND fr.relationship_type = 'donation'
            AND fr.to_id = fe.id
        );
      GET DIAGNOSTICS v_received = ROW_COUNT;
      RAISE NOTICE '  [fe-totals-reconcile] received orphans zeroed: %', v_received;
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('received sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] received sweep CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('received sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] received sweep FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  -- Sweep C (FIX-736) — recipient_count orphans: an individual carrying a
  -- positive recipient_count but no surviving donation FR from-side. SOUND (FR is
  -- complete) — this replaces the reverted, UNSOUND EC-based sweep. Outer driven
  -- by financial_entities_recipient_count_idx (partial WHERE entity_type=
  -- 'individual'); anti-join FR side rides financial_relationships_donation_size_rollup.
  IF v_canceled IS NULL THEN
    BEGIN
      UPDATE public.financial_entities fe
      SET recipient_count = 0
      WHERE fe.entity_type = 'individual'
        AND fe.recipient_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM public.financial_relationships fr
          WHERE fr.from_type = 'financial_entity'
            AND fr.relationship_type = 'donation'
            AND fr.from_id = fe.id
        );
      GET DIAGNOSTICS v_reccount = ROW_COUNT;
      RAISE NOTICE '  [fe-totals-reconcile] recipient_count orphans zeroed: %', v_reccount;
    EXCEPTION
    WHEN query_canceled THEN
      v_canceled := format('recipient_count sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] recipient_count sweep CANCELED: %', SQLERRM;
    WHEN OTHERS THEN
      v_failures := v_failures || format('recipient_count sweep: %s', SQLERRM);
      RAISE WARNING '  [fe-totals-reconcile] recipient_count sweep FAILED: %', SQLERRM;
    END;
    COMMIT;
  END IF;

  UPDATE public.data_sync_log
  SET status        = CASE
                        WHEN v_canceled IS NOT NULL          THEN 'partial'
                        WHEN array_length(v_failures, 1) > 0 THEN 'failed'
                        ELSE 'complete'
                      END,
      completed_at  = clock_timestamp(),
      rows_inserted = v_donated + v_received + v_reccount,
      rows_failed   = COALESCE(array_length(v_failures, 1), 0),
      error_message = CASE
                        WHEN v_canceled IS NOT NULL
                          THEN left(format('canceled — %s%s', v_canceled,
                                 CASE WHEN array_length(v_failures, 1) > 0
                                      THEN '; prior failures: ' || array_to_string(v_failures, '; ')
                                      ELSE '' END), 1000)
                        WHEN array_length(v_failures, 1) > 0
                          THEN left(array_to_string(v_failures, '; '), 1000)
                        ELSE NULL
                      END,
      metadata      = metadata || jsonb_build_object(
                        'donated_orphans_zeroed', v_donated,
                        'received_orphans_zeroed', v_received,
                        'recipient_count_orphans_zeroed', v_reccount,
                        'failures', COALESCE(array_length(v_failures, 1), 0),
                        'canceled', v_canceled IS NOT NULL,
                        'cancel_detail', v_canceled,
                        'elapsed_seconds', round(EXTRACT(epoch FROM (clock_timestamp() - v_started)))::int)
  WHERE id = v_log_id;

  RAISE NOTICE '[fe-totals-reconcile] % — donated=% received=% recipient_count=% zeroed (% failures)',
    CASE WHEN v_canceled IS NOT NULL THEN 'CANCELED'
         WHEN array_length(v_failures, 1) > 0 THEN 'PARTIAL' ELSE 'complete' END,
    v_donated, v_received, v_reccount, COALESCE(array_length(v_failures, 1), 0);

  PERFORM pg_advisory_unlock(c_lock_key);
END;
$procedure$
;
