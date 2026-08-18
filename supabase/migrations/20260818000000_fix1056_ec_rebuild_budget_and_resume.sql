-- =============================================================================
-- FIX-1056 — give run_entity_connections_rebuild() a wall-clock budget, a
-- durable per-arm resume checkpoint, and per-arm timings.
--
-- WHAT THE MEASUREMENT ACTUALLY FOUND (and how it differs from the bullet).
--
-- The FIX-1056 bullet attributes the 6h overrun to the CONTRACTS arm, on the
-- strength of the 08-17 run's cancel_detail naming
-- `rebuild_entity_connections_contracts`. That is where the axe FELL; it is not
-- where the time WENT. Measured on prod 2026-08-18 on an idle box, read-only,
-- bounded at 300s, with work_mem=256MB — exactly what this procedure sets:
--
--   GroupAggregate (actual time=125131.882..128408.178 rows=189949 loops=1)
--     Buffers: shared hit=9 read=301515, temp read=44943 written=44944
--     ->  Sort  Sort Method: external merge  Disk: 359544kB
--           ->  Bitmap Heap Scan on financial_relationships
--                 (actual time=768.903..95472.569 rows=3908956)
--                 Heap Blocks: exact=295464
--   Execution Time: 128456.054 ms
--
-- The contracts arm's aggregate is **128 seconds**, not hours. Two real things
-- are visible in that plan and both are worth recording, but neither is a 6h
-- sink: the sort spills (359MB external merge against a 256MB work_mem, because
-- the contract+grant input went 1,467,389 -> 3,822,744 rows in the two weeks of
-- 2026-07-06 and 2026-07-13 — a USASpending ingest, not the 07-29..08-03 window
-- the bullet dated), and the group-count estimate is 2,327,285 against 189,949
-- actual, a 12.3x over-estimate off `from_id`'s n_distinct=-0.268211.
--
-- WHERE THE 6 HOURS ACTUALLY WENT — measured, not inferred. Each incremental
-- arm stamps its watermark row with now(), which is the chunk transaction's
-- start, so `pipeline_state.updated_at` is a per-arm clock the run leaves
-- behind:
--
--   entity_connections_donations  updated_at 2026-08-17 08:00:00  (arm 1 start)
--   entity_connections_votes      updated_at 2026-08-17 11:17:04  (arm 2 start)
--   run cancelled                            2026-08-17 14:00:24  (08:00:12+6h)
--
-- The DONATIONS arm ran 08:00:00 -> 11:17:04 = 11,824s (3h17m, 55% of the
-- budget). Everything else — votes, cosponsors, appointments, oversight, holds,
-- gifts, and the cancelled contracts arm — shared the remaining 9,800s.
--
-- WHY DONATIONS WAS THAT EXPENSIVE, AND WHY IT IS A RECURRING SHAPE RATHER THAN
-- A ONE-OFF. The donations arm is incremental on a `updated_at` watermark. The
-- FEC same-person merge and re-split work (FIX-933/934/954/955) bulk-rewrote
-- `financial_relationships`, which bumped `updated_at` on a very large donor
-- set — measured by week of updated_at:
--
--   2026-07-27   1,201,953 rows    820,602 distinct donors
--   2026-08-03   2,721,613 rows  1,358,662 distinct donors
--
-- so the incremental arm degenerated into a near-full rebuild and wrote
-- 4,011,180 edges against the 5,706,655 donation edges that exist — ~70% of the
-- table, matching the ~71% of donors the dirty set covered. THAT is the step
-- change, and it lands squarely in the 07-29..08-03 window the bullet dated.
-- The bullet's edges_total/runtime throughput metric could not see it: the
-- contracts arm's cost scales with its INPUT (3.9M FR rows) while its OUTPUT
-- (189,949 edges) barely moves, so a 2.6x input growth is invisible to an
-- edges-per-second reading. Both regressions are real; they are just not the
-- ones the metric named.
--
-- WHAT THIS MIGRATION DOES, AND WHY IT SHIPS ANYWAY. The bullet's step 2 is the
-- durable answer regardless of which arm is slow, and the measurement makes the
-- case stronger rather than weaker: the donations dirty set is a function of how
-- much upstream bulk-rewriting happened since the last run, so it is unbounded
-- by construction and WILL blow up again the next time a merge lands. A rebuild
-- that restarts from arm 1 every firing can never converge against that; one
-- that banks per-arm progress converges in two firings. This is the
-- FIX-1002/FIX-1021 treatment applied to the EC rebuild:
--
--   1. WALL-CLOCK BUDGET (5h). Checked BEFORE each arm starts, so the procedure
--      stops at an arm boundary with its bookkeeping intact instead of being
--      axed mid-statement. Deliberately 1h under the 6h role-level
--      statement_timeout so the terminal UPDATE and the cursor write always
--      land. The 6h ceiling itself is NOT raised — FIX-985 set it on purpose
--      and FIX-971 corrected the record on jobs that outrun their own cadence.
--
--   2. DURABLE PER-ARM CHECKPOINT in pipeline_state.entity_connections_rebuild_cursor.
--      Each arm that completes cleanly is appended to `completed_arms` and the
--      cursor is COMMITted with it. The next firing skips banked arms and
--      continues. A cancel banks nothing extra and needs no extra handling —
--      the cursor is already durable from the last clean arm, and the arm that
--      was cancelled rolled back, so re-running it is exactly right.
--
--   3. PER-ARM TIMINGS in metadata.arm_timings. This is the observability gap
--      that produced the misdiagnosis in the first place: `cancel_detail` names
--      the arm the axe hit and nothing recorded where the hours went, so the
--      only per-arm clock available was an accident of the watermark rows. From
--      the next firing on, every arm's elapsed seconds are in the log row.
--
-- RESUME SAFETY. Skipping a banked arm leaves that arm's edges as of the
-- previous firing — stale by at most one cadence, never missing. That is the
-- same complete-if-stale principle the donations windowing already documents.
-- Each arm is a self-contained DELETE-then-INSERT over its own connection_type,
-- so re-running one is idempotent and skipping one cannot corrupt another.
-- `external` and `investigation` stay last within whatever arms remain, which
-- preserves their ON CONFLICT DO NOTHING ordering against the base edges
-- regardless of which firing wrote those.
--
-- A cursor older than 7 days is discarded and a fresh cycle started, so a
-- half-finished cycle can never pin the rebuild to a stale arm list forever.
-- A cursor whose mode differs from the current p_mode is likewise discarded.
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
  -- raise this to 6h: the margin IS the feature.
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
  -- the already-armed timer. FIX-1056 note: the same is true of the
  -- `SET statement_timeout TO '30min'` clause on the individual arm functions —
  -- it is decorative on an already-running CALL, which is why the 08-17 run died
  -- at the 6h mark rather than 30 minutes into the contracts arm.
  SET work_mem = '256MB';

  -- ── FIX-1056 — budget, overridable without a migration ────────────────────
  -- pipeline_state.entity_connections_rebuild_budget = {"seconds": N}. Exists so
  -- an operator can shrink or widen the budget in one UPDATE, and so the two
  -- repro paths below can exercise the SHIPPED code path rather than a test
  -- variant of it. Absent (the normal state) => the 5h default.
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
  -- This is the crash-safe half of FIX-590/591: the pause is undone at the end
  -- of a successful run, but a run that dies hard (or a GHA break-glass run
  -- SIGKILLed at the 4h cap) leaves the flag off with nothing to restore it.
  -- The TS rebuild script has carried this reconcile since FIX-591, but FIX-688
  -- moved the schedule to pg_cron and left that script as manual break-glass —
  -- so the self-heal stopped running on prod entirely. That is how FIX-884
  -- happened: the 2026-06-28 GHA run was cancelled at the cap, and the flag sat
  -- off for ~4 weeks (9,505,759 dead tuples, all-visible 0.9%) because both
  -- pg_cron jobs are 'incremental' and every re-enable here was gated on v_full.
  --
  -- Placed AFTER the advisory-lock guard on purpose: if a rebuild is genuinely
  -- in flight we return early above, so we can never un-pause a peer's
  -- deliberate pause. Conditional on the observed state so a healthy run does
  -- no catalog churn, and RAISEs a WARNING when it actually heals something.
  --
  -- The predicate parses reloptions the way check_rebuild_autovacuum_status()
  -- does (split_part -> boolean, absent => default true) rather than matching a
  -- literal 'autovacuum_enabled=false', so the reconcile and the detector can
  -- never disagree about what "stranded" means.
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

  -- ── Full donations chunk — per-window COMMIT (FIX-703) ─────────────────────
  -- Runs BEFORE the generic chunk loop (must precede external/investigation's
  -- ON CONFLICT DO NOTHING passes). Each window is its own short transaction:
  -- COMMIT after each advances xmin and bounds lock/dead-tuple footprint on Micro
  -- (so the raised CALL-level budget never becomes an atomic multi-hour txn).
  -- Each window range-scopes its delete+insert, so a mid-run failure leaves
  -- un-processed windows' PRIOR edges intact (complete-if-stale, never missing).
  -- FIX-704: no finalize step after the windows — recipient_count is reconciled
  -- out-of-band. NOTE (FIX-1056, corrected 2026-08-18): that comment used to say
  -- "reconcile_recipient_count(), monthly post-VACUUM", which has been FALSE
  -- since 2026-07-05 — FIX-736 unscheduled `ec-recipient-count-reconcile` and
  -- moved the routine FR orphan sweep to `financial-entity-totals-reconcile`.
  -- reconcile_recipient_count() survives as a break-glass full recompute with NO
  -- caller and NO cron job. This comment was the only thing in the prod catalog
  -- still naming it, and it is what made FIX-1053 read the arm as "gated behind
  -- the EC rebuild" when it is simply retired.
  --
  -- FIX-1056: banked as a single arm named 'donations_full_windows'. Window-level
  -- banking is deliberately NOT added — both cron jobs run mode='incremental', so
  -- this path is break-glass only, and each window is already an idempotent
  -- range-scoped delete+insert that is safe to re-run.
  IF v_full AND NOT ('donations_full_windows' = ANY(v_done_arms)) THEN
    v_arm_started := clock_timestamp();
    BEGIN
      PERFORM public.rebuild_ec_donations_full_prepare();  -- watermark only
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures || format('donations prepare: %s', SQLERRM);
      RAISE WARNING '  [donations] prepare FAILED: %', SQLERRM;
    END;
    COMMIT;

    v_donations_total := 0;
    FOR i IN 1..16 LOOP
      -- FIX-1056 — stop at a window boundary rather than being axed mid-window.
      IF clock_timestamp() - v_started >= c_budget THEN
        v_budget_out := true;
        RAISE WARNING '  [donations] window %/16 — BUDGET EXHAUSTED before start; banking and exiting', i;
        EXIT;
      END IF;

      v_lo := c_bounds[i];
      v_hi := CASE WHEN i < 16 THEN c_bounds[i + 1] ELSE NULL END;
      BEGIN
        v_win := public.rebuild_ec_donations_full_window(v_lo, v_hi);
        v_donations_total := v_donations_total + v_win;
        RAISE NOTICE '    [donations] window %/16 [%..%) — % edges',
          i, substr(v_lo::text, 1, 8), COALESCE(substr(v_hi::text, 1, 8), 'end'), v_win;
      EXCEPTION
      -- FIX-1028 — by name, FIRST. The prior comment on this handler asserted
      -- "WHEN OTHERS catches a statement_timeout cancel too", which is exactly
      -- backwards: PL/pgSQL's OTHERS matches every error EXCEPT query_canceled
      -- and assert_failure.
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
      -- COMMIT at the TOP LEVEL (outside the EXCEPTION subtransaction — PL/pgSQL
      -- forbids COMMIT inside one).
      COMMIT;

      -- FIX-1028 — stop the sweep. The box has just proven it cannot finish one
      -- window; the remaining 15 would each re-arm the same axe. Falling out of
      -- the loop still reaches the autovacuum re-enable and the terminal UPDATE
      -- below, which is the whole point.
      IF v_canceled IS NOT NULL THEN
        EXIT;
      END IF;
    END LOOP;

    v_total := v_total + v_donations_total;
    v_arm_timings := v_arm_timings || jsonb_build_object(
      'donations_full_windows', round(EXTRACT(epoch FROM (clock_timestamp() - v_arm_started)))::int);

    -- FIX-1056 — bank only a clean, complete pass over all 16 windows.
    IF v_canceled IS NULL AND NOT v_budget_out AND COALESCE(array_length(v_failures, 1), 0) = 0 THEN
      v_done_arms := v_done_arms || 'donations_full_windows';
      INSERT INTO public.pipeline_state (key, value)
      VALUES (c_cursor_key, jsonb_build_object(
        'mode', p_mode,
        'cycle_started_at', v_cycle_started,
        'completed_arms', to_jsonb(v_done_arms)))
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW();
      COMMIT;
    END IF;

    RAISE NOTICE '  [chunk] donations (windowed) — % (% edges)',
      CASE WHEN v_budget_out THEN 'BUDGET EXHAUSTED' WHEN v_canceled IS NOT NULL THEN 'CANCELED' ELSE 'complete' END,
      v_donations_total;
  ELSIF v_full THEN
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
    v_fns := ARRAY[
      'rebuild_entity_connections_donations',
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
  -- The first arm still outstanding, for the resumable-at message. WITH
  -- ORDINALITY because unnest() ordering is not contractually guaranteed and
  -- "first outstanding arm" has to mean first in ARM ORDER, not first returned.
  SELECT f INTO v_next_arm
    FROM unnest(v_fns) WITH ORDINALITY AS u(f, ord)
   WHERE NOT (u.f = ANY(v_done_arms))
   ORDER BY u.ord
   LIMIT 1;

  IF v_next_arm IS NULL
     AND v_canceled IS NULL
     AND NOT v_budget_out
     AND COALESCE(array_length(v_failures, 1), 0) = 0
  THEN
    -- Every arm banked AND the pass was clean: the cycle is closed, so the
    -- cursor must not survive to make the NEXT firing skip everything.
    -- Deliberately also gated on v_failures: in mode='full' the donations
    -- windows can fail without being banked while every v_fns arm succeeds,
    -- which would otherwise clear the cursor on a run that still owes work.
    -- Leaving the cursor is safe either way — each arm is an idempotent
    -- DELETE-then-INSERT over its own connection_type — but clearing it on a
    -- failed pass would throw away the record of what still needs redoing.
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
                        -- Distinct from 'failed' (a chunk raised) and 'complete'.
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
                          THEN left(format('budget exhausted — resumable at arm %s (%s of %s arms banked)',
                                 COALESCE(v_next_arm, '?'),
                                 COALESCE(array_length(v_done_arms, 1), 0),
                                 COALESCE(array_length(v_fns, 1), 0)), 1000)
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
                        'cycle_started_at', v_cycle_started
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
  'Rebuilds entity_connections arm by arm. FIX-1056: carries a 5h wall-clock '
  'budget checked at arm boundaries (1h under the 6h role statement_timeout, '
  'which is NOT raised — FIX-985), banks each completed arm into '
  'pipeline_state.entity_connections_rebuild_cursor so the next firing resumes '
  'rather than restarting, and records per-arm elapsed seconds in '
  'metadata.arm_timings. A budget exit closes the row status=partial with '
  '"budget exhausted — resumable at arm X"; a cancel (FIX-1028) closes it '
  'status=partial with the cursor already durable from the last clean arm.';
